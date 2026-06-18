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

import type { NopsResponse } from "./nops-con-tracking.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Subconjunto de la page de Stagehand que usamos aquí. */
export type EvalPage = {
  evaluate: (expr: string) => Promise<unknown>;
  url: () => string;
  goto?: (url: string) => Promise<unknown>;
  waitForLoadState: (state: "networkidle") => Promise<unknown>;
  keyPress?: (key: string) => Promise<unknown>;
};

export interface SearchMatch {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt?: string;
  motivo?: string;
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
}

/**
 * Busca un tracking en la página Search y lee el receipt resultante.
 * `verbose` loguea lo que ve (para calibrar en las primeras vueltas).
 */
export async function searchOneTracking(
  page: EvalPage,
  tracking: string,
  verbose = false,
): Promise<OneSearchResult> {
  const fillRaw = (await page.evaluate(fillTrackingExpr(tracking))) as string;
  const fill = JSON.parse(fillRaw) as { res: string; count: number };
  if (verbose) console.log(`    · fill: ${fill.res} (inputs visibles: ${fill.count})`);
  await sleep(300);

  const click = (await page.evaluate(clickSearchExpr)) as string;
  if (verbose) console.log(`    · click Buscar: ${click}`);
  if (click === "no-visible" && page.keyPress) {
    // Fallback: Enter en el input de Tracking.
    await page.keyPress("Enter").catch(() => {});
  }

  await page.waitForLoadState("networkidle").catch(() => {});

  // Poll: esperamos a que aparezca el receipt (input der), una alerta, o timeout.
  let last: OneSearchResult = { vals: [], alertText: "", sessionExpired: false, notFound: false };
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    const raw = (await page.evaluate(readResultExpr)) as string;
    const r = JSON.parse(raw) as OneSearchResult;
    last = r;
    if (r.sessionExpired) break;
    // El receipt aparece en el input de la DERECHA (vals[1]), distinto del tracking.
    const receipt = (r.vals[1] || "").trim();
    if (receipt && receipt.toUpperCase() !== tracking.toUpperCase()) {
      last.receipt = receipt;
      break;
    }
    if (r.notFound) break;
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

/**
 * Recorre cada tracking_proveedor del JSON de n8n, lo busca en la página Search
 * y arma encontrados/noEncontrados. `limit` (env STEPHY_SEARCH_LIMIT) acota para
 * pruebas. Devuelve null en `sessionExpired` global para que el caller decida.
 */
export async function searchAllTrackings(
  page: EvalPage,
  nopsData: NopsResponse,
  opts: { limit?: number } = {},
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

  for (let i = 0; i < total; i++) {
    const d = detalle[i];
    const tracking = Array.isArray(d.tracking_proveedor)
      ? String(d.tracking_proveedor[0] ?? "")
      : String(d.tracking_proveedor ?? "");
    const trimmed = tracking.trim();
    const base: SearchMatch = { nop: d.nop, id_venta: d.id_venta, tracking_proveedor: trimmed };

    if (!trimmed) {
      noEncontrados.push({ ...base, motivo: "sin tracking_proveedor" });
      continue;
    }

    const verbose = i < 3; // primeras 3 vueltas: logueo detallado para calibrar.
    process.stdout.write(`  [${i + 1}/${total}] ${trimmed} … `);
    const r = await searchOneTracking(page, trimmed, verbose);

    if (r.sessionExpired) {
      sessionExpiredCount++;
      console.log("⛔ Sesión Expirada");
      noEncontrados.push({ ...base, motivo: "sesión expirada" });
      continue;
    }
    if (r.receipt) {
      console.log(`✓ receipt ${r.receipt}`);
      encontrados.push({ ...base, receipt: r.receipt });
    } else {
      console.log("∅ sin receipt");
      noEncontrados.push({ ...base, motivo: "no está en Search" });
    }
  }

  console.log(
    `\n  ✓ [search] Encontrados: ${encontrados.length} · ` +
      `No encontrados: ${noEncontrados.length} · Sesión Expirada: ${sessionExpiredCount}`,
  );
  return { encontrados, noEncontrados, sessionExpiredCount };
}
