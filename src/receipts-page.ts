/**
 * Consignatarios desde la página RECEIPTS (plan B, más barato que /search).
 *
 * La búsqueda por receipt en /search sí responde, pero solo muestra "Box N / M":
 * el consignatario no está en el resultado, habría que abrir cada caja. La lista
 * de Receipts, en cambio, ya trae el consignatario en cada fila, así que UNA
 * pasada por la lista resuelve los 50 de golpe.
 *
 * No dependemos del orden de las columnas: el consignatario en Stephy se escribe
 * `NOMBRE APELLIDO [160012]` (mismo formato que receipt_huerfano.consignee), y el
 * receipt es un número de 5-7 dígitos. Con esos dos patrones se empareja cada
 * fila sin conocer el layout, que además es lo que sobrevive a un rediseño.
 *
 * Ojo: la lista es paginada y en su día se descartó para DESCUBRIR receipts
 * porque perdía algunos. Aquí el uso es distinto —buscar 50 receipts conocidos—
 * y es seguro: al final se reporta explícitamente cuáles de los 50 se vieron y
 * cuáles no, así que una página perdida se nota en vez de pasar por "no existe".
 */

import { clickMenuItemExpr, type EvalPage } from "./search-receipts.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ReceiptRow {
  receipt: string;
  consignee: string;
  n_consignatario: number;
}

/** Con el menú ☰ abierto, entra a Receipts (igual que gotoSearchViaMenu). */
export async function gotoReceiptsViaMenu(page: EvalPage): Promise<boolean> {
  console.log("\n→ [receipts] Click en el item «Receipts» del menú ☰…");
  let res = (await page.evaluate(clickMenuItemExpr("Receipts"))) as string;
  if (res !== "ok") res = (await page.evaluate(clickMenuItemExpr("Recibos"))) as string;
  console.log(`  · click item Receipts: ${res}`);
  await page.waitForLoadState("networkidle", 8000).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (/receipt/i.test(page.url())) break;
    await sleep(500);
  }
  const ok = /receipt/i.test(page.url());
  console.log(ok ? `  ✓ En Receipts: ${page.url()}` : `  ⚠ No llegué a Receipts (URL: ${page.url()})`);
  await sleep(2000);
  return ok;
}

/**
 * Controles de la página (filtros, buscador, paginación). La lista solo muestra
 * los receipts más recientes y no trae botón "next", así que para llegar a
 * recibos viejos hay que usar su propio filtro: esto revela cuál es.
 */
export const dumpReceiptsControlsExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    placeholder: el.getAttribute('placeholder'),
    name: el.getAttribute('name'),
    formcontrolname: el.getAttribute('formcontrolname'),
    ariaLabel: el.getAttribute('aria-label'),
    txt: T(el).slice(0, 40),
    visible: vis(el),
  });
  // Fuera el ruido: hay un checkbox oculto por FILA de la tabla y ahogaba el volcado.
  const utiles = Array.from(document.querySelectorAll('input, ion-input, ion-searchbar, ion-datetime'))
    .filter((el) => {
      const t = (el.getAttribute('type') || '').toLowerCase();
      return t !== 'checkbox' && t !== 'hidden' && t !== 'radio';
    })
    .map(desc);
  return JSON.stringify({
    inputs: utiles.slice(0, 15),
    selects: Array.from(document.querySelectorAll('select, ion-select, mat-select')).map(desc).slice(0, 15),
    buttons: Array.from(document.querySelectorAll('button, ion-button, [role=button]'))
      .filter(vis).map((el) => T(el).slice(0, 30)).filter(Boolean).slice(0, 30),
    iconBtns: Array.from(document.querySelectorAll('ion-icon')).filter(vis)
      .map((el) => el.getAttribute('name')).filter(Boolean).slice(0, 25),
    hasInfinite: !!document.querySelector('ion-infinite-scroll'),
  });
})()`;

/** Muestra: nº de filas + primeros/últimos receipts, para ver si el filtro amplió el rango. */
export const sampleRowsExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const rows = Array.from(document.querySelectorAll('tr, ion-row, ion-item, .row')).filter(vis).map(T);
  const recs = rows.map((t) => (t.match(/^(\\d{5,7})\\b/) || [])[1]).filter(Boolean);
  return JSON.stringify({ filas: rows.length, receipts: recs.length, primeros: recs.slice(0, 3), ultimos: recs.slice(-3) });
})()`;

