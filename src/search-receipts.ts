/**
 * Receipts vía la página SEARCH (rediseño confiable).
 *
 * En vez de scrapear la lista paginada de Receipts (que perdía recibos), aquí
 * buscamos UN tracking a la vez en la página `/search`:
 *
 *   1. Llegamos a Search HACIENDO CLICK en el item "Search" del menú ☰ (NO por
 *      URL directa). Navegar dentro del SPA mantiene viva la sesión Angular/Ionic
 *      — por eso entrar por menú evita el "Sesión Expirada" que daba el goto.
 *   2. Por cada `tracking_proveedor` del JSON de n8n: lo escribimos en el input
 *      de Tracking (el de la IZQUIERDA), click en "Buscar", y leemos el número
 *      de Receipt que aparece en el input de al lado (el de la DERECHA).
 *   3. Asociamos receipt ↔ tracking ↔ nop ↔ id_venta. El resultado alimenta el
 *      mismo write-back a Supabase (persistMatches del módulo viejo).
 *
 * Todo best-effort y observable: la primera vuelta loguea lo que ve (valores de
 * los inputs, alertas) para poder ajustar selectores sin re-explorar a ciegas.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NopsResponse } from "./nops-con-tracking.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");

/** Subconjunto de la page de Stagehand que usamos aquí. */
export type EvalPage = {
  evaluate: (expr: string) => Promise<unknown>;
  url: () => string;
  goto?: (url: string) => Promise<unknown>;
  waitForLoadState: (
    state: "networkidle",
    timeoutMs?: number,
  ) => Promise<unknown>;
  keyPress?: (key: string) => Promise<unknown>;
};

export interface SearchMatch {
  nop: string;
  id_venta: number | number[] | null;
  tracking_proveedor: string;
  receipt?: string;
  motivo?: string;
  /**
   * Telemetría: clasificación del resultado para la auditoría en BD.
   * `sin_respuesta` (guarda D′): la búsqueda NO recibió la respuesta de su propia
   * petición, así que no sabemos si hay receipt. NO es "no encontrado" — no debe
   * penalizar el backoff (lo trata `recordResults` como la sesión expirada).
   */
  resultado?:
    | "encontrado"
    | "no_encontrado"
    | "sesion_expirada"
    | "sin_tracking"
    | "sin_respuesta";
  /** Telemetría: latencia de la búsqueda de este tracking (ms). */
  ms?: number;
  /** Telemetría: si el receipt se escribió en Supabase (lo fija el caller). */
  persistido_db?: boolean;
  /** D′: de dónde salió el receipt — `red` es el único de fiar. */
  fuente?: "red" | "dom";
  /** D′: la lectura no está correlacionada o discrepa con el DOM. */
  sospechoso?: boolean;
}

// ==========================================================================
//  Exprs de página (se evalúan como string, patrón del proyecto)
// ==========================================================================

/** Click en el item del menú ☰ cuyo texto contiene `label` (Search / Buscar). */
export const clickMenuItemExpr = (label: string) => `(() => {
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const want = ${JSON.stringify(label.toUpperCase())};
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const items = Array.from(document.querySelectorAll('.menu-item-container, section.menu-item-container')).filter(vis);
  const target = items.find((el) => T(el).toUpperCase().includes(want));
  if (!target) return 'no-target';
  target.click();
  return 'ok';
})()`;

/**
 * Inputs de texto VISIBLES de la página Search, ordenados por posición (izq→der).
 * [0] = Tracking, [1] = Receipt. Llena el de Tracking con `value` por el setter
 * nativo (el valor NUNCA va al LLM). Antes limpia ambos inputs. Devuelve JSON
 * {res, count}.
 */
export const fillTrackingExpr = (value: string) => `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  if (!inputs.length) return JSON.stringify({ res: 'no-visible', count: 0 });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const setVal = (el, v) => {
    el.focus();
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Limpia ambos (el Receipt puede traer el resultado anterior).
  for (const el of inputs) setVal(el, '');
  setVal(inputs[0], ${JSON.stringify(value)});
  inputs[0].dispatchEvent(new Event('blur', { bubbles: true }));
  return JSON.stringify({ res: 'ok', count: inputs.length });
})()`;

/**
 * Click en el botón "Buscar"/"Search" HABILITADO más a la izquierda (el del
 * Tracking; el de Receipt suele venir deshabilitado). Devuelve 'ok'|'no-visible'.
 */
export const clickSearchExpr = `(() => {
  const T = (e) => ((e.innerText || e.textContent || e.value || '')).trim().toUpperCase();
  const btns = Array.from(document.querySelectorAll('button, ion-button, [role=button], input[type=submit]')).filter((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const t = T(el);
    const enabled = !el.disabled && !el.classList.contains('button-disabled') && s.pointerEvents !== 'none';
    return (t.includes('BUSCAR') || t === 'SEARCH') &&
      s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && enabled;
  });
  if (!btns.length) return 'no-visible';
  btns.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  btns[0].click();
  return 'ok';
})()`;

/**
 * Lee el estado tras una búsqueda: valores de los inputs visibles (izq→der),
 * texto de cualquier ion-alert/toast, y si hay "Sesión Expirada". Devuelve JSON.
 */
export const readResultExpr = `(() => {
  const vis = (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
    const t = (el.type || 'text').toLowerCase();
    return (t === 'text' || t === 'search' || t === '' || t === 'tel') && vis(el);
  });
  inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const vals = inputs.map((el) => (el.value || '').trim());
  const al = document.querySelector('ion-alert, ion-toast, .alert, [role=alert]');
  const alertText = al && vis(al) ? (al.innerText || al.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const bodySlice = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
  const sessionExpired = /sesi[oó]n expirada|session expired/i.test(alertText) ||
    /sesi[oó]n expirada/i.test(bodySlice);
  const notFound = /no\\s+results?|no\\s+(se\\s+)?(encontr|hay|existe)|sin\\s+resultado/i.test(alertText) ||
    /no\\s+results?/i.test(bodySlice);
  // Snapshot de cualquier tabla/lista de resultados (para ver dónde cae el receipt).
  const T = (e) => ((e.innerText || e.textContent || '')).replace(/\\s+/g, ' ').trim();
  const tables = Array.from(document.querySelectorAll('table, ion-list, .list, [class*="result" i], [class*="row" i]'))
    .filter(vis).map((e) => T(e)).filter((t) => t && t.length < 600);
  const resultSnap = Array.from(new Set(tables)).slice(0, 8);
  return JSON.stringify({ vals, alertText, sessionExpired, notFound, bodySlice, resultSnap });
})()`;

// ==========================================================================
//  Sonda de red — el ancla de la guarda D′ (Fases 1.2-A y 1.2-B)
// ==========================================================================

