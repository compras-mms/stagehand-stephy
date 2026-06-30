import { makeStagehand, resolveStagehandEnv } from "./stagehand.js";
import {
  runNopsConTracking,
  persistMatches,
  finalizeRunHistory,
} from "./nops-con-tracking.js";
import { gotoSearchViaMenu, searchAllTrackings } from "./search-receipts.js";
import { installLogCapture, getCapturedLog, sendRunLog } from "./email-log.js";

// Capturar TODO el log de la corrida desde el primer instante (incluso los logs
// internos de Stagehand), para mandarlo por correo al final.
installLogCapture();

/**
 * Estadísticas de la corrida, para armar el resumen del correo. Es un objeto
 * mutable a nivel de módulo para que tanto la rama de éxito como la de error
 * (que viven fuera de main()) puedan leerlo sin importar por dónde terminó.
 */
interface RunStats {
  inicio: Date;
  loginOk: boolean;
  menuOpen: boolean;
  searchRan: boolean;
  preview: boolean;
  encontrados: number;
  noEncontrados: number;
  sessionExpired: number;
  detalleActualizados: number | string | null;
  gruposActualizados: number | string | null;
  error: string | null;
}

const runStats: RunStats = {
  inicio: new Date(),
  loginOk: false,
  menuOpen: false,
  searchRan: false,
  preview: false,
  encontrados: 0,
  noEncontrados: 0,
  sessionExpired: 0,
  detalleActualizados: null,
  gruposActualizados: null,
  error: null,
};

/**
 * StephyTracking (https://app.stephytracking.com/) — flujo reconstruido desde
 * cero para ser confiable:
 *
 *   1. LOGIN SIEMPRE (limpio): borra cookies + storage y hace el login completo
 *      (compañía "tecnoship" → rol "Agente" → usuario/clave → ENTRAR → dashboard).
 *      No confiamos en la sesión persistente: el dashboard carga de caché aunque
 *      el token esté vencido, así que arrancamos siempre logueando de verdad.
 *
 *   2. ABRIR EL MENÚ ☰ en la esquina SUPERIOR IZQUIERDA. Si salta el Alert de
 *      notificaciones, se cancela (refresca la página) y se reabre.
 *
 *   3. (OPCIONAL, con STEPHY_SEARCH=1) RECEIPTS: entra a Search por el menú,
 *      dispara n8n (NOPs con tracking), busca cada tracking_proveedor uno por
 *      uno en /search y persiste los receipts en Supabase (write-back vía
 *      webhook actualizar-receipts → estatus 'Con recibo Almacen Miami').
 *      Sin el flag, el flujo termina tras abrir el menú.
 *
 * Las credenciales se escriben directo en el DOM con el setter nativo, así que
 * el usuario/clave reales NUNCA se mandan al LLM. El agente (act) se usa solo
 * como fallback para componentes custom (tarjeta de compañía, cambio de rol).
 *
 *   pnpm stephy           → login + menú
 *   pnpm stephy:auto      → + receipts y write-back real (lo que corre el cron)
 *   pnpm stephy:preview   → + receipts en dry-run (no escribe en Supabase)
 */

const STEPHY_URL = process.env.STEPHY_URL ?? "https://app.stephytracking.com/";
const COMPANY = process.env.STEPHY_COMPANY ?? "tecnoship";
const ROLE = process.env.STEPHY_ROLE ?? "Agente";

const ORIGIN = new URL(STEPHY_URL).origin;
const DASHBOARD_URL =
  process.env.STEPHY_DASHBOARD_URL ?? `${ORIGIN}/${COMPANY}/1/dashboard`;

// Caja de búsqueda de compañía en la landing ("Seleccione su Compañía").
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

