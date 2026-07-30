/**
 * Consignee por RECEIPT vía la página SEARCH (limpieza de recibos contaminados).
 *
 * Esto es la búsqueda INVERSA de search-receipts.ts. Allá escribimos un
 * `tracking_proveedor` en el input de la IZQUIERDA y leemos el receipt que sale
 * en el de la DERECHA. Aquí escribimos el RECEIPT en el input de la DERECHA y
 * leemos a quién pertenece (el consignatario), que es el único dato que permite
 * decidir de qué cliente es un recibo que quedó pegado a varios.
 *
 * Por qué hace falta: el workflow `actualizar-receipts` emparejaba solo por
 * `tracking_proveedor`, y las guías consolidadas (GoFo/SPX/Amazon) llevan
 * paquetes de varios clientes bajo una misma guía. Eso pegó un mismo receipt a
 * clientes distintos. Para curar los que quedan hay que preguntarle a Stephy de
 * quién es cada caja, porque en la BD esa verdad no existe.
 *
 * NO escribe nada: deja un JSON/CSV con `receipt → consignee → n_consignatario`
 * para decidir la limpieza aparte, revisable antes de tocar la BD.
 *
 * El consignatario en Stephy se ve como `NOMBRE APELLIDO [160012]`; el número
 * entre corchetes cruza con `usuarios.n_consignatario` en Supabase.
 */

import { resolveSearchTiming, type EvalPage, type SearchTiming } from "./search-receipts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ConsigneeMatch {
  receipt: string;
  /** Texto crudo del consignatario tal como lo muestra Stephy. */
  consignee?: string;
  /** Número entre corchetes → cruza con usuarios.n_consignatario. */
  n_consignatario?: number;
  /** Tracking que Stephy asocia al receipt (contexto, no se usa para decidir). */
  tracking?: string;
  /**
   * `error_pagina` = no pude siquiera leer el formulario (no es un dato de
   * Stephy). Se distingue de `no_encontrado` a propósito: confundirlos haría
   * pasar un fallo de scraping por "este receipt no existe".
   */
  resultado:
    | "encontrado"
    | "sin_consignee"
    | "no_encontrado"
    | "sesion_expirada"
    | "error_pagina";
  motivo?: string;
  ms?: number;
}

// ==========================================================================
//  Exprs de página
// ==========================================================================

/**
 * Escribe `value` en el input de RECEIPT (el de la DERECHA) y limpia el de
 * Tracking, para que el resultado anterior no contamine la lectura. Mismo patrón
 * de setter nativo que fillTrackingExpr: el valor nunca pasa por el LLM.
 */
export const fillReceiptExpr = (value: string) => `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  if (inputs.length < 2) return JSON.stringify({ res: 'faltan-inputs', count: inputs.length });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const setVal = (el, v) => {
    el.focus();
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  for (const el of inputs) setVal(el, '');
  setVal(inputs[1], ${JSON.stringify(value)});
  inputs[1].dispatchEvent(new Event('blur', { bubbles: true }));
  return JSON.stringify({ res: 'ok', count: inputs.length });
})()`;

/** Cuenta inputs de texto VISIBLES (para esperar a que Angular pinte el form). */
export const countInputsExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const all = Array.from(document.querySelectorAll('input'));
  const texto = all.filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  return String(texto.length);
})()`;

/** Volcado de TODOS los inputs (con visibilidad) para diagnosticar sin re-explorar. */
export const dumpInputsExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const all = Array.from(document.querySelectorAll('input, ion-input')).map((el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    placeholder: el.getAttribute('placeholder'),
    formcontrolname: el.getAttribute('formcontrolname'),
    name: el.getAttribute('name'),
    visible: vis(el),
    w: Math.round(el.getBoundingClientRect().width),
  }));
  return JSON.stringify({ url: location.href, count: all.length, inputs: all.slice(0, 20) });
})()`;

/**
 * Espera a que el formulario de Search esté pintado (≥2 inputs de texto
 * visibles). Esta SPA tarda en hidratar y el `sleep` fijo tras navegar no
 * alcanza siempre: sin esta espera, el primer receipt fallaba y —como cada
 * intento salía en 2ms— se quemaban los 50 sin tocar la página.
 */
export async function waitForSearchInputs(page: EvalPage, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeoutMs) {
    n = Number((await page.evaluate(countInputsExpr)) as string) || 0;
    if (n >= 2) return n;
    await sleep(300);
  }
  return n;
}

