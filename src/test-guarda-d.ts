/**
 * Banco de pruebas de la GUARDA D′ (plan §1.2-B / §1.6) — sin navegador.
 *
 * Se toca el corazón del scraper y la verificación era 100% manual: cada prueba
 * costaba un login y una corrida de laboratorio. Pero la guarda es lógica pura
 * sobre lo que devuelve la página, así que se puede probar con una `EvalPage`
 * falsa que reproduzca el mecanismo del bug tal como se filmó en la sonda 1.2-A:
 *
 *   - la respuesta de la búsqueda N llega DURANTE la búsqueda N+1 (hasta 9,1 s),
 *   - y el input de Receipt queda pintado con el recibo de la búsqueda anterior.
 *
 * Los exprs de red se ejecutan DE VERDAD (`vm.runInNewContext`) contra cuerpos de
 * respuesta copiados de la traza real, así que lo que se prueba son las regex y
 * la correlación que corren en producción, no una imitación.
 *
 *   npx tsx src/test-guarda-d.ts
 */

import vm from "node:vm";

import {
  clasificarResultado,
  netPendingExpr,
  netWatermarkExpr,
  readOwnResponseExpr,
  resolveSearchTiming,
  searchOneTracking,
  type EvalPage,
  type SearchTiming,
} from "./search-receipts.js";

// ==========================================================================
//  Cuerpos de respuesta REALES (traza data/calibracion-2026-08-02T03-48-54Z)
// ==========================================================================

/** La respuesta a NUESTRA búsqueda: `Result` + `Message`. */
const respBusqueda = (receipt: string) =>
  `"{'properties':{'Token':'', 'IsTokenValid':true}, 'data':[{'Result':'${receipt}', 'Message':''}]}"`;

/** Idem, pero el tracking no está en Stephy. */
const respNoEncontrado = () =>
  `"{'properties':{'Token':'', 'IsTokenValid':true}, 'data':[{'Result':'', 'Message':'Receipt Not Found'}]}"`;

/** Encadenada por la app tras el resultado (la que repinta el input). */
const respEncadenadaReceipt = (receipt: string) =>
  `"{'properties':{'Token':'', 'IsTokenValid':true}, 'data':[{'Receipt':'${receipt}', 'PCS':'1'}]}"`;

/** Encadenada de detalle/estatus. */
const respEncadenadaBox = (receipt: string) =>
  `"{'properties':{'Token':'', 'IsTokenValid':true, 'StatusName':'Delivered'}, 'data':[{'Box':'${receipt}-1/001-001', 'Date':'07/30/2026 - 12:29:35 PM', 'Status':{'Status':'Entregado'}}]}"`;

// ==========================================================================
//  Página falsa
// ==========================================================================

interface FakeReq {
  id: number;
  kind: "xhr";
  method: string;
  url: string;
  reqBody: string;
  t0: number;
  /** Cuándo resolverá (ms absolutos). null = nunca (petición abandonada). */
  resuelveEn: number | null;
  respuesta: string;
}

/** Guion de UNA búsqueda: qué pide, cuánto tarda y qué encadena. */
interface Guion {
  tracking: string;
  /** Recibo que Stephy tiene para este tracking; null = no está. */
  receiptReal: string | null;
  /** Latencia de NUESTRA petición. `Infinity` = nunca responde. */
  latenciaMs: number;
  /** Latencia de las encadenadas que dispara el resultado (repintan el input). */
  encadenadasMs?: number[];
}

/**
 * Reproduce la página: mantiene el registro de peticiones con su reloj, y pinta
 * el input de Receipt con el recibo de la ÚLTIMA respuesta que aterrizó — que es
 * exactamente cómo se fabricaban los pares cruzados.
 */
class PaginaFalsa implements EvalPage {
  private log: FakeReq[] = [];
  private seq = 0;
  private guion: Guion;
  private clickEn = 0;
  /** Lo que quedó pintado en el input de Receipt (contaminable). */
  private domReceipt = "";
  /** Recibo del tracking en curso, para pintar el input al aterrizar. */
  private receiptDeReq = new Map<number, string>();
  /** ¿La sonda está instalada? (false simula el hook que no se pudo poner). */
  constructor(
    guion: Guion,
    private readonly conSonda = true,
  ) {
    this.guion = guion;
  }

