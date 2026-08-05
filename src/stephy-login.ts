import { makeStagehand, resolveStagehandEnv } from "./stagehand.js";
import {
  runNopsConTracking,
  persistMatches,
  finalizeRunHistory,
  type PersistResponse,
} from "./nops-con-tracking.js";
import {
  gotoSearchViaMenu,
  searchAllTrackings,
  type GuardaDStats,
  type SearchBatch,
  type SearchMatch,
} from "./search-receipts.js";
import {
  loadSearchState,
  planIncrementalSearch,
  recordResults,
  saveSearchState,
} from "./search-state.js";
import {
  searchAllConsignees,
  reconOneReceipt,
  type ConsigneeMatch,
} from "./search-consignee.js";
import {
  gotoReceiptsViaMenu,
  gotoReceiptsDirect,
  scrapeReceiptsForConsignees,
} from "./receipts-page.js";
import { installLogCapture, getCapturedLog, sendRunLog } from "./email-log.js";
import { recordRunHealth, type RunReason } from "./run-health.js";
import { getLlmUsage, estimateLlmCostUsd } from "./llm-usage.js";
import { postRunTelemetry, type TelemetryPayload } from "./telemetry.js";
import { hostname } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  incremental: boolean;
  incrementalDue: number | null;
  incrementalSkipped: number | null;
  nopsTotal: number | null;
  runAttempts: number;
  encontrados: number;
  noEncontrados: number;
  sessionExpired: number;
  /**
   * Fase 4.2 — salud de la guarda D′ de esta corrida. `null` si la corrida no
   * llegó a buscar (login falló, corrida de consignatarios): ahí un 0 mentiría,
   * porque no es que no hubo lecturas raras, es que no hubo lecturas.
   */
  guardaD: GuardaDStats | null;
  detalleActualizados: number | string | null;
  gruposActualizados: number | string | null;
  persistFailed: boolean;
  writeBack: unknown;
  error: string | null;
  /**
   * Corrida de MANTENIMIENTO (STEPHY_CONSIGNEE=1): busca consignatarios por
   * receipt, no trackings. No es una corrida de tracking, así que no cuenta como
   * "no-search" (no dispara alarma ni racha) ni se registra en la telemetría de
   * corridas, que mide el pipeline normal.
   */
  consigneeRan: boolean;
  consigneeOk: number;
  consigneeTotal: number;
}

const runStats: RunStats = {
  inicio: new Date(),
  loginOk: false,
  menuOpen: false,
  searchRan: false,
  preview: false,
  incremental: false,
  incrementalDue: null,
  incrementalSkipped: null,
  nopsTotal: null,
  runAttempts: 0,
  encontrados: 0,
  noEncontrados: 0,
  sessionExpired: 0,
  guardaD: null,
  detalleActualizados: null,
  gruposActualizados: null,
  persistFailed: false,
  writeBack: null,
  error: null,
  consigneeRan: false,
  consigneeOk: 0,
  consigneeTotal: 0,
};

/**
 * Items de auditoría de la corrida (1 por tracking buscado), a nivel de MÓDULO
 * como runStats. Se llenan EN CALIENTE conforme llegan los lotes (flushBatch), de
 * modo que si el watchdog (#2) o un corte de CDP matan la corrida a mitad,
 * `finishRun()` (llamado también desde el watchdog) igual puede postear lo que ya
 * se buscó. La telemetría es best-effort y no altera la lógica del pipeline.
 */
const runItems: SearchMatch[] = [];

/** Evita que dos finales (p.ej. watchdog + resolución tardía) posteen dos veces. */
let runFinished = false;

/**
 * Referencia al Stagehand vivo de la corrida actual, a nivel de módulo, para que
 * el watchdog (#2) y el retry de corrida (#3) puedan cerrar el navegador aunque
 * el error ocurra dentro de runOnce(). runOnce() la setea al crear el browser y
 * la limpia en su `finally`.
 */
let activeStagehand: ReturnType<typeof makeStagehand> | null = null;

/**
 * #3 — ¿Es un error de CDP/inicialización que justifica RELANZAR Chrome? Un hipo
 * del socket CDP (close 1006), un `StagehandNotInitializedError` o un "Target
 * closed" tiran toda la corrida sin que el flujo esté realmente roto. Ante estos
 * reintentamos la corrida completa con un navegador nuevo (solo en fase de
 * login/menú; ver main()). Otros errores (lógica, red del webhook) NO se reintentan.
 */
function isFatalBrowserError(msg: string): boolean {
  return /StagehandNotInitialized|not initialized|Target (?:page|closed|crashed)|Target.*closed|Session closed|websocket|socket hang|\bCDP\b|\b1006\b|Connection closed|browser (?:has been|was) closed|Protocol error|Execution context was destroyed/i.test(
    msg,
  );
}

/**
 * #2 — Watchdog anti-cuelgue. Si una corrida supera STEPHY_WATCHDOG_MS (default
 * 60 min) — típicamente porque Chrome se trabó y el proceso quedó vivo bloqueando
 * el perfil — forzamos cierre del navegador, mandamos el log por correo y salimos
 * con exit(1) para que la siguiente corrida del cron encuentre el perfil libre.
 *
 * OJO: una corrida COMPLETA (190 trackings, uno por uno) tarda ~40-47 min, así que
 * el default DEBE ser mayor. Con 30 min el watchdog mataba la corrida a mitad, ANTES
 * de persistir en Supabase (el write-back ocurre al terminar el loop) → se perdía todo
 * lo hallado. Bajar solo cuando #4 (búsqueda incremental) recorte la duración real.
 */
const WATCHDOG_MS = Number(process.env.STEPHY_WATCHDOG_MS) || 60 * 60_000;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function armWatchdog(): void {
  watchdogTimer = setTimeout(async () => {
    const mins = Math.round(WATCHDOG_MS / 60_000);
    console.error(
      `\n⏱ WATCHDOG: la corrida superó ${mins} min sin terminar. Fuerzo cierre y salgo.`,
    );
    runStats.error = runStats.error ?? `Watchdog: timeout tras ${mins} min sin terminar la corrida`;
    try {
      await activeStagehand?.close();
    } catch {
      /* best-effort: el navegador ya podía estar muerto */
    }
    // Cierre único: correo + telemetría (registra el CUELGUE, que es el error más
    // importante de trazar y antes NO quedaba en BD).
    await finishRun({ exitCode: 1, watchdog: true });
    process.exit(1);
  }, WATCHDOG_MS);
  // No mantener vivo el event loop solo por el watchdog: si todo termina antes,
  // el proceso puede salir sin esperar a este timer.
  watchdogTimer.unref?.();
}

function disarmWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

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

/**
 * Una corrida completa con SU PROPIO navegador. Crea Stagehand, ejecuta el flujo
 * (login → menú → receipts) y cierra el navegador al terminar bien. Si algo
 * revienta, propaga el error SIN cerrar aquí: main() cierra `activeStagehand` y
 * decide si relanzar Chrome (#3).
 */
async function runOnce() {
  // Se marca ANTES de nada: si se marcara dentro del paso de consignatarios, un
  // login fallido nunca llegaría a marcarlo y la corrida se registraría como una
  // corrida de tracking (ensuciando corridas_tracking_stephy y la racha #11).
  runStats.consigneeRan = process.env.STEPHY_CONSIGNEE === "1";
  const env = resolveStagehandEnv();
  const stagehand = makeStagehand({ env, headless: false });
  activeStagehand = stagehand;
  await stagehand.init();

  type AnyPage = ReturnType<typeof stagehand.context.pages>[number];
  const page: AnyPage =
    stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  // ======================================================================
  //  Helpers (closures sobre `page` / `stagehand`)
  // ======================================================================

  /**
   * #2-hardening (endurecer login) — `stagehand.act()` envuelto en try/catch.
   * Los act() de fallback dependen del LLM, que a veces devuelve salida
   * estructurada inválida/truncada (ej. `{"`) → `AI_NoObjectGeneratedError`.
   * DESNUDO, ese error no lo captura nadie y mata el proceso ENTERO a mitad de
   * corrida (fue el culpable de corridas caídas el 2026-07-14). Aquí lo tragamos
   * y devolvemos `false`: como cada bloque ya tiene su gate por URL (/login,
   * /login/a, isOnDashboard) o su `res!=='ok'`, un act() fallido deja que el gate
   * aborte limpio o que el loop reintente. OJO: los errores REALES de
   * CDP/navegador (isFatalBrowserError) SÍ se relanzan — deben propagar para el
   * retry de corrida (#3); no los tragamos.
   */
  const safeAct = async (instruction: string): Promise<boolean> => {
    try {
      await stagehand.act(instruction);
      return true;
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      if (isFatalBrowserError(msg)) throw err; // CDP/browser real → lo maneja #3
      console.log(`  ⚠ act() falló (ignorado): ${msg.split("\n")[0]}`);
      return false;
    }
  };

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

  /**
   * Click DETERMINISTA en la tarjeta de la compañía por DOM (sin LLM). Busca el
   * elemento VISIBLE más específico (texto corto) que contenga el nombre de la
   * compañía, y clickea su ancestro clickeable (ion-card / item / card). Devuelve
   * "ok" | "no-target". El LLM queda solo como fallback en doLogin().
   */
  const clickCompanyCardDom = async (company: string): Promise<string> => {
    const expr = `(() => {
      const want = ${JSON.stringify(company.toUpperCase())};
      const vis = (el) => { const s=getComputedStyle(el), r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0; };
      const T = (el) => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();
      const all = Array.from(document.querySelectorAll(
        'ion-card, ion-item, .card, [class*="card" i], [class*="company" i], [class*="result" i], li, a, button, div'
      ));
      const cands = all.filter((el) => {
        if (!vis(el)) return false;
        if (/^(input|textarea)$/i.test(el.tagName)) return false;
        const t = T(el).toUpperCase();
        return t.includes(want) && t.length < 120; // evita contenedores gigantes
      });
      if (!cands.length) return 'no-target';
      cands.sort((a, b) => T(a).length - T(b).length); // el más específico primero
      const target = cands[0];
      const clickable = target.closest(
        'ion-card, ion-item, a, button, [role=button], [class*="card" i]'
      ) || target;
      clickable.click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  /** Abre el ion-select del rol (formcontrolname="type"). "ok" | "no-select". */
  const openRoleSelectDom = async (): Promise<string> => {
    const expr = `(() => {
      const sel = document.querySelector('ion-select[formcontrolname="type"]') ||
                  document.querySelector('ion-select');
      if (!sel) return 'no-select';
      sel.click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  /** En el ion-alert del rol, click en el radio cuyo texto contiene `role`. */
  const pickRoleInAlertDom = async (role: string): Promise<string> => {
    const expr = `(() => {
      const al = document.querySelector('ion-alert');
      if (!al) return 'no-alert';
      const want = ${JSON.stringify(role.toUpperCase())};
      const T = (el) => (el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().toUpperCase();
      const radios = Array.from(al.querySelectorAll('button.alert-radio-button, [role=radio]'));
      const target = radios.find((r) => T(r).includes(want));
      if (!target) return 'no-option';
      target.click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

  /** Click en el botón OK/Aceptar del ion-alert (evita CANCELAR). */
  const clickAlertOkDom = async (): Promise<string> => {
    const expr = `(() => {
      const al = document.querySelector('ion-alert');
      if (!al) return 'no-alert';
      const T = (el) => (el.innerText||el.textContent||el.value||'').replace(/\\s+/g,' ').trim().toUpperCase();
      const btns = Array.from(al.querySelectorAll('button.alert-button, .alert-button-group button, button'));
      const ok = btns.find((b) => { const t = T(b);
        return (t === 'OK' || t.includes('ACEPT') || t === 'ACCEPT') && !t.includes('CANCEL'); });
      const target = ok || btns.find((b) => !T(b).includes('CANCEL'));
      if (!target) return 'no-ok';
      target.click();
      return 'ok';
    })()`;
    return (await page.evaluate(expr)) as string;
  };

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
    // Log del TEXTO: si el alert se repite y bloquea el menú, sin esto no hay
    // forma de saber cuál es sin volver a explorar a ciegas.
    const texto = (await page
      .evaluate(
        `(() => { const a = document.querySelector('ion-alert');
          return a ? (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : ''; })()`,
      )
      .catch(() => "")) as string;
    console.log(`  ⚠ Alert detectado → Cancelar. Texto: "${texto}"`);
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
      await safeAct(`type "${COMPANY}" into the company search box`);
    }
    await page.keyPress("Enter");
    await sleep(2000);

    // 1b. Click en la tarjeta de la compañía. DOM-first (determinista); el
    //     agente (LLM) queda solo como fallback. Gate: verificamos que la URL
    //     avanzó a /login/* — si seguimos en la landing, NO tiene sentido
    //     continuar (es el caso que rompía la corrida al llegar a llenar campos
    //     que aún no existen).
    console.log(`→ Seleccionando la compañía "${COMPANY}"…`);
    const companyDom = await clickCompanyCardDom(COMPANY);
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(2000);
    if (!/\/login/i.test(page.url())) {
      console.log(
        `  ↻ Tarjeta por DOM no avanzó (res=${companyDom}, URL=${page.url()}); uso el agente…`,
      );
      await safeAct(
        `click the "${COMPANY}" (Tecnoship Group) company result card`,
      );
      await page.waitForLoadState("networkidle").catch(() => {});
      await sleep(2500);
    } else {
      console.log(`  ✓ Compañía seleccionada por DOM (${page.url()}).`);
    }
    if (!/\/login/i.test(page.url())) {
      console.log(
        `⚠ No se llegó a la pantalla de login (URL: ${page.url()}). Aborto este intento de login.`,
      );
      return;
    }

    // 1c. Cambiar rol Consignatario → Agente PRIMERO (define la URL + re-render).
    //     DOM-first (ion-select → ion-alert → radio → OK), determinista. Si el
    //     DOM no confirma /login/a, caemos al agente (LLM) en el mismo intento.
    //     Confirmamos SIEMPRE por URL (/login/a) porque los act() fallan en silencio.
    console.log(`→ Cambiando el rol a "${ROLE}"…`);
    for (let roleTry = 1; roleTry <= 3; roleTry++) {
      // --- Intento por DOM ---
      const open = await openRoleSelectDom();
      let pick = "skip";
      let ok = "skip";
      if (open === "ok") {
        for (let i = 0; i < 8; i++) {
          if (await isAlertVisible()) break;
          await sleep(300);
        }
        pick = await pickRoleInAlertDom(ROLE);
        await sleep(300);
        ok = await clickAlertOkDom();
        await page.waitForLoadState("networkidle").catch(() => {});
        await sleep(1200);
      }
      if (/\/login\/a/i.test(page.url())) {
        console.log(`  ✓ Rol por DOM (open=${open}, pick=${pick}, ok=${ok}).`);
        break;
      }

      // --- Fallback al agente (LLM) si el DOM no confirmó ---
      console.log(
        `  ↻ Rol por DOM no confirmó (open=${open}, pick=${pick}, ok=${ok}); pruebo el agente…`,
      );
      await safeAct(
        'click the role dropdown that currently shows "Consignatario"',
      );
      await sleep(1000);
      await safeAct(`select the "${ROLE}" option in the role dialog`);
      await sleep(500);
      await safeAct("click the OK button in the dialog");
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
        await safeAct(
          `type "${user}" into the "Número de Cuenta" account field`,
        );
      if (passRes !== "ok")
        await safeAct(
          "type the password into the Contraseña password field",
        );
    }

    // 1e. Esperar 1s y presionar ENTRAR.
    await sleep(1000);
    console.log("→ Iniciando sesión (ENTRAR)…");
    const entrarRes = await clickVisibleButton("ENTRAR");
    if (entrarRes !== "ok") {
      console.log("⚠ No hallé el botón ENTRAR visible; uso el agente…");
      await safeAct("click the ENTRAR login button");
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
    await safeAct(
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
  //  Paso 1-bis — Login MANUAL (STEPHY_MANUAL_LOGIN=1)
  // ======================================================================
  /**
   * Modo asistido: el script NO loguea. Abre la landing, tú haces el login a
   * mano en la ventana de Chrome, y el flujo se queda esperando (polling de la
   * URL) hasta detectar /dashboard. En cuanto lo detecta, sigue solo (menú →
   * Search → receipts). Timeout configurable con STEPHY_MANUAL_TIMEOUT_MS
   * (default 5 min).
   */
  async function waitForManualLogin(): Promise<void> {
    const timeoutMs = Number(process.env.STEPHY_MANUAL_TIMEOUT_MS) || 5 * 60_000;
    console.log(`\n→ Abriendo ${STEPHY_URL} para login MANUAL…`);
    await page.goto(STEPHY_URL).catch(() => {});
    console.log(
      "\n🖐  LOGIN MANUAL: inicia sesión tú mismo en la ventana de Chrome.\n" +
        "    El flujo continuará automáticamente en cuanto detecte el dashboard.\n" +
        `    (esperando hasta ${Math.round(timeoutMs / 1000)}s)…\n`,
    );
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (isOnDashboard()) {
        console.log(`\n✓ Dashboard detectado: ${page.url()}`);
        return;
      }
      await sleep(1500);
    }
    console.log(
      `\n⚠ Se agotó el tiempo de espera del login manual (URL actual: ${page.url()}).`,
    );
  }

  // ======================================================================
  //  Orquestación: login (manual o automático) → abrir menú ☰ → receipts
  // ======================================================================
  const MANUAL_LOGIN = process.env.STEPHY_MANUAL_LOGIN === "1";

  if (MANUAL_LOGIN) {
    await waitForManualLogin();
  } else {
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
  }

  runStats.loginOk = isOnDashboard();

  if (!isOnDashboard()) {
    console.log(
      MANUAL_LOGIN
        ? `\n⚠ Login manual no llegó al dashboard a tiempo (URL: ${page.url()}). No abro el menú.`
        : `\n⚠ Login falló tras varios intentos (URL: ${page.url()}). No abro el menú.`,
    );
    await stagehand.close();
    activeStagehand = null;
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
        // Telemetría: NOPs con tracking que devolvió n8n (universo considerado).
        runStats.nopsTotal = Array.isArray(nopsData.nops_detalle)
          ? nopsData.nops_detalle.length
          : (nopsData.total_nops ?? null);
        // #4 — Búsqueda incremental: no re-buscar cada corrida los ~145
        // trackings sin receipt. Filtra a los NUEVOS + los que vencieron su
        // backoff, y depura del estado los que n8n ya no devuelve (encontraron
        // receipt). Se desactiva con STEPHY_INCREMENTAL=0 o con el override de
        // trackings de prueba (que fuerza buscar exactamente esos).
        const incremental =
          process.env.STEPHY_INCREMENTAL !== "0" && !override;
        runStats.incremental = incremental;
        let toSearch = nopsData;
        const state = incremental ? await loadSearchState() : null;
        if (incremental && state) {
          const plan = planIncrementalSearch(nopsData, state);
          runStats.incrementalDue = plan.dueDetalle.length;
          runStats.incrementalSkipped = plan.skipped;
          console.log(
            `\n→ [incremental] De ${plan.considered} NOPs de n8n: ` +
              `${plan.dueDetalle.length} por buscar (nuevos o backoff vencido), ` +
              `${plan.skipped} en backoff, ${plan.pruned} depurado(s) del estado.`,
          );
          toSearch = { ...nopsData, nops_detalle: plan.dueDetalle };
        }

        // --- Persistencia INCREMENTAL (durabilidad ante cortes) --------------
        // El write-back a Supabase y el guardado del estado incremental ya NO
        // corren solo al final del loop: `searchAllTrackings` nos entrega lotes
        // conforme avanza (onBatch) y los persistimos EN CALIENTE. Así, si el
        // watchdog (#2) o un corte de CDP (#3) matan la corrida a mitad, lo
        // hallado hasta ese punto YA quedó escrito en Supabase y con su backoff
        // registrado, en vez de perderse. `persistMatches` y el webhook son
        // idempotentes; cada tracking llega en UN solo lote → sin doble conteo.
        const toNum = (v: unknown): number => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        let persistAttempted = false; // ¿hubo algún receipt que persistir?
        let persistFailed = false; // ¿algún lote falló el POST a Supabase?
        let detalleSum = 0;
        let gruposSum = 0;
        const persistResponses: unknown[] = [];

        const flushBatch = async (batch: SearchBatch): Promise<void> => {
          // 1. Persistir los receipts hallados del lote cuanto antes.
          let batchPersisted = false;
          if (batch.encontrados.length > 0) {
            persistAttempted = true;
            const pr = await persistMatches(batch.encontrados, { preview });
            if (pr) {
              persistResponses.push(pr);
              detalleSum += toNum(
                preview ? pr.detalle_a_actualizar : pr.detalle_actualizados,
              );
              gruposSum += toNum(
                preview ? pr.grupos_a_actualizar : pr.grupos_actualizados,
              );
              // En preview NO se escribió nada (dry-run); solo cuenta como
              // persistido cuando fue escritura real y el POST tuvo éxito.
              batchPersisted = !preview;
            } else {
              persistFailed = true;
            }
          }
          // 2. Telemetría EN CALIENTE: registrar los items del lote (marcando si
          //    el receipt quedó escrito en Supabase). Se acumulan aunque el
          //    watchdog mate la corrida después.
          for (const m of batch.encontrados) runItems.push({ ...m, persistido_db: batchPersisted });
          for (const m of batch.noEncontrados) runItems.push({ ...m, persistido_db: false });
          // 3. Registrar el lote en el estado incremental y guardarlo en disco.
          //    Los "sesión expirada" no penalizan backoff (lo maneja recordResults).
          if (incremental && state) {
            recordResults(state, batch);
            await saveSearchState(state);
          }
        };

        const { encontrados, noEncontrados, sessionExpiredCount, guardaD } =
          await searchAllTrackings(page, toSearch, { limit, onBatch: flushBatch });
        runStats.encontrados = encontrados.length;
        runStats.noEncontrados = noEncontrados.length;
        runStats.sessionExpired = sessionExpiredCount;
        runStats.guardaD = guardaD;
        runStats.persistFailed = persistFailed;

        // Caso "todo sesión expirada" (0 hallados, nada persistido): sin archivo
        // supabase en el histórico (como antes). En cualquier otro caso dejamos el
        // 4º archivo con las sumas de los lotes (aunque sean 0).
        const allSessionExpired =
          sessionExpiredCount > 0 && encontrados.length === 0 && !persistAttempted;
        if (allSessionExpired) {
          console.log(
            `\n⛔ Todas las búsquedas dieron "Sesión Expirada" (${sessionExpiredCount}). ` +
              "No se persistió nada; hay que resolver el permiso/sesión de Search.",
          );
          await finalizeRunHistory(toSearch, encontrados, noEncontrados);
        } else {
          runStats.detalleActualizados = detalleSum;
          runStats.gruposActualizados = gruposSum;
          const merged: PersistResponse = preview
            ? {
                preview: true,
                detalle_a_actualizar: detalleSum,
                grupos_a_actualizar: gruposSum,
                batches: persistResponses,
              }
            : {
                detalle_actualizados: detalleSum,
                grupos_actualizados: gruposSum,
                batches: persistResponses,
              };
          if (persistFailed) merged.persist_failed = true;
          runStats.writeBack = merged; // para la telemetría (payload crudo)
          await finalizeRunHistory(toSearch, encontrados, noEncontrados, merged);
        }
      }
    }
  }

  // ======================================================================
  //  Paso 3-bis (STEPHY_CONSIGNEE=1) — Consignatario POR RECEIPT
  //  Búsqueda inversa para curar los recibos que quedaron pegados a varios
  //  clientes. NO escribe en Supabase: deja un JSON+CSV para revisar y decidir.
  //  Lista de receipts: STEPHY_CONSIGNEE_RECEIPTS="1,2,3" o
  //  STEPHY_CONSIGNEE_FILE=<ruta> (JSON array, o texto con uno por línea).
  // ======================================================================
  if (process.env.STEPHY_CONSIGNEE === "1" && runStats.loginOk) {
    const receipts = await loadConsigneeReceipts();
    // Vía RECEIPTS (default): la lista trae el consignatario en cada fila, así que
    // una pasada resuelve todos. En /search el resultado solo muestra "Box N / M"
    // (verificado con RECON: el body no trae nada más y la caja no es clickeable),
    // por eso esa vía queda solo como fallback con STEPHY_CONSIGNEE_VIA=search.
    const via = (process.env.STEPHY_CONSIGNEE_VIA ?? "receipts").toLowerCase();
    if (via === "receipts") {
      // El menú ☰ queda atrapado a veces en un bucle de alertas (Cancelar
      // refresca y el alert vuelve). Si no abrió, se intenta la URL directa,
      // que verifica que la tabla exista antes de dar por buena la navegación.
      const enReceipts =
        (menuOpen && (await gotoReceiptsViaMenu(page))) ||
        (await gotoReceiptsDirect(page, `${ORIGIN}/${COMPANY}/1/receipts`));
      if (!receipts.length) {
        console.log("⚠ Sin receipts que buscar. Pasa STEPHY_CONSIGNEE_RECEIPTS o STEPHY_CONSIGNEE_FILE.");
      } else if (!enReceipts) {
        console.log("⚠ No pude entrar a Receipts (ni por menú ni directo); salto el paso.");
      } else {
        const { mapa } = await scrapeReceiptsForConsignees(page, receipts);
        const resultados: ConsigneeMatch[] = receipts.map((receipt) => {
          const hit = mapa.get(receipt.trim());
          return hit
            ? {
                receipt,
                consignee: hit.consignee,
                n_consignatario: hit.n_consignatario,
                resultado: "encontrado" as const,
              }
            : {
                receipt,
                resultado: "no_encontrado" as const,
                motivo: "no apareció en la lista de Receipts",
              };
        });
        runStats.consigneeTotal = resultados.length;
        runStats.consigneeOk = resultados.filter((r) => r.resultado === "encontrado").length;
        const dataDir = join(PROJECT_ROOT, "data");
        const stamp = fmtLocal(new Date()).replace(/[: ]/g, "-").slice(0, 19);
        await mkdir(dataDir, { recursive: true });
        const outJson = join(dataDir, `consignee-${stamp}.json`);
        const outCsv = join(dataDir, `consignee-${stamp}.csv`);
        await writeFile(
          outJson,
          JSON.stringify({ generado_en: new Date().toISOString(), via: "receipts", total: resultados.length, resultados }, null, 2),
          "utf8",
        );
        await writeFile(
          outCsv,
          [
            "receipt;n_consignatario;consignee;resultado;motivo",
            ...resultados.map((r) =>
              [r.receipt, r.n_consignatario ?? "", (r.consignee ?? "").replace(/;/g, ","), r.resultado, r.motivo ?? ""].join(";"),
            ),
          ].join("\n"),
          "utf8",
        );
        console.log(
          `\n  ✓ [consignee] ${runStats.consigneeOk}/${runStats.consigneeTotal} resueltos.` +
            `\n  💾 ${outJson}\n     ${outCsv}`,
        );
      }
    } else if (!(await gotoSearchViaMenu(page))) {
      console.log("⚠ No pude entrar a Search por el menú; salto el paso de consignatarios.");
    } else {
      if (!receipts.length) {
        console.log(
          "⚠ Sin receipts que buscar. Pasa STEPHY_CONSIGNEE_RECEIPTS o STEPHY_CONSIGNEE_FILE.",
        );
      } else if (process.env.STEPHY_CONSIGNEE_RECON === "1") {
        // Reconocimiento: vuelca la estructura del resultado de 2 receipts para
        // calibrar dónde vive el consignatario. No produce CSV.
        for (const r of receipts.slice(0, 2)) await reconOneReceipt(page, r);
      } else {
        const limit = Number(process.env.STEPHY_SEARCH_LIMIT) || undefined;
        const dataDir = join(PROJECT_ROOT, "data");
        const stamp = fmtLocal(new Date()).replace(/[: ]/g, "-").slice(0, 19);
        const outJson = join(dataDir, `consignee-${stamp}.json`);
        const outCsv = join(dataDir, `consignee-${stamp}.csv`);
        await mkdir(dataDir, { recursive: true });

        // Guardado EN CALIENTE por lote: si la corrida muere a mitad, lo ya
        // resuelto queda en disco (mismo criterio que la búsqueda de receipts).
        const acumulado: ConsigneeMatch[] = [];
        const dump = async () => {
          await writeFile(
            outJson,
            JSON.stringify({ generado_en: new Date().toISOString(), total: acumulado.length, resultados: acumulado }, null, 2),
            "utf8",
          );
          const filas = acumulado.map((r) =>
            [r.receipt, r.n_consignatario ?? "", (r.consignee ?? "").replace(/;/g, ","), r.resultado, r.motivo ?? ""].join(";"),
          );
          await writeFile(
            outCsv,
            ["receipt;n_consignatario;consignee;resultado;motivo", ...filas].join("\n"),
            "utf8",
          );
        };

        const { resultados, sessionExpiredCount } = await searchAllConsignees(page, receipts, {
          limit,
          onBatch: async (batch) => {
            acumulado.push(...batch);
            await dump();
          },
        });
        if (acumulado.length === 0 && resultados.length) {
          acumulado.push(...resultados);
          await dump();
        }
        runStats.consigneeTotal = resultados.length;
        runStats.consigneeOk = resultados.filter((r) => r.resultado === "encontrado").length;

        console.log(`\n  💾 Consignatarios guardados en:\n     ${outJson}\n     ${outCsv}`);
        if (sessionExpiredCount > 0) {
          console.log(
            `  ⚠ ${sessionExpiredCount} búsqueda(s) dieron "Sesión Expirada"; ` +
              "conviene repetir esas antes de decidir la limpieza.",
          );
        }
      }
    }
  }

  await stagehand.close();
  activeStagehand = null;
}

/**
 * Lee la lista de receipts a consultar: variable con lista separada por comas, o
 * archivo (JSON array de strings/objetos con `receipt`, o texto con uno por línea).
 */
async function loadConsigneeReceipts(): Promise<string[]> {
  const inline = process.env.STEPHY_CONSIGNEE_RECEIPTS?.trim();
  if (inline) return inline.split(",").map((s) => s.trim()).filter(Boolean);

  const file = process.env.STEPHY_CONSIGNEE_FILE?.trim();
  if (!file) return [];
  const raw = await readFile(file, "utf8").catch((err) => {
    console.log(`⚠ No pude leer ${file}: ${(err as Error).message}`);
    return "";
  });
  if (!raw.trim()) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    const arr = Array.isArray(j) ? j : [];
    return arr
      .map((x) => (typeof x === "string" ? x : String((x as { receipt?: unknown }).receipt ?? "")))
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // No es JSON: uno por línea.
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
}

/**
 * Orquesta las corridas: intenta runOnce() y, si muere con un error de
 * CDP/inicialización (#3) ANTES de que arranque la búsqueda, relanza Chrome desde
 * cero. No reintentamos una vez que la búsqueda empezó: re-buscar ~140 trackings
 * sería lento y dispararía el watchdog; además el write-back ya es idempotente.
 */
async function main() {
  const MAX_RUN_ATTEMPTS = Number(process.env.STEPHY_RUN_ATTEMPTS) || 2;
  for (let runTry = 1; runTry <= MAX_RUN_ATTEMPTS; runTry++) {
    runStats.runAttempts = runTry;
    try {
      await runOnce();
      return;
    } catch (err) {
      const e = err as Error | undefined;
      const msg: string = (e && (e.stack || e.message)) || String(err);
      // Cerrar el navegador muerto antes de decidir (best-effort).
      try {
        await activeStagehand?.close();
      } catch {
        /* ya estaba caído */
      }
      activeStagehand = null;

      const fatal = isFatalBrowserError(msg);
      const canRetry = fatal && !runStats.searchRan && runTry < MAX_RUN_ATTEMPTS;
      if (!canRetry) throw err;

      console.error(
        `\n↻ Corrida abortó por error de CDP/inicialización (intento ${runTry}/${MAX_RUN_ATTEMPTS}). ` +
          `Relanzo Chrome…\n   ${msg.split("\n")[0]}`,
      );
      // Resetear las banderas de fase; runStats.inicio se conserva (mide el total).
      runStats.loginOk = false;
      runStats.menuOpen = false;
      await sleep(3000);
    }
  }
}

/** Timestamp local legible para el asunto/cuerpo del correo. */
function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Escapa texto para incrustarlo seguro en el HTML del correo. */
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Clasifica la corrida para el historial de salud (#11). Sana = completó login +
 * búsqueda sin error. NO se cuenta "0 receipts" como fallo (con incremental es lo
 * normal). El orden importa: `error` cubre también el watchdog (setea runStats.error).
 */
function classifyRun(): { ok: boolean; reason: RunReason } {
  if (runStats.error) return { ok: false, reason: "error" };
  if (!runStats.loginOk) return { ok: false, reason: "login-failed" };
  // La corrida de consignatarios no busca trackings a propósito: "no-search" ahí
  // sería un falso fallo (correo de alarma + racha #11 contaminada).
  if (runStats.consigneeRan) return { ok: true, reason: "ok" };
  if (!runStats.searchRan) return { ok: false, reason: "no-search" };
  return { ok: true, reason: "ok" };
}

/**
 * Fase 4.2 — ¿hay que mirar esta corrida por el bug de recibos cruzados?
 *
 * Las tres señales son de VIGILANCIA, no de fallo: con la guarda D′ un receipt
 * solo se acepta si correlaciona con su propia petición, así que ninguna de estas
 * implica un dato malo escrito. Lo que implican es que el terreno donde vivía el
 * bug se movió — lecturas demasiado rápidas, el DOM discrepando de la red, o
 * búsquedas que se quedaron sin respuesta propia. Si esto se despierta, toca
 * abrir el log antes de que vuelva a haber pares cruzados.
 */
function guardaDAlerta(g: GuardaDStats | null): boolean {
  if (!g) return false;
  return g.sinRespuesta > 0 || g.sospechosos > 0 || g.rapidas > 0;
}

/**
 * Arma asunto + cuerpo (resumen arriba + log completo) para el correo. Async
 * porque además registra la salud de la corrida (#11) y, si hay racha de fallos,
 * escala el asunto. Se llama EXACTAMENTE una vez por corrida (una sola de las
 * ramas .then/.catch/watchdog dispara), así que registra un único resultado.
 */
async function buildEmailContent(): Promise<{
  asunto: string;
  cuerpo: string;
  html: string;
}> {
  const estado = runStats.error
    ? "❌ ERROR"
    : runStats.loginOk
      ? "✅ OK"
      : "⚠ LOGIN FALLÓ";
  const inicio = fmtLocal(runStats.inicio);
  const fin = fmtLocal(new Date());
  const modo = runStats.preview ? " (PREVIEW)" : "";

  // #11 — Las PREVIEW (dry-run manual) no reflejan la salud del cron: no se
  // registran ni escalan. Para las reales, registramos el resultado y miramos la
  // racha de fallos consecutivos. Best-effort: si falla, seguimos sin alerta.
  let health: Awaited<ReturnType<typeof recordRunHealth>> | null = null;
  if (!runStats.preview) {
    try {
      health = await recordRunHealth(classifyRun());
    } catch {
      /* nunca bloquear el correo por el historial de salud */
    }
  }

  let asunto = `Stephy ${inicio} — ${estado}${modo}`;
  if (health?.alert) {
    // Prefijo prominente al INICIO para que salte y ordene primero en la bandeja.
    asunto = `🚨 [STEPHY ${health.streak}× SIN COMPLETAR] ${asunto}`;
  }

  const resumen = [
    `RESUMEN DE LA CORRIDA`,
    `─────────────────────`,
    `Estado:        ${estado}`,
    `Inicio:        ${inicio}`,
    `Fin:           ${fin}`,
    `Login:         ${runStats.loginOk ? "OK" : "NO llegó al dashboard"}`,
    `Menú ☰:        ${runStats.menuOpen ? "abierto" : "no abierto"}`,
    `Búsqueda:      ${
      runStats.consigneeRan
        ? "N/A — corrida de CONSIGNATARIOS (mantenimiento, no escribe)"
        : runStats.searchRan
          ? runStats.preview
            ? "ejecutada (PREVIEW, no escribe)"
            : "ejecutada (escritura real)"
          : "no ejecutada"
    }`,
    runStats.consigneeRan
      ? `Consignatarios: ${runStats.consigneeOk}/${runStats.consigneeTotal} receipt(s) resueltos`
      : null,
    runStats.searchRan && runStats.incremental
      ? `Incremental:   ${runStats.incrementalDue ?? "?"} buscado(s), ${runStats.incrementalSkipped ?? "?"} en backoff`
      : null,
    `Receipts:      ${runStats.encontrados} encontrado(s), ${runStats.noEncontrados} no encontrado(s)`,
    `Sesión exp.:   ${runStats.sessionExpired}`,
    // Fase 4.2 — salud del lector. Se muestra siempre que haya habido búsqueda:
    // un "0 · 0 · 0" es la buena noticia, y verlo confirma que se midió.
    runStats.guardaD
      ? `Guarda D′:     ${runStats.guardaD.sinRespuesta} sin respuesta propia · ` +
        `${runStats.guardaD.sospechosos} con el DOM discrepando · ` +
        `${runStats.guardaD.rapidas} leído(s) en <900ms · ` +
        `${runStats.guardaD.preAlertas} pre-alerta(s)`
      : null,
    guardaDAlerta(runStats.guardaD)
      ? `               ⚠ señales del bug de recibos cruzados — revisar el log`
      : null,
    `Supabase:      ${
      runStats.detalleActualizados === null && runStats.gruposActualizados === null
        ? "sin write-back"
        : `${runStats.detalleActualizados ?? "?"} producto(s), ${runStats.gruposActualizados ?? "?"} grupo(s)`
    }`,
    runStats.error ? `Error:         ${runStats.error.split("\n")[0]}` : null,
    health && health.streak > 0
      ? `Racha fallos:  ${health.streak} corrida(s) seguida(s) sin completar` +
        ` (umbral ${health.threshold}${health.alert ? " — 🚨 ALERTA" : ""})`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const sep = "=".repeat(60);
  const cuerpo = `${resumen}\n\n${sep}\nLOG COMPLETO DE LA CORRIDA\n${sep}\n\n${getCapturedLog()}`;

  const html = buildEmailHtml({ estado, inicio, fin, health });
  return { asunto, cuerpo, html };
}

/**
 * Arma la versión HTML amigable del correo (misma info que `resumen`, pero con
 * encabezado a color según estado, tarjeta de métricas y el log completo abajo).
 * Estilo alineado a los correos de stagehand-amazon / stagehand-audit-amazon:
 * HTML autocontenido con estilos inline (Gmail ignora <style>), tablas para el
 * layout y un pie "MamaSAN · … · generado". El nodo Gmail lo envía como HTML.
 */
function buildEmailHtml(ctx: {
  estado: string;
  inicio: string;
  fin: string;
  health: Awaited<ReturnType<typeof recordRunHealth>> | null;
}): string {
  const { estado, inicio, fin, health } = ctx;

  // Paleta según resultado: verde OK · ámbar login-falló · rojo error.
  const kind: "ok" | "warn" | "error" = runStats.error
    ? "error"
    : runStats.loginOk
      ? "ok"
      : "warn";
  const theme = {
    ok: { accent: "#16a34a", bg: "#ecfdf5", emoji: "✅", label: "OK" },
    warn: { accent: "#d97706", bg: "#fffbeb", emoji: "⚠️", label: "LOGIN FALLÓ" },
    error: { accent: "#dc2626", bg: "#fef2f2", emoji: "❌", label: "ERROR" },
  }[kind];

  // Filas de la tarjeta de métricas (label → valor). Se omiten las condicionales
  // que no aplican, igual que en el resumen de texto plano.
  const busqueda = runStats.searchRan
    ? runStats.preview
      ? "ejecutada (PREVIEW, no escribe)"
      : "ejecutada (escritura real)"
    : "no ejecutada";
  const supabase =
    runStats.detalleActualizados === null && runStats.gruposActualizados === null
      ? "sin write-back"
      : `${runStats.detalleActualizados ?? "?"} producto(s), ${runStats.gruposActualizados ?? "?"} grupo(s)`;

  const rows: Array<[string, string]> = [
    ["Inicio", inicio],
    ["Fin", fin],
    ["Login", runStats.loginOk ? "OK" : "NO llegó al dashboard"],
    ["Menú ☰", runStats.menuOpen ? "abierto" : "no abierto"],
    ["Búsqueda", busqueda],
  ];
  if (runStats.searchRan && runStats.incremental) {
    rows.push([
      "Incremental",
      `${runStats.incrementalDue ?? "?"} buscado(s), ${runStats.incrementalSkipped ?? "?"} en backoff`,
    ]);
  }
  rows.push(["Sesión expirada", String(runStats.sessionExpired)]);
  if (runStats.guardaD) {
    rows.push([
      "Guarda D′",
      `${runStats.guardaD.sinRespuesta} sin respuesta propia · ` +
        `${runStats.guardaD.sospechosos} con el DOM discrepando · ` +
        `${runStats.guardaD.rapidas} leído(s) en <900ms · ` +
        `${runStats.guardaD.preAlertas} pre-alerta(s)`,
    ]);
  }
  rows.push(["Supabase", supabase]);
  if (health && health.streak > 0) {
    rows.push([
      "Racha fallos",
      `${health.streak} seguida(s) sin completar (umbral ${health.threshold})`,
    ]);
  }

  const rowsHtml = rows
    .map(
      ([k, v], i) =>
        `<tr style="background:${i % 2 ? "#ffffff" : "#f8fafc"}">` +
        `<td style="padding:8px 14px;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
        `<td style="padding:8px 14px;color:#0f172a">${esc(v)}</td></tr>`,
    )
    .join("");

  // Chips de receipts: encontrados (color del estado) vs no encontrados (gris).
  const chip = (n: number | string, txt: string, color: string, bg: string) =>
    `<td style="padding:0 6px"><div style="background:${bg};border-radius:10px;padding:12px 16px;text-align:center">` +
    `<div style="font-size:26px;font-weight:700;color:${color};line-height:1">${esc(n)}</div>` +
    `<div style="font-size:12px;color:#64748b;margin-top:4px">${esc(txt)}</div></div></td>`;

  const alertBanner = health?.alert
    ? `<tr><td style="padding:14px 24px;background:#dc2626;color:#ffffff;font-size:14px;font-weight:600">` +
      `🚨 ${health.streak} corridas seguidas sin completar — revisar el bot.</td></tr>`
    : "";

  const errorBox = runStats.error
    ? `<tr><td style="padding:8px 24px 0">` +
      `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;color:#991b1b;font-size:13px">` +
      `<b>Error:</b> ${esc(runStats.error.split("\n")[0])}</div></td></tr>`
    : "";

  // Fase 4.2 — caja ámbar con las señales del bug de recibos cruzados. Solo
  // aparece si alguna se despertó: en una corrida sana el correo no cambia.
  const g = runStats.guardaD;
  const guardaDBox =
    g && guardaDAlerta(g)
      ? `<tr><td style="padding:8px 24px 0">` +
        `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;color:#92400e;font-size:13px">` +
        `<b>⚠ Guarda D′ — señales a vigilar</b>` +
        `<ul style="margin:8px 0 0;padding-left:18px">` +
        (g.sinRespuesta > 0
          ? `<li><b>${esc(g.sinRespuesta)}</b> búsqueda(s) sin respuesta propia — no son «no encontrado»; se reintentan en la próxima corrida.</li>`
          : "") +
        (g.sospechosos > 0
          ? `<li><b>${esc(g.sospechosos)}</b> receipt(s) aceptado(s) por red con el DOM discrepando.</li>`
          : "") +
        (g.rapidas > 0
          ? `<li><b>${esc(g.rapidas)}</b> receipt(s) leído(s) en menos de 900 ms — la firma vieja del bug de recibos cruzados.</li>`
          : "") +
        `</ul>` +
        `<div style="margin-top:8px;color:#78350f">Ninguna implica un dato malo escrito (D′ exige correlación), pero conviene abrir el log.</div>` +
        `</div></td></tr>`
      : "";

  const modoBadge = runStats.preview
    ? `<span style="background:#e0e7ff;color:#3730a3;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600;margin-left:8px">PREVIEW</span>`
    : "";

  return `<!-- Stephy run email -->
<div style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
    <tr><td style="height:6px;background:${theme.accent}"></td></tr>
    ${alertBanner}
    <tr><td style="padding:22px 24px 14px;background:${theme.bg}">
      <div style="font-size:21px;font-weight:700;color:#0f172a">${theme.emoji} Stephy — ${esc(theme.label)}${modoBadge}</div>
      <div style="font-size:13px;color:#64748b;margin-top:6px">Corrida de tracking en StephyTracking · ${esc(inicio)}</div>
    </td></tr>

    <tr><td style="padding:18px 18px 4px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        ${chip(runStats.encontrados, "receipts encontrados", theme.accent, theme.bg)}
        ${chip(runStats.noEncontrados, "no encontrados", "#475569", "#f1f5f9")}
      </tr></table>
    </td></tr>

    ${errorBox}
    ${guardaDBox}

    <tr><td style="padding:14px 24px 4px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;font-size:13px">
        ${rowsHtml}
      </table>
    </td></tr>

    <tr><td style="padding:16px 24px 6px">
      <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Log completo de la corrida</div>
      <pre style="margin:0;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;font-size:11px;line-height:1.5;font-family:'SF Mono',Consolas,'Courier New',monospace;white-space:pre-wrap;word-break:break-word;overflow-x:auto">${esc(getCapturedLog())}</pre>
    </td></tr>

    <tr><td style="padding:14px 24px 22px;border-top:1px solid #f1f5f9">
      <div style="font-size:12px;color:#94a3b8">MamaSAN · Stephy Bot · generado ${esc(fin)}</div>
    </td></tr>
  </table>
</div>`;
}

// ==========================================================================
//  Cierre único de la corrida — telemetría (#) + correo
// ==========================================================================

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lee el commit corto de HEAD SIN child_process (leyendo .git directamente):
 * .git/HEAD → si es "ref: …" sigue el ref (loose o packed-refs). Best-effort:
 * null si no se puede resolver (p.ej. no es un repo git).
 */
async function readGitCommit(): Promise<string | null> {
  try {
    const head = (await readFile(join(PROJECT_ROOT, ".git", "HEAD"), "utf8")).trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return head.slice(0, 7); // HEAD desprendido = sha crudo
    const ref = m[1];
    try {
      const sha = (await readFile(join(PROJECT_ROOT, ".git", ref), "utf8")).trim();
      return sha.slice(0, 7);
    } catch {
      const packed = await readFile(join(PROJECT_ROOT, ".git", "packed-refs"), "utf8");
      for (const line of packed.split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const [sha, r] = line.split(" ");
        if (r === ref) return sha.slice(0, 7);
      }
      return null;
    }
  } catch {
    return null;
  }
}

/** Cómo se disparó la corrida (para segmentar métricas). */
function resolveDisparo(): string {
  if (process.env.STEPHY_DISPARO) return process.env.STEPHY_DISPARO;
  if (runStats.preview) return "preview";
  if (process.env.STEPHY_MANUAL_LOGIN === "1") return "manual";
  return "auto";
}

/** `corrida_id` idempotente, mismo formato que el bot Walmart (ISO con guiones). */
function buildCorridaId(inicio: Date): string {
  return inicio.toISOString().replace(/[:.]/g, "-");
}

/** number | string | null → number | null (para las columnas int de la BD). */
function numOrNull(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cierre ÚNICO de la corrida, llamado desde los 3 finales (éxito, catch y
 * watchdog): manda el correo (con su resumen + salud) y registra la corrida en
 * Supabase vía webhook n8n (telemetría). Idempotente en proceso (runFinished)
 * para que un watchdog + resolución tardía no dupliquen. Todo best-effort: un
 * fallo de correo o de telemetría nunca tumba el proceso.
 */
async function finishRun(opts: { exitCode: number; watchdog?: boolean }): Promise<void> {
  if (runFinished) return;
  runFinished = true;
  disarmWatchdog();

  // 1. Correo (incluye el registro de salud #11). Nunca bloquear por esto.
  try {
    const { asunto, cuerpo, html } = await buildEmailContent();
    await sendRunLog(asunto, cuerpo, html);
  } catch (err) {
    console.log(`⚠ [correo] Falló el armado/envío del correo: ${(err as Error).message}`);
  }

  // 2. Telemetría a Supabase (best-effort). La corrida de consignatarios es
  //    mantenimiento puntual, no una corrida del pipeline: registrarla metería
  //    una fila con 0 encontrados en corridas_tracking_stephy y torcería v_bot_salud.
  if (runStats.consigneeRan) {
    console.log("  ⓘ [telemetría] Corrida de consignatarios: no se registra como corrida de tracking.");
    return;
  }
  try {
    const usage = getLlmUsage();
    const costUsd = await estimateLlmCostUsd(usage);
    const estado = opts.watchdog
      ? "watchdog"
      : runStats.error
        ? "error"
        : runStats.loginOk
          ? "ok"
          : "login_failed";
    const fin = new Date();
    const payload: TelemetryPayload = {
      corrida: {
        corrida_id: buildCorridaId(runStats.inicio),
        disparo: resolveDisparo(),
        host: hostname() || null,
        git_commit: await readGitCommit(),
        inicio: runStats.inicio.toISOString(),
        fin: fin.toISOString(),
        duracion_ms: fin.getTime() - runStats.inicio.getTime(),
        estado,
        exit_code: opts.exitCode,
        login_ok: runStats.loginOk,
        menu_open: runStats.menuOpen,
        search_ran: runStats.searchRan,
        preview: runStats.preview,
        incremental: runStats.incremental,
        run_attempts: runStats.runAttempts,
        nops_total: runStats.nopsTotal,
        incremental_due: runStats.incrementalDue,
        incremental_skipped: runStats.incrementalSkipped,
        encontrados: runStats.encontrados,
        no_encontrados: runStats.noEncontrados,
        sesion_expirada: runStats.sessionExpired,
        detalle_actualizados: numOrNull(runStats.detalleActualizados),
        grupos_actualizados: numOrNull(runStats.gruposActualizados),
        persist_failed: runStats.persistFailed,
        llm_model: usage.model || null,
        llm_calls: usage.calls,
        llm_errors: usage.errors,
        llm_prompt_tokens: usage.promptTokens,
        llm_completion_tokens: usage.completionTokens,
        llm_total_tokens: usage.totalTokens,
        llm_ms: usage.ms,
        llm_cost_usd: costUsd,
        write_back: runStats.writeBack,
        error_msg: runStats.error,
      },
      items: runItems.map((m) => ({
        nop: m.nop,
        id_venta: m.id_venta,
        tracking_proveedor: m.tracking_proveedor,
        receipt: m.receipt ?? null,
        resultado: m.resultado ?? null,
        motivo: m.motivo ?? null,
        ms: m.ms ?? null,
        persistido_db: m.persistido_db ?? false,
      })),
    };
    await postRunTelemetry(payload);
  } catch (err) {
    console.log(`⚠ [telemetría] No se registró la corrida: ${(err as Error).message}`);
  }
}

// #2 — Armamos el watchdog ANTES de arrancar: si la corrida se cuelga, él fuerza
// el cierre + correo + telemetría + exit(1). finishRun() desarma el watchdog.
armWatchdog();

main()
  .then(async () => {
    await finishRun({ exitCode: 0 });
  })
  .catch(async (err) => {
    runStats.error = (err && (err.stack || err.message)) || String(err);
    console.error("Flujo falló:\n", err);
    await finishRun({ exitCode: 1 });
    process.exit(1);
  });