/**
 * Click en el botón "Buscar"/"Search" HABILITADO más a la DERECHA (el del
 * Receipt). Espejo de clickSearchExpr, que toma el de más a la izquierda.
 */
export const clickSearchReceiptExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || e.value || '')).trim().toUpperCase();
  const btns = Array.from(document.querySelectorAll('button, ion-button, [role=button], input[type=submit]')).filter((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const t = T(el);
    const enabled = !el.disabled && !el.classList.contains('button-disabled') && s.pointerEvents !== 'none';
    return (t.includes('BUSCAR') || t === 'SEARCH') &&
      s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && enabled;
  });
  if (!btns.length) return 'no-visible';
  btns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
  btns[0].click();
  return 'ok';
})()`;

/**
 * Lee el resultado buscando al consignatario. Devuelve JSON con:
 *   - vals        : valores de los inputs visibles (izq→der) = [tracking, receipt]
 *   - labeled     : texto del bloque cuya etiqueta menciona Consignee/Consignatario
 *   - candidates  : todos los `NOMBRE [123456]` visibles (el formato de Stephy)
 *   - alertText / sessionExpired / notFound : mismo contrato que readResultExpr
 *   - bodySlice / resultSnap : para calibrar selectores sin re-explorar a ciegas
 *
 * Se capturan CANDIDATOS en vez de adivinar un selector único: la primera corrida
 * loguea lo que ve y con eso se afina, que es el patrón que ya usa este proyecto.
 */
export const readConsigneeExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const vals = inputs.map((el) => (el.value || '').trim());

  const al = document.querySelector('ion-alert, ion-toast, .alert, [role=alert]');
  const alertText = al && vis(al) ? T(al) : '';
  const bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const sessionExpired = /sesi[oó]n expirada|session expired/i.test(alertText) ||
    /sesi[oó]n expirada/i.test(bodyText.slice(0, 400));
  const notFound = /no\\s+results?|no\\s+(se\\s+)?(encontr|hay|existe)|sin\\s+resultado/i.test(alertText) ||
    /no\\s+results?/i.test(bodyText.slice(0, 400));

  // Bloque etiquetado como Consignee/Consignatario (camino preferido).
  let labeled = '';
  const nodes = Array.from(document.querySelectorAll('*')).filter(vis);
  for (const el of nodes) {
    if (el.children.length > 3) continue;
    const t = T(el);
    if (!t || t.length > 200) continue;
    if (/consignee|consignatario/i.test(t)) { labeled = t; break; }
  }

  // Candidatos con el formato de Stephy: NOMBRE [123456].
  const rx = /([^\\[\\]\\n;|]{2,60}?)\\s*\\[(\\d{3,8})\\]/g;
  const candidates = [];
  let m;
  while ((m = rx.exec(bodyText)) !== null) {
    candidates.push({ texto: (m[1] || '').trim(), num: m[2] });
    if (candidates.length >= 12) break;
  }

  const blocks = Array.from(document.querySelectorAll('table, ion-list, .list, [class*="result" i], [class*="row" i], ion-card'))
    .filter(vis).map(T).filter((t) => t && t.length < 600);
  const resultSnap = Array.from(new Set(blocks)).slice(0, 8);

  return JSON.stringify({
    vals, labeled, candidates, alertText, sessionExpired, notFound,
    bodySlice: bodyText.slice(0, 500), resultSnap,
  });
})()`;

// ==========================================================================
//  Búsqueda de UN receipt
// ==========================================================================

interface RawConsigneeResult {
  vals: string[];
  labeled: string;
  candidates: { texto: string; num: string }[];
  alertText: string;
  sessionExpired: boolean;
  notFound: boolean;
  bodySlice?: string;
  resultSnap?: string[];
}

/**
 * Elige el consignatario entre los candidatos. Prefiere el bloque etiquetado
 * "Consignee"; si no, el primer `NOMBRE [num]` que NO sea el propio receipt ni el
 * shipper (los shippers de Stephy son casas conocidas: AMAZON, SHEIN, WALMART…).
 */
