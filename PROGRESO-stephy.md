# PROGRESO — proyecto `stagehand-stephy` (handoff entre sesiones)

> Estado y contexto para continuar en otra sesión. Última actualización: 2026-06-16 (parte 2).
> Acompaña a [`CONTEXT-stagehand-amazon.md`](CONTEXT-stagehand-amazon.md) (base genérica
> heredada de stagehand-amazon: stack, factory de Stagehand, estructura de la BD Supabase).

> **Lo más reciente (2026-06-16, parte 2):** el **pipeline completo funciona end-to-end y está
> verificado con datos reales**: `pnpm stephy` lee NOPs (webhook `nops-con-tracking`) → clickea
> **"All"** en Receipts → scrapea todos los recibos del almacén → cruza por tracking → y
> **persiste en Supabase** (`persistMatches` → webhook `actualizar-receipts`). En dos corridas se
> escribieron 50 productos + 41 grupos reales con `tracking_courier` y estatus `'Con recibo
> Almacen Miami'`. **Paso 1 cerrado. Punto C resuelto** (no había bug de filtros; los
> no-encontrados son productos que aún no llegan a Miami). Ver **§8.4 / §8.5**.
>
> **Lo siguiente (opcional):** Punto D — modo *preview* (mostrar qué se va a escribir sin tocar
> Supabase) para auditar antes de persistir. Hoy escribe directo (idempotente). Detalle en §8.5.

---

## 0. Objetivo del proyecto

