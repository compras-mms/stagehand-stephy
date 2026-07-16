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

  // Versión HTML amigable (mismo estilo que el correo de corrida, en rojo).
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
    <tr><td style="height:6px;background:#dc2626"></td></tr>
    <tr><td style="padding:22px 24px 14px;background:#fef2f2">
      <div style="font-size:21px;font-weight:700;color:#0f172a">🚨 Stephy — PREFLIGHT FALLÓ</div>
      <div style="font-size:13px;color:#64748b;margin-top:6px">El typecheck detectó errores · la corrida NO se ejecutó · ${esc(inicio)}</div>
    </td></tr>
    <tr><td style="padding:16px 24px 4px">
      <div style="font-size:13px;color:#0f172a;line-height:1.6">El gate de preflight detectó <b>errores de tipos</b> (<code>tsc --noEmit</code>). La corrida se saltó para no correr con código roto. Corrige los errores de abajo y la próxima corrida arrancará normal.</div>
    </td></tr>
    <tr><td style="padding:16px 24px 6px">
      <div style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px">Salida de tsc --noEmit</div>
      <pre style="margin:0;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;font-size:11px;line-height:1.5;font-family:'SF Mono',Consolas,'Courier New',monospace;white-space:pre-wrap;word-break:break-word;overflow-x:auto">${esc(out || "(sin salida)")}</pre>
    </td></tr>
    <tr><td style="padding:14px 24px 22px;border-top:1px solid #f1f5f9">
      <div style="font-size:12px;color:#94a3b8">MamaSAN · Stephy Bot · gate de preflight · ${esc(inicio)}</div>
    </td></tr>
  </table>
</div>`;

  await sendRunLog(asunto, cuerpo, html);
  process.exit(1);
}

main().catch((err) => {
  // Fallo inesperado del propio gate → fail-open (mejor correr que caer el cron).
  console.error("Preflight se cayó (fail-open, sigue la corrida):\n", err);
  process.exit(0);
});
