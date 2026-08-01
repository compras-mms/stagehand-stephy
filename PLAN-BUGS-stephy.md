# Plan de bugs — Stephy

**Abierto:** 2026-07-31 · **Estado:** Fase 0 ✅ hecha, Fase 1 sin empezar

> Sin nombres de clientes. El detalle con PII vive en `data/receipts-cruzados-20260731.md`
> (gitignoreado por `data/receipts-*.md`).

---

## Índice

| Fase | Qué | Bloquea a | Estado |
|---|---|---|---|
| **0** | Parar la sangría (pausar crons) | Fase 1 | ✅ 2026-07-31 23:03 |
| **1** | Arreglar el lector (`src/search-receipts.ts`) | Fases 3, 4, 5.3 | ⬜ |
| **2** | Casos puntuales abiertos (18559, 30510) | — | 🟡 parcial |
| **3** | Limpieza de los 82 grupos | Fase 4 | ⬜ |
| **4** | Blindaje | — | ⬜ |
| **5** | NOP por producto | — | ⬜ |
| **6** | Higiene | — | ⬜ |

### Camino crítico

```
Fase 0 (crons) → Fase 1 (lector) → verificación → reactivar crons
                                        ↓
                          Fase 3 (limpieza) → Fase 4 (blindaje)
                                        ↓
                                  Fase 5.3 (NOP por receipt)

Fase 2, Fase 5.2 y Fase 6 corren en paralelo, no bloquean.
```

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

- [x] `MamaSAN-Stephy-1000` deshabilitada
- [x] `MamaSAN-Stephy-2000` deshabilitada
- [x] `MamaSAN-Stephy-0600` y `-1600` ya estaban deshabilitadas de antes

**Frontera datos sucios / datos por confirmar:**
última corrida automática **2026-07-31 20:00:01 -04:00** (`MamaSAN-Stephy-2000`, resultado 0).
Pausa aplicada **2026-07-31 23:03 -04:00**.

Reactivar con:

```bash
powershell -Command "Enable-ScheduledTask -TaskName 'MamaSAN-Stephy-1000'; Enable-ScheduledTask -TaskName 'MamaSAN-Stephy-2000'"
```

**Criterio de salida:** cero corridas nuevas hasta que la Fase 1 pase su verificación (1.5).

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

### 1.2 Las tres guardas en `searchOneTracking`

| Guarda | Qué hace | Ataca |
|---|---|---|
| **A. Descartar la primera lectura** | El poll lee de inmediato tras el click; un recibo presente en la iteración 0 es residuo por definición. Guardarlo como `baseline` y exigir que el valor **cambie** respecto de él | residuo |
| **B. Exigir `vals[0] === tracking`** | Si el input de Tracking ya no contiene lo buscado, la pantalla es de otra búsqueda | respuesta tardía *(si 1.1 confirma que repinta)* |
| **C. Leer el par de la fila, no del input** | Tomar tracking↔recibo del `resultSnap` y exigir que el tracking de la fila sea el buscado | ambas |

Si 1.1 confirma que la fila trae el par, **C sustituye a B** y es más fuerte. Si no, quedan
A + B + 1.3.

### 1.3 Cerrar el XHR tardío por la vía dura

Guarda independiente del comportamiento de Angular, y por eso va igual: cuando una búsqueda se
abandona por presupuesto (`maxWaitMs` agotado, o el atajo de `src/search-receipts.ts:275`), su XHR
queda vivo. Antes de pasar al siguiente tracking, **resetear el estado de la página** (recarga de
`/search` o salir y volver) para que esa respuesta no tenga dónde pintar.

Solo se paga en las búsquedas abandonadas, no en todas. Y es determinista: no depende de adivinar
cómo repinta el framework.

### 1.4 Marcar en vez de creer

- Registrar `sospechoso = true` cuando `ms < 900` (umbral validado: 88% de esas lecturas traen
  recibo ambiguo, vs 40% de las normales).
- **Un recibo sospechoso no se persiste** — se reencola para una segunda búsqueda al final de la
  corrida. Si la segunda coincide, entra; si no, se reporta.
- Columnas nuevas en `auditoria_tracking_stephy`: `sospechoso`, `motivo_descarte`,
  `receipt_primera_lectura`.

### 1.5 Verificación (obligatoria antes de reactivar los crons)

- Corrida con límite sobre trackings **cuyo recibo real conocemos**: `449829` (venta 30510) y
  `449781` (venta 19448).
