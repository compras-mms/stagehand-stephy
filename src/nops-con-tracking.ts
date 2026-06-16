import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NOPs con tracking ←→ Receipts (StephyTracking).
 *
 * Flujo completo de una corrida de `pnpm stephy`:
 *   1. (pre-navegador) runNopsConTracking(): dispara el workflow n8n
 *      "nops-con-tracking", trae los NOPs con tracking de proveedor (pero sin
 *      tracking de courier) + su id_venta, y los guarda como archivo de TRABAJO
 *      en data/nops-con-tracking.json.
 *   2. (en la página Receipts) searchReceiptsForNops(): la tabla está PAGINADA;
 *      detecta cuántas páginas hay, recorre TODAS, y por cada tracking_proveedor
 *      del JSON busca su fila y toma el número de Receipt asociado.
 *   3. finalizeRunHistory(): escribe 3 archivos en una carpeta history/<fecha_hora>/
 *      (nops-con-tracking.json + receipts-encontrados.json +
 *      receipts-no-encontrados.json) y borra el archivo de trabajo de data/.
 *
 * Todo es best-effort: un fallo de n8n o del scraping NO rompe el login.
 */

const WEBHOOK_URL =
  process.env.NOPS_TRACKING_WEBHOOK_URL ??
  "https://n8n-n8n.40j1oe.easypanel.host/webhook/nops-con-tracking";

// Webhook de ESCRITURA (paso 5 del skill actualizar-receipts-stephy-mamasan):
// recibe [{tracking_proveedor, receipt}], hace los UPDATEs idempotentes en
// detalle_producto_venta + shipping_groups y pone estatus 'Con recibo Almacen
// Miami'. Idempotente (excluye filas con courier ya cargado).
const ACTUALIZAR_RECEIPTS_WEBHOOK_URL =
  process.env.ACTUALIZAR_RECEIPTS_WEBHOOK_URL ??
  "https://n8n-n8n.40j1oe.easypanel.host/webhook/actualizar-receipts";

// data/ vive en la raíz del proyecto (este archivo está en src/).
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const HISTORY_DIR = join(DATA_DIR, "history");
const LIVE_JSON = join(DATA_DIR, "nops-con-tracking.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Timestamp local `YYYY-MM-DD_HH-mm-ss` (seguro para nombre de carpeta). */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

// --- Tipos ----------------------------------------------------------------

interface NopDetalle {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor?: string | string[];
}

export interface NopsResponse {
  total_nops?: number;
  total_productos?: number;
  nops_array?: string[];
  nops_detalle?: NopDetalle[];
  items?: unknown[];
  [key: string]: unknown;
}

interface ReceiptRow {
  receipt: string;
  date: string;
  shipper: string;
  consignee: string;
  status: string;
  trackings: string;
}

interface Snapshot {
  ok: boolean;
  reason?: string;
  rows?: ReceiptRow[];
  pager?: { pages: number[]; active: number | null; max: number };
}

interface MatchResult {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt?: string;
  fecha?: string;
  shipper?: string;
  consignee?: string;
  status?: string;
  motivo?: string;
}

/** Respuesta del webhook `actualizar-receipts` (write-back a Supabase). */
export interface PersistResponse {
  // Rama de escritura real:
  detalle_actualizados?: number | string;
  grupos_actualizados?: number | string;
  // Rama preview (dry-run, no escribe): cuántas filas CAMBIARÍAN.
  preview?: boolean;
  detalle_a_actualizar?: number | string;
  grupos_a_actualizar?: number | string;
  // En ambas ramas: filas afectadas (detalle/grupos), con valores actual vs nuevo en preview.
  detalle?: unknown[];
  grupos?: unknown[];
  [key: string]: unknown;
}

/** Página mínima (subconjunto de la page de Stagehand) que usamos aquí. */
type EvalPage = {
  evaluate: (expr: string) => Promise<unknown>;
  url: () => string;
  waitForLoadState: (state: "networkidle") => Promise<unknown>;
};

// ==========================================================================
//  1. Disparar n8n y guardar el archivo de trabajo
// ==========================================================================

/**
 * Dispara el workflow "nops-con-tracking" y guarda la respuesta en
 * data/nops-con-tracking.json (archivo de TRABAJO; se archiva/borra al final
 * en finalizeRunHistory). Devuelve el payload (o null si falla). No lanza.
 */
export async function runNopsConTracking(): Promise<NopsResponse | null> {
  console.log(`\n→ [n8n] Disparando workflow "nops-con-tracking"…`);
  console.log(`  POST ${WEBHOOK_URL}`);

  let data: NopsResponse;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      console.log(`⚠ [n8n] El webhook respondió HTTP ${res.status}. Continúo sin los NOPs.`);
      return null;
    }
    data = (await res.json()) as NopsResponse;
  } catch (err) {
    console.log(`⚠ [n8n] No se pudo contactar el webhook: ${(err as Error).message}.`);
    console.log("  Continúo con el flujo del navegador de todas formas.");
    return null;
  }

  console.log(
    `✓ [n8n] Recibidos ${data.total_nops ?? "?"} NOPs con tracking ` +
      `(${data.total_productos ?? "?"} productos).`,
  );

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LIVE_JSON, JSON.stringify(data, null, 2), "utf8");
  console.log(`  💾 Guardado (trabajo) en data/nops-con-tracking.json`);

  return data;
}

