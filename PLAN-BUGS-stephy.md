# Plan de bugs — Stephy

**Abierto:** 2026-07-31 · **Revisado:** 2026-08-01 (calibración 1.1 + sonda de red 1.2-A) ·
**Estado:** Fase 0 ✅ · 1.1 ✅ (bug reproducido; guardas A/B/C muertas) · 1.2-A ✅ (la petición va
cifrada, pero la respuesta trae el recibo en claro → **guarda D′ por identidad de petición,
validada 7/7**) · **sigue 1.2-B: implementarla**

> Sin nombres de clientes. El detalle con PII vive en `data/receipts-cruzados-20260731.md`
> (gitignoreado por `data/receipts-*.md`).

---

## Índice

| Fase | Qué | Bloquea a | Estado |
|---|---|---|---|
| **0** | Parar la sangría — scraper **+ instructor** | Fase 1 | ✅ 2026-07-31 23:31 |
| **1** | Arreglar los lectores (`search-receipts.ts` **y `search-consignee.ts`**) | Fases 3, 4, 5.3 | 🟡 1.1 ✅ · 1.2-A ✅ · **sigue 1.2-B (implementar D′)** |
| **2** | Casos puntuales abiertos (18559, 30510) | — | 🟡 parcial |
| **3** | Limpieza de los grupos cruzados (82 + detector nuevo) | Fase 4 | ⬜ |
| **4** | Blindaje | — | ⬜ |
| **5** | NOP por producto | — | ⬜ |
| **6** | Higiene | — | ⬜ |

### Camino crítico

```
Fase 0 (scraper + instructor) → Fase 1 (los DOS lectores) → verificación 1.5
                                        ↓
                          Fase 3 (limpieza) → Fase 4 (blindaje)
                                        ↓
              reactivar: 1 cron scraper (canario) → 2º scraper → Instruir
                                        ↓
                                  Fase 5.3 (NOP por receipt)

Fase 2, Fase 5.0/5.2 y Fase 6 corren en paralelo, no bloquean.
```

⚠️ `MamaSAN Instruir` es el **último** en volver: mientras haya grupos cruzados en
`Con recibo Almacen Miami`, cada corrida suya fabrica una guía física mal dirigida.

---

## Contexto: el bug de fondo

`searchOneTracking` acepta el recibo del input de la derecha (`vals[1]`) con una sola condición:
no vacío y distinto del tracking buscado (`src/search-receipts.ts:265`). **Nada ata esa lectura a
la búsqueda recién lanzada.** Dos contaminaciones:

1. **Residuo.** `fillTrackingExpr` limpia los inputs por el setter nativo del DOM — borra el DOM,
   no el estado del componente Angular/Ionic. Si Angular repinta el Receipt con el resultado
   anterior, la primera lectura (inmediata tras el click) se lo lleva. **Firma: `ms` < ~900.**
2. **Respuesta tardía.** Una búsqueda cortada por presupuesto (`maxWaitMs` 3500, o el atajo
   `netSettled && elapsed >= minWaitMs` 500) deja su XHR vivo; aterriza durante la búsqueda
   siguiente y escribe SU recibo. **El par sale corrido una posición.**

⚠️ **`auditoria_tracking_stephy` NO es fuente de verdad del par tracking↔recibo: es la salida del
bug.** La verdad está en Stephy (buscar el tracking a mano) o en lo que reporte Jaime.

---

## Fase 0 — Parar la sangría ✅

Cada corrida metía recibos nuevos con el mismo defecto, así que la limpieza de la Fase 3 nunca
converge: limpias 82 y aparecen más.

**Hay que parar DOS cosas, no una:** el que *escribe* el recibo malo (el scraper) y el que lo
*convierte en mercancía física* (el instructor).

### Productor — scraper de receipts

- [x] `MamaSAN-Stephy-1000` deshabilitada
- [x] `MamaSAN-Stephy-2000` deshabilitada
- [x] `MamaSAN-Stephy-0600` y `-1600` ya estaban deshabilitadas de antes

### Consumidor — instructor ⚠️ (se pasó por alto en la primera pasada)

- [x] `MamaSAN Instruir` deshabilitada **2026-07-31 23:31 -04:00**

`MamaSAN Instruir` (06:00 y 17:00 diarios →
`stagehand-dar-instruccion\scripts\run-instruir.ps1`) toma los grupos en `Con recibo Almacen
Miami` y les manda Receipt Instruction en Stephy: **convierte un recibo cruzado en una guía
física a nombre del cliente equivocado.** Es el mecanismo exacto que produjo el caso 449781.

Al momento de la pausa había **64 grupos en `Con recibo Almacen Miami`, 16 marcados por los
detectores**. Última corrida 2026-07-31 17:00 (OK); la siguiente habría sido 2026-08-01 06:00.