export function pickConsignee(
  raw: RawConsigneeResult,
  receipt: string,
): { consignee?: string; n_consignatario?: number } {
  const SHIPPERS = /amazon|shein|walmart|temu|aliexpress|shipping\s+depar|fulfil|fullfil/i;
  // Quita la etiqueta ("Consignee:", "Consignatario -", …) para dejar solo el
  // nombre, y que el texto quede igual al formato de receipt_huerfano.consignee.
  const limpia = (s: string) =>
    s.replace(/^.*?(consignee|consignatario)\s*[:\-–]?\s*/i, "").trim();
  const fromText = (t: string) => {
    const m = /([^\[\]\n;|]{2,60}?)\s*\[(\d{3,8})\]/.exec(t);
    if (!m) return null;
    const nombre = limpia(m[1]);
    if (!nombre) return null;
    return { consignee: `${nombre} [${m[2]}]`, n_consignatario: Number(m[2]) };
  };

  if (raw.labeled) {
    const hit = fromText(raw.labeled);
    if (hit && !SHIPPERS.test(hit.consignee)) return hit;
  }
  for (const c of raw.candidates ?? []) {
    if (!c.texto || c.num === receipt) continue;
    if (SHIPPERS.test(c.texto)) continue; // es el shipper, no el consignatario
    return { consignee: `${c.texto} [${c.num}]`, n_consignatario: Number(c.num) };
  }
  return {};
}

/**
 * Busca UN receipt y devuelve su consignatario. Mismo poll adaptativo que
 * searchOneTracking: salimos apenas hay señal, sin quemar el presupuesto.
 */
export async function searchOneReceipt(
  page: EvalPage,
  receipt: string,
  verbose = false,
  timing: SearchTiming = resolveSearchTiming(),
): Promise<ConsigneeMatch> {
  const t0 = Date.now();
  // Reintenta el llenado: si el form aún no está hidratado, esperar y repetir es
  // lo correcto. Rendirse al primer intento (2ms) es lo que hizo fallar los 50.
  let fill = { res: "faltan-inputs", count: 0 };
  for (let intento = 0; intento < 3; intento++) {
    if (intento > 0) await waitForSearchInputs(page, 5_000);
    const fillRaw = (await page.evaluate(fillReceiptExpr(receipt))) as string;
    fill = JSON.parse(fillRaw) as { res: string; count: number };
    if (fill.res === "ok") break;
  }
  if (verbose) console.log(`    · fill receipt: ${fill.res} (inputs visibles: ${fill.count})`);
  if (fill.res !== "ok") {
    const dump = (await page.evaluate(dumpInputsExpr)) as string;
    console.log(`    · ⚠ no hay form de Search. DOM: ${dump}`);
    return {
      receipt,
      resultado: "error_pagina",
      motivo: `no pude llenar el input de Receipt (${fill.res}, visibles=${fill.count})`,
      ms: Date.now() - t0,
    };
  }
  await sleep(timing.settleMs);

  const click = (await page.evaluate(clickSearchReceiptExpr)) as string;
  if (verbose) console.log(`    · click Buscar (derecha): ${click}`);
  if (click === "no-visible" && page.keyPress) await page.keyPress("Enter").catch(() => {});

  let netSettled = false;
  const idleWatch = page
    .waitForLoadState("networkidle", timing.idleCapMs)
    .then(() => {
      netSettled = true;
    })
    .catch(() => {});

  const start = Date.now();
  let last: RawConsigneeResult = {
    vals: [], labeled: "", candidates: [], alertText: "", sessionExpired: false, notFound: false,
  };
  let picked: { consignee?: string; n_consignatario?: number } = {};
  while (true) {
    const raw = (await page.evaluate(readConsigneeExpr)) as string;
    last = JSON.parse(raw) as RawConsigneeResult;
    if (last.sessionExpired) break;
    picked = pickConsignee(last, receipt);
    if (picked.consignee) break;
    if (last.notFound) break;

    const elapsed = Date.now() - start;
    if (elapsed >= timing.maxWaitMs) break;
    if (netSettled && elapsed >= timing.minWaitMs) break;
    await sleep(timing.pollMs);
  }
  void idleWatch;
  const ms = Date.now() - t0;

  if (verbose) {
    console.log(`    · vals=${JSON.stringify(last.vals)} labeled="${last.labeled}"`);
    console.log(`    · candidates=${JSON.stringify(last.candidates)}`);
    if (last.resultSnap?.length) console.log(`    · resultSnap=${JSON.stringify(last.resultSnap)}`);
    if (!picked.consignee) console.log(`    · body: ${last.bodySlice ?? ""}`);
  }

  if (last.sessionExpired) {
    return { receipt, resultado: "sesion_expirada", motivo: "sesión expirada", ms };
  }
  if (picked.consignee) {
    return {
      receipt,
      consignee: picked.consignee,
      n_consignatario: picked.n_consignatario,
      tracking: (last.vals[0] || "").trim() || undefined,
      resultado: "encontrado",
      ms,
    };
  }
  // Distinguimos "el receipt no existe" de "existe pero no leí el consignatario":
  // el segundo caso es un problema de selector, no un dato faltante.
  const existe = (last.vals[1] || "").trim() === receipt && !last.notFound;
  return {
    receipt,
    resultado: existe ? "sin_consignee" : "no_encontrado",
    motivo: existe ? "receipt visible pero no encontré el consignatario" : "no está en Search",
    ms,
  };
}

