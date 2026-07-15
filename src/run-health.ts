/**
 * #11 — Alerta diferenciada de fallo (racha entre corridas).
 *
 * PROBLEMA: cada corrida manda un correo salga bien o mal. En una bandeja llena
 * de "✅ OK", un fallo aislado se pierde, y —peor— NADA avisa cuando el pipeline
 * lleva VARIAS corridas seguidas sin completar su trabajo (login roto días
 * enteros, watchdog matando la corrida antes de persistir, etc.). Ese patrón de
 * fallo sostenido es justo el que hay que gritar.
 *
 * SOLUCIÓN: guardar en disco el resultado de las últimas corridas y, al armar el
 * correo, calcular la RACHA de corridas consecutivas que NO completaron. Si la
 * racha llega al umbral (`STEPHY_FAILSTREAK_THRESHOLD`, default 3) el asunto se
 * escala con un prefijo 🚨 para que salte en la bandeja.
 *
 * CRITERIO de "sano" (no cuenta para la racha): la corrida hizo login Y ejecutó
 * la búsqueda Y no hubo error. Deliberadamente NO se cuenta "no persistió nada":
 * con la búsqueda incremental (#4), encontrar 0 receipts es lo NORMAL y sano, no
 * un fallo. (Un write-back que falla teniendo receipts es una señal más fina que
 * podría sumarse luego; hoy quedan cubiertos login-roto, crash y watchdog, que
 * eran los fallos silenciosos reales.)
 *
 * Las corridas PREVIEW (dry-run manual) NO se registran: no reflejan la salud del
 * cron. El estado vive en `data/run-health.json` (local, gitignoreado).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const HEALTH_JSON = join(DATA_DIR, "run-health.json");

const STATE_VERSION = 1;
/** Cuántas corridas guardar (suficiente para la racha + contexto de depuración). */
const MAX_ENTRIES = 20;

/** Umbral de racha para escalar el correo. Override por env. */
export function failStreakThreshold(): number {
  const raw = Number(process.env.STEPHY_FAILSTREAK_THRESHOLD);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}

/** Motivo por el que una corrida se consideró fallida (o "ok"). */
export type RunReason = "ok" | "error" | "login-failed" | "no-search";

/** Resultado de UNA corrida en el historial. */
export interface RunHealthEntry {
  ts: string; // ISO
  ok: boolean; // sano = completó (login + búsqueda, sin error)
  reason: RunReason;
}

export interface RunHealth {
  version: number;
  updated: string;
  runs: RunHealthEntry[]; // cronológico, más viejo primero, acotado a MAX_ENTRIES
}

/** Lo que devuelve `recordRunHealth` para que el correo decida el asunto. */
export interface HealthOutcome {
  /** Corridas consecutivas SIN completar, contando la actual (0 si esta fue sana). */
  streak: number;
  /** Umbral configurado. */
  threshold: number;
  /** streak >= threshold → escalar el asunto. */
  alert: boolean;
}

function emptyHealth(): RunHealth {
  return { version: STATE_VERSION, updated: new Date().toISOString(), runs: [] };
}

/** Lee data/run-health.json. Tolera ausencia/corrupción (arranca vacío). */
export async function loadRunHealth(): Promise<RunHealth> {
  try {
    const txt = await readFile(HEALTH_JSON, "utf8");
    const parsed = JSON.parse(txt) as Partial<RunHealth>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
      return emptyHealth();
    }
    return {
      version: parsed.version ?? STATE_VERSION,
      updated: parsed.updated ?? new Date().toISOString(),
      runs: parsed.runs as RunHealthEntry[],
    };
  } catch {
    return emptyHealth();
  }
}

/** Escribe el estado (best-effort; un fallo no rompe la corrida ni el correo). */
async function saveRunHealth(state: RunHealth): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(HEALTH_JSON, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.log(
      `⚠ [salud] No se pudo guardar run-health.json: ${(err as Error).message}.`,
    );
  }
}

/** Cuenta las corridas fallidas consecutivas al final del historial. */
export function trailingFailStreak(runs: RunHealthEntry[]): number {
  let n = 0;
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].ok) break;
    n++;
  }
  return n;
}

/**
 * Registra el resultado de la corrida ACTUAL y devuelve la racha de fallos.
 * Best-effort: si el disco falla, calcula la racha con lo que tenga en memoria y
 * nunca lanza (el correo debe salir igual). Llamar UNA vez por corrida.
 */
export async function recordRunHealth(
  entry: { ok: boolean; reason: RunReason },
  nowMs: number = Date.now(),
): Promise<HealthOutcome> {
  const threshold = failStreakThreshold();
  const state = await loadRunHealth();

  state.runs.push({
    ts: new Date(nowMs).toISOString(),
    ok: entry.ok,
    reason: entry.reason,
  });
  if (state.runs.length > MAX_ENTRIES) {
    state.runs = state.runs.slice(-MAX_ENTRIES);
  }
  state.updated = new Date(nowMs).toISOString();

  await saveRunHealth(state);

  const streak = trailingFailStreak(state.runs);
  return { streak, threshold, alert: streak >= threshold };
}