⚠️ Los 16 marcados que quedaron en ese estado son **prioridad de la Fase 3**: son los que
estaban a una corrida de volverse mercancía mal dirigida.

**Frontera datos sucios / datos por confirmar:**
última corrida automática del scraper **2026-07-31 20:00:01 -04:00** (`MamaSAN-Stephy-2000`,
resultado 0). Pausa del scraper **23:03**, pausa del instructor **23:31**.

Reactivar (el instructor **solo después** de que la Fase 3 haya limpiado lo que esté en
`Con recibo Almacen Miami`):

```bash
powershell -Command "Enable-ScheduledTask -TaskName 'MamaSAN-Stephy-1000'; Enable-ScheduledTask -TaskName 'MamaSAN-Stephy-2000'; Enable-ScheduledTask -TaskName 'MamaSAN Instruir'"
```

**Criterio de salida:** cero corridas nuevas de scraper **y de instructor** hasta que la Fase 1
pase su verificación (1.5). Reactivar de a uno (ver canario en 1.5).

---

## Fase 1 — Arreglar el lector

El corazón. Todo lo demás depende de esto.

### 1.1 Calibrar antes de tocar (corrida en seco)

Dos preguntas que hoy son suposición y cambian cuál guarda sirve:

1. Cuando entra una respuesta tardía, ¿Angular repinta también el input de Tracking (`vals[0]`),
   o solo el de Receipt (`vals[1]`)? Si repinta ambos, la guarda B sola resuelve el caso.
2. ¿`resultSnap` trae el par tracking↔recibo en una misma fila? El código ya captura ese snapshot
   (`src/search-receipts.ts:135`) pero **no lo usa para decidir** — solo lo loguea. Si la fila trae
   el par, esa es la fuente correcta y el input suelto se vuelve irrelevante.

**Cómo:** corrida con `STEPHY_SEARCH_LIMIT` bajo y `verbose`, registrando por tracking la
**primera** lectura del poll, la lectura **aceptada**, el `ms` y el `resultSnap` completo.
Sin escribir nada en Supabase.

Los interruptores ya existen, no hay que inventar nada:

```bash
STEPHY_SEARCH_TRACKINGS="<trk1>,<trk2>" STEPHY_PREVIEW=1 STEPHY_INCREMENTAL=0 pnpm stephy:manual
```

`STEPHY_SEARCH_TRACKINGS` salta n8n y busca exactamente esos; `STEPHY_PREVIEW=1` pone
`actualizar-receipts` en dry-run (SELECT, no UPDATE); `STEPHY_INCREMENTAL=0` ignora el backoff.
Añadir `STEPHY_TELEMETRY=0` para no ensuciar `v_bot_salud` con corridas de calibración.

### ✅ 1.1 RESULTADO — corrida 2026-08-01 18:15 UTC (7 trackings, dry-run)

Instrumentación añadida: `STEPHY_CALIBRATE=1` vuelca cada lectura del poll a
`data/calibracion-*.jsonl` (gitignoreado) sin tocar ninguna decisión. `STEPHY_EMAIL=0` evita
mandar correo de una corrida de laboratorio.

**El bug se reprodujo en vivo, y es peor que "a veces": la corrida entera va corrida una
posición.** Set: 2 trackings sanos con recibo conocido, 2 que NUNCA han estado en Stephy
(24 corridas cada uno, siempre `no_encontrado`), y el par del caso 449829.

| # | Tracking | Leyó | ms | Qué pasó de verdad |
|---|---|---|---|---|
| 1 | `SPX…6008` | 449181 ✅ | 2305 | su propia respuesta, a 2162 ms |
| 2 | `YT…1456` (no existe) | ∅ | 3784 | agotó `maxWaitMs`; su respuesta seguía viva |
| 3 | `SPX…9219` (recibo real 450364) | ∅ **falso negativo** | 3166 | leyó el «No Results» **de #2** |
| 4 | `YT…8675` (no existe) | **450364** ❌ | 784 | recibió el recibo **de #3** |
| 5 | `SPX…6008` (recibo real 449181) | ∅ **falso negativo** | 2948 | leyó el «No Results» **de #4** |
| 6 | `TBA332974596221` | **449181** ❌ | 1866 | recibió el recibo **de #5** |
| 7 | `SPX…0568` (Shein, venta 30510) | **449829** ❌ | 351 | recibió el recibo **de #6** ← el cruce histórico, calcado |

