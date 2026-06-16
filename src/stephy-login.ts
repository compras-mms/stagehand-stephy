import { createInterface } from "node:readline";
import { makeStagehand, resolveStagehandEnv } from "./stagehand.js";
import {
  runNopsConTracking,
  searchReceiptsForNops,
  persistMatches,
  finalizeRunHistory,
} from "./nops-con-tracking.js";

/**
 * Drive StephyTracking (https://app.stephytracking.com/) for the Tecnoship
 * company, role "Agente", up to the Receipts page.
 *
 * Flow:
 *   0. SKIP LOGIN if already authenticated. We first try to land directly on
 *      the dashboard (the Chrome profile is persistent, so the session often
 *      survives). If the dashboard loads, we skip the whole login.
 *   1. LOGIN (only if needed) — 3 screens:
 *      a. "Seleccione su Compañía" — search box: type the company, Enter, then
 *         click the company result card.
 *      b. "Acceso Consignatario" — change the role Consignatario → Agente FIRST
 *         (Ionic ion-select → alert with radios + OK; the role drives the URL),
 *         then fill user + password and press ENTRAR.
 *      c. Dashboard reached.
 *   2. OPEN MENU ☰ (top-right) → handle the notifications Alert → "Receipts":
 *      - Click the ☰ hamburger in the TOP-RIGHT corner.
 *      - If the Alert pops up, ALWAYS press CANCEL. Cancelling triggers a page
 *        refresh, so we re-open the menu from scratch and repeat. This loops
 *        until the menu opens WITHOUT an alert.
 *      - Then click "Receipts" → /tecnoship/1/receipts.
 *
 * Credentials are typed straight into the DOM with the native value setter, so
 * the real user/password are NEVER sent to the LLM. The Stagehand agent (act)
 * is used only as a fallback for custom components.
 *
 *   pnpm stephy
 */

const STEPHY_URL = process.env.STEPHY_URL ?? "https://app.stephytracking.com/";
const COMPANY = process.env.STEPHY_COMPANY ?? "tecnoship";
const ROLE = process.env.STEPHY_ROLE ?? "Agente";

const ORIGIN = new URL(STEPHY_URL).origin;
const DASHBOARD_URL =
  process.env.STEPHY_DASHBOARD_URL ?? `${ORIGIN}/${COMPANY}/1/dashboard`;
const RECEIPTS_URL =
  process.env.STEPHY_RECEIPTS_URL ?? `${ORIGIN}/${COMPANY}/1/receipts`;

// --- Selectors (lists of fallbacks tried in order) -------------------------

// Company search box on the landing page ("Seleccione su Compañía").
const SEARCH_SELECTORS = [
  'input[placeholder*="Search" i]',
  'input[type="search"]',
  'input[type="text"]',
  "input:not([type])",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  const [primary] = names;
  throw new Error(
    `${primary} is not set.\n` +
      "  1. Copy .env.example to .env\n" +
      "  2. Fill in STEPHY_USER and STEPHY_PASSWORD",
  );
}