/**
 * La calibración 1.1 probó que el DOM no ofrece NADA que ate la lectura del
 * recibo a la búsqueda que la pidió: Angular BORRA `vals[0]` al pintar el recibo
 * y no existe fila de resultados con el par. La correlación tiene que salir de
 * la RED — de ahí esta sonda.
 *
 * Parchea `XMLHttpRequest.prototype.open/send` y `window.fetch` para ir dejando
 * en `window.__stephyNet` un registro por petición: `{id, kind, method, url,
 * reqBody, t0, t1, status, respSlice}`.
 *
 * Desde 1.2-B **se instala siempre**, no solo en calibración: ya no es un
 * observador, es de donde sale el recibo. La petición va cifrada (`?params=`
 * AES), pero la respuesta viene en claro y se auto-describe, así que el `id` de
 * petición sirve de identidad y el recibo se lee de ahí, no del input.
 *
 * Idempotente (`if (window.__stephyNet) return 'ya'`) porque se reinyecta en
 * cada búsqueda: el SPA no recarga al navegar por el menú, pero un logout o una
 * recarga sí borrarían el hook.
 */
export const installNetHookExpr = `(() => {
  if (window.__stephyNet) return 'ya';
  const CAP = 120;
  const LOG = [];
  window.__stephyNet = LOG;
  let seq = 0;
  const push = (rec) => { LOG.push(rec); if (LOG.length > CAP) LOG.splice(0, LOG.length - CAP); };
  const slice = (s) => { try { return String(s == null ? '' : s).slice(0, 1500); } catch (e) { return '<unreadable>'; } };
  const bodyOf = (b) => {
    if (b == null) return '';
    if (typeof b === 'string') return slice(b);
    try {
      if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return slice(b.toString());
      if (typeof FormData !== 'undefined' && b instanceof FormData) {
        const out = []; b.forEach((v, k) => { out.push(k + '=' + v); }); return slice(out.join('&'));
      }
    } catch (e) {}
    try { return slice('[' + (b.constructor && b.constructor.name) + ']'); } catch (e) { return '[?]'; }
  };

  // --- XMLHttpRequest ---
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__st = { method: String(method || ''), url: String(url || '') }; } catch (e) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const m = this.__st || { method: '?', url: '?' };
    const rec = {
      id: ++seq, kind: 'xhr', method: m.method, url: m.url,
      reqBody: bodyOf(body), t0: Date.now(), t1: null, status: null, respSlice: null,
    };
    push(rec);
    const self = this;
    const done = () => {
      if (rec.t1 != null) return;
      rec.t1 = Date.now();
      try { rec.status = self.status; } catch (e) { rec.status = -1; }
      try {
        const rt = self.responseType;
        if (rt === '' || rt === 'text') rec.respSlice = slice(self.responseText);
        else if (rt === 'json') rec.respSlice = slice(JSON.stringify(self.response));
        else rec.respSlice = '<responseType:' + rt + '>';
      } catch (e) { rec.respSlice = '<err>'; }
    };
    try { this.addEventListener('loadend', done); } catch (e) {}
    return XS.apply(this, arguments);
  };

  // --- fetch ---
  const F = window.fetch;
  if (typeof F === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : ((input && input.url) || '');
      const method = (init && init.method) || (input && input.method) || 'GET';
      const rec = {
        id: ++seq, kind: 'fetch', method: String(method), url: String(url),
        reqBody: bodyOf(init && init.body), t0: Date.now(), t1: null, status: null, respSlice: null,
      };
      push(rec);
      return F.apply(this, arguments).then(
        (res) => {
          rec.t1 = Date.now();
          try { rec.status = res.status; } catch (e) {}
          try { res.clone().text().then((t) => { rec.respSlice = slice(t); }).catch(() => {}); } catch (e) {}
          return res;
        },
        (err) => { rec.t1 = Date.now(); rec.status = -1; rec.respSlice = '<error>'; throw err; },
      );
    };
  }
  return 'ok';
})()`;

/**
 * Devuelve las peticiones registradas por la sonda: las NUEVAS (`id > sinceId`)
 * más las que se pidan explícitamente por id (`alsoIds` — las que quedaron sin
 * responder antes del click, para ver si aterrizan DURANTE esta búsqueda, que es
 * la pregunta 3 del plan). `maxId` sirve de marca de agua para la próxima.
 */
export const readNetExpr = (sinceId: number, alsoIds: number[] = []) => `(() => {
  const L = window.__stephyNet;
  if (!L) return JSON.stringify({ hooked: false, maxId: 0, entries: [] });
  const since = ${Number.isFinite(sinceId) ? sinceId : 0};
  const also = ${JSON.stringify(alsoIds)};
  let maxId = 0;
  const entries = [];
  for (const r of L) {
    if (r.id > maxId) maxId = r.id;
    if (r.id > since || also.indexOf(r.id) >= 0) entries.push(r);
  }
  return JSON.stringify({ hooked: true, maxId, entries });
})()`;

/** Una petición vista por la sonda de red (calibración 1.2-A). */
export interface NetEntry {
  id: number;
  kind: "xhr" | "fetch";
  method: string;
  url: string;
  reqBody: string;
  t0: number;
  /** null = seguía en vuelo cuando se leyó (XHR abandonado). */
  t1: number | null;
  status: number | null;
  respSlice: string | null;
}

/**
 * Marca de agua COMPACTA: el `id` más alto registrado y los que siguen en vuelo.
 * Se lee justo antes del click, así que todo lo que traiga un `id` mayor nació
 * de NUESTRA búsqueda. Es compacta a propósito: `readNetExpr` devuelve los
 * cuerpos completos (hasta ~180 KB) y esto corre en cada tracking.
 */
export const netWatermarkExpr = `(() => {
  const L = window.__stephyNet;
  if (!L) return JSON.stringify({ hooked: false, maxId: 0, pendientes: [] });
  let maxId = 0;
  const pendientes = [];
  for (const r of L) {
    if (r.id > maxId) maxId = r.id;
    if (r.t1 == null) pendientes.push(r.id);
  }
  return JSON.stringify({ hooked: true, maxId, pendientes });
})()`;

/**
 * GUARDA D′ — la respuesta de NUESTRA petición.
 *
 * De las peticiones nacidas después de la marca de agua, busca la que trae la
 * forma `{'Result':…,'Message':…}`: esa y solo esa es la respuesta a la búsqueda
 * que lanzó nuestro click. Las que la app encadena después traen otras formas
 * (`{'Receipt','PCS'}`, `{'Box',…}`) y son justo las que repintan el input con el
 * recibo ANTERIOR — por eso el filtro va por forma de respuesta y no por URL
 * (todas comparten path `/`).
 *
 * `Result` vacío + `Message:'Receipt Not Found'` = no encontrado DE VERDAD (de
 * nuestra búsqueda, no de una ajena): ahí es donde se acaban los falsos negativos.
 */