async function main() {
  const env = resolveStagehandEnv();
  const stagehand = makeStagehand({ env, headless: false });
  await stagehand.init();

  type AnyPage = ReturnType<typeof stagehand.context.pages>[number];
  const page: AnyPage =
    stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  // ======================================================================
  //  Helpers (closures sobre `page` / `stagehand`)
  // ======================================================================

  /** Primer selector de `selectors` presente y visible en la página. */
  const firstVisible = async (selectors: string[]) => {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return sel;
      } catch {
        /* selector inválido en esta página — ignorar */
      }
    }
    return null;
  };

  /**
   * Llena el <input> VISIBLE que matchea `cssSelector`. StephyTracking es
   * Ionic/Angular y mantiene copias ocultas del form, así que `.first()` suele
   * caer en una oculta. Corremos en la página, elegimos el visible, y ponemos el
   * valor por el setter nativo para que el form reactivo de Angular (que escucha
   * `input`) lo registre. El valor NUNCA se manda al LLM. Devuelve "ok" | "no-visible".
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

  /** Click en el botón VISIBLE cuyo texto contiene `text` (case-insensitive). */
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

  const isOnDashboard = () => /dashboard/i.test(page.url());

  /** ¿Hay un ion-alert visible en pantalla? */
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
   * Si el Alert de notificaciones está arriba, presiona CANCELAR (regla del
   * usuario: SIEMPRE Cancelar). Cancelar refresca la página, así que esperamos a
   * que asiente. Devuelve true si había alert y se canceló.
   */
  const cancelIfAlert = async (): Promise<boolean> => {
    if (!(await isAlertVisible())) return false;
    console.log("  ⚠ Alert detectado → Cancelar.");
    // "CANCELAR".includes("CANCEL") es true, así matchea ambos idiomas.
    let res = await clickVisibleButton("CANCEL");
    if (res !== "ok") res = await clickVisibleButton("CANCELAR");
    await sleep(1200);
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(600);
    return true;
  };

  // ======================================================================
  //  Paso 0 — Logout duro (sesión limpia garantizada)
  // ======================================================================
  /**
   * Borra cookies + localStorage/sessionStorage (Ionic guarda ahí el token) y
   * deja la página en la landing, para que doLogin() arranque de cero. Así
   * evitamos el caso "dashboard de caché con token vencido → Sesión Expirada".
   */
  async function hardLogout(): Promise<void> {
    console.log("\n🔒 Logout duro: limpio cookies + storage…");
    await page.goto(DASHBOARD_URL).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    try {
      await page.evaluate(
        `(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return 'ok'; })()`,
      );
    } catch {
      /* best-effort */
    }
    try {
      await stagehand.context.clearCookies();
    } catch {
      /* best-effort */
    }
    await sleep(500);
  }

  // ======================================================================
  //  Paso 1 — Login completo (compañía → rol → credenciales → dashboard)
  // ======================================================================
  async function doLogin() {
    const user = requireEnv("STEPHY_USER", "LOGIN_USER", "LOGIN_EMAIL");
    const password = requireEnv("STEPHY_PASSWORD", "LOGIN_PASSWORD");

    // 1a. Landing: buscar la compañía.
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

    // 1b. Click en la tarjeta de la compañía (markup custom → agente).
    console.log(`→ Seleccionando la compañía "${COMPANY}"…`);
    await stagehand.act(
      `click the "${COMPANY}" (Tecnoship Group) company result card`,
    );
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(2500);

    // 1c. Cambiar rol Consignatario → Agente PRIMERO (define la URL + re-render).
    //     Los act() dependen del LLM y a veces fallan en silencio, así que
    //     reintentamos hasta confirmar /login/a por URL.
    console.log(`→ Cambiando el rol a "${ROLE}"…`);
    for (let roleTry = 1; roleTry <= 3; roleTry++) {
      await stagehand.act(
        'click the role dropdown that currently shows "Consignatario"',
      );
      await sleep(1000);
      await stagehand.act(`select the "${ROLE}" option in the role dialog`);
      await sleep(500);
      await stagehand.act("click the OK button in the dialog");
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(1500);
      if (/\/login\/a/i.test(page.url())) break;
      console.log(
        `  ↻ Rol aún no confirmado (intento ${roleTry}/3, URL: ${page.url()})…`,
      );
    }
    console.log(
      /\/login\/a/i.test(page.url())
        ? `✓ Rol "${ROLE}" activo (${page.url()}).`
        : `⚠ Rol no confirmado por URL (actual: ${page.url()}).`,
    );

    // 1d. Llenar usuario + clave (DESPUÉS del rol).
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

    // 1e. Esperar 1s y presionar ENTRAR.
    await sleep(1000);
    console.log("→ Iniciando sesión (ENTRAR)…");
    const entrarRes = await clickVisibleButton("ENTRAR");
    if (entrarRes !== "ok") {
      console.log("⚠ No hallé el botón ENTRAR visible; uso el agente…");
      await stagehand.act("click the ENTRAR login button");
    }

    // 1f. Esperar el dashboard.
    console.log("→ Esperando a que cargue el dashboard…");
    await page.waitForLoadState("networkidle").catch(() => {});
    for (let i = 0; i < 20; i++) {
      if (isOnDashboard()) break;
      await sleep(1000);
    }
    console.log(
      isOnDashboard()
        ? `✓ Login completado. Dashboard: ${page.url()}`
        : `⚠ No se detectó /dashboard. URL actual: ${page.url()}`,
    );
  }

  // ======================================================================
  //  Paso 2 — Abrir el menú ☰ en la esquina SUPERIOR IZQUIERDA
  // ======================================================================

  /**
   * Click en el ☰: en StephyTracking es un `div.burger-menu` arriba-izquierda
   * (NO un ion-menu-button). Elegimos el más cercano a la esquina superior
   * izquierda. Fallback al agente si no aparece.
   */
  const clickHamburger = async (): Promise<string> => {
    const expr = `(() => {
      const cands = Array.from(document.querySelectorAll(
        '.burger-menu, [class*="burger" i], ion-menu-button, [aria-label*="menu" i]'
      ));
      const vis = cands.filter((el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      });
      if (!vis.length) return 'no-visible';
      // Más cercano a la ESQUINA SUPERIOR IZQUIERDA: minimizar (left + top).
      vis.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.left + ra.top) - (rb.left + rb.top);
      });
      vis[0].click();
      return 'ok';
    })()`;
    const res = (await page.evaluate(expr)) as string;
    if (res === "ok") return "ok";
    await stagehand.act(
      'click the hamburger menu (three horizontal lines, the "div.burger-menu") in the TOP-LEFT corner, just above the word "Dashboard"',
    );
    return "agent";
  };

  /**
   * ¿El menú quedó abierto? La app NO usa `ion-menu`; al clickear el ☰ el div
   * `.burger-menu` recibe la clase `open` y aparece `article.menu-container` con
   * los items `section.menu-item-container` (Search, Dashboard, Receipts,
   * Invoices, Logout, …). Detectamos por esas señales y devolvemos los textos.
   */
  const readOpenMenu = async (): Promise<{ open: boolean; items: string[] }> => {
    const raw = (await page.evaluate(`(() => {
      const vis = (el) => { const s=getComputedStyle(el), r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
      const T = (el) => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
      const burgerOpen = !!document.querySelector('.burger-menu.open');
      const container = document.querySelector('.menu-container, article.menu-container');
      const containerVisible = !!container && vis(container);
      const itemEls = Array.from(document.querySelectorAll('.menu-item-container')).filter(vis);
      const items = Array.from(new Set(itemEls.map(T).filter(Boolean).map((t) => t.slice(0, 40))));
      return JSON.stringify({
        open: burgerOpen || containerVisible || items.length >= 2,
        items,
      });
    })()`)) as string;
    return JSON.parse(raw) as { open: boolean; items: string[] };
  };

  async function openMenu(): Promise<boolean> {
    // Regla: cuando aparezca el Alert, Cancelar (refresca la página) y reabrir.
    // El Alert es lo ÚNICO que fuerza reintento. Cuando el menú abre sin alerta,
    // terminamos.
    const MAX = 6;
    for (let attempt = 1; attempt <= MAX; attempt++) {
      console.log(`\n→ Abriendo el menú ☰ (arriba-izquierda) (intento ${attempt}/${MAX})…`);

      if (await cancelIfAlert()) {
        console.log("  ↻ El Cancelar refrescó la página; reabro el menú…");
        continue;
      }

      const click = await clickHamburger();
      console.log(`  · click ☰: ${click}`);
      await sleep(1500);

      if (await cancelIfAlert()) {
        console.log("  ↻ El Cancelar refrescó la página; reabro el menú…");
        continue;
      }

      const menu = await readOpenMenu();
      if (menu.open) {
        console.log(`  ✓ Menú abierto sin alertas. Items: ${menu.items.join(" · ") || "(sin items legibles)"}`);
        return true;
      }
      console.log("  ⓘ El menú no parece abierto todavía; reintento…");
    }
    console.log("⚠ No se logró abrir el menú sin alertas tras varios intentos.");
    return false;
  }

  // ======================================================================
  //  Orquestación: SIEMPRE login limpio → abrir menú ☰ → TERMINAR
  // ======================================================================
  await hardLogout();

  // Login SIEMPRE de primero (no confiamos en sesión previa). Reintentamos solo
  // si no llegó al dashboard; doLogin() re-navega a la landing en cada intento.
  const MAX_LOGIN_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.log(
        `\n↻ Login no llegó al dashboard; reintento ${attempt}/${MAX_LOGIN_ATTEMPTS}…`,
      );
    }
    await doLogin();
    if (isOnDashboard()) break;
  }

  runStats.loginOk = isOnDashboard();

  if (!isOnDashboard()) {
    console.log(`\n⚠ Login falló tras ${MAX_LOGIN_ATTEMPTS} intento(s) (URL: ${page.url()}). No abro el menú.`);
    await stagehand.close();
    return;
  }

  const menuOpen = await openMenu();
  runStats.menuOpen = menuOpen;
  console.log(
    menuOpen
      ? "\n✅ Login + menú ☰ abierto."
      : "\n⚠ Login OK pero no pude abrir el menú ☰.",
  );

  // ======================================================================
  //  Paso 3 (opcional, STEPHY_SEARCH=1) — Receipts vía página Search
  //  menú → Search → n8n (NOPs) → buscar cada tracking → write-back Supabase
  // ======================================================================
  if (process.env.STEPHY_SEARCH === "1" && menuOpen) {
    const limit = Number(process.env.STEPHY_SEARCH_LIMIT) || undefined;
    const preview = process.env.STEPHY_PREVIEW === "1";
    runStats.searchRan = true;
    runStats.preview = preview;

    const onSearch = await gotoSearchViaMenu(page);
    if (!onSearch) {
      console.log("⚠ No pude entrar a Search por el menú; salto el paso de receipts.");
    } else {
      // Override de prueba: STEPHY_SEARCH_TRACKINGS="trk1,trk2" salta n8n y busca
      // esos trackings (para validar dónde aparece el receipt con casos conocidos).
      const override = process.env.STEPHY_SEARCH_TRACKINGS?.trim();
      const nopsData = override
        ? {
            total_nops: override.split(",").length,
            nops_detalle: override
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .map((t) => ({ nop: t, id_venta: null, tracking_proveedor: t })),
          }
        : // Dispara n8n DESPUÉS de entrar a Search (como pidió Jaime).
          await runNopsConTracking();
      if (!nopsData) {
        console.log("⚠ Sin NOPs de n8n; no hay nada que buscar.");
      } else {
        const { encontrados, noEncontrados, sessionExpiredCount } =
          await searchAllTrackings(page, nopsData, { limit });
        runStats.encontrados = encontrados.length;
        runStats.noEncontrados = noEncontrados.length;
        runStats.sessionExpired = sessionExpiredCount;

        if (sessionExpiredCount > 0 && encontrados.length === 0) {
          console.log(
            `\n⛔ Todas las búsquedas dieron "Sesión Expirada" (${sessionExpiredCount}). ` +
              "No persisto nada; hay que resolver el permiso/sesión de Search.",
          );
          await finalizeRunHistory(nopsData, encontrados, noEncontrados);
        } else {
          const persistResult = await persistMatches(encontrados, { preview });
          if (persistResult) {
            runStats.detalleActualizados =
              (preview
                ? persistResult.detalle_a_actualizar
                : persistResult.detalle_actualizados) ?? null;
            runStats.gruposActualizados =
              (preview
                ? persistResult.grupos_a_actualizar
                : persistResult.grupos_actualizados) ?? null;
          }
          await finalizeRunHistory(nopsData, encontrados, noEncontrados, persistResult);
        }
      }
    }
  }

  await stagehand.close();
}

