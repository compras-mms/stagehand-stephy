/**
 * #4 — Búsqueda incremental (estado con backoff).
 *
 * PROBLEMA: el webhook n8n devuelve TODOS los NOPs sin `tracking_courier`
 * (~190). La mayoría aún no tiene receipt en Miami, así que cada corrida
 * re-busca los mismos ~145 trackings uno por uno (~40-47 min) casi siempre sin
 * encontrar nada. A 4 corridas/día son ~560 búsquedas/día, casi todas fallidas.
 *
 * SOLUCIÓN: guardar en disco, por `tracking_proveedor`, cuándo se buscó por
 * última vez y con qué resultado. Un tracking que ya se buscó y NO tenía receipt
 * no se vuelve a buscar hasta que venza su backoff (6h → 12h → 24h). Los NUEVOS
 * (nunca vistos) se buscan de inmediato. Cuando un tracking encuentra receipt se
 * persiste y n8n deja de devolverlo → se depura del estado automáticamente.
 *
 * El estado vive en `data/search-state.json` (trabajo local, gitignoreado). NO
 * lo borra `finalizeRunHistory` (solo elimina el JSON de trabajo de n8n).
 *
 * Se puede desactivar con `STEPHY_INCREMENTAL=0` (fuerza re-buscar todo, útil
 * para reconstruir). El schedule de backoff se ajusta con `STEPHY_BACKOFF_HOURS`
 * (ej. "6,12,24") y `STEPHY_BACKOFF_MULT`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NopDetalle, NopsResponse } from "./nops-con-tracking.js";
import type { SearchMatch } from "./search-receipts.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_JSON = join(DATA_DIR, "search-state.json");

const STATE_VERSION = 1;

/** Estado de UN tracking_proveedor entre corridas. */
export interface TrackingState {
  firstSeen: string; // ISO — primera vez que apareció en la lista de n8n
  lastSearched: string; // ISO — última búsqueda real
  attempts: number; // nº de búsquedas que NO hallaron receipt (avanza backoff)
  nextEligible: string; // ISO — no volver a buscar antes de esta hora
  lastResult: "no-receipt" | "session-expired" | "sin-respuesta";
}

export interface SearchState {
  version: number;
  updated: string;
  trackings: Record<string, TrackingState>;
}

/** Normaliza el tracking a buscar de un NopDetalle (primero si es array). */
export function trackingKey(d: NopDetalle): string {
  const t = Array.isArray(d.tracking_proveedor)
    ? d.tracking_proveedor[0]
    : d.tracking_proveedor;
  return String(t ?? "").trim();
}

/** Schedule de backoff en horas, por nº de intento fallido. attempt 1→6h… */
function backoffHours(attempts: number): number {
  const raw = process.env.STEPHY_BACKOFF_HOURS?.trim();
  const schedule = raw
    ? raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [6, 12, 24];
  const table = schedule.length ? schedule : [6, 12, 24];
  const idx = Math.min(Math.max(attempts, 1), table.length) - 1;
  return table[idx];
}

/** Milisegundos de backoff tras `attempts` fallos (aplica STEPHY_BACKOFF_MULT). */
export function backoffMs(attempts: number): number {
  const mult = Number(process.env.STEPHY_BACKOFF_MULT) || 1;
  return backoffHours(attempts) * 3600_000 * mult;
}

/** Estado vacío. */
function emptyState(): SearchState {
  return { version: STATE_VERSION, updated: new Date().toISOString(), trackings: {} };
}

/** Lee data/search-state.json. Tolera ausencia/corrupción (arranca vacío). */
export async function loadSearchState(): Promise<SearchState> {
  try {
    const txt = await readFile(STATE_JSON, "utf8");
    const parsed = JSON.parse(txt) as Partial<SearchState>;
    if (!parsed || typeof parsed !== "object" || !parsed.trackings) {
      return emptyState();
    }
    return {
      version: parsed.version ?? STATE_VERSION,
      updated: parsed.updated ?? new Date().toISOString(),
      trackings: parsed.trackings as Record<string, TrackingState>,
    };
  } catch {
    // No existe todavía o está corrupto → arrancamos limpio.
    return emptyState();
  }
}

/** Escribe el estado a disco (best-effort; un fallo no rompe la corrida). */
export async function saveSearchState(state: SearchState): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(STATE_JSON, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.log(
      `⚠ [incremental] No se pudo guardar search-state.json: ${(err as Error).message}.`,
    );
  }
}