export const readOwnResponseExpr = (sinceId: number) => `(() => {
  const L = window.__stephyNet;
  if (!L) return JSON.stringify({ hooked: false, maxId: 0, own: null, pendientes: 0, nuevas: 0, tokenInvalido: false, otras: [] });
  const since = ${Number.isFinite(sinceId) ? sinceId : 0};
  const RES = /['"]Result['"]\\s*:\\s*['"]([^'"]*)['"]/;
  const MSG = /['"]Message['"]\\s*:\\s*['"]([^'"]*)['"]/;
  const TOK = /['"]IsTokenValid['"]\\s*:\\s*false/;
  let maxId = 0, pendientes = 0, nuevas = 0, tokenInvalido = false, own = null;
  const otras = [];
  for (const r of L) {
    if (r.id > maxId) maxId = r.id;
    if (r.id <= since) continue;
    nuevas++;
    if (r.t1 == null) { pendientes++; continue; }
    const s = r.respSlice || '';
    if (TOK.test(s)) tokenInvalido = true;
    if (own) continue;
    const m = RES.exec(s);
    const mm = MSG.exec(s);
    if (m && mm) {
      own = { id: r.id, result: (m[1] || '').trim(), message: (mm[1] || '').trim(), ms: r.t1 - r.t0, status: r.status };
    } else if (otras.length < 4) {
      otras.push({ id: r.id, status: r.status, resp: s.slice(0, 120) });
    }
  }
  return JSON.stringify({ hooked: true, maxId, own, pendientes, nuevas, tokenInvalido, otras });
})()`;

/**
 * Variante de D′ para el lector GEMELO (`searchOneReceipt`). Allá la respuesta
 * propia no tiene la forma `Result`/`Message` sino la de la caja, así que la
 * identidad se ata por CONTENIDO: la respuesta a "busca el receipt R" menciona R,
 * y la contaminación que puede llegar es de un receipt ANTERIOR (R′ ≠ R). El
 * "no existe" se reconoce por `data:[]` / "not found".
 */
export const readOwnByContentExpr = (sinceId: number, needle: string) => `(() => {
  const L = window.__stephyNet;
  if (!L) return JSON.stringify({ hooked: false, maxId: 0, own: null, pendientes: 0, nuevas: 0, tokenInvalido: false, otras: [] });
  const since = ${Number.isFinite(sinceId) ? sinceId : 0};
  const needle = ${JSON.stringify(String(needle || ""))};
  const VACIA = /['"]data['"]\\s*:\\s*\\[\\s*\\]|not\\s*found/i;
  const TOK = /['"]IsTokenValid['"]\\s*:\\s*false/;
  let maxId = 0, pendientes = 0, nuevas = 0, tokenInvalido = false, own = null;
  const otras = [];
  for (const r of L) {
    if (r.id > maxId) maxId = r.id;
    if (r.id <= since) continue;
    nuevas++;
    if (r.t1 == null) { pendientes++; continue; }
    const s = r.respSlice || '';
    if (TOK.test(s)) tokenInvalido = true;
    if (own) continue;
    if (needle && s.indexOf(needle) >= 0) {
      own = { id: r.id, forma: 'contiene', ms: r.t1 - r.t0, status: r.status, resp: s.slice(0, 200) };
    } else if (VACIA.test(s)) {
      own = { id: r.id, forma: 'vacia', ms: r.t1 - r.t0, status: r.status, resp: s.slice(0, 200) };
    } else if (otras.length < 4) {
      otras.push({ id: r.id, status: r.status, resp: s.slice(0, 120) });
    }
  }
  return JSON.stringify({ hooked: true, maxId, own, pendientes, nuevas, tokenInvalido, otras });
})()`;

/** Cuántas peticiones nacidas después de `sinceId` siguen en vuelo (drenaje E). */
export const netPendingExpr = (sinceId: number) => `(() => {
  const L = window.__stephyNet;
  if (!L) return '0';
  let n = 0;
  for (const r of L) if (r.id > ${Number.isFinite(sinceId) ? sinceId : 0} && r.t1 == null) n++;
  return String(n);
})()`;

/** La respuesta a NUESTRA petición, ya interpretada (guarda D′). */
export interface OwnResponse {
  id: number;
  /** Número de recibo. Vacío = «Receipt Not Found» de nuestra propia búsqueda. */
  result: string;
  message: string;
  ms: number;
  status: number | null;
}

/** Lo que devuelve `readOwnResponseExpr`. */
interface OwnSnapshot {
  hooked: boolean;
  maxId: number;
  own: OwnResponse | null;
  pendientes: number;
  nuevas: number;
  tokenInvalido: boolean;
  otras: { id: number; status: number | null; resp: string }[];
}

/** Lo que devuelve `readOwnByContentExpr` (lector gemelo). */
export interface OwnByContentSnapshot {
  hooked: boolean;
  maxId: number;
  own: { id: number; forma: "contiene" | "vacia"; ms: number; status: number | null; resp: string } | null;
  pendientes: number;
  nuevas: number;
  tokenInvalido: boolean;
  otras: { id: number; status: number | null; resp: string }[];
}

/**
 * Instala la sonda (idempotente) y devuelve si quedó puesta. Best-effort: si
 * falla, el caller decide qué hacer — con `STEPHY_REQUIRE_NET=1` (default) eso
 * significa NO aceptar recibos, que es lo correcto mientras el bug esté vivo.
 */
export async function installNetHook(page: EvalPage): Promise<{ hooked: boolean; detalle: string }> {
  try {
    const res = (await page.evaluate(installNetHookExpr)) as string;
    return { hooked: res === "ok" || res === "ya", detalle: res };
  } catch (err) {
    return { hooked: false, detalle: `err:${(err as Error).message}` };
  }
}

/** Marca de agua de red justo antes del click (guarda D′). */
export async function readNetWatermark(
  page: EvalPage,
): Promise<{ hooked: boolean; maxId: number; pendientes: number[] }> {
  try {
    const raw = (await page.evaluate(netWatermarkExpr)) as string;
    const snap = JSON.parse(raw) as { hooked: boolean; maxId: number; pendientes: number[] };
    return { hooked: !!snap.hooked, maxId: snap.maxId ?? 0, pendientes: snap.pendientes ?? [] };
  } catch {
    return { hooked: false, maxId: 0, pendientes: [] };
  }
}

/**
 * GUARDA E — drenaje. Al salir de una búsqueda quedan en vuelo las peticiones
 * que la app encadenó (las que repintan el input con el recibo que acabamos de
 * leer). Esperarlas antes de pasar al siguiente tracking evita que aterricen ahí.
 *
 * Con D′ el recibo ya no sale del DOM, así que esto dejó de ser crítico: sirve
 * para que la señal de respaldo del DOM no dispare falsas alarmas de
 * `sospechoso`. Por eso va con tope corto y se corta apenas no queda nada en
 * vuelo. `STEPHY_SEARCH_DRAIN_MS=0` lo apaga.
 */