/** Click en el botón "All" (parece alternar entre "solo míos" y todos). */
export const clickAllButtonExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).trim().toUpperCase();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const b = Array.from(document.querySelectorAll('button, ion-button, [role=button]')).filter(vis)
    .find((el) => T(el) === 'ALL');
  if (!b) return 'no-all';
  b.click();
  return 'ok';
})()`;

/** Pone todos los <select> en su primera opción ("-----" = sin filtrar). */
export const clearSelectsExpr = `(() => {
  const sels = Array.from(document.querySelectorAll('select'));
  if (!sels.length) return 'no-selects';
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  const res = [];
  for (const s of sels) {
    const opts = Array.from(s.options).map((o) => o.value + '=' + o.text.trim());
    set.call(s, s.options[0].value);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    s.dispatchEvent(new Event('input', { bubbles: true }));
    res.push(opts.join('|'));
  }
  return JSON.stringify(res);
})()`;

/** Click en el ícono "filter" de la barra superior. */
export const clickFilterIconExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const ic = Array.from(document.querySelectorAll('ion-icon')).filter(vis)
    .find((el) => (el.getAttribute('name') || '') === 'filter');
  if (!ic) return 'no-filter-icon';
  (ic.closest('button, ion-button, [role=button]') || ic).click();
  return 'ok';
})()`;

/**
 * Mapea cada control del panel de filtro con su ETIQUETA. Los inputs no traen
 * placeholder ni formcontrolname, así que la única forma de saber cuál es el
 * número de receipt es leer el texto que los rodea.
 */
export const dumpFilterPanelExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  // Contenedor del panel: el ancestro del botón Apply.
  const apply = Array.from(document.querySelectorAll('button, ion-button')).filter(vis)
    .find((el) => /APPLY|APLICAR/i.test(T(el)));
  let panel = apply;
  for (let i = 0; i < 6 && panel && panel.parentElement; i++) {
    if (panel.querySelectorAll('input').length >= 3) break;
    panel = panel.parentElement;
  }
  if (!panel) return JSON.stringify({ error: 'sin panel' });
  const campos = Array.from(panel.querySelectorAll('input, select')).map((el, i) => {
    // Etiqueta: ion-item/label contenedor, o el texto del bloque padre.
    let lab = '';
    const item = el.closest('ion-item, .item, label, ion-col, div');
    if (item) lab = T(item).slice(0, 60);
    let p = el.parentElement, up = '';
    for (let k = 0; k < 3 && p; k++) { const t = T(p); if (t && t.length < 80) { up = t; break; } p = p.parentElement; }
    const r = el.getBoundingClientRect();
    return { i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), visible: vis(el),
      x: Math.round(r.left), y: Math.round(r.top), label: lab, cerca: up };
  });
  return JSON.stringify({ panelText: T(panel).slice(0, 700), campos });
})()`;

/** Pone el select de estatus en "Sent" (los receipts viejos ya salieron). */
export const setStatusSentExpr = `(() => {
  const sels = Array.from(document.querySelectorAll('select'));
  const s = sels.find((x) => Array.from(x.options).some((o) => /sent/i.test(o.text)));
  if (!s) return 'no-select';
  const opt = Array.from(s.options).find((o) => /sent/i.test(o.text));
  const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  set.call(s, opt.value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
  s.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok:' + opt.value + '=' + opt.text.trim();
})()`;

/**
 * Escribe en el campo "Receipt Number" del panel de filtro. Los inputs no traen
 * placeholder ni formcontrolname, así que se identifica por la etiqueta que lo
 * rodea (verificado con RECON: label "Receipt Number").
 */
export const fillReceiptNumberExpr = (value: string) => `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return (t === 'text' || t === '') && vis(el);
  });
  const target = inputs.find((el) => {
    const c = el.closest('ion-item, .item, label, ion-col, div');
    return c && /receipt\\s*number/i.test(T(c));
  });
  if (!target) return JSON.stringify({ res: 'no-campo', candidatos: inputs.length });
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  target.focus();
  set.call(target, ${JSON.stringify(value)});
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.dispatchEvent(new Event('blur', { bubbles: true }));
  return JSON.stringify({ res: 'ok' });
})()`;

/** Click en "Apply" del panel de filtro. */
export const clickApplyExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).trim().toUpperCase();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const b = Array.from(document.querySelectorAll('button, ion-button, [role=button]')).filter(vis)
    .find((el) => /^(APPLY|APLICAR)$/.test(T(el)));
  if (!b) return 'no-apply';
  b.click();
  return 'ok';
})()`;