/** Timestamp local legible para el asunto/cuerpo del correo. */
function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Arma asunto + cuerpo (resumen arriba + log completo) para el correo. */
function buildEmailContent(): { asunto: string; cuerpo: string } {
  const estado = runStats.error
    ? "❌ ERROR"
    : runStats.loginOk
      ? "✅ OK"
      : "⚠ LOGIN FALLÓ";
  const inicio = fmtLocal(runStats.inicio);
  const fin = fmtLocal(new Date());
  const modo = runStats.preview ? " (PREVIEW)" : "";

  const asunto = `Stephy ${inicio} — ${estado}${modo}`;

  const resumen = [
    `RESUMEN DE LA CORRIDA`,
    `─────────────────────`,
    `Estado:        ${estado}`,
    `Inicio:        ${inicio}`,
    `Fin:           ${fin}`,
    `Login:         ${runStats.loginOk ? "OK" : "NO llegó al dashboard"}`,
    `Menú ☰:        ${runStats.menuOpen ? "abierto" : "no abierto"}`,
    `Búsqueda:      ${
      runStats.searchRan
        ? runStats.preview
          ? "ejecutada (PREVIEW, no escribe)"
          : "ejecutada (escritura real)"
        : "no ejecutada"
    }`,
    `Receipts:      ${runStats.encontrados} encontrado(s), ${runStats.noEncontrados} no encontrado(s)`,
    `Sesión exp.:   ${runStats.sessionExpired}`,
    `Supabase:      ${
      runStats.detalleActualizados === null && runStats.gruposActualizados === null
        ? "sin write-back"
        : `${runStats.detalleActualizados ?? "?"} producto(s), ${runStats.gruposActualizados ?? "?"} grupo(s)`
    }`,
    runStats.error ? `Error:         ${runStats.error.split("\n")[0]}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sep = "=".repeat(60);
  const cuerpo = `${resumen}\n\n${sep}\nLOG COMPLETO DE LA CORRIDA\n${sep}\n\n${getCapturedLog()}`;
  return { asunto, cuerpo };
}

main()
  .then(async () => {
    const { asunto, cuerpo } = buildEmailContent();
    await sendRunLog(asunto, cuerpo);
  })
  .catch(async (err) => {
    runStats.error = (err && (err.stack || err.message)) || String(err);
    console.error("Flujo falló:\n", err);
    const { asunto, cuerpo } = buildEmailContent();
    await sendRunLog(asunto, cuerpo);
    process.exit(1);
  });