export async function drainNet(
  page: EvalPage,
  sinceId: number,
  capMs: number,
  pollMs: number,
): Promise<{ ms: number; pendientes: number }> {
  if (capMs <= 0) return { ms: 0, pendientes: 0 };
  const t0 = Date.now();
  let pendientes = 0;
  while (Date.now() - t0 < capMs) {
    try {
      pendientes = Number((await page.evaluate(netPendingExpr(sinceId))) as string) || 0;
    } catch {
      break; // la página se fue; el caller ya lo detectará por otra vía
    }
    if (pendientes === 0) break;
    await sleep(Math.max(pollMs, 100));
  }
  return { ms: Date.now() - t0, pendientes };
}

// ==========================================================================
//  Navegación a Search por el menú
// ==========================================================================

/**
 * Con el menú ☰ YA abierto, click en el item "Search" y espera la página
 * `/search`. Devuelve true si la URL contiene "search".
 */
export async function gotoSearchViaMenu(page: EvalPage): Promise<boolean> {
  console.log("\n→ [search] Click en el item «Search» del menú ☰…");
  let res = (await page.evaluate(clickMenuItemExpr("Search"))) as string;
  if (res !== "ok") res = (await page.evaluate(clickMenuItemExpr("Buscar"))) as string;
  console.log(`  · click item Search: ${res}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  for (let i = 0; i < 15; i++) {
    if (/search/i.test(page.url())) break;
    await sleep(500);
  }
  const ok = /search/i.test(page.url());
  console.log(ok ? `  ✓ En Search: ${page.url()}` : `  ⚠ No llegué a /search (URL: ${page.url()})`);
  await sleep(1200);
  return ok;
}

// ==========================================================================
//  Búsqueda de UN tracking
// ==========================================================================

export interface OneSearchResult {
  receipt?: string;
  vals: string[];
  alertText: string;
  sessionExpired: boolean;
  notFound: boolean;
  bodySlice?: string;
  resultSnap?: string[];
  /** Calibración (Fase 1.1): TODAS las lecturas del poll, en orden. */
  reads?: PollRead[];
  /** Por qué salió el poll (ahora también decide: ver `fuente`). */
  exitReason?: PollExit;
  /** Calibración 1.2-A: peticiones de red de ESTA búsqueda (+ las heredadas). */
  net?: NetEntry[];
  /** ¿Quedó puesta la sonda? ('ok' = recién inyectada, 'ya' = ya estaba). */
  netHook?: string;
  /** Ids que seguían en vuelo ANTES del click (herencia de la búsqueda anterior). */
  netPendientesAntes?: number[];
  // --- Guarda D′ (Fase 1.2-B) ---------------------------------------------
  /** De dónde salió el receipt. `red` = correlacionado; `dom` = sin correlacionar. */
  fuente?: "red" | "dom";
  /** La respuesta de NUESTRA petición, tal como la vio la sonda. */
  netOwn?: OwnResponse | null;
  /** Lo que decía el input de Receipt (señal de respaldo, ya no decide). */
  receiptDom?: string;
  /** La búsqueda no recibió respuesta propia: no sabemos si hay receipt. */
  sinRespuesta?: boolean;
  /** La lectura no está correlacionada, o red y DOM discrepan. */
  sospechoso?: boolean;
  /** Por qué es sospechosa / por qué se descartó. */
  motivoDescarte?: string;
  /** Drenaje (guarda E): ms gastados y peticiones que quedaron en vuelo. */
  netDrainMs?: number;
  netPendientesDespues?: number;
}

/**
 * Calibración (Fase 1.1) — una lectura del poll tal cual salió de la página,
 * con el instante en que se tomó. La iteración 0 es la lectura INMEDIATA tras el
 * click: si ya trae recibo, es residuo por definición (el XHR no ha respondido).
 */
export interface PollRead {
  iter: number;
  /** ms desde el click de Buscar. */
  ms: number;
  vals: string[];
  alertText: string;
  notFound: boolean;
  sessionExpired: boolean;
  /** ¿La red ya se había aquietado cuando se tomó esta lectura? */
  netSettled: boolean;
  resultSnap?: string[];
}

/**
 * Por qué terminó el poll. Los `net_*` son los de la guarda D′ (correlacionados);
 * `receipt`/`not_found`/`max_wait`/`net_settled` son del camino de respaldo por
 * DOM, que ya NO está correlacionado y por eso sale marcado como sospechoso.
 */
export type PollExit =
  | "receipt"
  | "sesion_expirada"
  | "not_found"
  | "max_wait"
  | "net_settled"
  | "net_result"
  | "net_not_found"
  | "sin_respuesta";

/** Modo calibración: instrumenta el poll sin cambiar ninguna decisión. */
export const calibrating = (): boolean => process.env.STEPHY_CALIBRATE === "1";

/**
 * ¿Exigimos correlación de red para aceptar un receipt? Por defecto SÍ.
 *
 * Sin la sonda, el lector vuelve a ser el que fabricaba los recibos cruzados: lo
 * que lee del input no está atado a lo que buscó. Con esto en 1, una lectura sin
 * correlacionar no se acepta — se reporta como `sin_respuesta` y se reintenta,
 * que es infinitamente más barato que escribir el recibo de otro cliente.
 * `STEPHY_REQUIRE_NET=0` restaura el comportamiento viejo (solo para emergencias).
 */
export const requireNet = (): boolean => process.env.STEPHY_REQUIRE_NET !== "0";

/**
 * Tiempos del poll por tracking (#5 — recortar latencia). Todos con override por
 * env para poder afinarlos sin recompilar si el sitio cambia de velocidad:
 *   - settleMs   : pausa tras llenar el input antes de click (Angular registra el valor).
 *   - pollMs     : intervalo entre lecturas del resultado.
 *   - idleCapMs  : tope del waitForLoadState("networkidle") — evita el cuelgue de 30s
 *                  (default de Playwright) en esta SPA que casi nunca queda idle.
 *   - minWaitMs  : NO concluir "sin receipt" antes de esto (da tiempo a que el XHR
 *                  de búsqueda salga y responda → evita falsos negativos).
 *   - maxWaitMs  : presupuesto total de espera de un resultado (backstop duro).
 *
 * `minWaitMs`/`maxWaitMs`/`idleCapMs` ya SOLO gobiernan el camino de respaldo por
 * DOM. Con la guarda D′ el presupuesto es POR PETICIÓN (`netMaxWaitMs`): se espera
 * a que resuelva la nuestra, no a que el reloj llegue a un número. Ese era el
 * origen de los pares corridos — la latencia real medida en 1.1 iba de 2,2 s a
 * 6,9 s contra un `maxWaitMs` de 3500.
 *
 *   - netMaxWaitMs : tope de espera de NUESTRA respuesta (guarda F).
 *   - drainMs      : tope del drenaje de lo que quedó en vuelo (guarda E, 0 = off).
 */
export interface SearchTiming {
  settleMs: number;
  pollMs: number;
  idleCapMs: number;
  minWaitMs: number;
  maxWaitMs: number;
  netMaxWaitMs: number;
  drainMs: number;
}

const numEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Resuelve los tiempos del poll (defaults calibrados + override por env). */
export function resolveSearchTiming(): SearchTiming {
  return {
    settleMs: numEnv("STEPHY_SEARCH_SETTLE_MS", 120),
    pollMs: numEnv("STEPHY_SEARCH_POLL_MS", 200),
    idleCapMs: numEnv("STEPHY_SEARCH_IDLE_CAP_MS", 1500),
    minWaitMs: numEnv("STEPHY_SEARCH_MIN_WAIT_MS", 500),
    maxWaitMs: numEnv("STEPHY_SEARCH_MAX_WAIT_MS", 3500),
    // 10 s cubre con margen la peor latencia medida (9,1 s en la corrida 1.2-A).
    netMaxWaitMs: numEnv("STEPHY_SEARCH_NET_MAX_WAIT_MS", 10_000),
    drainMs: numEnv("STEPHY_SEARCH_DRAIN_MS", 1200),
  };
}

/**
 * Busca un tracking en la página Search y devuelve el receipt de ESA búsqueda.
 * `verbose` loguea lo que ve (para calibrar en las primeras vueltas).
 *
 * GUARDA D′ (Fase 1.2-B) — el receipt sale de la RED, no del DOM. Se toma una
 * marca de agua de peticiones justo antes del click y se espera la respuesta con
 * forma `{'Result','Message'}` de una petición NACIDA DESPUÉS: esa es, por
 * identidad, la respuesta a nuestro tracking. El input de la derecha pasa a ser
 * señal de respaldo — si discrepa, gana la red y la lectura queda `sospechoso`.
 *
 * Esto cierra el bug de los recibos cruzados: antes se aceptaba lo que hubiera
 * en el input con la sola condición de no estar vacío, así que la respuesta
 * tardía de la búsqueda anterior (medida: hasta 9,1 s) se adjudicaba a la
 * siguiente y toda la corrida quedaba corrida una posición.
 *
 * El presupuesto también cambia de naturaleza (guarda F): se espera a que
 * NUESTRA petición resuelva, con tope `netMaxWaitMs`, en vez de a que el reloj
 * llegue a `maxWaitMs`. Con eso se acaban además los falsos negativos, que era
 * el daño colateral: un «No Results» ajeno cerraba la búsqueda de un tracking
 * que sí tenía recibo y lo mandaba al backoff de 6/12/24 h.
 *
 * Si la sonda no está disponible se cae al camino de respaldo por DOM (el
 * comportamiento viejo), pero marcado: con `STEPHY_REQUIRE_NET=1` (default) ese
 * receipt NO se acepta, se reporta `sin_respuesta` y se reintenta.
 */
export async function searchOneTracking(
  page: EvalPage,
  tracking: string,
  verbose = false,
  timing: SearchTiming = resolveSearchTiming(),
): Promise<OneSearchResult> {
  // --- Sonda de red: SIEMPRE, ya no es solo calibración --------------------
  // Se (re)inyecta en cada búsqueda: es idempotente y así sobrevive a un logout
  // o a una recarga que la borrarían.
  const hook = await installNetHook(page);
  let hooked = hook.hooked;
  const netHook = hook.detalle;

  const fillRaw = (await page.evaluate(fillTrackingExpr(tracking))) as string;
  const fill = JSON.parse(fillRaw) as { res: string; count: number };
  if (verbose) console.log(`    · fill: ${fill.res} (inputs visibles: ${fill.count})`);
  await sleep(timing.settleMs);

  // Marca de agua JUSTO antes del click: todo lo que venga después es de esta
  // búsqueda; lo que quede aquí sin `t1` es herencia de la anterior.
  let netWatermark = 0;
  let netPendientesAntes: number[] = [];
  if (hooked) {
    const wm = await readNetWatermark(page);
    hooked = wm.hooked;
    netWatermark = wm.maxId;
    netPendientesAntes = wm.pendientes;
    if (verbose && netPendientesAntes.length) {
      console.log(
        `    · [red] ${netPendientesAntes.length} petición(es) heredada(s) en vuelo: ${netPendientesAntes.join(",")}`,
      );
    }
  }

  const click = (await page.evaluate(clickSearchExpr)) as string;
  if (verbose) console.log(`    · click Buscar: ${click}`);
  if (click === "no-visible" && page.keyPress) {
    // Fallback: Enter en el input de Tracking.
    await page.keyPress("Enter").catch(() => {});
  }

  // Espera la quietud de red EN PARALELO al poll, con tope duro. Ya solo alimenta
  // el camino de respaldo (y la traza de calibración): con D′ la señal de "mi
  // búsqueda terminó" es que MI petición respondió, no que la red se aquietó.
  let netSettled = false;
  const idleWatch = page
    .waitForLoadState("networkidle", timing.idleCapMs)
    .then(() => {
      netSettled = true;
    })
    .catch(() => {});

  const start = Date.now();
  let last: OneSearchResult = { vals: [], alertText: "", sessionExpired: false, notFound: false };
  // Calibración (1.1): guardamos CADA lectura sin alterar ninguna decisión.
  const cal = calibrating();
  const reads: PollRead[] = [];
  let iter = 0;
  let exitReason: PollExit = hooked ? "sin_respuesta" : "max_wait";
  let own: OwnResponse | null = null;
  let otrasResp: string[] = [];
  // Con sonda esperamos NUESTRA respuesta; sin ella, el presupuesto viejo.
  const budget = hooked ? timing.netMaxWaitMs : timing.maxWaitMs;

  while (true) {
    const raw = (await page.evaluate(readResultExpr)) as string;
    const r = JSON.parse(raw) as OneSearchResult;
    last = r;
    if (cal) {
      reads.push({
        iter,
        ms: Date.now() - start,
        vals: r.vals,
        alertText: r.alertText,
        notFound: r.notFound,
        sessionExpired: r.sessionExpired,
        netSettled,
        resultSnap: r.resultSnap,
      });
      iter++;
    }
    if (r.sessionExpired) {
      exitReason = "sesion_expirada";
      break;
    }

    if (hooked) {
      // --- Guarda D′: la respuesta de NUESTRA petición ---------------------
      let tokenInvalido = false;
      try {
        const rawNet = (await page.evaluate(readOwnResponseExpr(netWatermark))) as string;
        const snap = JSON.parse(rawNet) as OwnSnapshot;
        if (!snap.hooked) {
          hooked = false; // la SPA recargó y se llevó el hook
        } else {
          own = snap.own;
          tokenInvalido = snap.tokenInvalido;
          otrasResp = (snap.otras ?? []).map((o) => `#${o.id}(${o.status}) ${o.resp}`);
        }
      } catch {
        // Lectura puntual fallida: reintentamos en el siguiente ciclo del poll.
        // Si falla siempre, salimos por presupuesto como `sin_respuesta`.
      }
      if (own) {
        exitReason = own.result ? "net_result" : "net_not_found";
        break;
      }
      if (tokenInvalido) {
        exitReason = "sesion_expirada";
        break;
      }
      // Ojo: en este camino NO miramos `r.notFound`. Ese cartel puede ser de una
      // búsqueda ajena — es el que fabricaba los falsos negativos.
    } else {
      // --- Camino de respaldo (sin sonda): el lector viejo, sin correlación --
      const receipt = (r.vals[1] || "").trim();
      if (receipt && receipt.toUpperCase() !== tracking.toUpperCase()) {
        last.receipt = receipt;
        exitReason = "receipt";
        break;
      }
      if (r.notFound) {
        exitReason = "not_found";
        break;
      }
    }

    const elapsed = Date.now() - start;
    if (elapsed >= budget) {
      exitReason = hooked ? "sin_respuesta" : "max_wait";
      break;
    }
    // Red aquietada + ya pasó el guard mínimo → el receipt no está aquí; no
    // gastamos el presupuesto completo esperando algo que no vendrá. Solo aplica
    // al camino de respaldo: con D′ el criterio es la respuesta propia.
    if (!hooked && netSettled && elapsed >= timing.minWaitMs) {
      exitReason = "net_settled";
      break;
    }
    await sleep(timing.pollMs);
  }
  void idleWatch; // el .catch ya lo hace inofensivo; no bloqueamos por él.
  last.exitReason = exitReason;
  last.netHook = netHook;
  last.netPendientesAntes = netPendientesAntes;
  last.netOwn = own;
  if (cal) last.reads = reads;

  // Lo que decía el input: ya no decide, pero delata cuándo el DOM estaba
  // contaminado (y con eso se puede medir el bug en producción).
  const domReceipt = (last.vals[1] || "").trim();
  last.receiptDom =
    domReceipt && domReceipt.toUpperCase() !== tracking.toUpperCase() ? domReceipt : undefined;

  // --- Veredicto -----------------------------------------------------------
  switch (exitReason) {
    case "net_result": {
      last.receipt = own?.result;
      last.fuente = "red";
      last.notFound = false;
      if (last.receiptDom && last.receiptDom !== own?.result) {
        last.sospechoso = true;
        last.motivoDescarte = `el DOM mostraba «${last.receiptDom}» y la red «${own?.result}» (gana la red)`;
      }
      break;
    }
    case "net_not_found": {
      last.receipt = undefined;
      last.fuente = "red";
      last.notFound = true;
      if (last.receiptDom) {
        last.sospechoso = true;
        last.motivoDescarte =
          `el DOM mostraba «${last.receiptDom}» pero nuestra propia respuesta dijo ` +
          `«${own?.message || "sin recibo"}» (contaminación del input, descartada)`;
      }
      break;
    }
    case "sin_respuesta": {
      last.receipt = undefined;
      last.notFound = false;
      last.sinRespuesta = true;
      last.sospechoso = true;
      last.motivoDescarte =
        `la búsqueda no recibió respuesta propia en ${budget}ms` +
        (otrasResp.length ? ` (respuestas nuevas sin forma de resultado: ${otrasResp.join(" | ")})` : "");
      break;
    }
    case "sesion_expirada": {
      last.sessionExpired = true;
      last.receipt = undefined;
      break;
    }
    default: {
      // receipt / not_found / max_wait / net_settled → camino de respaldo.
      last.fuente = "dom";
      last.sospechoso = true;
      last.motivoDescarte = `sin sonda de red (${netHook || "no instalada"}): lectura del DOM sin correlacionar`;
      if (requireNet()) {
        // Preferimos reintentar antes que escribir el recibo de otro cliente.
        last.receipt = undefined;
        last.sinRespuesta = true;
        last.motivoDescarte += " — descartada por STEPHY_REQUIRE_NET";
      }
      break;
    }
  }

  // --- Guarda E: drenar lo que esta búsqueda dejó en vuelo ------------------
  if (hooked && timing.drainMs > 0) {
    const d = await drainNet(page, netWatermark, timing.drainMs, timing.pollMs);
    last.netDrainMs = d.ms;
    last.netPendientesDespues = d.pendientes;
    if (verbose && d.pendientes > 0) {
      console.log(`    · [red] drenaje: quedaron ${d.pendientes} petición(es) en vuelo tras ${d.ms}ms`);
    }
  }

  // Volcado completo de la red (con cuerpos) solo en calibración: es caro.
  if (cal) {
    try {
      const raw = (await page.evaluate(readNetExpr(netWatermark, netPendientesAntes))) as string;
      const snap = JSON.parse(raw) as { hooked: boolean; maxId: number; entries: NetEntry[] };
      last.net = snap.entries;
    } catch (err) {
      last.netHook = `${netHook} read-post-err:${(err as Error).message}`;
    }
  }

  if (verbose) {
    console.log(
      `    · [red] salida=${exitReason} own=${own ? `#${own.id} result="${own.result}" msg="${own.message}" (${own.ms}ms)` : "—"}`,
    );
    console.log(`    · result vals=${JSON.stringify(last.vals)} alert="${last.alertText}" notFound=${last.notFound} sessionExpired=${last.sessionExpired}`);
    if (last.resultSnap?.length) console.log(`    · resultSnap=${JSON.stringify(last.resultSnap)}`);
    if (!last.receipt) console.log(`    · body: ${last.bodySlice ?? ""}`);
  }
  return last;
}

