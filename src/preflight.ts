/**
 * #13 — Gate de preflight para el cron (sin navegador).
 *
 * PROBLEMA: `tsx` transpila SIN type-checkear, así que el cron podía arrancar con
 * el código roto (mal merge, bump de dependencia) y reventar a mitad de la corrida
 * —gastando el navegador y sumando footprint a Cloudflare— en vez de avisar antes.
 *
 * SOLUCIÓN: correr `tsc --noEmit` ANTES de la corrida. Si pasa, el .cmd sigue con
 * `stephy:auto`. Si hay errores de tipos, se salta la corrida (exit 1) y se manda
 * un correo de alerta reusando el webhook de `email-log`. Cero hits a Cloudflare.
 *
 * FAIL-OPEN ante fallo del PROPIO gate: si `tsc` no se pudo ni ejecutar (spawn
 * roto, etc.), NO bloqueamos la corrida (exit 0) — vale más correr que perder el
 * pipeline por un fallo del guardrail. Solo saltamos la corrida cuando `tsc`
 * corrió y encontró errores de tipos reales.
 */

import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import { sendRunLog } from "./email-log.js";

dotenv.config();

/** Timestamp local legible para el asunto del correo. */
function fmtLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

async function main() {
  console.log("🔎 Preflight: typecheck (tsc --noEmit)…");

  const res = spawnSync("pnpm exec tsc --noEmit", {
    shell: true,
    encoding: "utf8",
    cwd: process.cwd(),
  });

  // No se pudo ni lanzar tsc → fail-open: dejamos correr la corrida.
  if (res.error) {
    console.error(
      `⚠ Preflight: no se pudo ejecutar tsc (${res.error.message}). ` +
        `Fail-open: sigue la corrida.`,
    );
    process.exit(0);
  }

  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();

  if (res.status === 0) {
    console.log("✓ Typecheck OK — sigue la corrida.");
    process.exit(0);
  }

  // tsc corrió y encontró errores de tipos → saltamos la corrida + alertamos.
  console.error(`✗ Typecheck FALLÓ (exit ${res.status}) — se salta la corrida.\n${out}`);

  const inicio = fmtLocal(new Date());
  const asunto = `🚨 [STEPHY PREFLIGHT] Typecheck falló — corrida SALTADA (${inicio})`;
  const sep = "=".repeat(60);
  const cuerpo =
    `El gate de preflight detectó ERRORES DE TIPOS (tsc --noEmit).\n` +
    `La corrida NO se ejecutó para no correr con código roto.\n` +
    `Corrige los errores de abajo y la próxima corrida arrancará normal.\n\n` +
    `${sep}\nSALIDA DE tsc --noEmit\n${sep}\n\n${out || "(sin salida)"}`;

  await sendRunLog(asunto, cuerpo);
  process.exit(1);
}

main().catch((err) => {
  // Fallo inesperado del propio gate → fail-open (mejor correr que caer el cron).
  console.error("Preflight se cayó (fail-open, sigue la corrida):\n", err);
  process.exit(0);
});