Un tracking que **no existe en Stephy** salió con recibo (#4). El cruce del caso 449829 se
reprodujo idéntico (#7). Y aparece un daño que el plan no contemplaba: **falsos negativos** —
recibos que SÍ están se reportan como «no encontrado» (#3, #5) y entran al backoff de 6/12/24 h.

**Respuesta 1 — ¿Angular repinta `vals[0]`? NO: lo BORRA.** Cuando pinta un recibo, los inputs
quedan `["", "<recibo>"]`, **igual en la lectura legítima que en la contaminada** (#1 sano y #7
cruzado son indistinguibles). En cambio el «No Results» **conserva** el tracking en `vals[0]`.
⇒ **La guarda B queda descartada: rechazaría el 100% de las lecturas, incluidas las buenas.**

**Respuesta 2 — ¿`resultSnap` trae el par? NO.** Siempre
`["Tracking Search Receipt Search", "Qr Code"]` (+ `"No Results"`). No hay fila de resultados:
el recibo solo vive en el input. ⇒ **La guarda C también queda descartada.**

**Hallazgo extra — el residuo no apareció.** Las 7 lecturas de la iteración 0 salieron limpias;
`fillTrackingExpr` sí borra. Las 3 contaminaciones fueron **XHR tardío, ninguna residuo**. La
firma `ms < 900` no delata residuo: delata *respuesta ajena que ya venía en camino*.

**La causa habilitadora, medida:** la latencia real de la búsqueda va de **2,2 s a 6,9 s**
(reconstruida por dónde aterrizó cada respuesta), contra un presupuesto `maxWaitMs` de **3500 ms**.
Cada vez que una búsqueda excede el presupuesto, **todas las siguientes quedan corridas una
posición** hasta que una respuesta lenta rompa la cadena. El atajo `netSettled` no intervino:
`waitForLoadState("networkidle", 1500)` **nunca** resolvió en toda la corrida (`netSettled=n` en
las 7 búsquedas) — el culpable fue `maxWaitMs`, no el atajo de 500 ms.

### 1.2 Las guardas — REDISEÑADAS tras 1.1

⚠️ **La calibración mató las guardas B y C**: el DOM no ofrece NADA que ate la lectura a la
búsqueda (borra `vals[0]`, no hay fila con el par). Y la A ataca un residuo que no existe. Con
lo que la página muestra, **la correlación es imposible desde el DOM**. Hay que sacarla de otro
lado.

| Guarda | Qué hace | Estado |
|---|---|---|
| ~~A. Descartar la primera lectura~~ | — | ❌ innecesaria: no hubo residuo en 7/7 |
| ~~B. Exigir `vals[0] === tracking`~~ | — | ❌ **rechazaría también las lecturas buenas** |
| ~~C. Leer el par de la fila~~ | — | ❌ no existe tal fila en el DOM |
| ~~D. Correlacionar por el CONTENIDO de la red~~ | — | ❌ la petición va **cifrada** (`?params=` AES) — el tracking no viaja en claro |
| **D′. Correlacionar por IDENTIDAD de petición** | El hook ya distingue cada XHR. Se acepta como recibo el campo `Result` de la respuesta de **la petición que lanzó nuestro click**, no lo que pinte el DOM | ✅ **validada 7/7 en la corrida 1.2-A** |
| **E. Drenar antes de seguir** | Una búsqueda abandonada deja su XHR vivo. Antes del siguiente tracking, esperar/descartar esa respuesta (o resetear por el menú ☰) para que no tenga dónde pintar | ✅ propuesta, ver 1.3 |
| **F. Presupuesto realista** | `maxWaitMs` 3500 < latencia real (2,2–6,9 s). Subirlo y hacerlo adaptativo | ✅ propuesta |

**D′ es la única que da correlación de verdad**; E y F reducen la exposición pero no la
garantizan. Ya verificada con la sonda (§1.2-A ✅).

Sobre F: subir el presupuesto **alarga la corrida** (hoy ~2,2 s/tracking × ~145). El drenaje de E
se paga solo en las abandonadas, así que la combinación sensata es F moderada + E siempre.

### 1.2-A Sonda de red — ✅ HECHA 2026-08-01 (2ª corrida de calibración)

Instrumentación añadida a `src/search-receipts.ts`: `installNetHookExpr` (parchea
`XMLHttpRequest.open/send` y `window.fetch`, empuja a `window.__stephyNet`, idempotente y
reinyectada en cada búsqueda) + `readNetExpr(sinceId, alsoIds)` + volcado al JSONL con el
resumen de las 4 preguntas ya resuelto. Solo se activa con `STEPHY_CALIBRATE=1`.

Corrida: mismos 7 trackings de la 1.1, `STEPHY_PREVIEW=1 STEPHY_INCREMENTAL=0
STEPHY_TELEMETRY=0 STEPHY_EMAIL=0`, los 5 crons verificados deshabilitados.
Traza: `data/calibracion-2026-08-02T03-48-54-832Z.jsonl` (16 peticiones, 7 búsquedas).

**P1 — ¿el tracking viaja en la petición? NO.** Todo va a `POST https://api.stephytracking.com/`
con el cuerpo VACÍO y dos parámetros de query: `params` (~1.8 KB, AES de CryptoJS —
base64 de `U2FsdGVkX1…` = `Salted__`) y `AppToken`. **La petición es opaca.**
⇒ **La guarda D tal como estaba escrita (emparejar por contenido) muere igual que B y C.**

**P2 — ¿la respuesta trae el recibo? SÍ, EN CLARO.** Y además se auto-describe. Tres formas
distintas, distinguibles por su cuerpo:

| Forma de la respuesta | Qué es | Cuántas |
|---|---|---|
| `data:[{'Result':'449181','Message':''}]` / `{'Result':'','Message':'Receipt Not Found'}` | **la respuesta a NUESTRA búsqueda**; `Result` = el número de recibo | 7 — exactamente una por búsqueda |
| `data:[{'Receipt':'449181','PCS':'1'}]` | encadenada por la app tras el resultado | 4 |
| `data:[{'Box':'449181-1/001-001','Date':…,'Status':…}]` | detalle/estatus, encadenada | 3 |

⇒ **Correlación posible sin descifrar nada: por IDENTIDAD de petición.** La respuesta con forma
`Result`/`Message` de la petición creada tras nuestro click ES la respuesta a nuestro tracking.
**Emparejó 7/7**, incluidos los dos `YT…` inexistentes (`Message:'Receipt Not Found'` de su
propia petición, no de una ajena). Esto es **mejor** que guardar el DOM: se lee el recibo de la
red y el input deja de importar.

**P3 — ¿lo abandonado aterriza en la búsqueda siguiente? SÍ, SIEMPRE.** 6 de las 7 búsquedas
heredaron peticiones en vuelo, y en 5 de ellas aterrizaron ahí dentro: **#4 tardó 9.148 ms** y
cayó en la 5ª búsqueda; #8 4.036 ms; #12 3.038 ms. **Es el mecanismo del bug, filmado.**
Ojo: son las encadenadas (`Receipt/PCS`, `Box`) las que quedan colgando, y son justo las que
pueden repintar el input con el recibo ANTERIOR.

**P4 — `XMLHttpRequest`, nunca `fetch`. Varias por búsqueda** (1 de búsqueda + 1-2 encadenadas).
El filtro va por **forma de la respuesta**, no por la URL (todas comparten path `/`).

**Nota sobre esta corrida:** salió limpia (7/7 recibos correctos, latencias 1,6-3,6 s) — el sitio
estaba más rápido que en la 1.1 (2,2-6,9 s). No invalida nada: el desfase depende de la latencia
del día, que es exactamente por lo que hace falta un ancla que no dependa del reloj.

**Regalo de la corrida:** `SPXMIA013672607210010568` (Shein, venta 30510) → recibo **450514**,
correlacionado a nuestra propia petición (#14). Es el número que faltaba en el caso 2 de la
Fase 2 — confirmar con Jaime antes de escribirlo.

### ▶️ 1.2-B EMPEZAR AQUÍ EN LA PRÓXIMA SESIÓN — implementar D′

Criterio de salida de 1.2-A cumplido (en su variante: P1 negativa, P2 positiva y suficiente).
Lo que hay que escribir:

1. **`searchOneTracking` deja de creer en el DOM.** Marca de agua de red antes del click →
   esperar a que aparezca **una respuesta con forma `Result`/`Message` creada después del
   click** → el recibo es ese `Result` (vacío + `Receipt Not Found` = no encontrado de verdad).
   El input pasa a ser señal de respaldo: si DOM y red discrepan, gana la red y se marca
   `sospechoso`.
2. **Presupuesto por petición, no por reloj (F).** Se espera a que NUESTRA petición resuelva,
   con tope ~10 s. Se acaban los falsos negativos por «No Results» ajeno.
3. **Drenaje (E)**: con la red visible ya se sabe qué quedó en vuelo — esperar/descartar antes
   del siguiente tracking. Reset SIEMPRE por el menú ☰ (ver 1.3).
4. **El gemelo `searchOneReceipt`** (§1.2-bis) va con la misma D′: su respuesta también debe
   salir de la petición que lanzó su propio click.
5. El hook deja de ser solo de calibración: pasa a instalarse siempre (es pasivo y barato).

Luego, la verificación 1.5.

### 1.2-bis El lector gemelo tiene el mismo bug

`searchOneReceipt` (`src/search-consignee.ts:303`) es una copia estructural de
`searchOneTracking`: mismo poll, mismo atajo `netSettled && elapsed >= minWaitMs`, y **ninguna
correlación entre el receipt buscado y lo que lee**. Peor: devuelve `tracking: vals[0]`
(`:334`) — justo el dato con el que la Fase 3 pensaba verificar quién es el dueño real de cada
recibo.

**Las guardas van a los DOS lectores**, o la limpieza se verifica con el instrumento roto.
En el gemelo la guarda natural es la simétrica: exigir que `vals[1] === receipt` buscado antes
de aceptar el consignatario/tracking leído.

### 1.3 Cerrar el XHR tardío por la vía dura

Guarda independiente del comportamiento de Angular, y por eso va igual: cuando una búsqueda se
abandona por presupuesto (`maxWaitMs` agotado, o el atajo de `src/search-receipts.ts:275`), su XHR
queda vivo. Antes de pasar al siguiente tracking, **resetear el estado de la página** para que esa
respuesta no tenga dónde pintar.

⚠️ **El reset va por el menú ☰ (`gotoSearchViaMenu`), NUNCA por `goto`/recarga de URL.** Navegar
por URL directa es lo que dispara el "Sesión Expirada" — es la razón de ser de esa función
(`src/search-receipts.ts:151`, y el comentario de cabecera del módulo). Una recarga dura del
`/search` mataría la sesión Angular y convertiría el resto de la corrida en sesiones expiradas.

Solo se paga en las búsquedas abandonadas, no en todas. Y es determinista: no depende de adivinar
cómo repinta el framework.

### 1.4 Marcar en vez de creer

- Registrar `sospechoso = true` cuando `ms < 900` (umbral validado: 88% de esas lecturas traen
  recibo ambiguo, vs 40% de las normales). ⚠️ Tras 1.1 el umbral queda como **señal de respaldo,
  no como criterio**: el cruce #6 de la calibración se aceptó a **1866 ms** y habría pasado el
  filtro. Con la guarda D el criterio es la correlación; `ms` solo alimenta la alerta.
- **Marcar también el falso negativo.** 1.1 mostró que un «No Results» ajeno cierra la búsqueda
  de un tracking que SÍ tenía recibo (#3 y #5, 2 de 7). Hoy eso entra al backoff 6/12/24 h como
  si el recibo no existiera. Un `no_encontrado` cuya búsqueda quedó sin respuesta propia debe
  reintentarse, no penalizarse.
- **Un recibo sospechoso no se persiste** — se reencola para una segunda búsqueda al final de la
  corrida. Si la segunda coincide, entra; si no, se reporta.
- Columnas nuevas en `auditoria_tracking_stephy`: `sospechoso`, `motivo_descarte`,
  `receipt_primera_lectura`.

**Dos choques con el pipeline actual que hay que resolver al implementar esto:**

1. **El backoff castigaría al sospechoso.** `recordResults` (`src/search-state.ts:198`) clasifica
   como intento fallido *todo* lo que no traiga `motivo === "sesión expirada"` → 6h/12h/24h. Un
   sospechoso descartado **no es ni encontrado ni no-encontrado**: si cae en `noEncontrados`, un
   recibo real se queda sin escribir hasta un día. Hace falta una **tercera clase** que se trate
   como la sesión expirada (elegible ya, sin avanzar `attempts`).
2. **El flush en caliente lo persistiría antes de reencolarlo.** `flushBatch`
   (`src/stephy-login.ts:876`) escribe en Supabase cada 10 trackings. El sospechoso **no puede
   entrar en `encontrados`** — necesita su propio buffer, fuera del lote, hasta que la segunda
   búsqueda lo confirme.

### 1.5 Verificación (obligatoria antes de reactivar los crons)

- Corrida con límite sobre trackings **cuyo recibo real conocemos**: `449829` (venta 30510) y
  `449781` (venta 19448).
- Comprobar a mano en Stephy una muestra de los nuevos.
- **Criterio de salida:** cero lecturas <900 ms aceptadas, y el set conocido sale correcto.
- **Canario al reactivar:** habilitar **un solo** cron de scraper (`MamaSAN-Stephy-1000`), revisar
  esa primera corrida entera (correo + `auditoria_tracking_stephy`) antes de habilitar el segundo.
  `MamaSAN Instruir` va de último, y solo cuando la Fase 3 haya limpiado lo que quedó en
  `Con recibo Almacen Miami`.

### 1.6 Pruebas

Se está tocando el corazón del scraper y hoy el repo solo tiene `pnpm typecheck` — la
verificación es 100% manual. Las guardas A/B/C y la clasificación de sospechosos son **lógica
pura**: se pueden probar sin navegador pasándole a `searchOneTracking` una `EvalPage` falsa que
devuelva secuencias de lecturas (residuo → valor bueno, par corrido, receipt tardío). Vale el
costo de montar el runner mínimo antes de tocar el lector.

---

## Fase 2 — Casos puntuales abiertos

Ya diagnosticados, con mercancía física de por medio. No dependen de código.

### Venta 18559
- [x] Guía `449781` liberada (movida a la venta 19448, su dueño real)
- [ ] Devolver de `Por Entregar ccs` a `Recibido almacen Miami` — regresión (rango 80 → 40), la
      anula `trg_clamp_regresion_shipping`. Requiere
      `set_config('app.bypass_estatus_clamp','on', true)` en la misma transacción.
      **Lo corre Jaime** (el clasificador de permisos lo bloquea desde aquí).

### Venta 30510 — grupo Shein `GSU18F221000Q4R`
- [x] `449829` desvinculado del grupo Shein (sg + artículo 35031228).
      Respaldo `bkp_fix_449829_shein_20260731_sg` / `_dpv` (RLS on).
      `449829` se queda en el grupo Amazon `113-4281271-1231463`, su dueño real.
- [ ] **Escribir el recibo REAL del Shein** — Jaime le dio instrucción en Stephy el 31/07, el
      número lo tiene él. **Pendiente: que lo pase.**
- [ ] Devolver estatus de `Recibido almacen Ccs` a `Con instruccion Almacen Miami`
      (rango 70 → 60, mismo clamp, mismo procedimiento). El vuelo `073126AF` sí es correcto.
- [ ] Aclarar si los grupos `GSU18F221000Q47` y `Q48` (mismo `tracking_master`, hoy en
      `Enviado Proveedor` sin recibo) entraron en la instrucción del 31/07 o son cajas aparte.

---

## Fase 3 — Limpieza de los grupos cruzados

Universo detectado por **tres** señales. Las dos primeras viven en la bitácora; la tercera vive en
la BD y es la que cubre el hueco de la bitácora (ver "ventana ciega" abajo).

| Detector | Dónde | Qué marca | Grupos |
|---|---|---|---|
| Recibo ambiguo en bitácora — mismo recibo con >1 tracking | `auditoria_tracking_stephy` | cruces delatados por repetición | 76 |
| Lectura rápida — `ms < 900` | `auditoria_tracking_stephy` | cruces que nadie delató | 67 |
| **Unión (universo original del plan)** | | | **82** |
| Recibo ambiguo en BD — mismo `tracking_master_courier` en grupos con `tracking_master` distinto | `shipping_groups` | cruces de cualquier época | **39 recibos / 99 grupos** |

La segunda señal es imprescindible: el caso 449829 no salía en la primera porque el bot leyó ese
recibo una sola vez; lo delató el tiempo, 136 ms.

### ⚠️ Ventana ciega — el "82" no es el universo

`auditoria_tracking_stephy` **arranca el 2026-07-15 15:43 UTC** (2.426 filas, 430 trackings). El
bot venía escribiendo receipts desde ~18/06: **hay un mes de corridas sin bitácora**, y los dos
primeros detectores viven ahí dentro. De los 2.529 grupos con recibo en BD, solo **244** están
cubiertos por el audit.

El tercer detector no depende de la bitácora y por eso ve hacia atrás:

- **39 recibos ambiguos en BD** (99 grupos involucrados)
- **30 de esos 39 ni siquiera aparecen en `auditoria_tracking_stephy`** → invisibles para el plan original
- **35 de 39 son dentro de un mismo cliente** → invisibles también para `guard_recibo_duplicado` (ver Fase 4.1)
- 23 fueron tocados por primera vez antes de que existiera el audit

Antes de trabajarlos hay que **depurarlos contra dos cosas**: las consolidaciones legítimas (caja
partida, el bloque C de abajo) y los 37 residuales de la limpieza de receipts duplicados del 30/07
(31 consolidados descartados + 6 que no están en Stephy). Lo que sobreviva se suma a la cola.

⚠️ **Prioridad por encima de todo bloque:** los **16 grupos marcados que quedaron en
`Con recibo Almacen Miami`** cuando se pausó `MamaSAN Instruir`. Son los que estaban a una
corrida de convertirse en guía física mal dirigida.

Orden de trabajo, de mayor a menor daño:

| Bloque | Grupos | Qué es | Trato |
|---|---|---|---|
| **B** | 17 | Dos trackings distintos, mismo cliente. **Uno de cada pareja está mal** | uno por uno, máxima prioridad |
| **E** | 5 | Lectura rápida sin ambigüedad. Empezar por `449839` y `450360` (145-146 ms) | uno por uno |
| **D-avanzados** | 12 | Un solo grupo, ya instruidos/volados — daño inminente | uno por uno |
| **D-resto** | 31 | Un solo grupo, sin mover. **No despriorizar**: el caso 449781 tenía esta forma y estaba mal | por lotes |
| **C** | 16 | Varios grupos, mismo tracking. Probablemente legítimos (caja partida) | confirmar y descartar en bloque |

**Reglas:**
- Verificar buscando el **tracking en Stephy**, nunca dando por bueno el audit. Si se usa el
  lector inverso (`stephy:consignee`), tiene que ser **después** de la Fase 1.2-bis: hoy ese
  lector arrastra el mismo bug.
- El detector marca el **recibo**, no necesariamente al tenedor actual: puede que el grupo que lo
  tiene hoy sea el correcto.
- Respaldo `bkp_fix_*` **con RLS activado** antes de cada corrección.
- ⚠️ El nudo de la **venta 33826**: tres recibos enredados sobre cuatro grupos, con dos trackings
  apareciendo cada uno en dos recibos. Se desata entero de una sentada, no recibo por recibo.

Lista completa categorizada: `data/receipts-cruzados-20260731.md`.

### Receta de corrección (y por qué no es un solo UPDATE)

Quitarle un recibo malo a un grupo toca **dos tablas y dos triggers**:

1. `shipping_groups.tracking_master_courier := NULL`
2. **`detalle_producto_venta.tracking_courier := NULL`** en los artículos del grupo. Si esto se
   omite, el webhook `actualizar-receipts` es idempotente y **excluye las filas que ya tienen
   courier cargado** → el recibo correcto no se escribe nunca y el grupo queda muerto.
3. Devolver `estatus_shipping` (`Recibido almacen Ccs` 70 / `Con instruccion` 60 /
   `Con recibo` 50 → `Enviado Proveedor` 40).

El paso 3 choca con **`trg_clamp_regresion_shipping`, que está en las DOS tablas**
(`shipping_groups` y `detalle_producto_venta`) → requiere
`set_config('app.bypass_estatus_clamp','on', true)` en la misma transacción, y eso **lo corre
Jaime** (el clasificador de permisos lo bloquea desde aquí).

⚠️ **Consecuencia operativa que el plan no contemplaba:** no son las 2 transacciones de la
Fase 2 — son ~82 (más lo que aporte el detector nuevo). **Decisión previa a empezar:** armar
**un solo script SQL por bloque**, con su `set_config` y su respaldo, que Jaime corra de una
sentada. Nada de ir grupo por grupo pidiéndole un bypass cada vez.

**NO usar `app.bypass_recibo_guard`** (decidido el 30/07): ese es el otro guard, el de recibos
duplicados, y desactivarlo es justo lo contrario de lo que se quiere aquí.

---

## Fase 4 — Blindaje

1. **Extender `guard_recibo_duplicado`.** Hoy el trigger (`trg_guard_recibo_duplicado` sobre
   `shipping_groups`) solo actúa si el recibo cae en un grupo de **otro cliente**
   (`v.user_id IS DISTINCT FROM v_user_new`). Los cruces dentro de un mismo cliente pasan
   limpios — y son los más probables, porque los trackings de una venta se buscan seguidos.
   **La medición lo confirma: 35 de los 39 recibos ambiguos en BD son del mismo cliente.**
   Agregar: avisar cuando un recibo caiga en dos grupos del mismo cliente con `tracking_master`
   distinto. Eso habría cazado el 449829.
   *Al tocarlo, conservar el filtro `NEW.tracking_master_courier ~ '^[0-9]{5,7}$'` y el escape
   por `app.bypass_recibo_guard`; y para el caso mismo-cliente **avisar, no revertir** (hoy el
   trigger restaura el valor viejo en silencio).*
2. **Alerta de lecturas rápidas en el correo de corrida** (`buildEmailHtml` ya existe; es agregarle
   una sección).
3. **Consulta programada semanal** que avise sola. Debe correr **el detector de BD** (recibo
   ambiguo en `shipping_groups`), no solo los de bitácora: es el único que no depende de la
   retención ni de la ventana de `auditoria_tracking_stephy`.

---

## Fase 5 — NOP por producto

Objetivo: que cada producto tenga su NOP desglosado (`-1`, `-2`, `-3`) **solo cuando hay evidencia
de que el envío se separó**; mientras no la haya, el NOP se muestra pelado.

**Estado del modelo hoy:** `no_orden_prov` ya vive **por artículo** (columna de
`detalle_producto_venta`, no de `shipping_groups`). La granularidad ya existe; falta el nombre. Y
el mecanismo de separación también existe: `shipping_groups` con la convención `Envio2`/`Envio3`
que ya usan los skills de Amazon/Shein/Temu.

### ⚠️ 5.0 Prerrequisito — el trigger que el plan no contemplaba

`trigger_asignar_grupo_por_no_orden_prov` (BEFORE INSERT/UPDATE en `detalle_producto_venta`,
`SECURITY DEFINER`) hace dos cosas que contradicen el diseño de 5.1:

1. **Deriva `id_grupo` DESDE `no_orden_prov`** — busca `shipping_groups` con
   `nombre_grupo = btrim(no_orden_prov)` dentro de la venta, y lo **crea** si no existe. La
   dirección real es NOP → grupo, no grupo → NOP como propone el `nop_display`.
2. **Pisa `tracking_proveedor`, `tracking_courier` y `tracking_vzla` del artículo con los del
   grupo en CADA update.** O sea: la "granularidad por artículo" de la que parte esta fase es un
   **espejo del grupo**, no un dato propio — no puede divergir.

Consecuencia: mover un producto a otro grupo exige cambiar su `no_orden_prov` (a `Envio2`, como
hacen los skills hoy) — justo lo que 5.1 quiere evitar. Y cualquier sufijo derivado de `id_grupo`
convive con un trigger que resuelve el sentido contrario.

**Esto se verifica ANTES de 5.1 y 5.2**, no después: define si el diseño es viable tal cual o
hay que tocar el trigger. Prueba barata: actualizar cualquier campo de un `detalle_producto_venta`
que esté en un grupo `Envio2` y ver si el trigger lo devuelve a su grupo original.

Números al 2026-07-31:

| | |
|---|---|
| NOPs totales | 2.160 |
| con más de 1 producto | 530 |
| ya repartidos en más de un grupo | 151 |
| con más de un `tracking_proveedor` | 81 |
| con más de un `tracking_courier` | 78 |
| en más de una venta | 59 ⚠️ (ver Fase 6) |

### 5.1 Columna derivada `nop_display`

`no_orden_prov` **se queda intacto**: es la llave contra Amazon/Shein/Temu y contra
`auditoria_compras_*` y las vistas `v_auditoria_*_po_reusado`. Si se le mete `-2`, los skills
`trackings-amazon`, `buscar-tracking-temu` y `buscar-tracking-shein` dejan de encontrar la orden
en el proveedor.

El sufijo se **calcula desde `id_grupo`**: 1 grupo → sin sufijo; 2+ grupos → `-1`, `-2`. Así la
regla "mientras no haga falta, no separes" sale gratis y no puede desincronizarse de la realidad.

### 5.2 Disparador limpio — se puede ya (no depende de Fase 1)

`tracking_proveedor` distinto dentro del mismo NOP (81 casos). Es dato del proveedor, no del
scraper. Automatiza lo que los skills de Amazon/Shein/Temu ya hacen a mano creando `Envio2`.

### 5.3 Disparador por receipt — después de Fase 1

`tracking_courier` distinto dentro del mismo NOP (78 casos). **Hoy no es confiable**: el receipt es
justo el campo contaminado por el bug, así que "mismo NOP con receipts diferentes" puede ser real
o puede ser el scraper leyendo el recibo de otro tracking. Un grupo partido es mucho más difícil
de deshacer que un campo mal escrito.

Cuando el receipt **contradiga** al proveedor → **alertar, no repartir en silencio**. Son dos
separaciones distintas: el proveedor puede mandar 2 shipments que en Miami llegan en 1 caja, o al
revés.

---

## Fase 6 — Higiene

- [ ] **59 NOPs que aparecen en más de una venta** — no deberían existir. Investigar: reuso de NOP,
      error de carga o consolidación mal registrada.
- [ ] **RLS en las 10 tablas `bkp_*` viejas** (30-31/07): hoy legibles y escribibles con la anon
      key. Activar sin políticas las deja solo para service-role, que es lo deseado en un respaldo.
- [x] **`git push`** — hecho 2026-07-31: `origin/main` pasó de `94738be` a `d5e657c`, subiendo
      `3e10742` (#17) que llevaba días sin pushear.
- [x] Commitear el `.gitignore` (línea `data/receipts-*.md`) y este archivo — commit `d5e657c` (#18).
- [ ] Logs de evento del caso 449781: `repartos_escaneos` `db3bfb6f` y 2 filas de
      `historial_shipping_grupo` siguen apuntando al grupo de 18559. Son tablas de auditoría —
      propuesta: dejarlas y anotar la corrección aparte. **Falta decisión.**

---

## Pendiente de Jaime

1. El número de recibo **real** del Shein de la venta 30510 (instrucción del 31/07).
2. Correr los dos `set_config('app.bypass_estatus_clamp', ...)` de la Fase 2.
3. Decisión sobre los logs de evento (Fase 6).
4. **Los ~82 `set_config` de la Fase 3** — decidir el formato (un script SQL por bloque) antes de
   empezar la limpieza.
5. **Revisar qué salió por `MamaSAN Instruir` desde el 18/06** — la tarea corría 2×/día sobre
   recibos que ya venían contaminados; el caso 449781 salió por ahí. Hay 688 grupos en
   `Con instruccion Almacen Miami` (36 marcados) y 654 ya `Entregado` (27 marcados).
6. Los bugs que faltan por pasar — se acumulan aquí con causa + evidencia.