// ==========================================================================
//  Loop sobre todos los NOPs
// ==========================================================================

/** Un lote de resultados listo para persistir + registrar en el estado. */
export interface SearchBatch {
  encontrados: SearchMatch[];
  noEncontrados: SearchMatch[];
}

/**
 * Salud del lector según la guarda D′ (Fase 4.2). Se venía imprimiendo solo en el
 * log; ahora sube al resumen y al correo, que es donde alguien lo va a ver. Es el
 * detector en caliente del bug de recibos cruzados: si estas cifras se despiertan,
 * la guarda está trabajando de más y hay que mirar la corrida.
 */
export interface GuardaDStats {
  /** Búsquedas sin respuesta propia: NO son "no encontrado", se reintentan. */
  sinRespuesta: number;
  /** Receipts aceptados por red pero con el DOM discrepando. */
  sospechosos: number;
  /** Receipts aceptados en <900 ms — la firma vieja del bug (§1.4). */
  rapidas: number;
}

/**
 * Recorre cada tracking_proveedor del JSON de n8n, lo busca en la página Search
 * y arma encontrados/noEncontrados. `limit` (env STEPHY_SEARCH_LIMIT) acota para
 * pruebas. Devuelve null en `sessionExpired` global para que el caller decida.
 *
 * Persistencia INCREMENTAL (durabilidad ante cortes): si el caller pasa
 * `onBatch`, cada `batchSize` trackings procesados (o al terminar el loop) se le
 * entrega el lote acumulado para que persista los receipts hallados y guarde el
 * estado incremental EN CALIENTE. Así, si el watchdog (#2) o un corte de CDP (#3)
 * matan la corrida a mitad, lo ya encontrado YA está escrito en Supabase en vez
 * de perderse (antes `persistMatches` corría solo al final del loop). Cada
 * tracking se entrega en EXACTAMENTE un lote → sin doble conteo de backoff. El
 * `onBatch` es best-effort: si falla, se loguea y la búsqueda continúa.
 */