export interface IncrementalPlan {
  /** NopDetalle que SÍ se buscarán esta corrida (nuevos o con backoff vencido). */
  dueDetalle: NopDetalle[];
  /** Cuántos se saltaron por backoff aún vigente. */
  skipped: number;
  /** Total de NopDetalle considerados (lo que trajo n8n). */
  considered: number;
  /** Cuántos trackings se depuraron del estado (ya no vienen de n8n). */
  pruned: number;
}

/**
 * Decide qué trackings buscar esta corrida y DEPURA el estado. Muta `state`
 * (elimina entradas que ya no vienen de n8n). NO escribe a disco; el caller
 * guarda con saveSearchState tras registrar resultados.
 */
export function planIncrementalSearch(
  nopsData: NopsResponse,
  state: SearchState,
  nowMs: number = Date.now(),
): IncrementalPlan {
  const detalle = Array.isArray(nopsData.nops_detalle) ? nopsData.nops_detalle : [];
  const seen = new Set<string>();
  const dueDetalle: NopDetalle[] = [];
  let skipped = 0;

  for (const d of detalle) {
    const key = trackingKey(d);
    if (!key) {
      // Sin tracking: no cuesta búsqueda real (searchAllTrackings lo salta),
      // pero lo dejamos pasar para que quede en no-encontrados como antes.
      dueDetalle.push(d);
      continue;
    }
    seen.add(key);
    const st = state.trackings[key];
    if (!st) {
      dueDetalle.push(d); // nunca visto → buscar ya
      continue;
    }
    if (Date.parse(st.nextEligible) <= nowMs) {
      dueDetalle.push(d); // backoff vencido → toca de nuevo
    } else {
      skipped++;
    }
  }

  // Depura: quita del estado los trackings que YA NO vienen de n8n. Salen de la
  // lista cuando encontraron receipt (write-back → tracking_courier → excluidos)
  // o si la orden cambió. Así el estado queda acotado a lo pendiente.
  let pruned = 0;
  for (const key of Object.keys(state.trackings)) {
    if (!seen.has(key)) {
      delete state.trackings[key];
      pruned++;
    }
  }

  return { dueDetalle, skipped, considered: detalle.length, pruned };
}

/**
 * Registra en el estado el resultado de la corrida. Los ENCONTRADOS se sacan del
 * estado (se persisten y n8n dejará de devolverlos). Los NO encontrados avanzan
 * su backoff, salvo dos clases que NO son "aún sin receipt" y por eso quedan
 * elegibles para la próxima corrida sin penalización:
 *
 *   - `sesion_expirada` — fallo de infra: no llegamos a preguntar.
 *   - `sin_respuesta` (guarda D′) — preguntamos pero la respuesta de NUESTRA
 *     petición nunca llegó. Antes esto se colaba como "no encontrado" y mandaba
 *     al backoff de 6/12/24 h a trackings que SÍ tenían recibo (los falsos
 *     negativos que destapó la calibración 1.1: 2 de 7).
 */
export function recordResults(
  state: SearchState,
  results: { encontrados: SearchMatch[]; noEncontrados: SearchMatch[] },
  nowMs: number = Date.now(),
): void {
  const nowIso = new Date(nowMs).toISOString();

  for (const e of results.encontrados) {
    const key = e.tracking_proveedor?.trim();
    if (key) delete state.trackings[key];
  }

  for (const ne of results.noEncontrados) {
    const key = ne.tracking_proveedor?.trim();
    if (!key) continue; // "sin tracking_proveedor" no es buscable
    const prev = state.trackings[key];
    const sessionExpired =
      ne.resultado === "sesion_expirada" || ne.motivo === "sesión expirada";
    const sinRespuesta = ne.resultado === "sin_respuesta";

    if (sessionExpired || sinRespuesta) {
      // No avanzamos backoff: no llegamos a saber si hay receipt. Elegible ya.
      state.trackings[key] = {
        firstSeen: prev?.firstSeen ?? nowIso,
        lastSearched: nowIso,
        attempts: prev?.attempts ?? 0,
        nextEligible: nowIso,
        lastResult: sinRespuesta ? "sin-respuesta" : "session-expired",
      };
      continue;
    }

    const attempts = (prev?.attempts ?? 0) + 1;
    state.trackings[key] = {
      firstSeen: prev?.firstSeen ?? nowIso,
      lastSearched: nowIso,
      attempts,
      nextEligible: new Date(nowMs + backoffMs(attempts)).toISOString(),
      lastResult: "no-receipt",
    };
  }

  state.updated = nowIso;
}
