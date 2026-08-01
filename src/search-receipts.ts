/**
 * Receipts vía la página SEARCH (rediseño confiable).
 *
 * En vez de scrapear la lista paginada de Receipts (que perdía recibos), aquí
 * buscamos UN tracking a la vez en la página `/search`:
 *
 *   1. Llegamos a Search HACIENDO CLICK en el item "Search" del menú ☰ (NO por
 *      URL directa). Navegar dentro del SPA mantiene viva la sesión Angular/Ionic
 *      — por eso entrar por menú evita el "Sesión Expirada" que daba el goto.
 *   2. Por cada `tracking_proveedor` del JSON de n8n: lo escribimos en el input
 *      de Tracking (el de la IZQUIERDA), click en "Buscar", y leemos el número
 *      de Receipt que aparece en el input de al lado (el de la DERECHA).
 *   3. Asociamos receipt ↔ tracking ↔ nop ↔ id_venta. El resultado alimenta el
 *      mismo write-back a Supabase (persistMatches del módulo viejo).
 *
 * Todo best-effort y observable: la primera vuelta loguea lo que ve (valores de
 * los inputs, alertas) para poder ajustar selectores sin re-explorar a ciegas.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NopsResponse } from "./nops-con-tracking.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");

/** Subconjunto de la page de Stagehand que usamos aquí. */
export type EvalPage = {
  evaluate: (expr: string) => Promise<unknown>;
  url: () => string;
  goto?: (url: string) => Promise<unknown>;
  waitForLoadState: (
    state: "networkidle",
    timeoutMs?: number,
  ) => Promise<unknown>;
  keyPress?: (key: string) => Promise<unknown>;
};

export interface SearchMatch {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt?: string;
  motivo?: string;
  /** Telemetría: clasificación del resultado para la auditoría en BD. */
  resultado?: "encontrado" | "no_encontrado" | "sesion_expirada" | "sin_tracking";
  /** Telemetría: latencia de la búsqueda de este tracking (ms). */
  ms?: number;
  /** Telemetría: si el receipt se escribió en Supabase (lo fija el caller). */
  persistido_db?: boolean;
}

// ==========================================================================
//  Exprs de página (se evalúan como string, patrón del proyecto)
// ==========================================================================

/** Click en el item del menú ☰ cuyo texto contiene `label` (Search / Buscar). */
export const clickMenuItemExpr = (label: string) => `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const want = ${JSON.stringify(label.toUpperCase())};
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const items = Array.from(document.querySelectorAll('.menu-item-container, section.menu-item-container')).filter(vis);
  const target = items.find((el) => T(el).toUpperCase().includes(want));
  if (!target) return 'no-target';
  target.click();
  return 'ok';
})()`;

/**
 * Inputs de texto VISIBLES de la página Search, ordenados por posición (izq→der).
 * [0] = Tracking, [1] = Receipt. Llena el de Tracking con `value` por el setter
 * nativo (el valor NUNCA va al LLM). Antes limpia ambos inputs. Devuelve JSON
 * {res, count}.
 */
export const fillTrackingExpr = (value: string) => `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  if (!inputs.length) return JSON.stringify({ res: 'no-visible', count: 0 });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const setVal = (el, v) => {
    el.focus();
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Limpia ambos (el Receipt puede traer el resultado anterior).
  for (const el of inputs) setVal(el, '');
  setVal(inputs[0], ${JSON.stringify(value)});
  inputs[0].dispatchEvent(new Event('blur', { bubbles: true }));
  return JSON.stringify({ res: 'ok', count: inputs.length });
})()`;

/**
 * Click en el botón "Buscar"/"Search" HABILITADO más a la izquierda (el del
 * Tracking; el de Receipt suele venir deshabilitado). Devuelve 'ok'|'no-visible'.
 */
