import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NOPs con tracking ←→ Receipts (StephyTracking) — write-back a Supabase.
 *
 * Helpers que usa el flujo de `pnpm stephy` (con STEPHY_SEARCH=1):
 *   1. runNopsConTracking(): dispara el workflow n8n "nops-con-tracking", trae
 *      los NOPs con tracking de proveedor (sin tracking de courier) + su
 *      id_venta, y los guarda como archivo de TRABAJO en
 *      data/nops-con-tracking.json. La BÚSQUEDA de cada tracking se hace en
 *      src/search-receipts.ts (página /search, tracking-por-tracking).
 *   2. persistMatches(): POST de los matches {tracking_proveedor, receipt} al
 *      webhook "actualizar-receipts", que hace los UPDATEs en Supabase
 *      (detalle_producto_venta + shipping_groups) y pone estatus
 *      'Con recibo Almacen Miami'.
 *   3. finalizeRunHistory(): escribe los archivos de la corrida en
 *      history/<fecha_hora>/ y borra el archivo de trabajo de data/.
 *
 * Todo es best-effort: un fallo de n8n NO rompe el login.
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

export interface NopDetalle {
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

interface MatchResult {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt?: string;
  /** Hallado por pre-alerta: está en Miami sin recibo ⇒ solo se mueve el estatus. */
  sin_recibo?: boolean;
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
//  2. Write-back a Supabase (paso 5 del skill) vía webhook actualizar-receipts
// ==========================================================================

/**
 * Persiste los matches en Supabase: POST [{tracking_proveedor, receipt}] al
 * webhook `actualizar-receipts`, que hace los UPDATEs idempotentes en
 * detalle_producto_venta + shipping_groups y pone estatus 'Con recibo Almacen
 * Miami'. Best-effort: cualquier fallo se loguea y devuelve null sin lanzar.
 * Devuelve la respuesta del webhook (para archivarla en el history).
 *
 * Dos clases de match (2026-08-24):
 *   - con recibo  → `{tracking_proveedor, receipt}`: escribe tracking_courier
 *     / tracking_master_courier + estatus.
 *   - pre-alerta  → `{tracking_proveedor, receipt: null, pre_alerta: true}`:
 *     el paquete está en Miami pero sin número de recibo, así que el webhook
 *     mueve SOLO el estatus y deja tracking_courier en NULL.
 * En ambos casos el guard forward-only del webhook impide retroceder un estatus
 * que ya vaya más adelante en el pipeline.
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
    .filter((e) => e.tracking_proveedor?.trim() && (e.receipt?.trim() || e.sin_recibo))
    .map((e) =>
      e.receipt?.trim()
        ? {
            tracking_proveedor: e.tracking_proveedor.trim(),
            receipt: String(e.receipt).trim(),
          }
        : {
            // Pre-alerta: está en Miami pero sin recibo ⇒ solo estatus.
            tracking_proveedor: e.tracking_proveedor.trim(),
            receipt: null,
            pre_alerta: true,
          },
    );
  const conRecibo = payload.filter((p) => p.receipt !== null).length;

  console.log(
    `\n→ [n8n] ${preview ? "Previsualizando" : "Persistiendo"} ${payload.length} ` +
      `match(es) en Supabase (${conRecibo} con recibo, ${payload.length - conRecibo} ` +
      `pre-alerta solo-estatus · actualizar-receipts · ${tag})…`,
  );

  if (payload.length === 0) {
    console.log("  ⓘ No hay matches que persistir; nada que procesar.");
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

  // #12 — Retención: conservar solo las N carpetas más recientes (env
  // STEPHY_HISTORY_KEEP, default 30) para que data/history/ no crezca sin tope.
  await pruneHistory();

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

/** Nº de carpetas de histórico a conservar (env STEPHY_HISTORY_KEEP, default 30). */
export function historyKeep(): number {
  const raw = Number(process.env.STEPHY_HISTORY_KEEP);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30;
}

/**
 * #12 — Poda data/history/ dejando solo las `historyKeep()` carpetas más recientes.
 * Las carpetas se nombran `YYYY-MM-DD_HH-mm-ss`, así que ordenar por nombre = por
 * fecha. Best-effort: cualquier fallo se loguea y NO rompe la corrida (el histórico
 * ya quedó escrito). Ignora entradas que no sean carpetas de timestamp.
 */
export async function pruneHistory(keep: number = historyKeep()): Promise<number> {
  try {
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort(); // ascendente: más viejas primero

    const excess = dirs.length - keep;
    if (excess <= 0) return 0;

    const toDelete = dirs.slice(0, excess);
    let removed = 0;
    for (const name of toDelete) {
      try {
        await rm(join(HISTORY_DIR, name), { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.log(`⚠ [retención] No se pudo borrar history/${name}: ${(err as Error).message}.`);
      }
    }
    if (removed > 0) {
      console.log(`🧹 Retención: podadas ${removed} corrida(s) vieja(s) de history/ (conservo ${keep}).`);
    }
    return removed;
  } catch {
    // history/ no existe todavía o no se pudo leer → nada que podar.
    return 0;
  }
}