// ==========================================================================
//  2. Scraping de la tabla de Receipts (paginada) + matching
// ==========================================================================

// Lee la tabla de Receipts: elige la tabla de datos, mapea columnas por el
// texto de la cabecera, devuelve filas {receipt,date,shipper,consignee,status,
// trackings} y la info del paginador (páginas, activa, máx). Se ejecuta en el
// navegador como string (patrón evaluate del proyecto). Los `\\` escapan las
// regex para que sobrevivan al string.
export const SCRAPE_EXPR = `(() => {
  const T = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll('table'));
  let best = null, bestScore = -1;
  for (const t of tables) {
    const h = ((t.querySelector('thead') || t).innerText || '').toLowerCase();
    let score = 0;
    if (h.includes('tracking')) score += 3;
    if (h.includes('receipt')) score += 2;
    if (h.includes('consignee')) score += 1;
    score += Math.min(t.querySelectorAll('tr').length, 200) / 1000;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (!best) return { ok: false, reason: 'no-table' };
  const headerRow = best.querySelector('thead tr') || best.querySelector('tr');
  const headers = Array.from(headerRow ? headerRow.children : []).map((c) => T(c).toLowerCase());
  const idxOf = (kw) => headers.findIndex((x) => x.includes(kw));
  const iRec = idxOf('receipt'), iTrk = idxOf('tracking'), iDate = idxOf('date'),
        iShip = idxOf('shipper'), iCons = idxOf('consignee'), iStat = idxOf('status');
  const bodyRows = best.querySelector('tbody')
    ? Array.from(best.querySelectorAll('tbody tr'))
    : Array.from(best.querySelectorAll('tr')).slice(1);
  const cell = (cells, i) => (i >= 0 && cells[i] ? T(cells[i]) : '');
  const rows = [];
  for (const r of bodyRows) {
    const cells = Array.from(r.children);
    if (!cells.length) continue;
    const recTxt = cell(cells, iRec);
    const recNum = (recTxt.match(/\\d{3,}/) || [''])[0];
    const trk = cell(cells, iTrk);
    if (!recNum && !trk) continue;
    rows.push({
      receipt: recNum || recTxt,
      date: cell(cells, iDate),
      shipper: cell(cells, iShip),
      consignee: cell(cells, iCons),
      status: cell(cells, iStat),
      trackings: trk,
    });
  }
  const clickable = Array.from(document.querySelectorAll('a,button,li,span,div,ion-button'));
  const isPrev = (e) => /previous/i.test(T(e)) && T(e).length < 20;
  const isNext = (e) => /^next(\\s*»)?$/i.test(T(e)) || T(e).toLowerCase() === 'next';
  const prevEl = clickable.find(isPrev);
  let container = null, n = prevEl;
  for (let k = 0; k < 6 && n; k++) { n = n.parentElement; if (n && /next/i.test(n.innerText || '')) { container = n; break; } }
  if (!container) { const nx = clickable.find(isNext); container = (nx && nx.parentElement) || document.body; }
  const links = Array.from(container.querySelectorAll('a,button,li,span'));
  const nums = [];
  let active = null;
  for (const e of links) {
    const t = T(e);
    if (/^\\d{1,3}$/.test(t)) {
      const v = Number(t);
      if (!nums.includes(v)) nums.push(v);
      const cl = (e.className || '') + ' ' + ((e.closest('li') || {}).className || '');
      if (/active|selected|current/i.test(cl)) active = v;
    }
  }
  nums.sort((a, b) => a - b);
  return { ok: true, rows, pager: { pages: nums, active, max: nums.length ? nums[nums.length - 1] : 1 } };
})()`;