// ==========================================================================
//  Reconocimiento (STEPHY_CONSIGNEE_RECON=1)
// ==========================================================================

/**
 * Vuelca la ESTRUCTURA del resultado, no solo su texto. La búsqueda por receipt
 * devuelve "Box N / M" pero el consignatario no sale en el innerText, así que hay
 * que ver el HTML real para saber si está en un atributo, en un nodo oculto, o si
 * hay que abrir la caja.
 */
export const dumpResultHtmlExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  // Nodos hoja cuyo texto es "Box 1 / 3": el resultado de la búsqueda.
  const boxes = Array.from(document.querySelectorAll('*'))
    .filter((el) => el.children.length <= 2 && /Box\\s*\\d+\\s*\\/\\s*\\d+/i.test(T(el)));
  const box = boxes[0] || null;
  // Subimos hasta un ancestro con contenido real para capturar la tarjeta entera.
  let cont = box;
  for (let i = 0; i < 5 && cont && cont.parentElement; i++) {
    if (T(cont).length > 60) break;
    cont = cont.parentElement;
  }
  const clickables = Array.from(document.querySelectorAll('ion-card, ion-item, [button], [role=button], button, a, tr, ion-row'))
    .filter(vis).filter((el) => /Box\\s*\\d+/i.test(T(el)))
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 80), txt: T(el).slice(0, 80) }));
  return JSON.stringify({
    url: location.href,
    boxCount: boxes.length,
    boxTexts: boxes.slice(0, 5).map((e) => T(e).slice(0, 60)),
    containerHtml: cont ? cont.outerHTML.slice(0, 6000) : null,
    clickables: clickables.slice(0, 8),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 800),
  });
})()`;

/** Click en la primera "Box N / M" (o su tarjeta contenedora). */
export const clickFirstBoxExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const boxes = Array.from(document.querySelectorAll('*'))
    .filter((el) => vis(el) && el.children.length <= 2 && /Box\\s*\\d+\\s*\\/\\s*\\d+/i.test(T(el)));
  if (!boxes.length) return 'no-box';
  let el = boxes[0];
  for (let i = 0; i < 4 && el.parentElement; i++) {
    const c = el.closest('ion-card, ion-item, button, [role=button], tr');
    if (c) { el = c; break; }
    el = el.parentElement;
  }
  el.click();
  return 'ok';
})()`;

/**
 * Corrida de reconocimiento sobre UN receipt: busca, vuelca la estructura, abre
 * la primera caja y vuelve a volcar. Con eso se calibra el selector real del
 * consignatario sin gastar un login por intento.
 */
export async function reconOneReceipt(page: EvalPage, receipt: string): Promise<void> {
  const timing = resolveSearchTiming();
  console.log(`\n══════ RECON receipt ${receipt} ══════`);
  const inputs = await waitForSearchInputs(page);
  console.log(`· inputs de texto visibles: ${inputs}`);
  const fillRaw = (await page.evaluate(fillReceiptExpr(receipt))) as string;
  console.log(`· fill: ${fillRaw}`);
  await sleep(timing.settleMs);
  console.log(`· click Buscar: ${(await page.evaluate(clickSearchReceiptExpr)) as string}`);
  await sleep(2500);

  console.log("\n───── ANTES de abrir la caja ─────");
  console.log((await page.evaluate(dumpResultHtmlExpr)) as string);

  const click = (await page.evaluate(clickFirstBoxExpr)) as string;
  console.log(`\n· click en la primera Box: ${click}`);
  await sleep(2500);

  console.log("\n───── DESPUÉS de abrir la caja ─────");
  console.log((await page.evaluate(dumpResultHtmlExpr)) as string);
  console.log(`══════ FIN RECON ${receipt} ══════\n`);
}