export const clickSearchExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || e.value || '')).trim().toUpperCase();
  const btns = Array.from(document.querySelectorAll('button, ion-button, [role=button], input[type=submit]')).filter((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const t = T(el);
    const enabled = !el.disabled && !el.classList.contains('button-disabled') && s.pointerEvents !== 'none';
    return (t.includes('BUSCAR') || t === 'SEARCH') &&
      s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && enabled;
  });
  if (!btns.length) return 'no-visible';
  btns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  btns[0].click();
  return 'ok';
})()`;

/**
 * Lee el estado tras una búsqueda: valores de los inputs visibles (izq→der),
 * texto de cualquier ion-alert/toast, y si hay "Sesión Expirada". Devuelve JSON.
 */
export const readResultExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const vals = inputs.map((el) => (el.value || '').trim());
  const al = document.querySelector('ion-alert, ion-toast, .alert, [role=alert]');
  const alertText = al && vis(al) ? (al.innerText || al.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const bodySlice = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
  const sessionExpired = /sesi[oó]n expirada|session expired/i.test(alertText) ||
    /sesi[oó]n expirada/i.test(bodySlice);
  const notFound = /no\\s+results?|no\\s+(se\\s+)?(encontr|hay|existe)|sin\\s+resultado/i.test(alertText) ||
    /no\\s+results?/i.test(bodySlice);
  // Snapshot de cualquier tabla/lista de resultados (para ver dónde cae el receipt).
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll('table, ion-list, .list, [class*="result" i], [class*="row" i]'))
    .filter(vis).map((e) => T(e)).filter((t) => t && t.length < 600);
  const resultSnap = Array.from(new Set(tables)).slice(0, 8);
  return JSON.stringify({ vals, alertText, sessionExpired, notFound, bodySlice, resultSnap });
})()`;

// ==========================================================================
//  Navegación a Search por el menú
// ==========================================================================

/**
 * Con el menú ☰ YA abierto, click en el item "Search" y espera la página
 * `/search`. Devuelve true si la URL contiene "search".
 */