  /** Arranca la siguiente búsqueda del guion conservando el registro de red. */
  siguiente(guion: Guion): void {
    this.guion = guion;
  }

  /** Materializa el reloj: marca como resueltas las que ya vencieron y repinta. */
  private tick(): void {
    const ahora = Date.now();
    for (const r of this.log) {
      if (r.resuelveEn == null || r.resuelveEn > ahora) continue;
      if ((r as { yaAplicada?: boolean }).yaAplicada) continue;
      (r as { yaAplicada?: boolean }).yaAplicada = true;
      // Al aterrizar, Angular repinta el input con SU recibo (contaminación).
      const rec = this.receiptDeReq.get(r.id);
      if (rec) this.domReceipt = rec;
    }
  }

  /** El registro tal como lo vería `window.__stephyNet` en ese instante. */
  private snapshot(): unknown[] {
    const ahora = Date.now();
    return this.log.map((r) => ({
      id: r.id,
      kind: r.kind,
      method: r.method,
      url: r.url,
      reqBody: r.reqBody,
      t0: r.t0,
      t1: r.resuelveEn != null && r.resuelveEn <= ahora ? r.resuelveEn : null,
      status: r.resuelveEn != null && r.resuelveEn <= ahora ? 200 : null,
      respSlice: r.resuelveEn != null && r.resuelveEn <= ahora ? r.respuesta : null,
    }));
  }

  /** Corre un expr de red de verdad contra el registro (mismas regex que en prod). */
  private correr(expr: string): string {
    const sandbox = { window: { __stephyNet: this.conSonda ? this.snapshot() : undefined } };
    return vm.runInNewContext(expr, sandbox) as string;
  }

  url(): string {
    return "https://app.stephytracking.com/tecnoship/1/search";
  }

  async waitForLoadState(): Promise<void> {
    // Esta SPA nunca queda idle: en la corrida 1.1 no resolvió ni una vez.
    await new Promise(() => {});
  }

  async evaluate(expr: string): Promise<unknown> {
    this.tick();

    if (expr.includes("__stephyNet") && expr.includes("return 'ya'")) {
      return this.conSonda ? "ok" : "no-se-pudo";
    }
    if (expr === netWatermarkExpr) return this.correr(expr);
    if (expr.startsWith(netPendingExpr(0).slice(0, 40))) return this.correr(expr);
    if (expr.includes("IsTokenValid")) return this.correr(expr); // readOwnResponseExpr

    // --- fill: limpia el DOM (la calibración 1.1 probó que sí borra) --------
    if (expr.includes("setVal(inputs[0]")) {
      this.domReceipt = "";
      return JSON.stringify({ res: "ok", count: 2 });
    }

    // --- click: nace NUESTRA petición + las encadenadas del resultado -------
    if (expr.includes("BUSCAR")) {
      const ahora = Date.now();
      this.clickEn = ahora;
      const id = ++this.seq;
      const receipt = this.guion.receiptReal;
      this.log.push({
        id,
        kind: "xhr",
        method: "POST",
        url: "https://api.stephytracking.com/?params=U2FsdGVkX18&AppToken=x",
        reqBody: "",
        t0: ahora,
        resuelveEn: Number.isFinite(this.guion.latenciaMs) ? ahora + this.guion.latenciaMs : null,
        respuesta: receipt ? respBusqueda(receipt) : respNoEncontrado(),
      });
      if (receipt) this.receiptDeReq.set(id, receipt);
      // Encadenadas: salen tras el resultado y son las que repintan el input.
      for (const [i, ms] of (this.guion.encadenadasMs ?? []).entries()) {
        if (!receipt) break;
        const cid = ++this.seq;
        this.log.push({
          id: cid,
          kind: "xhr",
          method: "POST",
          url: "https://api.stephytracking.com/?params=U2FsdGVkX18&AppToken=x",
          reqBody: "",
          t0: ahora + this.guion.latenciaMs,
          resuelveEn: ahora + this.guion.latenciaMs + ms,
          respuesta: i === 0 ? respEncadenadaReceipt(receipt) : respEncadenadaBox(receipt),
        });
        this.receiptDeReq.set(cid, receipt);
      }
      return "ok";
    }

    // --- readResultExpr: el DOM, contaminable -------------------------------
    if (expr.includes("resultSnap")) {
      // "No Results" aparece si NINGUNA respuesta ha pintado nada todavía y ya
      // aterrizó algo negativo — ajeno o propio, el DOM no los distingue.
      const algoAterrizo = this.log.some(
        (r) => r.resuelveEn != null && r.resuelveEn <= Date.now() && r.t0 >= this.clickEn - 60_000,
      );
      const notFound = algoAterrizo && !this.domReceipt;
      return JSON.stringify({
        vals: ["", this.domReceipt],
        alertText: notFound ? "No Results" : "",
        sessionExpired: false,
        notFound,
        bodySlice: "",
        resultSnap: ["Tracking Search Receipt Search", "Qr Code"],
      });
    }

    throw new Error(`expr no contemplado en la página falsa: ${expr.slice(0, 80)}`);
  }
}