export async function searchAllTrackings(
  page: EvalPage,
  nopsData: NopsResponse,
  opts: {
    limit?: number;
    batchSize?: number;
    onBatch?: (batch: SearchBatch) => Promise<void>;
  } = {},
): Promise<{
  encontrados: SearchMatch[];
  noEncontrados: SearchMatch[];
  sessionExpiredCount: number;
  guardaD: GuardaDStats;
}> {
  const detalle = Array.isArray(nopsData.nops_detalle) ? nopsData.nops_detalle : [];
  const total = opts.limit ? Math.min(opts.limit, detalle.length) : detalle.length;
  console.log(`\n→ [search] Buscando ${total} tracking(s) uno por uno en /search…`);

  const encontrados: SearchMatch[] = [];
  const noEncontrados: SearchMatch[] = [];
  let sessionExpiredCount = 0;
  // Guarda D′: contadores de salud del lector (van al resumen de la corrida).
  let sinRespuestaCount = 0; // búsquedas sin respuesta propia → se reintentan
  let sospechososCount = 0; // aceptados pero con el DOM discrepando
  let rapidasCount = 0; // aceptados en <900 ms (la firma vieja del bug)

  // --- Lotes para persistencia incremental ---------------------------------
  // Umbral de flush: cada N trackings PROCESADOS entregamos el lote (así el
  // estado incremental se guarda periódicamente aunque no haya hallazgos).
  const envBatch = Number(process.env.STEPHY_PERSIST_BATCH);
  const batchSize =
    opts.batchSize && opts.batchSize > 0
      ? opts.batchSize
      : Number.isFinite(envBatch) && envBatch > 0
        ? envBatch
        : 10;
  const pendingEnc: SearchMatch[] = [];
  const pendingNoEnc: SearchMatch[] = [];
  const addFound = (m: SearchMatch) => {
    encontrados.push(m);
    pendingEnc.push(m);
  };
  const addMissing = (m: SearchMatch) => {
    noEncontrados.push(m);
    pendingNoEnc.push(m);
  };
  /** Entrega el lote acumulado al caller (best-effort) y limpia los buffers. */
  const flush = async () => {
    if (pendingEnc.length === 0 && pendingNoEnc.length === 0) return;
    const batch: SearchBatch = {
      encontrados: pendingEnc.slice(),
      noEncontrados: pendingNoEnc.slice(),
    };
    pendingEnc.length = 0;
    pendingNoEnc.length = 0;
    if (!opts.onBatch) return;
    try {
      await opts.onBatch(batch);
    } catch (err) {
      console.log(
        `  ⚠ [batch] onBatch falló (ignorado, la búsqueda continúa): ${(err as Error).message}`,
      );
    }
  };

  const timing = resolveSearchTiming(); // resuelve una vez (mismo para todos).
  let sumMs = 0; // suma de latencias reales para promediar (#5).

  // --- Calibración (Fase 1.1) ----------------------------------------------
  // Con STEPHY_CALIBRATE=1 volcamos, tracking por tracking, TODAS las lecturas
  // del poll a un JSONL: la primera lectura (residuo si trae recibo), la
  // aceptada, el ms y el resultSnap completo. Sirve para responder las dos
  // preguntas abiertas del plan (¿repinta vals[0]? ¿el snap trae el par?) sin
  // tocar la lógica de decisión. Best-effort: si falla el disco, se sigue.
  const cal = calibrating();
  const calFile = join(DATA_DIR, `calibracion-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  if (cal) {
    await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
    console.log(`\n🔬 [calibración] STEPHY_CALIBRATE=1 → trazado del poll en ${calFile}`);
    console.log(`   timing: ${JSON.stringify(timing)}`);
  }
  const calDump = async (row: unknown) => {
    if (!cal) return;
    try {
      await appendFile(calFile, JSON.stringify(row) + "\n", "utf8");
    } catch (err) {
      console.log(`  ⚠ [calibración] no pude escribir el trazado: ${(err as Error).message}`);
    }
  };

  for (let i = 0; i < total; i++) {
    const d = detalle[i];
    const tracking = Array.isArray(d.tracking_proveedor)
      ? String(d.tracking_proveedor[0] ?? "")
      : String(d.tracking_proveedor ?? "");
    const trimmed = tracking.trim();
    const base: SearchMatch = { nop: d.nop, id_venta: d.id_venta, tracking_proveedor: trimmed };

    if (!trimmed) {
      addMissing({ ...base, resultado: "sin_tracking", motivo: "sin tracking_proveedor", ms: 0 });
      continue;
    }

    const verbose = cal || i < 3; // primeras 3 vueltas (o calibración): detalle.
    process.stdout.write(`  [${i + 1}/${total}] ${trimmed} … `);
    const t0 = Date.now();
    const r = await searchOneTracking(page, trimmed, verbose, timing);
    const ms = Date.now() - t0;
    sumMs += ms;

    if (cal) {
      const first = r.reads?.[0];
      const firstReceipt = (first?.vals?.[1] || "").trim();
      // La señal cruda: recibo YA presente en la lectura inmediata al click.
      if (firstReceipt) {
        console.log(
          `\n    ⚠ [calibración] RESIDUO: la lectura 0 (${first?.ms}ms) ya traía «${firstReceipt}»`,
        );
      }
      // --- Sonda de red (1.2-A): las 4 preguntas, resueltas en el momento ---
      const net = r.net ?? [];
      const hay = (pajar: string | null | undefined, aguja: string) =>
        !!pajar && pajar.toUpperCase().includes(aguja.toUpperCase());
      // P1 — ¿el tracking buscado viaja en la petición?
      const pedidoConTracking = net.filter(
        (e) => hay(e.url, trimmed) || hay(e.reqBody, trimmed),
      );
      // P2 — ¿la respuesta de ESA petición trae el recibo aceptado?
      const rec = (r.receipt ?? "").trim();
      const respuestaConRecibo = rec
        ? net.filter((e) => hay(e.respSlice, rec))
        : [];
      const correlaciona =
        !!rec &&
        pedidoConTracking.some((e) => respuestaConRecibo.some((x) => x.id === e.id));
      // P3 — ¿una petición heredada (abandonada) resolvió DURANTE esta búsqueda?
      const heredadasResueltas = net.filter(
        (e) => (r.netPendientesAntes ?? []).includes(e.id) && e.t1 != null,
      );
      if (pedidoConTracking.length) {
        console.log(
          `    · [red] P1 ✓ el tracking viaja en ${pedidoConTracking.length} petición(es): ` +
            pedidoConTracking.map((e) => `#${e.id} ${e.kind} ${e.method} ${e.url.slice(0, 90)}`).join(" | "),
        );
      } else {
        console.log(`    · [red] P1 ✗ NINGUNA de las ${net.length} peticiones lleva el tracking`);
      }
      if (rec) {
        console.log(
          respuestaConRecibo.length
            ? `    · [red] P2 ${correlaciona ? "✓ CORRELACIONA" : "⚠ el recibo viene en otra petición"}: ` +
                `recibo «${rec}» en #${respuestaConRecibo.map((e) => e.id).join(",#")}`
            : `    · [red] P2 ✗ el recibo «${rec}» NO aparece en ninguna respuesta capturada`,
        );
      }
      if (heredadasResueltas.length) {
        console.log(
          `    · [red] P3 ⚠ ${heredadasResueltas.length} petición(es) de la búsqueda ANTERIOR resolvieron aquí: ` +
            heredadasResueltas.map((e) => `#${e.id} (${(e.t1 as number) - e.t0}ms)`).join(", "),
        );
      }
      await calDump({
        idx: i + 1,
        tracking: trimmed,
        ts: new Date().toISOString(),
        ms,
        exitReason: r.exitReason,
        receiptAceptado: r.receipt ?? null,
        receiptPrimeraLectura: firstReceipt || null,
        // --- guarda D′ (1.2-B) ---
        fuente: r.fuente ?? null,
        netOwn: r.netOwn ?? null,
        receiptDom: r.receiptDom ?? null,
        sospechoso: r.sospechoso ?? false,
        sinRespuesta: r.sinRespuesta ?? false,
        motivoDescarte: r.motivoDescarte ?? null,
        netDrainMs: r.netDrainMs ?? null,
        netPendientesDespues: r.netPendientesDespues ?? null,
        trackingEnInput: r.vals?.[0] ?? null,
        inputConservaTracking:
          (r.vals?.[0] || "").trim().toUpperCase() === trimmed.toUpperCase(),
        lecturas: r.reads ?? [],
        // --- red (1.2-A) ---
        redHook: r.netHook ?? null,
        redPendientesAntes: r.netPendientesAntes ?? [],
        red: net,
        redResumen: {
          p1_trackingEnPeticion: pedidoConTracking.map((e) => e.id),
          p2_reciboEnRespuesta: respuestaConRecibo.map((e) => e.id),
          p2_correlaciona: correlaciona,
          p3_heredadasResueltasAqui: heredadasResueltas.map((e) => e.id),
          p4_kinds: Array.from(new Set(net.map((e) => e.kind))),
          p4_peticiones: net.length,
        },
      });
    }

    if (r.sessionExpired) {
      sessionExpiredCount++;
      console.log(`⛔ Sesión Expirada (${ms}ms)`);
      addMissing({ ...base, resultado: "sesion_expirada", motivo: "sesión expirada", ms });
    } else if (r.sinRespuesta) {
      // Guarda D′: no sabemos si hay receipt. NO es "no encontrado" — se
      // reintenta en la próxima corrida sin penalizar el backoff.
      sinRespuestaCount++;
      console.log(`⏳ sin respuesta propia (${ms}ms) — se reintenta`);
      if (verbose || r.fuente === "dom") console.log(`      ${r.motivoDescarte ?? ""}`);
      addMissing({
        ...base,
        resultado: "sin_respuesta",
        motivo: r.motivoDescarte ?? "la búsqueda no recibió respuesta propia",
        ms,
        fuente: r.fuente,
        sospechoso: true,
      });
    } else if (r.receipt) {
      if (r.sospechoso) sospechososCount++;
      // §1.4: la lectura rápida ya no decide nada (con D′ el criterio es la
      // correlación), pero se sigue registrando porque es la señal con la que se
      // detectaron los 82 grupos cruzados y sirve para vigilar la regresión.
      if (ms < 900) rapidasCount++;
      console.log(
        `✓ receipt ${r.receipt} (${ms}ms, ${r.fuente ?? "?"})` +
          (r.sospechoso ? " ⚠ sospechoso" : ""),
      );
      if (r.sospechoso) console.log(`      ⚠ ${r.motivoDescarte ?? ""}`);
      addFound({
        ...base,
        receipt: r.receipt,
        resultado: "encontrado",
        ms,
        fuente: r.fuente,
        sospechoso: r.sospechoso,
        motivo: r.sospechoso ? `sospechoso: ${r.motivoDescarte ?? ""}` : undefined,
      });
    } else {
      // Con D′ este "no está" es de NUESTRA respuesta («Receipt Not Found»), no
      // de un cartel ajeno: ahora sí merece avanzar el backoff.
      console.log(`∅ sin receipt (${ms}ms, ${r.fuente ?? "?"})`);
      addMissing({
        ...base,
        resultado: "no_encontrado",
        motivo: "no está en Search",
        ms,
        fuente: r.fuente,
        sospechoso: r.sospechoso,
      });
    }

    // Flush por lote: cada `batchSize` trackings procesados (encontrados o no).
    if (pendingEnc.length + pendingNoEnc.length >= batchSize) await flush();
  }

  await flush(); // remanente del último lote parcial.

  const searched = encontrados.length + noEncontrados.filter((n) => n.motivo !== "sin tracking_proveedor").length;
  const avg = searched ? Math.round(sumMs / searched) : 0;
  console.log(
    `\n  ✓ [search] Encontrados: ${encontrados.length} · ` +
      `No encontrados: ${noEncontrados.length} · Sesión Expirada: ${sessionExpiredCount} · ` +
      `latencia ~${avg}ms/tracking (${Math.round(sumMs / 1000)}s total)`,
  );
  // Salud de la guarda D′ (criterio de salida de la verificación 1.5 del plan).
  console.log(
    `  · [D′] correlación: ${sinRespuestaCount} sin respuesta propia (se reintentan) · ` +
      `${sospechososCount} aceptado(s) con el DOM discrepando · ` +
      `${rapidasCount} aceptado(s) en <900ms`,
  );
  if (sinRespuestaCount > 0) {
    console.log(
      `  ⚠ ${sinRespuestaCount} búsqueda(s) sin respuesta propia: NO son "no encontrado". ` +
        `Quedan elegibles para la próxima corrida sin penalizar backoff.`,
    );
  }
  return {
    encontrados,
    noEncontrados,
    sessionExpiredCount,
    guardaD: {
      sinRespuesta: sinRespuestaCount,
      sospechosos: sospechososCount,
      rapidas: rapidasCount,
    },
  };
}
