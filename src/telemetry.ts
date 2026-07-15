/**
 * Telemetría de corridas de Stephy → Supabase (vía webhook n8n).
 *
 * POST `{ corrida, items }` al webhook `registrar-corrida-stephy`, que hace el
 * upsert en `corridas_tracking_stephy` (1 fila/corrida, idempotente por
 * corrida_id) + reemplazo de `auditoria_tracking_stephy` (1 fila/tracking). El
 * dashboard `v_bot_salud` lee de ahí. Mismo patrón que el bot Walmart.
 *
 * Best-effort: nunca lanza — un fallo de telemetría NO debe afectar la corrida
 * (el write-back real de receipts ya ocurrió por su propio webhook). Se puede
 * desactivar con STEPHY_TELEMETRY=0 (corridas dev/manual que no deben ensuciar
 * las métricas).
 */

const REGISTRAR_CORRIDA_WEBHOOK_URL =
  process.env.REGISTRAR_CORRIDA_WEBHOOK_URL ??
  "https://n8n-n8n.40j1oe.easypanel.host/webhook/registrar-corrida-stephy";

/** Fila de auditoría por tracking buscado. */
export interface TelemetryItem {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt: string | null;
  resultado: string | null;
  motivo: string | null;
  ms: number | null;
  persistido_db: boolean;
}

/** Fila de corrida (1 por ejecución). */
export interface TelemetryCorrida {
  corrida_id: string;
  disparo: string;
  host: string | null;
  git_commit: string | null;
  inicio: string;
  fin: string;
  duracion_ms: number;
  estado: string;
  exit_code: number;
  login_ok: boolean;
  menu_open: boolean;
  search_ran: boolean;
  preview: boolean;
  incremental: boolean;
  run_attempts: number;
  nops_total: number | null;
  incremental_due: number | null;
  incremental_skipped: number | null;
  encontrados: number;
  no_encontrados: number;
  sesion_expirada: number;
  detalle_actualizados: number | null;
  grupos_actualizados: number | null;
  persist_failed: boolean;
  llm_model: string | null;
  llm_calls: number;
  llm_errors: number;
  llm_prompt_tokens: number;
  llm_completion_tokens: number;
  llm_total_tokens: number;
  llm_ms: number;
  llm_cost_usd: number | null;
  write_back: unknown;
  error_msg: string | null;
}

export interface TelemetryPayload {
  corrida: TelemetryCorrida;
  items: TelemetryItem[];
}

/**
 * Postea la telemetría de la corrida. Best-effort: loguea el resultado y nunca
 * lanza. Respeta el gate STEPHY_TELEMETRY=0 (no envía nada).
 */
export async function postRunTelemetry(payload: TelemetryPayload): Promise<void> {
  if (process.env.STEPHY_TELEMETRY === "0") {
    console.log("ⓘ [telemetría] STEPHY_TELEMETRY=0 → no se registra la corrida en BD.");
    return;
  }
  try {
    const res = await fetch(REGISTRAR_CORRIDA_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.log(`⚠ [telemetría] registrar-corrida-stephy respondió HTTP ${res.status}.`);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      corrida_id?: string;
      filas?: number;
    };
    console.log(
      `📊 [telemetría] Corrida registrada en BD (corrida_id=${data.corrida_id ?? "?"}, ` +
        `${data.filas ?? payload.items.length} item(s) de auditoría).`,
    );
  } catch (err) {
    console.log(
      `⚠ [telemetría] No se pudo registrar la corrida: ${(err as Error).message}.`,
    );
  }
}