Automatizar **StephyTracking** (https://app.stephytracking.com/) para la compañía
**Tecnoship**, rol **Agente**, con Stagehand v3 + Chrome local. Comparte la base de datos
Supabase "Mama SAN Amazon" (`pdjxswivcgiwzrfexiiw`) y las mismas tablas que stagehand-amazon
(ver §6 del CONTEXT). Puede que se agregue alguna tabla adicional más adelante.

---

## 1. Estado actual — ✅ Login funcionando end-to-end

El flujo de **inicio de sesión completo está implementado y verificado** (llega al dashboard):

`pnpm stephy` → `src/stephy-login.ts`:
1. Abre la landing, escribe **`tecnoship`** en la búsqueda y Enter.
2. Clickea la tarjeta de la compañía **Tecnoship Group** (vía agente `act()`).
3. Cambia el rol **Consignatario → Agente** (ion-select + diálogo, vía agente).
4. Llena **usuario (624)** y **contraseña (Mama*123)** en los inputs visibles.
5. Espera 1 s y presiona **ENTRAR**.
6. Espera y confirma el **dashboard**: `https://app.stephytracking.com/tecnoship/1/dashboard`.

Resultado verificado:
```
✓ Rol "Agente" activo (https://app.stephytracking.com/tecnoship/1/login/a).
✓ Login completado. Dashboard: https://app.stephytracking.com/tecnoship/1/dashboard
```

**Siguiente paso pendiente**: automatizar el trabajo DENTRO del dashboard (aún no empezado).
Secciones vistas en el dashboard: *Pending Invoices*, *Pending Receipts*, *Pending Pickups*.
El menú lateral (☰) y las rutas tipo `/tecnoship/1/receipts` existen (los skills de MAMÁ SAN
ya usan `app.stephytracking.com/tecnoship/1/receipts`).

---

## 2. APRENDIZAJES CLAVE de StephyTracking (críticos, no re-descubrir)

1. **Es una app Ionic/Angular** (no Material). Implica:
   - **El DOM mantiene COPIAS OCULTAS del formulario** (vistas Ionic en transición). Un
     `locator('input[type=text]').first()` suele caer en un input **oculto** → el llenado
     falla en silencio. **Hay que apuntar al elemento VISIBLE.**
   - Para llenar inputs reactivos de Angular: setear el valor con el **setter nativo**
     (`HTMLInputElement.prototype.value`) y disparar eventos `input`/`change`/`blur`, no solo
     `.value=`. (Implementado en el helper `fillVisible()` de `stephy-login.ts`.)
2. **El rol se codifica en la URL**: `/tecnoship/1/login/c` = Consignatario,
   `/tecnoship/1/login/a` = **Agente**. El script verifica `/login/a` antes de escribir.
   - Navegar DIRECTO a `/tecnoship/1/login` (sin pasar por la búsqueda de compañía) **redirige
     a `/`** — hay que hacer siempre el flujo de búsqueda de compañía primero.
3. **Selectores reales del login** (rol Agente, elementos VISIBLES):
   - Usuario: `input[name="user"]` (placeholder "Número de Cuenta").
   - Contraseña: `input[name="password"][type="password"]` (placeholder "Contraseña").
   - Rol: `ion-select[formcontrolname="type"]` (abre un `ion-alert` con radios + OK).
   - Submit: `button[type="submit"]` con texto **ENTRAR**.
   - Búsqueda de compañía: `input[placeholder*="Search" i]` (aria-label "search text").
4. **Stagehand v3 understudy locator**: tiene `.first()`, `.click()`, `.fill()`,
   `.isVisible()`, `.count()`. **NO tiene `.last()` ni `.nth()`** (lanza TypeError). Para
   "el visible entre varios", usar `page.evaluate(<string>)` y filtrar por visibilidad.
5. **`*:has-text("…")` matchea ancestros** (incluido `<html>`): `.first()` devuelve el
   `<html>` y clickearlo es un no-op. NO usar `:has-text` con `.first()` para clicks; usar el
   agente (`act()`) o `evaluate` con filtro de texto+visibilidad.
6. **Componentes custom (tarjeta de compañía, diálogo de rol)**: el agente `act()` los maneja
   de forma confiable; los inputs/botones nativos se manejan mejor deterministas por `evaluate`.

---

## 3. Operación / cómo correr

```bash
cd "C:/Users/Moises Loita/Desktop/stagehand-stephy"
pnpm install      # primera vez
pnpm smoke        # test de humo sin LLM (lanza Chrome, navega example.com)
pnpm stephy       # FLUJO DE LOGIN completo (deja el navegador abierto al final)
pnpm inspect      # diagnóstico: vuelca el DOM real del login (útil si cambia el sitio)
pnpm typecheck    # tsc --noEmit
```

- El navegador queda **abierto al final** (espera Enter en la terminal). Es intencional para
  inspección manual.
- **`headless: false`** siempre (ventana visible) para ver el flujo.

### ⚠ Gotcha operativo: lock del perfil de Chrome
Si una corrida se interrumpe, queda un Chrome usando `chrome-user-data` y la siguiente corrida
falla con **`ECONNREFUSED 127.0.0.1:<puerto>`**. Solución: matar ese Chrome antes de reintentar:
```powershell
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*stagehand-stephy*chrome-user-data*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 4. Estructura del proyecto

```
stagehand-stephy/
├── src/
│   ├── stagehand.ts        # Factory makeStagehand() — copiado de amazon, reutilizable tal cual.
│   ├── smoke.ts            # Test de humo sin LLM.
│   ├── stephy-login.ts     # ★ Flujo de login (pnpm stephy). Helpers fillVisible/clickVisibleButton.
│   └── inspect-dom.ts      # Diagnóstico: vuelca inputs/buttons/selects del login (pnpm inspect).
├── data/                   # Logs de corridas (login-run.log, inspect.log). gitignored.
├── chrome-user-data/       # Perfil persistente DEDICADO de Chrome (gitignored). Mantiene sesión.
├── CONTEXT-stagehand-amazon.md  # Base genérica + estructura de la BD Supabase.
├── PROGRESO-stephy.md      # ESTE archivo (handoff).
├── package.json, tsconfig.json, .gitignore
└── .env (gitignored) / .env.example
```

### Scripts npm (`package.json`)
`smoke`, `stephy` (login), `inspect`, `typecheck`.
NOTA: NO nombrar un script `login` — choca con el comando reservado `pnpm login` (registro npm).

---

## 5. Configuración (`.env`)

Variables activas (valores reales en `.env`, gitignored):
- `OPENROUTER_API_KEY` (heredada de amazon — **conviene rotarla**), `OPENROUTER_MODEL=google/gemini-3.5-flash`
- `STAGEHAND_ENV=LOCAL`, `CHROME_PATH`, `CHROME_USER_DATA_DIR` (perfil propio de stephy)
- `STEPHY_URL=https://app.stephytracking.com/`
- `STEPHY_COMPANY=tecnoship`
- `STEPHY_ROLE=Agente`
- `STEPHY_USER=624`
- `STEPHY_PASSWORD=Mama*123`

---

## 6. Base de datos (recordatorio)

Misma Supabase que amazon: proyecto **`pdjxswivcgiwzrfexiiw`** ("Mama SAN Amazon"). Tablas
núcleo: `venta`, `detalle_producto_venta`, `shipping_groups`, `usuarios`, `cuota`,
`direcciones_envio`, `proveedor`. Detalle completo en `CONTEXT-stagehand-amazon.md` §5.
Acceso: webhooks n8n **o** MCP de Supabase (`mcp__838e5e5c-…`) / `@supabase/supabase-js`
(no instalado aún). Aún no se ha conectado stephy a la BD — pendiente cuando el flujo del
dashboard lo requiera.

---

## 7. TODO / próximos pasos

- [x] Definir el proceso a automatizar: **cruzar receipts de Stephy ↔ Supabase y escribir
      tracking_courier / tracking_master_courier** (equivalente al skill `actualizar-receipts-stephy-mamasan`).
- [x] Login + navegación a `/tecnoship/1/receipts` (hecho en sesiones previas).
- [x] **Write-back a Supabase montado en n8n** (webhook `actualizar-receipts`) + SQL de lectura
      alineado con los filtros del skill (webhook `nops-con-tracking`). Ver **§8**.
- [x] **`persistMatches(encontrados)` escrita en `nops-con-tracking.ts`** — hace
      `POST /webhook/actualizar-receipts` con `[{tracking_proveedor, receipt}]`, loguea
      `detalle_actualizados`/`grupos_actualizados` y devuelve la respuesta. Conectada en
      `stephy-login.ts` tras `searchReceiptsForNops` (best-effort, no lanza). El history ahora
      guarda un 4º archivo `supabase-actualizado.json`. Typecheck OK; webhook reverificado con
      `[]` → ceros. **Falta probar end-to-end con matches reales (depende del Punto C).**
- [ ] **(Punto C, pendiente)** Verificar en vivo la pantalla Receipts: ¿el filtro **"Dates"**
      limita a HOY? La última corrida cruzó 318 NOPs y dio **0 matches** → muy probablemente hay
      que abrir Filters → apagar "Dates" → Apply → botón **"All"** antes de scrapear. Sin esto
      no hay nada que persistir.
- [ ] **(Punto D, pendiente)** Decidir modo **preview** vs. ejecución directa, y si se confirma
      el supuesto `tracking_master == tracking_proveedor` (hasta ahora se cumple en los datos vistos).
- [ ] Considerar rotar `OPENROUTER_API_KEY` (viene del .env de amazon).
- [ ] (Opcional) Hacer determinista el cambio de rol y el click de la tarjeta para reducir
      dependencia del LLM (`act()`), si se busca más velocidad/robustez.

---

## 8. Sesión 2026-06-16 — Write-back a Supabase vía n8n (parte server-side LISTA)

Contexto: el flujo Stagehand leía pendientes (webhook `nops-con-tracking`), cruzaba contra la
tabla Receipts y solo escribía JSON local — **nunca persistía en Supabase** (faltaba el paso 5 del
skill). Esta sesión cerró la parte **server-side** de ese gap. Falta solo la llamada desde el TS.

### 8.1 Webhook NUEVO `actualizar-receipts` (paso 5 del skill) — ✅ creado y activo

- **n8n workflow id:** `rA1HoTmdEQRNaWi8`
- **URL producción:** `POST https://n8n-n8n.40j1oe.easypanel.host/webhook/actualizar-receipts`
- **Sin credenciales de entrada** (público, como `nops-con-tracking`).
- **Nodos:** Webhook → Code "Armar SQL UPDATEs" → Postgres "Ejecutar UPDATEs" → Respond.
- **Credencial Postgres usada:** `Postgres account` (id `wkKZ7GmIBS4c72M5`) — la única del proyecto.

**Contrato de entrada** (body = array, o `{ "matches": [...] }`):
```json
[ { "tracking_proveedor": "GFUS01046715372864", "receipt": "442202" }, ... ]
```
- Acepta también `tracking_master` como alias de `tracking_proveedor`, y `tracking_courier` como
  alias de `receipt`. Deduplica por `tracking_proveedor`. Sanitiza cada valor con whitelist
  `[A-Za-z0-9_.-/ ]` (anti-inyección, ya que el webhook es público).

**Qué hace** (un solo SQL con CTEs que modifican datos, idempotente):
- `UPDATE detalle_producto_venta SET tracking_courier=<receipt>, estatus_shipping='Con recibo
  Almacen Miami', fecha_actualizacion_shipping=NOW()` donde `tracking_proveedor=<tp>` **AND
  estado_compra='comprado' AND tracking_courier vacío** (no pisa courier ya cargado).
- `UPDATE shipping_groups SET tracking_master_courier=<receipt>, estatus_shipping='Con recibo
  Almacen Miami', updated_at=NOW()` donde `tracking_master=<tp>` **AND tracking_master_courier vacío**.
- Asume `tracking_master == tracking_proveedor` (mismo valor en ambas tablas; confirmado en datos).

**Respuesta** (un objeto):
```json
{ "detalle_actualizados": N, "grupos_actualizados": G, "detalle": [ ...filas RETURNING... ], "grupos": [ ... ] }
```
- **Verificado:** `POST []` (array vacío) → `{ "detalle_actualizados":0, "grupos_actualizados":0,
  "detalle":[], "grupos":[] }` sin tocar datos. Idempotente y seguro reejecutar.

### 8.2 Webhook `nops-con-tracking` (lectura) — ✅ actualizado

- **n8n workflow id:** `wmpClU53AFKkanIi` · misma URL `POST /webhook/nops-con-tracking`.
- **Antes:** solo filtraba `no_orden_prov`/`tracking_proveedor` presentes y `tracking_courier` vacío
  → devolvía un **superconjunto** (335 NOPs / 511 productos) con estados fuera de etapa.
- **Ahora** el SQL además filtra (igual que el Paso 1 del skill):
  - `LOWER(estado_compra) = 'comprado'`
  - `estatus_shipping IN ('Enviado Proveedor','Con instruccion Almacen Miami','Recibido almacen Miami')`
  - `fecha_actualizacion_compra` entre `(DATE_TRUNC('year',NOW())+INTERVAL '1 month')` y `NOW()`.
- **Y agrega al SELECT** (para el UPDATE de grupos robusto): `dpv.id_grupo`, `sg.nombre_grupo`,
  `sg.tracking_master` (vía `LEFT JOIN shipping_groups sg ON sg.id_grupo = dpv.id_grupo`).
- El nodo Code ahora incluye `tracking_master` e `id_grupo` en cada `nops_detalle`.
- **Verificado:** ahora devuelve **318 NOPs / 446 productos** y los `items` solo traen los 3
  estados permitidos (Enviado Proveedor 409, Con instruccion 35, Recibido Miami 2).

### 8.3 Lo que FALTA (próxima sesión)

1. ~~**Código TS** — `persistMatches(encontrados)`~~ ✅ **HECHO (sesión 2026-06-16, parte 2).**
   Implementada en `src/nops-con-tracking.ts` (export), conectada en `stephy-login.ts` tras
   `searchReceiptsForNops`. URL por env `ACTUALIZAR_RECEIPTS_WEBHOOK_URL`. El history guarda un
   4º archivo `supabase-actualizado.json` con la respuesta del webhook. Filtra los matches sin
   `receipt`, deduplica por contrato del webhook, no lanza (best-effort). Typecheck OK.
2. **(SIGUIENTE) Punto C** — REPLANTEADO tras la corrida 2026-06-16 14:41. Ver §8.4.
3. **Punto D** — modo preview vs. directo; confirmar `tracking_master == tracking_proveedor`.

---

## 8.4 Sesión 2026-06-16 (parte 2) — Write-back PROBADO end-to-end + replanteo Punto C

`persistMatches` quedó conectada y se corrió `pnpm stephy` completo. Resultado **real**:
- 85 recibos recolectados (2 páginas) · **40 matches** · 279 no encontrados (de 319 NOPs).
- `persistMatches` → webhook → **Supabase actualizado de verdad: 49 productos en
  `detalle_producto_venta` + 40 grupos** con `tracking_courier` y estatus `'Con recibo Almacen
  Miami'`. Historial en `data/history/2026-06-16_14-41-04/` (4 archivos, incl. `supabase-actualizado.json`).
- ⇒ **El pipeline funciona end-to-end.** El paso 1 está cerrado y verificado con datos reales.

**Punto C REPLANTEADO** (la premisa vieja "0 matches por filtro Dates" NO se reprodujo):
- Dump del DOM de Receipts (correr `STEPHY_DUMP_RECEIPTS=1 pnpm stephy`, bloque diagnóstico en
  `stephy-login.ts` gateado por esa env): **NO hay date input**. Hay un div **"Filter"**, un botón
  **"All"**, y **dos `<select>` de estado** filtrando: select#1 value="2" (opciones tipo
  "----- Warehouse Sent"), select#2 value="-1" ("----- Pending Repack Repacked").
