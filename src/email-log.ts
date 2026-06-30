/**
 * Registro por correo de cada corrida de Stephy.
 *
 *   1. installLogCapture(): intercepta process.stdout/stderr y va guardando TODO
 *      lo que imprime la corrida (incluidos los logs internos de Stagehand) en
 *      un buffer en memoria, sin dejar de escribir a la consola. Se llama UNA vez
 *      al cargar el módulo, antes de que arranque el flujo, para no perder nada.
 *   2. getCapturedLog(): devuelve el log acumulado (con tope de tamaño para no
 *      mandar un correo gigante).
 *   3. sendRunLog(asunto, cuerpo): POST al webhook n8n `enviar-log-stephy`, que
 *      manda el correo a moises@mamasan.app vía Gmail. Best-effort: nunca lanza,
 *      así un fallo de correo no rompe la corrida.
 */

import { Buffer } from "node:buffer";

// Tope para no mandar correos enormes (un log de corrida ronda ~30-60 KB; en
// caso de error con stack traces puede crecer). 200k chars ≈ 200 KB.
const MAX_LOG_CHARS = 200_000;

const ENVIAR_LOG_WEBHOOK_URL =
  process.env.ENVIAR_LOG_WEBHOOK_URL ??
  "https://n8n-n8n.40j1oe.easypanel.host/webhook/enviar-log-stephy";

const chunks: string[] = [];
let totalChars = 0;
let truncated = false;
let installed = false;

/**
 * Tee de process.stdout/stderr hacia el buffer en memoria. Mantiene la escritura
 * original a la consola (para que el .cmd siga volcando a auto-runs.log).
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  const patch = (stream: NodeJS.WriteStream) => {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      try {
        const text =
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8");
        if (totalChars < MAX_LOG_CHARS) {
          chunks.push(text);
          totalChars += text.length;
        } else {
          truncated = true;
        }
      } catch {
        /* si no se puede leer el chunk, no rompemos la escritura real */
      }
      // @ts-expect-error: reenvío de argumentos variádicos al write original.
      return original(chunk, encoding, cb);
    }) as typeof stream.write;
  };

  patch(process.stdout);
  patch(process.stderr);
}

/** Log acumulado de la corrida (con aviso si se truncó por tamaño). */
export function getCapturedLog(): string {
  const log = chunks.join("");
  return truncated
    ? log + `\n\n[…log truncado a ${MAX_LOG_CHARS} caracteres…]`
    : log;
}

/**
 * Manda el log de la corrida por correo (webhook n8n → Gmail). Best-effort:
 * loguea el resultado y nunca lanza.
 */
export async function sendRunLog(asunto: string, cuerpo: string): Promise<void> {
  try {
    const res = await fetch(ENVIAR_LOG_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ asunto, cuerpo }),
    });
    if (!res.ok) {
      console.log(`⚠ [correo] enviar-log-stephy respondió HTTP ${res.status}.`);
    } else {
      console.log(`✉  [correo] Log de la corrida enviado a moises@mamasan.app.`);
    }
  } catch (err) {
    console.log(
      `⚠ [correo] No se pudo enviar el log: ${(err as Error).message}`,
    );
  }
}