/** ¿Está abierto el panel de filtro? (hay un botón Apply visible) */
export const filterOpenExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).trim().toUpperCase();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  return Array.from(document.querySelectorAll('button, ion-button')).filter(vis)
    .some((el) => /^(APPLY|APLICAR)$/.test(T(el))) ? 'abierto' : 'cerrado';
})()`;

/**
 * Busca UN receipt por el filtro "Receipt Number" y devuelve su fila. Es la vía
 * que sí llega a recibos viejos: la lista por defecto solo trae los recientes.
 */
export async function lookupReceiptViaFilter(
  page: EvalPage,
  receipt: string,
  verbose = false,
): Promise<ReceiptRow | null> {
  if (((await page.evaluate(filterOpenExpr)) as string) === "cerrado") {
    const abre = (await page.evaluate(clickFilterIconExpr)) as string;
    if (abre !== "ok") {
      if (verbose) console.log(`    · no pude abrir el filtro (${abre})`);
      return null;
    }
    await sleep(1200);
  }
  const fill = JSON.parse((await page.evaluate(fillReceiptNumberExpr(receipt))) as string) as {
    res: string;
    candidatos?: number;
  };
  if (fill.res !== "ok") {
    if (verbose) console.log(`    · no hallé el campo Receipt Number (${JSON.stringify(fill)})`);
    return null;
  }
  const apply = (await page.evaluate(clickApplyExpr)) as string;
  if (apply !== "ok") {
    if (verbose) console.log(`    · no pude aplicar (${apply})`);
    return null;
  }
  await page.waitForLoadState("networkidle", 6000).catch(() => {});

  // Poll: esperamos a que la tabla refleje el filtro.
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const raw = (await page.evaluate(scrapeReceiptsExpr)) as string;
    let filas: (ReceiptRow & { raw?: string })[] = [];
    try {
      filas = JSON.parse(raw) as (ReceiptRow & { raw?: string })[];
    } catch {
      filas = [];
    }
    if (verbose && i === 0) {
      console.log(`    · poll[0]: ${filas.length} fila(s) legibles; primeras: ${JSON.stringify(filas.slice(0, 3))}`);
    }
    const hit = filas.find((f) => f.receipt === receipt.trim());
    if (hit) {
      if (verbose) console.log(`    · fila: ${hit.raw ?? ""}`);
      return { receipt: hit.receipt, consignee: hit.consignee, n_consignatario: hit.n_consignatario };
    }
    // Si quedó UNA sola fila y no matchea el número, igual puede ser el receipt
    // buscado con el número escrito distinto: lo tomamos solo si es inequívoco.
    if (filas.length === 1 && i >= 6) {
      const f = filas[0];
      if (verbose) console.log(`    · única fila (número no idéntico): ${f.raw ?? ""}`);
      return { receipt: receipt.trim(), consignee: f.consignee, n_consignatario: f.n_consignatario };
    }
  }
  return null;
}

/** Cuenta filas de datos (para detectar si el scroll infinito carga más). */
export const countRowsExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  return String(Array.from(document.querySelectorAll('tr, ion-row, ion-item, .row')).filter(vis).length);
})()`;