export async function gotoSearchViaMenu(page: EvalPage): Promise<boolean> {
  console.log("\n→ [search] Click en el item «Search» del menú ☰…");
  let res = (await page.evaluate(clickMenuItemExpr("Search"))) as string;
  if (res !== "ok") res = (await page.evaluate(clickMenuItemExpr("Buscar"))) as string;
  console.log(`  · click item Search: ${res}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let i = 0; i < 15; i++) {
    if (/search/i.test(page.url())) break;
    await sleep(500);
  }
  const ok = /search/i.test(page.url());
  console.log(ok ? `  ✓ En Search: ${page.url()}` : `  ⚠ No llegué a /search (URL: ${page.url()})`);
  await sleep(1200);
  return ok;
}

// ==========================================================================
//  Búsqueda de UN tracking
// ==========================================================================

export interface OneSearchResult {
  receipt?: string;
  vals: string[];
  alertText: string;
  sessionExpired: boolean;
  notFound: boolean;
  bodySlice?: string;
  resultSnap?: string[];
  /** Calibración (Fase 1.1): TODAS las lecturas del poll, en orden. */
  reads?: PollRead[];
  /** Calibración: por qué salió el poll. */
  exitReason?: PollExit;
}

/**
 * Calibración (Fase 1.1) — una lectura del poll tal cual salió de la página,
 * con el instante en que se tomó. La iteración 0 es la lectura INMEDIATA tras el
 * click: si ya trae recibo, es residuo por definición (el XHR no ha respondido).
 */
export interface PollRead {
  iter: number;
  /** ms desde el click de Buscar. */
  ms: number;
  vals: string[];
  alertText: string;
  notFound: boolean;
  sessionExpired: boolean;
  /** ¿La red ya se había aquietado cuando se tomó esta lectura? */
  netSettled: boolean;
  resultSnap?: string[];
}

/** Por qué terminó el poll (calibración). */
export type PollExit =
  | "receipt"
  | "sesion_expirada"
  | "not_found"
  | "max_wait"
  | "net_settled";

/** Modo calibración: instrumenta el poll sin cambiar ninguna decisión. */
export const calibrating = (): boolean => process.env.STEPHY_CALIBRATE === "1";

/**
 * Tiempos del poll por tracking (#5 — recortar latencia). Todos con override por
 * env para poder afinarlos sin recompilar si el sitio cambia de velocidad:
 *   - settleMs   : pausa tras llenar el input antes de click (Angular registra el valor).
 *   - pollMs     : intervalo entre lecturas del resultado.
 *   - idleCapMs  : tope del waitForLoadState("networkidle") — evita el cuelgue de 30s
 *                  (default de Playwright) en esta SPA que casi nunca queda idle.
 *   - minWaitMs  : NO concluir "sin receipt" antes de esto (da tiempo a que el XHR
 *                  de búsqueda salga y responda → evita falsos negativos).
 *   - maxWaitMs  : presupuesto total de espera de un resultado (backstop duro).
 */
export interface SearchTiming {
  settleMs: number;
  pollMs: number;
  idleCapMs: number;
  minWaitMs: number;
  maxWaitMs: number;
}

const numEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Resuelve los tiempos del poll (defaults calibrados + override por env). */
export function resolveSearchTiming(): SearchTiming {
  return {
    settleMs: numEnv("STEPHY_SEARCH_SETTLE_MS", 120),
    pollMs: numEnv("STEPHY_SEARCH_POLL_MS", 200),
    idleCapMs: numEnv("STEPHY_SEARCH_IDLE_CAP_MS", 1500),
    minWaitMs: numEnv("STEPHY_SEARCH_MIN_WAIT_MS", 500),
    maxWaitMs: numEnv("STEPHY_SEARCH_MAX_WAIT_MS", 3500),
  };
}

/**
 * Busca un tracking en la página Search y lee el receipt resultante.
 * `verbose` loguea lo que ve (para calibrar en las primeras vueltas).
 *
 * Poll ADAPTATIVO con salida temprana (#5): en vez de sleeps fijos + un
 * `networkidle` sin tope (que colgaba hasta 30s por tracking en esta SPA), leemos
 * el resultado en intervalos cortos y salimos apenas aparece el receipt / la
 * alerta / la sesión expirada. El "no está" se concluye cuando la red se aquieta
 * (con tope) pasado `minWaitMs`, o al agotar `maxWaitMs`.
 */
export async function searchOneTracking(
  page: EvalPage,
  tracking: string,
  verbose = false,
  timing: SearchTiming = resolveSearchTiming(),
): Promise<OneSearchResult> {
  const fillRaw = (await page.evaluate(fillTrackingExpr(tracking))) as string;
  const fill = JSON.parse(fillRaw) as { res: string; count: number };
  if (verbose) console.log(`    · fill: ${fill.res} (inputs visibles: ${fill.count})`);
  await sleep(timing.settleMs);

  const click = (await page.evaluate(clickSearchExpr)) as string;
  if (verbose) console.log(`    · click Buscar: ${click}`);
  if (click === "no-visible" && page.keyPress) {
    // Fallback: Enter en el input de Tracking.
    await page.keyPress("Enter").catch(() => {});
  }

  // Espera la quietud de red EN PARALELO al poll, con tope duro. En esta SPA el
  // networkidle sin tope colgaba hasta 30s por tracking. Aquí solo lo usamos como
  // señal de "el XHR de búsqueda ya terminó" para concluir el "no está" antes.
  let netSettled = false;
  const idleWatch = page
    .waitForLoadState("networkidle", timing.idleCapMs)
    .then(() => {
      netSettled = true;
    })
    .catch(() => {});

  // Poll: leemos hasta que aparezca el receipt (input der), una alerta, o timeout.
  const start = Date.now();
  let last: OneSearchResult = { vals: [], alertText: "", sessionExpired: false, notFound: false };
  // Calibración (1.1): guardamos CADA lectura sin alterar ninguna decisión.
  const cal = calibrating();
  const reads: PollRead[] = [];
  let iter = 0;
  let exitReason: PollExit = "max_wait";
  while (true) {
    const raw = (await page.evaluate(readResultExpr)) as string;
    const r = JSON.parse(raw) as OneSearchResult;
    last = r;
    if (cal) {
      reads.push({
        iter,
        ms: Date.now() - start,
        vals: r.vals,
        alertText: r.alertText,
        notFound: r.notFound,
        sessionExpired: r.sessionExpired,
        netSettled,
        resultSnap: r.resultSnap,
      });
      iter++;
    }
    if (r.sessionExpired) {
      exitReason = "sesion_expirada";
      break;
    }
    // El receipt aparece en el input de la DERECHA (vals[1]), distinto del tracking.
    const receipt = (r.vals[1] || "").trim();
    if (receipt && receipt.toUpperCase() !== tracking.toUpperCase()) {
      last.receipt = receipt;
      exitReason = "receipt";
      break;
    }
    if (r.notFound) {
      exitReason = "not_found";
      break;
    }

    const elapsed = Date.now() - start;
    if (elapsed >= timing.maxWaitMs) {
      exitReason = "max_wait";
      break;
    }
    // Red aquietada + ya pasó el guard mínimo → el receipt no está aquí; no
    // gastamos el presupuesto completo esperando algo que no vendrá.
    if (netSettled && elapsed >= timing.minWaitMs) {
      exitReason = "net_settled";
      break;
    }
    await sleep(timing.pollMs);
  }
  void idleWatch; // el .catch ya lo hace inofensivo; no bloqueamos por él.
  if (cal) {
    last.reads = reads;
    last.exitReason = exitReason;
  }

  if (verbose) {
    console.log(`    · result vals=${JSON.stringify(last.vals)} alert="${last.alertText}" notFound=${last.notFound} sessionExpired=${last.sessionExpired}`);
    if (last.resultSnap?.length) console.log(`    · resultSnap=${JSON.stringify(last.resultSnap)}`);
    if (!last.receipt) console.log(`    · body: ${last.bodySlice ?? ""}`);
  }
  return last;
}

// ==========================================================================
//  Loop sobre todos los NOPs
// ==========================================================================

/** Un lote de resultados listo para persistir + registrar en el estado. */
export interface SearchBatch {
  encontrados: SearchMatch[];
  noEncontrados: SearchMatch[];
}

/**
 * Recorre cada tracking_proveedor del JSON de n8n, lo busca en la página Search
 * y arma encontrados/noEncontrados. `limit` (env STEPHY_SEARCH_LIMIT) acota para
 * pruebas. Devuelve null en `sessionExpired` global para que el caller decida.
 *
 * Persistencia INCREMENTAL (durabilidad ante cortes): si el caller pasa
 * `onBatch`, cada `batchSize` trackings procesados (o al terminar el loop) se le
 * entrega el lote acumulado para que persista los receipts hallados y guarde el
 * estado incremental EN CALIENTE. Así, si el watchdog (#2) o un corte de CDP (#3)
 * matan la corrida a mitad, lo ya encontrado YA está escrito en Supabase en vez
 * de perderse (antes `persistMatches` corría solo al final del loop). Cada
 * tracking se entrega en EXACTAMENTE un lote → sin doble conteo de backoff. El
 * `onBatch` es best-effort: si falla, se loguea y la búsqueda continúa.
 */
export async function searchAllTrackings(
  page: EvalPage,
  nopsData: NopsResponse,
  opts: {
    limit?: number;
    batchSize?: number;
    onBatch?: (batch: SearchBatch) => Promise<void>;
  } = {},
): Promise<{
  encontrados: SearchMatch[];
  noEncontrados: SearchMatch[];
  sessionExpiredCount: number;
}> {
  const detalle = Array.isArray(nopsData.nops_detalle) ? nopsData.nops_detalle : [];
  const total = opts.limit ? Math.min(opts.limit, detalle.length) : detalle.length;
  console.log(`\n→ [search] Buscando ${total} tracking(s) uno por uno en /search…`);

  const encontrados: SearchMatch[] = [];
  const noEncontrados: SearchMatch[] = [];
  let sessionExpiredCount = 0;

  // --- Lotes para persistencia incremental ---------------------------------
  // Umbral de flush: cada N trackings PROCESADOS entregamos el lote (así el
  // estado incremental se guarda periódicamente aunque no haya hallazgos).
  const envBatch = Number(process.env.STEPHY_PERSIST_BATCH);
  const batchSize =
    opts.batchSize && opts.batchSize > 0
      ? opts.batchSize
      : Number.isFinite(envBatch) && envBatch > 0
        ? envBatch
        : 10;
  const pendingEnc: SearchMatch[] = [];
  const pendingNoEnc: SearchMatch[] = [];
  const addFound = (m: SearchMatch) => {
    encontrados.push(m);
    pendingEnc.push(m);
  };
  const addMissing = (m: SearchMatch) => {
    noEncontrados.push(m);
    pendingNoEnc.push(m);
  };
  /** Entrega el lote acumulado al caller (best-effort) y limpia los buffers. */
  const flush = async () => {
    if (pendingEnc.length === 0 && pendingNoEnc.length === 0) return;
    const batch: SearchBatch = {
      encontrados: pendingEnc.slice(),
      noEncontrados: pendingNoEnc.slice(),
    };
    pendingEnc.length = 0;
    pendingNoEnc.length = 0;
    if (!opts.onBatch) return;
    try {
      await opts.onBatch(batch);
    } catch (err) {
      console.log(
        `  ⚠ [batch] onBatch falló (ignorado, la búsqueda continúa): ${(err as Error).message}`,
      );
    }
  };

  const timing = resolveSearchTiming(); // resuelve una vez (mismo para todos).
  let sumMs = 0; // suma de latencias reales para promediar (#5).

  // --- Calibración (Fase 1.1) ----------------------------------------------
  // Con STEPHY_CALIBRATE=1 volcamos, tracking por tracking, TODAS las lecturas
  // del poll a un JSONL: la primera lectura (residuo si trae recibo), la
  // aceptada, el ms y el resultSnap completo. Sirve para responder las dos
  // preguntas abiertas del plan (¿repinta vals[0]? ¿el snap trae el par?) sin
  // tocar la lógica de decisión. Best-effort: si falla el disco, se sigue.
  const cal = calibrating();
  const calFile = join(DATA_DIR, `calibracion-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  if (cal) {
    await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    console.log(`\n🔬 [calibración] STEPHY_CALIBRATE=1 → trazado del poll en ${calFile}`);
    console.log(`   timing: ${JSON.stringify(timing)}`);
  }
  const calDump = async (row: unknown) => {
    if (!cal) return;
    try {
      await appendFile(calFile, JSON.stringify(row) + "\n", "utf8");
    } catch (err) {
      console.log(`  ⚠ [calibración] no pude escribir el trazado: ${(err as Error).message}`);
    }
  };

  for (let i = 0; i < total; i++) {
    const d = detalle[i];
    const tracking = Array.isArray(d.tracking_proveedor)
      ? String(d.tracking_proveedor[0] ?? "")
      : String(d.tracking_proveedor ?? "");
    const trimmed = tracking.trim();
    const base: SearchMatch = { nop: d.nop, id_venta: d.id_venta, tracking_proveedor: trimmed };

    if (!trimmed) {
      addMissing({ ...base, resultado: "sin_tracking", motivo: "sin tracking_proveedor", ms: 0 });
      continue;
    }

    const verbose = cal || i < 3; // primeras 3 vueltas (o calibración): detalle.
    process.stdout.write(`  [${i + 1}/${total}] ${trimmed} … `);
    const t0 = Date.now();
    const r = await searchOneTracking(page, trimmed, verbose, timing);
    const ms = Date.now() - t0;
    sumMs += ms;

    if (cal) {
      const first = r.reads?.[0];
      const firstReceipt = (first?.vals?.[1] || "").trim();
      // La señal cruda: recibo YA presente en la lectura inmediata al click.
      if (firstReceipt) {
        console.log(
          `\n    ⚠ [calibración] RESIDUO: la lectura 0 (${first?.ms}ms) ya traía «${firstReceipt}»`,
        );
      }
      await calDump({
        idx: i + 1,
        tracking: trimmed,
        ts: new Date().toISOString(),
        ms,
        exitReason: r.exitReason,
        receiptAceptado: r.receipt ?? null,
        receiptPrimeraLectura: firstReceipt || null,
        trackingEnInput: r.vals?.[0] ?? null,
        inputConservaTracking:
          (r.vals?.[0] || "").trim().toUpperCase() === trimmed.toUpperCase(),
        lecturas: r.reads ?? [],
      });
    }

    if (r.sessionExpired) {
      sessionExpiredCount++;
      console.log(`⛔ Sesión Expirada (${ms}ms)`);
      addMissing({ ...base, resultado: "sesion_expirada", motivo: "sesión expirada", ms });
    } else if (r.receipt) {
      console.log(`✓ receipt ${r.receipt} (${ms}ms)`);
      addFound({ ...base, receipt: r.receipt, resultado: "encontrado", ms });
    } else {
      console.log(`∅ sin receipt (${ms}ms)`);
      addMissing({ ...base, resultado: "no_encontrado", motivo: "no está en Search", ms });
    }

    // Flush por lote: cada `batchSize` trackings procesados (encontrados o no).
    if (pendingEnc.length + pendingNoEnc.length >= batchSize) await flush();
  }

  await flush(); // remanente del último lote parcial.

  const searched = encontrados.length + noEncontrados.filter((n) => n.motivo !== "sin tracking_proveedor").length;
  const avg = searched ? Math.round(sumMs / searched) : 0;
  console.log(
    `\n  ✓ [search] Encontrados: ${encontrados.length} · ` +
      `No encontrados: ${noEncontrados.length} · Sesión Expirada: ${sessionExpiredCount} · ` +
      `latencia ~${avg}ms/tracking (${Math.round(sumMs / 1000)}s total)`,
  );
  return { encontrados, noEncontrados, sessionExpiredCount };
}