// ==========================================================================
//  Loop sobre todos los receipts
// ==========================================================================

/**
 * Recorre los receipts y devuelve el consignatario de cada uno. `onBatch` permite
 * al caller ir guardando en caliente (mismo criterio de durabilidad que la
 * búsqueda de receipts: si la corrida muere a mitad, lo hallado ya está en disco).
 */
export async function searchAllConsignees(
  page: EvalPage,
  receipts: string[],
  opts: { limit?: number; batchSize?: number; onBatch?: (b: ConsigneeMatch[]) => Promise<void> } = {},
): Promise<{ resultados: ConsigneeMatch[]; sessionExpiredCount: number }> {
  const lista = receipts.map((r) => String(r).trim()).filter(Boolean);
  const total = opts.limit ? Math.min(opts.limit, lista.length) : lista.length;
  console.log(`\n→ [consignee] Buscando el consignatario de ${total} receipt(s) en /search…`);

  // Antes de nada, esperar a que el form exista. Si no aparece, abortamos con un
  // mensaje claro en vez de recorrer la lista entera devolviendo "no está".
  const inputs = await waitForSearchInputs(page);
  if (inputs < 2) {
    const dump = (await page.evaluate(dumpInputsExpr)) as string;
    console.log(
      `  ⛔ [consignee] El formulario de Search no apareció (inputs de texto visibles: ${inputs}).\n` +
        `     No busco nada: sería confundir un fallo de página con "el receipt no existe".\n` +
        `     DOM: ${dump}`,
    );
    return {
      resultados: lista.slice(0, total).map((receipt) => ({
        receipt,
        resultado: "error_pagina" as const,
        motivo: `el formulario de Search no cargó (inputs visibles: ${inputs})`,
      })),
      sessionExpiredCount: 0,
    };
  }
  console.log(`  · form de Search listo (${inputs} inputs de texto visibles).`);

  const resultados: ConsigneeMatch[] = [];
  let sessionExpiredCount = 0;
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 10;
  const pending: ConsigneeMatch[] = [];
  const flush = async () => {
    if (!pending.length || !opts.onBatch) {
      pending.length = 0;
      return;
    }
    const batch = pending.slice();
    pending.length = 0;
    try {
      await opts.onBatch(batch);
    } catch (err) {
      console.log(`  ⚠ [consignee] onBatch falló (ignorado): ${(err as Error).message}`);
    }
  };

  const timing = resolveSearchTiming();
  let sumMs = 0;

  for (let i = 0; i < total; i++) {
    const receipt = lista[i];
    const verbose = i < 3; // primeras vueltas: log detallado para calibrar
    process.stdout.write(`  [${i + 1}/${total}] receipt ${receipt} … `);
    const r = await searchOneReceipt(page, receipt, verbose, timing);
    sumMs += r.ms ?? 0;

    if (r.resultado === "sesion_expirada") {
      sessionExpiredCount++;
      console.log(`⛔ Sesión Expirada (${r.ms}ms)`);
    } else if (r.resultado === "encontrado") {
      console.log(`✓ ${r.consignee} (${r.ms}ms)`);
    } else if (r.resultado === "sin_consignee") {
      console.log(`⚠ existe pero sin consignatario legible (${r.ms}ms)`);
    } else if (r.resultado === "error_pagina") {
      console.log(`⛔ fallo de página, NO es "no existe" (${r.ms}ms)`);
    } else {
      console.log(`∅ no está (${r.ms}ms)`);
    }

    resultados.push(r);
    pending.push(r);
    if (pending.length >= batchSize) await flush();
  }
  await flush();

  const enc = resultados.filter((r) => r.resultado === "encontrado").length;
  const avg = total ? Math.round(sumMs / total) : 0;
  const errPag = resultados.filter((r) => r.resultado === "error_pagina").length;
  console.log(
    `\n  ✓ [consignee] Con consignatario: ${enc}/${total} · ` +
      `sin consignatario: ${resultados.filter((r) => r.resultado === "sin_consignee").length} · ` +
      `no están: ${resultados.filter((r) => r.resultado === "no_encontrado").length} · ` +
      `fallos de página: ${errPag} · sesión expirada: ${sessionExpiredCount} · ~${avg}ms c/u`,
  );
  if (errPag > 0) {
    console.log(
      `  ⚠ ${errPag} receipt(s) fallaron por página, NO por dato faltante: no los tomes como resueltos.`,
    );
  }
  return { resultados, sessionExpiredCount };
}