// Click en el link de página `n` dentro del cluster del paginador.
export const clickPageExpr = (npage: number) => `(() => {
  const T = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const clickable = Array.from(document.querySelectorAll('a,button,li,span,div,ion-button'));
  const isPrev = (e) => /previous/i.test(T(e)) && T(e).length < 20;
  const isNext = (e) => /^next(\\s*»)?$/i.test(T(e)) || T(e).toLowerCase() === 'next';
  const prevEl = clickable.find(isPrev);
  let container = null, n = prevEl;
  for (let k = 0; k < 6 && n; k++) { n = n.parentElement; if (n && /next/i.test(n.innerText || '')) { container = n; break; } }
  if (!container) { const nx = clickable.find(isNext); container = (nx && nx.parentElement) || document.body; }
  const want = ${JSON.stringify(String(npage))};
  const links = Array.from(container.querySelectorAll('a,button,li,span'));
  const target = links.find((e) => T(e) === want && e.offsetParent !== null);
  if (!target) return 'no-target';
  target.click();
  return 'ok';
})()`;

const settle = async (page: EvalPage) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await sleep(1200);
};

// Click el elemento VISIBLE cuyo texto recortado es EXACTAMENTE `label`
// (preferimos el más específico/hoja). Se usa para el botón "All" de Receipts,
// que muestra TODOS los recibos (Punto C) en vez del subconjunto por defecto.
export const clickExactTextExpr = (label: string) => `(() => {
  const T = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\\s+/g, ' ').trim();
  const want = ${JSON.stringify(label)};
  const els = Array.from(document.querySelectorAll('button, ion-button, [role=button], a, span, li'));
  const vis = els.filter((e) => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return T(e) === want && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
  if (!vis.length) return 'no-target';
  vis.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
  vis[0].click();
  return 'ok';
})()`;

/**
 * Punto C: antes de scrapear, intenta mostrar TODOS los recibos clickeando el
 * botón "All" de la página Receipts (por defecto la tabla viene filtrada/paginada
 * a un subconjunto). Best-effort: si no halla el botón, sigue igual.
 */
async function showAllReceipts(page: EvalPage): Promise<void> {
  const res = (await page.evaluate(clickExactTextExpr("All"))) as string;
  console.log(`  ⓘ Botón "All" (mostrar todos los recibos): ${res}.`);
  if (res === "ok") {
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(1800);
  }
}