/** Block until the user presses Enter — hands control to a human, keeps browser open. */
function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  // ======================================================================
  //  Step 0 (pre-navegador) — Disparar el workflow n8n "nops-con-tracking" y
  //  traer los NOPs con tracking + id_venta (archivo de trabajo en data/).
  //  Best-effort: si n8n falla, NO bloquea el login.
  // ======================================================================
  const nopsData = await runNopsConTracking();

  const env = resolveStagehandEnv();
  const stagehand = makeStagehand({ env, headless: false });
  await stagehand.init();

  type AnyPage = ReturnType<typeof stagehand.context.pages>[number];
  const page: AnyPage =
    stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  // ======================================================================
  //  Shared helpers (closures over `page` / `stagehand`)
  // ======================================================================

  /** First selector from `selectors` that is present and visible on the page. */
  const firstVisible = async (selectors: string[]) => {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return sel;
      } catch {
        /* invalid selector on this page — ignore */
      }
    }
    return null;
  };

  /**
   * Fill the VISIBLE <input> matching `cssSelector`. StephyTracking is
   * Ionic/Angular and keeps several hidden copies of the form, so `.first()`
   * often lands on a hidden duplicate. We run in-page, pick the visible one,
   * and set its value through the native setter so Angular's reactive form
   * (which listens for `input`) registers it. The value is NEVER sent to the LLM.
   * Returns "ok" | "no-visible".
   */
  const fillVisible = async (cssSelector: string, value: string) => {
    const expr = `(() => {
      const els = Array.from(document.querySelectorAll(${JSON.stringify(cssSelector)}));
      const vis = els.find((el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!vis) return 'no-visible';
      vis.focus();
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(vis, ${JSON.stringify(value)});
      vis.dispatchEvent(new Event('input', { bubbles: true }));
      vis.dispatchEvent(new Event('change', { bubbles: true }));
      vis.dispatchEvent(new Event('blur', { bubbles: true }));
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  /** Click the VISIBLE button whose trimmed text contains `text` (case-insensitive). */
  const clickVisibleButton = async (text: string) => {
    const expr = `(() => {
      const btns = Array.from(document.querySelectorAll('button, [role=button], input[type=submit]'));
      const want = ${JSON.stringify(text.toUpperCase())};
      const vis = btns.find((el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        const t = (el.innerText || el.textContent || el.value || '').trim().toUpperCase();
        return t.includes(want) && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!vis) return 'no-visible';
      vis.click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  /**
   * Click the VISIBLE element whose trimmed text contains `text` (menu items,
   * links, labels…). Picks the MOST SPECIFIC match (shortest text) so we click
   * the leaf "Receipts" item, not an ancestor container.
   * Returns "ok" | "no-visible".
   */
  const clickVisibleText = async (text: string) => {
    const expr = `(() => {
      const want = ${JSON.stringify(text.toLowerCase())};
      const els = Array.from(document.querySelectorAll(
        'ion-item, ion-label, a, [role=menuitem], button, ion-button, span, div'
      ));
      const vis = els.filter((el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return t.includes(want) && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!vis.length) return 'no-visible';
      vis.sort((a, b) =>
        (a.textContent || '').trim().length - (b.textContent || '').trim().length);
      vis[0].click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  const isOnDashboard = () => /dashboard/i.test(page.url());

  /** Is an Ionic alert dialog currently visible on screen? */
  const isAlertVisible = async (): Promise<boolean> => {
    const expr = `(() => {
      const al = document.querySelector('ion-alert');
      if (!al) return false;
      const s = getComputedStyle(al), r = al.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    })()`;
    return (await page.evaluate(expr)) as boolean;
  };

  /**
   * If the notifications Alert is up, press CANCEL (the user's rule: ALWAYS
   * Cancel). Cancelling triggers a page refresh, so we wait for it to settle.
   * Returns true if an alert was present and cancelled.
   */
  const cancelIfAlert = async (): Promise<boolean> => {
    if (!(await isAlertVisible())) return false;
    console.log("  ⚠ Alert detectado → Cancelar.");
    // "CANCELAR".includes("CANCEL") is true, so this matches both languages.
    let res = await clickVisibleButton("CANCEL");
    if (res !== "ok") res = await clickVisibleButton("CANCELAR");
    // Cancel refreshes the page; let it reload.
    await sleep(1200);
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(600);
    return true;
  };

  // ======================================================================
  //  Step 0 — Skip login if already authenticated
  // ======================================================================
  async function alreadyLoggedIn(): Promise<boolean> {
    console.log(`\n→ Verificando sesión existente (${DASHBOARD_URL})…`);
    await page.goto(DASHBOARD_URL);
    await page.waitForLoadState("networkidle").catch(() => {});

    // The Ionic/Angular app can bounce through "/" while it boots, and the
    // notifications Alert can mask the real URL. So we POLL for the dashboard
    // (clearing any Alert each round) instead of deciding on a single snapshot.
    // RULE (pedido del usuario): si la sesión está viva y llegamos al
    // dashboard, NO redirigimos a la URL base para loguear. Solo concluimos
    // "sin sesión" cuando el formulario de empresa/login se hace visible de
    // verdad, o cuando expira la ventana de gracia.
    const GRACE = 15;
    for (let i = 0; i < GRACE; i++) {
      await cancelIfAlert();
      if (isOnDashboard()) {
        console.log(`✓ Ya hay sesión activa. Dashboard: ${page.url()}`);
        return true;
      }
      // Re-empujar al dashboard un par de veces por si un redirect transitorio
      // (o el refresh del Cancelar) nos botó a "/". Una sesión VIVA se queda.
      if (!/dashboard/i.test(page.url()) && (i === 4 || i === 9)) {
        await page.goto(DASHBOARD_URL);
        await page.waitForLoadState("networkidle").catch(() => {});
        continue;
      }
      // Señal de DESLOGUEADO: el campo de usuario del login o la caja de
      // búsqueda de compañía están realmente visibles (y NO en el dashboard).
      if (i >= 3) {
        const loginField = await firstVisible([
          'input[name="user"]',
          ...SEARCH_SELECTORS,
        ]);
        if (loginField && !isOnDashboard()) {
          console.log(
            `ⓘ Sin sesión activa (URL: ${page.url()}). Procedo con el login…`,
          );
          return false;
        }
      }
      await sleep(1000);
    }
    console.log(
      `ⓘ No se confirmó el dashboard (URL: ${page.url()}). Procedo con el login…`,
    );
    return false;
  }

  // ======================================================================
  //  Step 1 — Full login flow (only runs if not already logged in)
  // ======================================================================
  async function doLogin() {
    const user = requireEnv("STEPHY_USER", "LOGIN_USER", "LOGIN_EMAIL");
    const password = requireEnv("STEPHY_PASSWORD", "LOGIN_PASSWORD");

    // 1a. Landing page: search for the company.
    console.log(`\n→ Abriendo ${STEPHY_URL} …`);
    await page.goto(STEPHY_URL);
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(1500);

    console.log(`→ Buscando la compañía "${COMPANY}"…`);
    const searchSel = await firstVisible(SEARCH_SELECTORS);
    if (searchSel) {
      const box = page.locator(searchSel).first();
      await box.click().catch(() => {});
      await box.fill(COMPANY);
    } else {
      await stagehand.act(`type "${COMPANY}" into the company search box`);
    }
    await page.keyPress("Enter");
    await sleep(2000);

    // 1b. Click the company result card (custom markup → agent).
    console.log(`→ Seleccionando la compañía "${COMPANY}"…`);
    await stagehand.act(
      `click the "${COMPANY}" (Tecnoship Group) company result card`,
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(2500);

    // 1c. Change role Consignatario → Agente FIRST (drives the URL + re-renders).
    console.log(`→ Cambiando el rol a "${ROLE}"…`);
    await stagehand.act(
      'click the role dropdown that currently shows "Consignatario"',
    );
    await sleep(1000);
    await stagehand.act(`select the "${ROLE}" option in the role dialog`);
    await sleep(500);
    await stagehand.act("click the OK button in the dialog");
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(1500);

    if (!/\/login\/a/i.test(page.url())) {
      console.log(`⚠ Rol no confirmado por URL (actual: ${page.url()}).`);
    } else {
      console.log(`✓ Rol "${ROLE}" activo (${page.url()}).`);
    }

    // 1d. Fill user + password (AFTER the role is set).
    console.log("→ Llenando usuario y contraseña…");
    const userRes = await fillVisible('input[name="user"]', user);
    await sleep(300);
    const passRes = await fillVisible(
      'input[name="password"][type="password"]',
      password,
    );
    await sleep(300);
    if (userRes !== "ok" || passRes !== "ok") {
      console.log(
        `⚠ No se pudieron llenar campos por DOM (user=${userRes}, pass=${passRes}); intento con el agente…`,
      );
      if (userRes !== "ok")
        await stagehand.act(
          `type "${user}" into the "Número de Cuenta" account field`,
        );
      if (passRes !== "ok")
        await stagehand.act(
          "type the password into the Contraseña password field",
        );
    }

    // 1e. Wait 1s, then press ENTRAR.
    await sleep(1000);
    console.log("→ Iniciando sesión (ENTRAR)…");
    const entrarRes = await clickVisibleButton("ENTRAR");
    if (entrarRes !== "ok") {
      console.log("⚠ No hallé el botón ENTRAR visible; uso el agente…");
      await stagehand.act("click the ENTRAR login button");
    }

    // 1f. Wait for the dashboard.
    console.log("→ Esperando a que cargue el dashboard…");
    await page.waitForLoadState("networkidle").catch(() => {});
    for (let i = 0; i < 20; i++) {
      if (isOnDashboard()) break;
      await sleep(1000);
    }

    if (isOnDashboard()) {
      console.log(`✓ Login completado. Dashboard: ${page.url()}`);
    } else {
      console.log(`⚠ No se detectó /dashboard. URL actual: ${page.url()}`);
    }
  }

  // ======================================================================
  //  Step 2 — Open the ☰ menu (handling the Alert) and go to "Receipts"
  // ======================================================================

  /** Click the VISIBLE hamburger ☰ button nearest the TOP-RIGHT corner. */
  const clickHamburger = async (): Promise<boolean> => {
    const expr = `(() => {
      const cands = Array.from(document.querySelectorAll(
        'ion-menu-button, ion-buttons ion-button, ion-buttons button, button[aria-label*="menu" i], [aria-label*="menu" i]'
      ));
      const vis = cands.filter((el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!vis.length) return 'no-visible';
      // Nearest the TOP-RIGHT: maximise (right - top).
      vis.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.right - rb.top) - (ra.right - ra.top);
      });
      vis[0].click();
      return 'ok';
    })()`;
    const res = await page.evaluate(expr);
    if (res === "ok") return true;
    await stagehand.act(
      "click the ☰ hamburger menu button (three horizontal lines) in the TOP-RIGHT corner of the page",
    );
    return true;
  };

  async function openMenuAndReceipts() {
    // --- Open the menu, retrying through the Alert ----------------------
    // Rule: whenever the Alert shows, press CANCEL; cancelling REFRESHES the
    // page, so we must re-open the menu from scratch. The Alert is the ONLY
    // thing that forces a retry — once the menu opens WITHOUT an alert, we
    // proceed to click "Receipts".
    const MAX = 6;
    let menuReady = false;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      console.log(`\n→ Abriendo el menú ☰ (intento ${attempt}/${MAX})…`);

      // Clear any alert already on screen (e.g. from the dashboard load).
      // Cancel refreshes the page → restart this attempt from a clean state.
      if (await cancelIfAlert()) {
        console.log("  ↻ El Cancelar refrescó la página; reabro el menú…");
        continue;
      }

      await clickHamburger();
      await sleep(1500);

      // Did the Alert pop up because of the menu click? Cancel → refresh → retry.
      if (await cancelIfAlert()) {
        console.log("  ↻ El Cancelar refrescó la página; reabro el menú…");
        continue;
      }

      // No alert in the way → the menu is open; go to Receipts.
      menuReady = true;
      console.log("  ✓ Menú abierto sin alertas.");
      break;
    }

    if (!menuReady) {
      console.log(
        "⚠ No se logró abrir el menú sin alertas tras varios intentos; sigo de todas formas.",
      );
    }

    // --- Click "Receipts" ----------------------------------------------
    console.log('→ Entrando a "Receipts"…');
    const recRes = await clickVisibleText("Receipts");
    if (recRes !== "ok") {
      console.log("  ⓘ No hallé 'Receipts' por DOM; uso el agente…");
      await stagehand.act('click the "Receipts" menu item in the open side menu');
    }

    // --- Confirm we reached the Receipts page --------------------------
    await page.waitForLoadState("networkidle").catch(() => {});
    let onReceipts = false;
    for (let i = 0; i < 15; i++) {
      if (/receipts/i.test(page.url())) {
        onReceipts = true;
        break;
      }
      await sleep(1000);
    }

    if (onReceipts) {
      console.log(`\n✓ En la página de Receipts: ${page.url()}`);
    } else {
      // Already authenticated → direct navigation is a valid fallback.
      console.log(
        `\n⚠ No se detectó /receipts (URL: ${page.url()}).` +
          `\n  → Intento navegación directa a ${RECEIPTS_URL}…`,
      );
      await page.goto(RECEIPTS_URL);
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(1500);
      await cancelIfAlert();
      console.log(
        /receipts/i.test(page.url())
          ? `✓ En la página de Receipts: ${page.url()}`
          : `⚠ Aún no se llegó a Receipts. URL actual: ${page.url()}`,
      );
    }
  }

  // ======================================================================
  //  Orchestration
  // ======================================================================
  if (!(await alreadyLoggedIn())) {
    await doLogin();
  }

  if (isOnDashboard()) {
    await openMenuAndReceipts();
  } else {
    console.log(
      `\n⚠ No estamos en el dashboard (URL: ${page.url()}); no abro el menú.`,
    );
  }

  // ======================================================================
  //  (DIAGNÓSTICO, gateado por env STEPHY_DUMP_RECEIPTS=1) — Volcar el DOM de
  //  los controles de filtro de la página Receipts (Filters / Dates / All),
  //  para implementar el "Punto C": apagar el filtro de fecha antes de scrapear.
  // ======================================================================
  if (process.env.STEPHY_DUMP_RECEIPTS && /receipts/i.test(page.url())) {
    const DUMP = `(() => {
      const vis = (el) => { const s=getComputedStyle(el), r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
      const T = (el) => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60);
      const desc = (el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type'),
        name: el.getAttribute('name'), placeholder: el.getAttribute('placeholder'),
        aria: el.getAttribute('aria-label'), value: el.value ?? null, text: T(el), visible: vis(el) });
      const q = (sel) => { try { return Array.from(document.querySelectorAll(sel)).filter(vis).map(desc); } catch { return []; } };
      return JSON.stringify({
        url: location.href,
        buttons: q('button, ion-button, [role=button], input[type=submit]'),
        segments: q('ion-segment, ion-segment-button'),
        chips: q('ion-chip'),
        selects: q('ion-select, select, [role=combobox]'),
        selectOptions: Array.from(document.querySelectorAll('select')).map((s) => ({
          value: s.value,
          options: Array.from(s.options).map((o) => ({ value: o.value, text: (o.textContent||'').trim(), selected: o.selected })),
        })),
        dateInputs: q('input[type=date], ion-datetime, input[placeholder*=date i], input[name*=date i]'),
        inputs: q('input'),
        textHits: Array.from(document.querySelectorAll('button,ion-button,ion-label,ion-item,a,span,div,[role=button]'))
          .filter(el=>vis(el)&&/\\b(filter|filtro|date|fecha|all|todos|apply|aplicar)\\b/i.test(T(el))&&T(el).length<40)
          .map(desc),
      }, null, 2);
    })()`;
    console.log("\n===== DOM: controles de filtro en Receipts =====");
    console.log(await page.evaluate(DUMP));
    console.log("===== fin dump Receipts =====\n");
  }

  // ======================================================================
  //  Step 3 — Cruzar los NOPs con tracking contra la tabla de Receipts
  //  (paginada) y volcar los 3 JSON a data/history/<fecha_hora>/.
  // ======================================================================
  if (nopsData) {
    try {
      if (/receipts/i.test(page.url())) {
        const { encontrados, noEncontrados } = await searchReceiptsForNops(
          page,
          nopsData,
        );
        // Paso 5 del skill: escribir tracking_courier en Supabase (best-effort,
        // idempotente). persistMatches NO lanza; devuelve null si algo falla.
        const persistResult = await persistMatches(encontrados);
        await finalizeRunHistory(
          nopsData,
          encontrados,
          noEncontrados,
          persistResult,
        );
      } else {
        console.log(
          `\n⚠ No se llegó a Receipts (URL: ${page.url()}); archivo los NOPs sin búsqueda de recibos.`,
        );
        const noEnc = (nopsData.nops_detalle ?? []).map((d) => ({
          nop: d.nop,
          id_venta: d.id_venta,
          tracking_proveedor: Array.isArray(d.tracking_proveedor)
            ? String(d.tracking_proveedor[0] ?? "")
            : String(d.tracking_proveedor ?? ""),
          motivo: "no se llegó a la página Receipts",
        }));
        await finalizeRunHistory(nopsData, [], noEnc);
      }
    } catch (err) {
      console.error(
        "⚠ Error cruzando NOPs con Receipts:",
        (err as Error).message,
      );
      try {
        await finalizeRunHistory(nopsData, [], []);
      } catch {
        /* best-effort */
      }
    }
  }

  await waitForEnter("\nPresiona Enter para cerrar el navegador… ");
  await stagehand.close();
}

main().catch((err) => {
  console.error("Login flow failed:\n", err);
  process.exit(1);
});