- Comprobar a mano en Stephy una muestra de los nuevos.
- **Criterio de salida:** cero lecturas <900 ms aceptadas, y el set conocido sale correcto.

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

## Fase 3 — Limpieza de los 82 grupos

Universo detectado por **dos** señales (la segunda es imprescindible: el caso 449829 no salía en
la primera porque el bot leyó ese recibo una sola vez; lo delató el tiempo, 136 ms):

| Detector | Qué marca | Grupos |
|---|---|---|
| Recibo ambiguo — mismo recibo con >1 tracking en la bitácora | cruces delatados por repetición | 76 |
| Lectura rápida — `ms < 900` | cruces que nadie delató | 67 |
| **Unión** | | **82** |

Orden de trabajo, de mayor a menor daño:

| Bloque | Grupos | Qué es | Trato |
|---|---|---|---|
| **B** | 17 | Dos trackings distintos, mismo cliente. **Uno de cada pareja está mal** | uno por uno, máxima prioridad |
| **E** | 5 | Lectura rápida sin ambigüedad. Empezar por `449839` y `450360` (145-146 ms) | uno por uno |
| **D-avanzados** | 12 | Un solo grupo, ya instruidos/volados — daño inminente | uno por uno |
| **D-resto** | 31 | Un solo grupo, sin mover. **No despriorizar**: el caso 449781 tenía esta forma y estaba mal | por lotes |
| **C** | 16 | Varios grupos, mismo tracking. Probablemente legítimos (caja partida) | confirmar y descartar en bloque |

**Reglas:**
- Verificar buscando el **tracking en Stephy**, nunca dando por bueno el audit.
- El detector marca el **recibo**, no necesariamente al tenedor actual: puede que el grupo que lo
  tiene hoy sea el correcto.
- Respaldo `bkp_fix_*` **con RLS activado** antes de cada corrección.
- ⚠️ El nudo de la **venta 33826**: tres recibos enredados sobre cuatro grupos, con dos trackings
  apareciendo cada uno en dos recibos. Se desata entero de una sentada, no recibo por recibo.

Lista completa categorizada: `data/receipts-cruzados-20260731.md`.

---

## Fase 4 — Blindaje

1. **Extender `guard_recibo_duplicado`.** Hoy solo bloquea si el recibo cae en un grupo de **otro
   cliente** (`user_id IS DISTINCT FROM`). Los cruces dentro de un mismo cliente pasan limpios — y
   son los más probables, porque los trackings de una venta se buscan seguidos. Agregar: avisar
   cuando un recibo caiga en dos grupos del mismo cliente con `tracking_master` distinto. Eso
   habría cazado el 449829.
2. **Alerta de lecturas rápidas en el correo de corrida** (`buildEmailHtml` ya existe; es agregarle
   una sección).
3. **Consulta programada semanal** con los dos detectores, que avise sola.

---

## Fase 5 — NOP por producto

Objetivo: que cada producto tenga su NOP desglosado (`-1`, `-2`, `-3`) **solo cuando hay evidencia
de que el envío se separó**; mientras no la haya, el NOP se muestra pelado.

**Estado del modelo hoy:** `no_orden_prov` ya vive **por artículo** (columna de
`detalle_producto_venta`, no de `shipping_groups`). La granularidad ya existe; falta el nombre. Y
el mecanismo de separación también existe: `shipping_groups` con la convención `Envio2`/`Envio3`
que ya usan los skills de Amazon/Shein/Temu.

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
- [ ] **`git push`** del commit `3e10742` — `origin/main` sigue en `94738be`.
- [ ] Commitear el `.gitignore` (línea `data/receipts-*.md`) y este archivo.
- [ ] Logs de evento del caso 449781: `repartos_escaneos` `db3bfb6f` y 2 filas de
      `historial_shipping_grupo` siguen apuntando al grupo de 18559. Son tablas de auditoría —
      propuesta: dejarlas y anotar la corrección aparte. **Falta decisión.**

---

## Pendiente de Jaime

1. El número de recibo **real** del Shein de la venta 30510 (instrucción del 31/07).
2. Correr los dos `set_config('app.bypass_estatus_clamp', ...)` de la Fase 2.
3. Decisión sobre los logs de evento (Fase 6).
4. Los bugs que faltan por pasar — se acumulan aquí con causa + evidencia.