/** Tokeniza la celda de Trackings (puede traer varios). */
function splitTokens(s: string | undefined): string[] {
  return String(s ?? "")
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Recorre TODAS las páginas de la tabla de Receipts y acumula las filas. */
async function scrapeAllPages(page: EvalPage): Promise<ReceiptRow[]> {
  const init = (await page.evaluate(SCRAPE_EXPR)) as Snapshot;
  if (!init || !init.ok) {
    console.log("  ⚠ No se halló la tabla de recibos; devuelvo vacío.");
    return [];
  }
  const max = Math.max(1, init.pager?.max ?? 1);
  console.log(`  ⓘ Páginas detectadas: ${max}.`);

  const seen = new Set<string>();
  const all: ReceiptRow[] = [];
  const pushRows = (rows: ReceiptRow[] | undefined) => {
    for (const r of rows ?? []) {
      const k = `${r.receipt}|${r.trackings}`;
      if (!seen.has(k)) {
        seen.add(k);
        all.push(r);
      }
    }
  };

  for (let p = 1; p <= max; p++) {
    let snap = (await page.evaluate(SCRAPE_EXPR)) as Snapshot;
    const active = snap?.pager?.active ?? null;
    if (active !== p) {
      const res = (await page.evaluate(clickPageExpr(p))) as string;
      if (res !== "ok") console.log(`  ⚠ No pude navegar a la página ${p} (${res}).`);
      await settle(page);
      snap = (await page.evaluate(SCRAPE_EXPR)) as Snapshot;
    }
    if (snap?.ok) {
      pushRows(snap.rows);
      console.log(`  · Página ${p}: ${(snap.rows ?? []).length} filas (acum. ${all.length}).`);
    }
  }
  return all;
}

/**
 * En la página Receipts: scrapea todas las páginas y cruza cada
 * tracking_proveedor del JSON de NOPs contra la columna Trackings.
 * Devuelve listas de encontrados (con su Receipt) y no encontrados.
 */
export async function searchReceiptsForNops(
  page: EvalPage,
  nopsData: NopsResponse,
): Promise<{ encontrados: MatchResult[]; noEncontrados: MatchResult[]; totalRecibos: number }> {
  console.log("\n→ [receipts] Buscando los trackings en Receipts (tabla paginada)…");
  await showAllReceipts(page);
  const receipts = await scrapeAllPages(page);
  console.log(`  ✓ Recibos recolectados (todas las páginas): ${receipts.length}.`);

  // Índice tracking-token → fila de recibo.
  const byToken = new Map<string, ReceiptRow>();
  for (const r of receipts) {
    for (const tok of splitTokens(r.trackings)) {
      const key = tok.toUpperCase();
      if (!byToken.has(key)) byToken.set(key, r);
    }
  }

  const detalle = Array.isArray(nopsData.nops_detalle) ? nopsData.nops_detalle : [];
  const encontrados: MatchResult[] = [];
  const noEncontrados: MatchResult[] = [];

  for (const d of detalle) {
    const track = Array.isArray(d.tracking_proveedor)
      ? String(d.tracking_proveedor[0] ?? "")
      : String(d.tracking_proveedor ?? "");
    const trimmed = track.trim();
    if (!trimmed) {
      noEncontrados.push({ nop: d.nop, id_venta: d.id_venta, tracking_proveedor: trimmed, motivo: "sin tracking_proveedor" });
      continue;
    }
    const key = trimmed.toUpperCase();
    let row = byToken.get(key);
    if (!row) {
      // Fallback por "contiene" (por si la celda agrupa varios o difiere el formato).
      row = receipts.find((rr) => (rr.trackings || "").toUpperCase().includes(key));
    }
    if (row) {
      encontrados.push({
        nop: d.nop,
        id_venta: d.id_venta,
        tracking_proveedor: trimmed,
        receipt: row.receipt,
        fecha: row.date,
        shipper: row.shipper,
        consignee: row.consignee,
        status: row.status,
      });
    } else {
      noEncontrados.push({ nop: d.nop, id_venta: d.id_venta, tracking_proveedor: trimmed, motivo: "no está en Receipts" });
    }
  }

  console.log(`  ✓ Encontrados: ${encontrados.length} · No encontrados: ${noEncontrados.length}`);
  return { encontrados, noEncontrados, totalRecibos: receipts.length };
}

// ==========================================================================
//  2.5. Write-back a Supabase (paso 5 del skill) vía webhook actualizar-receipts
// ==========================================================================

/**
 * Persiste los matches en Supabase: POST [{tracking_proveedor, receipt}] al
 * webhook `actualizar-receipts`, que hace los UPDATEs idempotentes en
 * detalle_producto_venta + shipping_groups y pone estatus 'Con recibo Almacen
 * Miami'. Best-effort: cualquier fallo se loguea y devuelve null sin lanzar.
 * Devuelve la respuesta del webhook (para archivarla en el history).
 *
 * Punto D — modo preview (dry-run): con `{ preview: true }` el webhook hace
 * SELECT en vez de UPDATE y devuelve qué filas CAMBIARÍAN (valor actual vs
 * nuevo) SIN escribir nada. Útil para auditar antes de persistir.
 */
export async function persistMatches(
  encontrados: MatchResult[],
  opts: { preview?: boolean } = {},
): Promise<PersistResponse | null> {
  const preview = !!opts.preview;
  const tag = preview ? "PREVIEW/dry-run, no escribe" : "escritura";
  const payload = encontrados
    .filter((e) => e.tracking_proveedor?.trim() && e.receipt?.trim())
    .map((e) => ({
      tracking_proveedor: e.tracking_proveedor.trim(),
      receipt: String(e.receipt).trim(),
    }));

  console.log(
    `\n→ [n8n] ${preview ? "Previsualizando" : "Persistiendo"} ${payload.length} ` +
      `match(es) en Supabase (actualizar-receipts · ${tag})…`,
  );

  if (payload.length === 0) {
    console.log("  ⓘ No hay matches con receipt; nada que procesar.");
    return preview
      ? { preview: true, detalle_a_actualizar: 0, grupos_a_actualizar: 0, detalle: [], grupos: [] }
      : { detalle_actualizados: 0, grupos_actualizados: 0, detalle: [], grupos: [] };
  }

  console.log(`  POST ${ACTUALIZAR_RECEIPTS_WEBHOOK_URL}`);
  // En preview se envía {matches, preview:true}; sin preview, el array tal cual
  // (contrato histórico del webhook).
  const body = preview ? JSON.stringify({ matches: payload, preview: true }) : JSON.stringify(payload);
  try {
    const res = await fetch(ACTUALIZAR_RECEIPTS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      console.log(
        `⚠ [n8n] actualizar-receipts respondió HTTP ${res.status}. No se ${preview ? "previsualizó" : "persistió"}.`,
      );
      return null;
    }
    // El "Respond to Webhook" puede devolver el objeto suelto o dentro de un array.
    const raw = (await res.json()) as PersistResponse | PersistResponse[];
    const data = Array.isArray(raw) ? raw[0] ?? {} : raw;
    if (preview) {
      console.log(
        `✓ [n8n] PREVIEW (NO se escribió nada): cambiarían ${data.detalle_a_actualizar ?? "?"} ` +
          `producto(s) en detalle_producto_venta y ${data.grupos_a_actualizar ?? "?"} grupo(s).`,
      );
    } else {
      console.log(
        `✓ [n8n] Supabase actualizado: ${data.detalle_actualizados ?? "?"} ` +
          `producto(s) en detalle_producto_venta, ${data.grupos_actualizados ?? "?"} grupo(s).`,
      );
    }
    return data;
  } catch (err) {
    console.log(
      `⚠ [n8n] No se pudo contactar actualizar-receipts: ${(err as Error).message}.`,
    );
    return null;
  }
}

// ==========================================================================
//  3. Histórico: carpeta con fecha/hora + 3 archivos, y limpieza de data/
// ==========================================================================

/**
 * Escribe los 3 archivos de la corrida en data/history/<fecha_hora>/ y elimina
 * el archivo de trabajo data/nops-con-tracking.json.
 */
export async function finalizeRunHistory(
  nopsData: NopsResponse,
  encontrados: MatchResult[],
  noEncontrados: MatchResult[],
  persistResult?: PersistResponse | null,
): Promise<string> {
  const ts = stamp();
  const dir = join(HISTORY_DIR, ts);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();

  await writeFile(join(dir, "nops-con-tracking.json"), JSON.stringify(nopsData, null, 2), "utf8");
  await writeFile(
    join(dir, "receipts-encontrados.json"),
    JSON.stringify({ generado_en: now, total: encontrados.length, encontrados }, null, 2),
    "utf8",
  );
  await writeFile(
    join(dir, "receipts-no-encontrados.json"),
    JSON.stringify({ generado_en: now, total: noEncontrados.length, no_encontrados: noEncontrados }, null, 2),
    "utf8",
  );
  // 4º archivo (solo si hubo intento de write-back): la respuesta del webhook.
  // En preview se nombra distinto (supabase-PREVIEW.json) para que quede claro
  // que NO se persistió nada.
  const isPreview = persistResult?.preview === true;
  const persistFile = isPreview ? "supabase-PREVIEW.json" : "supabase-actualizado.json";
  if (persistResult !== undefined) {
    await writeFile(
      join(dir, persistFile),
      JSON.stringify({ generado_en: now, preview: isPreview, respuesta: persistResult }, null, 2),
      "utf8",
    );
  }

  await rm(LIVE_JSON, { force: true });

  const n = persistResult !== undefined ? 4 : 3;
  console.log(`\n🗂  Histórico de la corrida → data/history/${ts}/ (${n} archivos):`);
  console.log(`   • nops-con-tracking.json       (${nopsData.total_nops ?? "?"} NOPs)`);
  console.log(`   • receipts-encontrados.json    (${encontrados.length})`);
  console.log(`   • receipts-no-encontrados.json (${noEncontrados.length})`);
  if (persistResult !== undefined) {
    const det = isPreview ? persistResult?.detalle_a_actualizar : persistResult?.detalle_actualizados;
    const grp = isPreview ? persistResult?.grupos_a_actualizar : persistResult?.grupos_actualizados;
    console.log(
      `   • ${persistFile}    ` +
        `(detalle ${det ?? "?"}, grupos ${grp ?? "?"}${isPreview ? " — PREVIEW, no escrito" : ""})`,
    );
  }
  console.log(`🧹 Eliminado data/nops-con-tracking.json (archivo de trabajo).`);
  return dir;
}