/** Scroll al fondo del contenedor scrolleable (dispara el infinite-scroll si existe). */
export const scrollBottomExpr = `(() => {
  const cont = document.querySelector('ion-content');
  if (cont && cont.getScrollElement) {
    cont.getScrollElement().then((el) => { el.scrollTop = el.scrollHeight; });
    return 'ion-content';
  }
  const sc = Array.from(document.querySelectorAll('*')).find((el) => el.scrollHeight > el.clientHeight + 200);
  if (sc) { sc.scrollTop = sc.scrollHeight; return 'elem'; }
  window.scrollTo(0, document.body.scrollHeight);
  return 'window';
})()`;

/** Recon de la estructura de la lista, por si hay que recalibrar. */
export const dumpReceiptsExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const rows = Array.from(document.querySelectorAll('tr, ion-row, ion-item, .row')).filter(vis);
  return JSON.stringify({
    url: location.href,
    rowCount: rows.length,
    sample: rows.slice(0, 6).map((r) => T(r).slice(0, 220)),
    headers: Array.from(document.querySelectorAll('th, ion-col.header, thead *')).filter(vis).map(T).slice(0, 15),
    bodySlice: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
  });
})()`;

/**
 * Extrae `receipt → consignatario` de las filas visibles. Empareja por patrón
 * (número de recibo + `NOMBRE [num]`), no por posición de columna.
 */
export const scrapeReceiptsExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const out = [];

  // --- Camino BUENO: leer por CELDA usando el índice del encabezado ---------
  // Antes se parseaba el texto plano de la fila y se tomaba el primer
  // "NOMBRE [num]" que no fuera un shipper conocido. Eso fallaba en cuanto
  // aparecía un transporte fuera de la lista (GOFO), que se colaba como
  // consignatario. La tabla tiene encabezados, así que la columna correcta se
  // puede pedir por nombre y no hay que adivinar nada.
  for (const table of Array.from(document.querySelectorAll('table')).filter(vis)) {
    const heads = Array.from(table.querySelectorAll('th')).map(T);
    if (!heads.length) continue;
    const iRec = heads.findIndex((h) => /^receipt$/i.test(h));
    const iCon = heads.findIndex((h) => /^(consignee|consignatario)$/i.test(h));
    if (iRec < 0 || iCon < 0) continue;
    for (const tr of Array.from(table.querySelectorAll('tr')).filter(vis)) {
      const cells = Array.from(tr.children).map(T);
      if (cells.length <= Math.max(iRec, iCon)) continue;
      const receipt = (cells[iRec] || '').trim();
      const consRaw = (cells[iCon] || '').trim();
      if (!/^\\d{4,8}$/.test(receipt) || !consRaw) continue;
      const m = /^(.*?)\\s*\\[(\\d{3,8})\\]$/.exec(consRaw);
      if (!m) continue;
      out.push({
        receipt,
        consignee: m[1].trim() + ' [' + m[2] + ']',
        n_consignatario: Number(m[2]),
        raw: T(tr).slice(0, 160),
        via: 'celda',
      });
    }
  }
  if (out.length) return JSON.stringify(out);

  // --- Fallback: sin encabezados legibles, heurística por texto ------------
  // Solo se usa si la tabla cambia de forma. Se amplía la lista de no-clientes
  // con los transportes que Stephy lista en su propio filtro.
  const NO_CLIENTE = /amazon|shein|walmart|temu|aliexpress|shipping\\s+depar|fulfil|fullfil|gofo|swiftx|speedx|yanwen|usps|laser\\s*ship|fedex|\\bups\\b|\\bdhl\\b|\\bems\\b|estes|ceva|conway|transexpress|tecnoship|pick\\s*up|prime\\s*amz|inditex|flamingo|roadway|roadrunner|old\\s*dominion|southeastern|pilot\\s*freight|abf\\s*freight|aaa\\s*cooper|\\btnt\\b|\\bsaja\\b|\\bself\\b|\\bsell\\b|\\btip\\s*top\\b|\\b3m\\b/i;
  for (const row of Array.from(document.querySelectorAll('tr, ion-row, ion-item, .row')).filter(vis)) {
    const txt = T(row);
    if (!txt || txt.length > 600) continue;
    const partes = [];
    // El nombre NO puede traer dígitos ni comas: así no se traga el nº de
    // recibo ni la fecha que lo preceden en el texto de la fila.
    const rx = /([A-Za-zÁÉÍÓÚÑÜáéíóúñü.&'\\- ]{2,60}?)\\s*\\[(\\d{3,8})\\]/g;
    let m;
    while ((m = rx.exec(txt)) !== null) partes.push({ nombre: (m[1] || '').trim(), num: m[2] });
    // El consignatario es la ÚLTIMA columna con ese formato (va después del shipper).
    const cands = partes.filter((p) => p.nombre && !NO_CLIENTE.test(p.nombre));
    const cons = cands[cands.length - 1];
    if (!cons) continue;
    const nums = (txt.match(/(?<![\\d\\[])\\d{5,7}(?![\\d\\]])/g) || [])
      .filter((n) => !partes.some((p) => p.num === n));
    if (!nums.length) continue;
    out.push({ receipt: nums[0], consignee: cons.nombre + ' [' + cons.num + ']', n_consignatario: Number(cons.num), raw: txt.slice(0, 160), via: 'texto' });
  }
  return JSON.stringify(out);
})()`;

