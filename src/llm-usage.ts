/**
 * Telemetría de uso de LLM (OpenRouter) para una corrida de Stephy.
 *
 * Stagehand enruta TODA llamada al modelo (act / extract / observe / agent) por
 * el `AISdkClient`. Aquí lo subclaseamos para ACUMULAR, sin tocar la lógica del
 * pipeline: por cada `createChatCompletion` sumamos tokens (prompt/completion/…),
 * cuento de llamadas, errores y latencia. El acumulador vive a nivel de módulo
 * para que `finishRun()` lo lea al final (igual que runStats/items).
 *
 * COSTO = ESTIMADO. El AISdkClient devuelve tokens, NO dólares. Estimamos
 * `costo = prompt·precio_in + completion·precio_out` con los precios por token de
 * OpenRouter (`/api/v1/models`, cacheado) o un override por env
 * (OPENROUTER_PRICE_IN / OPENROUTER_PRICE_OUT, USD por 1M tokens). Si no hay
 * precio disponible, el costo queda `null` (honesto) en vez de un número inventado.
 */

import { AISdkClient } from "@browserbasehq/stagehand";

export interface LlmUsage {
  model: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  ms: number;
}

const usage: LlmUsage = {
  model: "",
  calls: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  totalTokens: 0,
  ms: 0,
};

/** Snapshot del uso acumulado hasta ahora (copia, no la referencia viva). */
export function getLlmUsage(): LlmUsage {
  return { ...usage };
}

/** Registra el id del modelo activo (para estimar costo y guardarlo en BD). */
export function setLlmModel(model: string): void {
  usage.model = model;
}

/** Forma del `usage` que devuelve el AISdkClient de Stagehand. */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
}

type CreateArgs = Parameters<AISdkClient["createChatCompletion"]>[0];

/**
 * AISdkClient que contabiliza cada llamada. Envuelve `createChatCompletion`:
 * mide latencia, suma tokens del `usage` de la respuesta y cuenta errores
 * (re-lanzándolos: NO cambia el comportamiento, solo observa).
 */
export class UsageTrackingAISdkClient extends AISdkClient {
  override async createChatCompletion<T>(params: CreateArgs): Promise<T> {
    usage.calls++;
    const t0 = Date.now();
    try {
      const res = (await super.createChatCompletion<T>(params)) as unknown as {
        usage?: RawUsage;
      };
      const u = res?.usage;
      if (u) {
        usage.promptTokens += Number(u.prompt_tokens) || 0;
        usage.completionTokens += Number(u.completion_tokens) || 0;
        usage.reasoningTokens += Number(u.reasoning_tokens) || 0;
        usage.cachedInputTokens += Number(u.cached_input_tokens) || 0;
        usage.totalTokens += Number(u.total_tokens) || 0;
      }
      return res as unknown as T;
    } catch (err) {
      usage.errors++;
      throw err;
    } finally {
      usage.ms += Date.now() - t0;
    }
  }
}

// --- Estimación de costo -----------------------------------------------------

/** Precio por TOKEN (no por millón) de un modelo. */
interface TokenPrice {
  prompt: number;
  completion: number;
}

let pricingPromise: Promise<TokenPrice | null> | null = null;

/**
 * Resuelve el precio por token del modelo. Precedencia:
 *   1. Override por env OPENROUTER_PRICE_IN / OPENROUTER_PRICE_OUT (USD por 1M).
 *   2. OpenRouter `/api/v1/models` (pricing.prompt / pricing.completion, ya por token).
 * Devuelve null si no se puede determinar (→ costo null, sin inventar).
 */
async function fetchPricing(modelId: string): Promise<TokenPrice | null> {
  const inPerM = Number(process.env.OPENROUTER_PRICE_IN);
  const outPerM = Number(process.env.OPENROUTER_PRICE_OUT);
  if (Number.isFinite(inPerM) && Number.isFinite(outPerM)) {
    return { prompt: inPerM / 1e6, completion: outPerM / 1e6 };
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    const m = data.data?.find((x) => x.id === modelId);
    if (!m?.pricing) return null;
    const prompt = Number(m.pricing.prompt);
    const completion = Number(m.pricing.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return { prompt, completion };
  } catch {
    return null;
  }
}

/**
 * Estima el costo en USD del uso acumulado (o del snapshot que se pase).
 * `null` si no hubo llamadas o no se pudo resolver el precio. El resultado del
 * fetch de precios se cachea por corrida (una sola llamada a OpenRouter).
 */
export async function estimateLlmCostUsd(u: LlmUsage = usage): Promise<number | null> {
  if (u.calls === 0) return null;
  if (!u.model) return null;
  if (u.promptTokens === 0 && u.completionTokens === 0) return 0;
  if (!pricingPromise) pricingPromise = fetchPricing(u.model);
  const price = await pricingPromise;
  if (!price) return null;
  const cost = u.promptTokens * price.prompt + u.completionTokens * price.completion;
  return Math.round(cost * 1e8) / 1e8; // redondeo a 8 decimales
}