// ==========================================================================
//  Runner
// ==========================================================================

let fallos = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) fallos++;
};

/** Tiempos acelerados: la lógica es la misma, el reloj no importa. */
const timingRapido = (over: Partial<SearchTiming> = {}): SearchTiming => ({
  ...resolveSearchTiming(),
  settleMs: 0,
  pollMs: 20,
  idleCapMs: 50,
  minWaitMs: 50,
  maxWaitMs: 350,
  netMaxWaitMs: 1200,
  drainMs: 0,
  ...over,
});

async function main(): Promise<void> {
  console.log("\n════ Guarda D′ — banco de pruebas (sin navegador) ════\n");

  // ---------------------------------------------------------------------
  // 1. El bug filmado: la respuesta de cada búsqueda aterriza DURANTE la
  //    siguiente y el input queda con el recibo anterior. Es la secuencia de
  //    la calibración 1.1, donde la corrida entera salió corrida una posición.
  // ---------------------------------------------------------------------
  console.log("1) Cadena de respuestas tardías (el bug tal como se filmó)");
  {
    // Latencias elegidas para que la encadenada de cada búsqueda aterrice DENTRO
    // de la siguiente: es el mecanismo exacto que dejó corrida una posición a la
    // corrida entera de la calibración 1.1. El último par (450364 pintado
    // mientras se busca TBA…6221 → 449829) es el cruce histórico de la venta
    // 30510, calcado.
    const guiones: Guion[] = [
      { tracking: "SPXMIA005672607090006008", receiptReal: "449181", latenciaMs: 800, encadenadasMs: [200] },
      { tracking: "YT2614801002001456", receiptReal: null, latenciaMs: 800 },
      { tracking: "SPXMIA013672607210009219", receiptReal: "450364", latenciaMs: 800, encadenadasMs: [200] },
      { tracking: "TBA332974596221", receiptReal: "449829", latenciaMs: 800, encadenadasMs: [200] },
      { tracking: "SPXMIA013672607210010568", receiptReal: "450514", latenciaMs: 800, encadenadasMs: [200] },
    ];
    const timing = timingRapido({ netMaxWaitMs: 2000 });
    const correrCadena = async (conSonda: boolean): Promise<(string | null)[]> => {
      const pagina = new PaginaFalsa(guiones[0], conSonda);
      const salidas: (string | null)[] = [];
      for (const g of guiones) {
        pagina.siguiente(g);
        const r = await searchOneTracking(pagina, g.tracking, false, timing);
        salidas.push(r.receipt ?? null);
      }
      return salidas;
    };

    // (a) El lector VIEJO sobre el mismo guion: tiene que cruzar. Si no cruza,
    //     el fake no está reproduciendo el bug y la prueba (b) no vale nada.
    process.env.STEPHY_REQUIRE_NET = "0";
    const viejas = await correrCadena(false);
    delete process.env.STEPHY_REQUIRE_NET;
    // Los dos daños que midió la calibración 1.1, por separado: recibos de otro
    // tracking (cruces) y recibos reales reportados como inexistentes.
    const cruces = viejas.filter((s, i) => s != null && s !== guiones[i].receiptReal).length;
    const falsosNeg = viejas.filter((s, i) => s == null && guiones[i].receiptReal != null).length;
    const cruzadosViejo = cruces + falsosNeg;
    ok(
      cruzadosViejo > 0,
      `el lector por DOM falla ${cruzadosViejo}/${guiones.length} sobre este guion ` +
        `(${cruces} cruce(s), ${falsosNeg} falso(s) negativo(s)): ` +
        viejas.map((s, i) => `${guiones[i].tracking.slice(-6)}→${s ?? "∅"}`).join(", "),
    );

    // (b) El mismo guion con la guarda D′.
    const nuevas = await correrCadena(true);
    for (const [i, g] of guiones.entries()) {
      ok(
        nuevas[i] === g.receiptReal,
        `${g.tracking} → ${nuevas[i] ?? "∅"} (esperado ${g.receiptReal ?? "∅"})`,
      );
    }
    ok(
      nuevas.every((s, i) => s === guiones[i].receiptReal),
      `ningún par cruzado con D′ (el viejo cruzaba ${cruzadosViejo})`,
    );
  }

  // ---------------------------------------------------------------------
  // 2. Falso negativo: el tracking SÍ tiene recibo, pero un «No Results»
  //    ajeno ya está pintado. Antes cerraba la búsqueda y mandaba el tracking
  //    al backoff de 6/12/24 h (2 de 7 en la calibración 1.1).
  // ---------------------------------------------------------------------
  console.log("\n2) «No Results» ajeno con recibo propio en camino");
  {
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: null, latenciaMs: 50 });
    // Primero una búsqueda sin recibo: deja el «No Results» pintado.
    await searchOneTracking(pagina, "YT2614801002001456", false, timingRapido());
    // Ahora una que sí tiene recibo, pero responde tarde.
    pagina.siguiente({ tracking: "SPX…6008", receiptReal: "449181", latenciaMs: 800 });
    const r = await searchOneTracking(pagina, "SPXMIA005672607090006008", false, timingRapido());
    ok(r.receipt === "449181", `no se rindió ante el cartel ajeno → ${r.receipt ?? "∅"}`);
    ok(r.fuente === "red", `la fuente es la red (${r.fuente})`);
  }

  // ---------------------------------------------------------------------
  // 3. Nuestra petición nunca responde → `sin_respuesta`, NO «no encontrado».
  //    La diferencia importa: `no_encontrado` avanza el backoff.
  // ---------------------------------------------------------------------
  console.log("\n3) Nuestra petición no responde dentro del presupuesto");
  {
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: "449181", latenciaMs: Infinity });
    const r = await searchOneTracking(pagina, "SPXMIA005672607090006008", false, timingRapido());
    ok(r.sinRespuesta === true, "marcada como sin respuesta propia");
    ok(!r.receipt, `sin receipt aceptado (${r.receipt ?? "∅"})`);
    ok(r.notFound === false, "NO se reporta como «no encontrado»");
    ok(r.exitReason === "sin_respuesta", `exitReason=${r.exitReason}`);
  }

  // ---------------------------------------------------------------------
  // 4. El «no está» de VERDAD: nuestra propia respuesta dice Receipt Not Found.
  // ---------------------------------------------------------------------
  console.log("\n4) «Receipt Not Found» de nuestra propia respuesta");
  {
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: null, latenciaMs: 200 });
    const r = await searchOneTracking(pagina, "YT2614801002001456", false, timingRapido());
    ok(!r.receipt, "sin receipt");
    ok(r.notFound === true, "se concluye «no está» (y sí avanza backoff)");
    ok(r.exitReason === "net_not_found", `exitReason=${r.exitReason}`);
  }

  // ---------------------------------------------------------------------
  // 5. Input contaminado + nuestra respuesta vacía: el DOM ofrece un recibo
  //    ajeno y la red lo desmiente. Antes ese recibo se escribía en Supabase.
  // ---------------------------------------------------------------------
  console.log("\n5) El DOM ofrece un recibo ajeno y la red lo desmiente");
  {
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: "449181", latenciaMs: 100, encadenadasMs: [50] });
    await searchOneTracking(pagina, "SPXMIA005672607090006008", false, timingRapido());
    pagina.siguiente({ tracking: "y", receiptReal: null, latenciaMs: 300 });
    const r = await searchOneTracking(pagina, "YT2610801001888675", false, timingRapido());
    ok(!r.receipt, `no se adjudicó el recibo ajeno (${r.receipt ?? "∅"})`);
    ok(r.notFound === true, "concluye «no está», que es la verdad de su propia respuesta");
  }

  // ---------------------------------------------------------------------
  // 6. Sin sonda: con STEPHY_REQUIRE_NET (default) no se acepta nada del DOM.
  // ---------------------------------------------------------------------
  console.log("\n6) Sin sonda de red (STEPHY_REQUIRE_NET por defecto)");
  {
    delete process.env.STEPHY_REQUIRE_NET;
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: "449181", latenciaMs: 100 }, false);
    const r = await searchOneTracking(pagina, "SPXMIA005672607090006008", false, timingRapido());
    ok(r.fuente === "dom", `cae al camino de respaldo (${r.fuente})`);
    ok(r.sospechoso === true, "marcada como sospechosa");
    ok(!r.receipt, `y NO se acepta el receipt (${r.receipt ?? "∅"})`);
    ok(r.sinRespuesta === true, "se reporta como sin_respuesta → se reintenta");
  }

  console.log("\n7) Sin sonda con STEPHY_REQUIRE_NET=0 (escape de emergencia)");
  {
    process.env.STEPHY_REQUIRE_NET = "0";
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: "449181", latenciaMs: 100 }, false);
    const r = await searchOneTracking(pagina, "SPXMIA005672607090006008", false, timingRapido());
    ok(r.receipt === "449181", `vuelve el lector viejo (${r.receipt ?? "∅"})`);
    ok(r.sospechoso === true, "pero queda marcado sospechoso");
    delete process.env.STEPHY_REQUIRE_NET;
  }

  // ---------------------------------------------------------------------
  // 8. Las regex de D′ contra los cuerpos reales, uno por uno.
  // ---------------------------------------------------------------------
  console.log("\n8) Clasificación de respuestas por forma (cuerpos reales)");
  {
    const casos: { resp: string; esNuestra: boolean; result: string; que: string }[] = [
      { resp: respBusqueda("449181"), esNuestra: true, result: "449181", que: "Result/Message con recibo" },
      { resp: respNoEncontrado(), esNuestra: true, result: "", que: "Result vacío + Receipt Not Found" },
      { resp: respEncadenadaReceipt("449181"), esNuestra: false, result: "", que: "encadenada Receipt/PCS" },
      { resp: respEncadenadaBox("449181"), esNuestra: false, result: "", que: "encadenada Box/Date/Status" },
    ];
    for (const c of casos) {
      const sandbox = {
        window: {
          __stephyNet: [
            { id: 1, kind: "xhr", method: "POST", url: "/", reqBody: "", t0: 0, t1: 10, status: 200, respSlice: c.resp },
          ],
        },
      };
      const raw = vm.runInNewContext(readOwnResponseExpr(0), sandbox) as string;
      const snap = JSON.parse(raw) as { own: { result: string } | null };
      const detectada = snap.own != null;
      ok(
        detectada === c.esNuestra && (!detectada || snap.own?.result === c.result),
        `${c.que} → ${detectada ? `nuestra (Result="${snap.own?.result}")` : "encadenada, ignorada"}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // 9. PRE-ALERTA del propio tracking (`PA:<el mismo tracking>`). Desde el
  //    2026-08-24 significa RECIBIDO en el almacén de Miami, pero sin número de
  //    recibo: se marca el estatus y `tracking_courier` queda NULL. Lo que la
  //    ata a nuestra búsqueda es que el sufijo sea el tracking que se buscó.
  // ---------------------------------------------------------------------
  console.log("\n9) Pre-alerta `PA:<mismo tracking>` — recibido en Miami, sin número de recibo");
  {
    const trk = "SPXMIA013672607280001233";
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: `PA:${trk}`, latenciaMs: 100 });
    const r = await searchOneTracking(pagina, trk, false, timingRapido());
    ok(!r.receipt, `no se inventa un recibo (${r.receipt ?? "∅"})`);
    ok(r.preAlerta === true, "queda marcada como pre-alerta (recibido sin recibo)");
    ok(r.preAlertaAjena !== true, "no se confunde con una pre-alerta ajena");
    ok(r.sinRespuesta !== true, "NO se reintenta como si no hubiera respuesta");
    ok(r.resultadoCrudo === `PA:${trk}`, `se guarda el crudo (${r.resultadoCrudo ?? "∅"})`);
    ok(r.fuente === "red", `la respuesta sí era la propia (${r.fuente})`);
  }

  // ---------------------------------------------------------------------
  // 9-bis. Pre-alerta de OTRO tracking: la respuesta no es de esta búsqueda.
  //        Se descarta y se reintenta — es la comprobación que pidió Jaime
  //        para poder fiarse de la forma `PA`.
  // ---------------------------------------------------------------------
  console.log("\n9-bis) Pre-alerta de OTRO tracking — se descarta");
  {
    const pagina = new PaginaFalsa({
      tracking: "x",
      receiptReal: "PA:SPXMIA013672607280001233",
      latenciaMs: 100,
    });
    const r = await searchOneTracking(pagina, "GFUS01048022862912", false, timingRapido());
    ok(!r.receipt, `no se escribe (${r.receipt ?? "∅"})`);
    ok(r.preAlerta !== true, "NO cuenta como recibida");
    ok(r.preAlertaAjena === true, "queda marcada como pre-alerta ajena");
    ok(r.sinRespuesta === true, "se reintenta sin penalizar backoff");
    ok(r.sospechoso === true, "queda marcada sospechosa");
  }

  // ---------------------------------------------------------------------
  // 10. Forma desconocida: ni 6 dígitos ni `PA:`. No se escribe y se reintenta
  //     sin penalizar backoff — no sabemos qué es.
  // ---------------------------------------------------------------------
  console.log("\n10) Respuesta con forma desconocida");
  {
    const pagina = new PaginaFalsa({ tracking: "x", receiptReal: "44167", latenciaMs: 100 });
    const r = await searchOneTracking(pagina, "GFUS01048022862912", false, timingRapido());
    ok(!r.receipt, `no se escribe (${r.receipt ?? "∅"})`);
    ok(r.sinRespuesta === true, "se reintenta sin penalizar backoff");
    ok(r.sospechoso === true, "queda marcada sospechosa");
  }

  console.log("\n11) Clasificación de la forma del Result");
  {
    const TRK = "SPXMIA013672607280001233";
    const casos: [string, string, string][] = [
      ["449967", TRK, "recibo"],
      ["450611", TRK, "recibo"],
      ["325920", TRK, "recibo"],
      // Pre-alerta válida: el sufijo es EXACTAMENTE el tracking buscado, con
      // separador (`:`), con espacio o pegado (el caso `PAGFUS010630`).
      [`PA:${TRK}`, TRK, "pre_alerta"],
      ["PA GFUS010630", "GFUS010630", "pre_alerta"],
      ["PAGFUS010630", "GFUS010630", "pre_alerta"],
      ["PA-GFUS010630", "GFUS010630", "pre_alerta"],
      // Pre-alerta de otro tracking: es de otra búsqueda, no se escribe.
      [`PA:${TRK}`, "GFUS01048022862912", "pre_alerta_ajena"],
      ["PAGFUS010630", TRK, "pre_alerta_ajena"],
      ["PA:", TRK, "otra"],
      ["44167", TRK, "otra"],
      ["200014630057262", TRK, "otra"],
      ["TBA333372158280", TRK, "otra"],
      // Eco del propio input: no es un resultado, ni siquiera si empieza por PA.
      [TRK, TRK, "otra"],
      ["PAGFUS010630", "PAGFUS010630", "otra"],
      ["", TRK, "otra"],
    ];
    for (const [valor, trk, esperado] of casos) {
      const got = clasificarResultado(valor, trk);
      ok(got === esperado, `«${valor}» vs «${trk}» → ${got} (esperado ${esperado})`);
    }
  }

  console.log(
    `\n════ ${fallos === 0 ? "TODO OK" : `${fallos} FALLO(S)`} ════\n`,
  );
  if (fallos > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