/** Click en "siguiente página". Devuelve 'ok' | 'no-next' | 'disabled'. */
export const clickNextPageExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || e.getAttribute('aria-label') || '')).trim().toUpperCase();
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const cands = Array.from(document.querySelectorAll('button, ion-button, [role=button], a, ion-icon')).filter(vis);
  const next = cands.find((el) => {
    const t = T(el);
    return t === 'NEXT' || t === 'SIGUIENTE' || t === '>' || t === '›' ||
      /chevron-forward|arrow-forward|next/i.test(el.getAttribute('name') || '') ||
      /chevron-forward|arrow-forward/i.test(el.getAttribute('icon') || '');
  });
  if (!next) return 'no-next';
  const el = next.closest('button, ion-button, [role=button], a') || next;
  if (el.disabled || el.classList.contains('button-disabled') || el.getAttribute('aria-disabled') === 'true') return 'disabled';
  el.click();
  return 'ok';
})()`;

/**
 * Resuelve `receipt → consignatario` usando el FILTRO de la página.
 *
 * La lista por defecto solo trae los receipts recientes (y no hay paginación ni
 * scroll infinito que llegue atrás), así que recorrerla no sirve para recibos
 * viejos. El panel de filtro sí tiene un campo "Receipt Number": se busca uno
 * por uno.
 *
 * Antes del lote corre un CONTROL con un receipt que sabemos presente (el más
 * reciente de la lista). Si el control falla, el mecanismo está roto y se aborta
 * en vez de reportar 50 "no está" — que es justo el error que ya cometimos una vez.
 */
export async function scrapeReceiptsForConsignees(
  page: EvalPage,
  buscados: string[],
  opts: { onProgress?: (hechos: number, total: number) => Promise<void> } = {},
): Promise<{ mapa: Map<string, ReceiptRow>; paginas: number }> {
  const mapa = new Map<string, ReceiptRow>();
  const lista = buscados.map((r) => r.trim()).filter(Boolean);

  // --- Control: ¿funciona el filtro? -------------------------------------
  const rawIni = (await page.evaluate(scrapeReceiptsExpr)) as string;
  let control = "";
  try {
    const filas = JSON.parse(rawIni) as ReceiptRow[];
    control = filas[0]?.receipt ?? "";
  } catch {
    control = "";
  }
  if (control) {
    console.log(`\n  · [receipts] CONTROL con un receipt presente (${control})…`);
    const ok = await lookupReceiptViaFilter(page, control, true);
    if (!ok) {
      // Diagnóstico: distinguir "el filtro no filtró" de "el scraping no lee".
      // Sin esto solo sabemos que falló, no por qué, y cada intento cuesta un login.
      const crudo = (await page.evaluate(scrapeReceiptsExpr)) as string;
      const estruct = (await page.evaluate(dumpReceiptsExpr)) as string;
      console.log(
        `  ⛔ [receipts] El control falló: el filtro no devuelve ni un receipt que SÍ está en la lista.\n` +
          `     Aborto: reportar "no está" para los ${lista.length} sería un falso negativo.\n` +
          `     · scrape devolvió: ${crudo.slice(0, 700)}\n` +
          `     · estructura: ${estruct.slice(0, 900)}`,
      );
      return { mapa, paginas: 0 };
    }
    console.log(`  ✓ [receipts] Control OK → ${ok.consignee}. El filtro sirve.`);
  } else {
    console.log("  ⚠ [receipts] Sin receipt de control (lista vacía); sigo igual, pero ojo con los resultados.");
  }

  // --- Lote real ---------------------------------------------------------
  for (let i = 0; i < lista.length; i++) {
    const receipt = lista[i];
    process.stdout.write(`  [${i + 1}/${lista.length}] receipt ${receipt} … `);
    const t0 = Date.now();
    const hit = await lookupReceiptViaFilter(page, receipt, i < 2);
    const ms = Date.now() - t0;
    if (hit) {
      mapa.set(receipt, hit);
      console.log(`✓ ${hit.consignee} (${ms}ms)`);
    } else {
      console.log(`∅ sin resultado (${ms}ms)`);
    }
    if (opts.onProgress) await opts.onProgress(i + 1, lista.length);
  }

  console.log(`\n  ✓ [receipts] ${mapa.size}/${lista.length} receipt(s) resueltos vía filtro.`);
  const faltan = lista.filter((r) => !mapa.has(r));
  if (faltan.length) console.log(`  ⚠ Sin resultado: ${faltan.join(", ")}`);
  return { mapa, paginas: 1 };
}

/**
 * Entra a Receipts por URL directa. Es el plan B cuando el menú ☰ queda
 * atrapado en el bucle de alertas (el "Cancelar" refresca la página y el alert
 * vuelve). Se verifica que la tabla exista de verdad antes de dar OK: navegar
 * dentro de esta SPA a veces cae en "Sesión Expirada" y devolver true sin
 * comprobar haría que el lote entero reportara falsos "no está".
 */
export async function gotoReceiptsDirect(page: EvalPage, url: string): Promise<boolean> {
  console.log(`\n→ [receipts] Menú no disponible; entro directo a ${url} …`);
  if (!page.goto) {
    console.log("  ⚠ La página no expone goto(); no puedo intentar la vía directa.");
    return false;
  }
  await page.goto(url).catch(() => {});
  await page.waitForLoadState("networkidle", 8000).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await sleep(600);
    const est = (await page.evaluate(dumpReceiptsExpr)) as string;
    try {
      const j = JSON.parse(est) as { rowCount: number; headers: string[]; bodySlice: string };
      if (/sesi[oó]n expirada|session expired/i.test(j.bodySlice || "")) {
        console.log("  ⛔ La vía directa cayó en «Sesión Expirada».");
        return false;
      }
      if ((j.headers || []).some((h) => /consignee/i.test(h))) {
        console.log(`  ✓ Tabla de Receipts visible (${j.rowCount} filas).`);
        return true;
      }
    } catch {
      /* aún cargando */
    }
  }
  console.log("  ⚠ La tabla de Receipts no apareció por la vía directa.");
  return false;
}