- Duda abierta: ¿esos dos selects ocultan recibos que SÍ cruzarían? Hoy se vieron 85 recibos; los
  279 no-encontrados probablemente son productos que aún no llegan a Miami, pero hay que CONFIRMAR
  que el filtro de estado no esté escondiendo recibos válidos.
### 8.5 Punto C — CERRADO (corrida de verificación 2026-06-16 14:48)

Se agregó `showAllReceipts(page)` (clickea el botón **"All"** vía `clickExactTextExpr`) ANTES de
`scrapeAllPages` en `searchReceiptsForNops`. Resultado de la verificación:

- **El botón "All" funciona**: consolida toda la tabla en la página 1 (pasó de 51 → **86 filas**
  en pág. 1; la pág. 2 ya son duplicados → dedup deja **86 recibos únicos**).
- **NO revela recibos ocultos**: 86 recibos ≈ los mismos 85 de antes. El universo de recibos en
  el almacén es ~86 y ya lo capturábamos vía paginación. ⇒ Los 279 no-encontrados son
  **productos que aún NO llegaron al almacén de Miami**, no un bug de filtro.
- **Semántica de los 2 selects** (volcada en el dump): 
  - Select#1 = estado del recibo: opciones `----- / Warehouse / Sent`; **está en "Warehouse"**
    (value 2) → muestra justo los recibos FÍSICAMENTE en el almacén, que es exactamente el
    subconjunto que el skill necesita (los que hay que asignar tracking_courier). Correcto.
  - Select#2 = sub-filtro de repack: `----- / Pending Repack / Repacked`; **está en "-----"**
    (sin filtro). Correcto.
- **Pipeline auto-consistente**: el read webhook trajo **280 NOPs** (antes 319) porque los ~39
  NOP que se persistieron en la corrida previa ya tienen `tracking_courier` y salen del filtro.
  Esta corrida cruzó 1 match nuevo → 1 detalle + 1 grupo actualizados.

**Conclusión:** el flujo end-to-end (leer NOPs → "All" → scrapear todos los recibos del almacén →
cruzar → persistir en Supabase) **funciona y es correcto**. Punto C resuelto. `showAllReceipts`
queda en el código permanente (mejora robustez del scrape: todo en una página).

**Pendiente menor (Punto D):** decidir si se quiere un modo *preview* (no escribir) para auditar
antes de persistir. Hoy escribe directo (idempotente). El supuesto `tracking_master ==
tracking_proveedor` se sigue cumpliendo en los datos.

> Nota: los UPDATEs son idempotentes (excluyen filas con courier ya cargado), así que es seguro
> conectar el TS y reejecutar `pnpm stephy` sin miedo a duplicar o pisar trabajo manual.
