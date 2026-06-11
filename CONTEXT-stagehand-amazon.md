# CONTEXT — base reutilizable para arrancar `stagehand-stephy`

> Documento de contexto autosuficiente. Resume lo **genérico** heredado de
> `stagehand-amazon` que `stagehand-stephy` reutiliza: stack, automatización de
> Chrome con Stagehand, login simple (sin OTP), las **conexiones** (webhooks n8n /
> Supabase), y la **estructura de la base de datos Supabase compartida**
> (proyecto "Mama SAN Amazon").
>
> Generado: 2026-06-11. Fuente: lectura del código + esquema en vivo de Supabase.
>
> **Nota:** stephy hará un **inicio de sesión simple, SIN OTP**. Todo lo relativo a
> OTP/MFA del proyecto Amazon se omitió deliberadamente.

---

## 0. Resumen ejecutivo (TL;DR)

- **Qué es**: automatización con **Stagehand v3** controlando **Chrome local** vía
  CDP/Playwright. Inicia sesión en un sistema, navega y extrae/escribe datos.
- **Stack**: TypeScript + ESM, runtime `tsx`, gestor `pnpm`. Sin framework, son scripts CLI.
- **LLM**: OpenRouter (vía Vercel AI SDK), modelo por defecto `google/gemini-3.5-flash`.
- **DB**: Supabase Postgres "Mama SAN Amazon" (`pdjxswivcgiwzrfexiiw`). En amazon la DB se
  toca **vía webhooks n8n**; stephy puede usar eso o el **MCP de Supabase** directo.
- **Tablas núcleo**: `venta`, `detalle_producto_venta`, `shipping_groups`, `usuarios`,
  `cuota`, `direcciones_envio`, `proveedor` (+ ~42 tablas auxiliares en el mismo proyecto).

---

## 1. Stack y dependencias

| Aspecto | Valor |
|---|---|
| Lenguaje | TypeScript 5 (`^5`), ESM puro (`"type": "module"`) |
| Runtime | **tsx** (`^4`) — ejecuta los `.ts` directo, sin compilar (`tsc --noEmit` solo type-check) |
| Gestor de paquetes | **pnpm** (10.x); npm funciona con `--legacy-peer-deps` |
| Stagehand | `@browserbasehq/stagehand` `^3` (v3) |
| LLM provider | `@openrouter/ai-sdk-provider` `^1` (Vercel AI SDK) |
| Env | `dotenv` `^17` (Stagehand pide `^16`; en pnpm es solo warning) |
| Validación | `zod` `^3` |
| Tipos node | `@types/node` `^24` |
| Browser engine | Playwright/CDP embebido en Stagehand v3; usa `chrome-launcher` internamente |
| DB directa (opcional) | `@supabase/supabase-js` — **NO** está heredado; añadir si stephy habla con Supabase directo |

### `tsconfig.json` (clave)
`target/module ES2022`, `moduleResolution: "bundler"`, `lib: ["ES2022","DOM"]`, `strict: true`,
`esModuleInterop`, `noEmit: true`, `types: ["node"]`, `include: ["src/**/*.ts"]`.
Importante: los imports internos usan extensión `.js` (p. ej. `from "./stagehand.js"`) aunque los
archivos sean `.ts` — requisito de ESM + bundler resolution. **Replicar este patrón en stephy.**

---

## 2. Configuración de Stagehand / Chrome  (reutilizar tal cual)

Patrón de inicialización (de `src/stagehand.ts`). Lo esencial:

```ts
import { Stagehand, AISdkClient } from "@browserbasehq/stagehand";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import dotenv from "dotenv";

dotenv.config(); // Stagehand NO auto-carga .env — hay que llamarlo una vez por script.

const DEFAULT_MODEL = "google/gemini-3.5-flash";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export function makeStagehand(opts = {}): Stagehand {
  const env = resolveStagehandEnv(opts.env);              // "LOCAL" | "BROWSERBASE"
  const headless = opts.headless ?? process.env.HEADLESS === "1"; // visible por defecto

  const apiKey = process.env.OPENROUTER_API_KEY;          // requerido salvo requireKey:false
  const modelId = process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
  const openrouter = createOpenRouter({ apiKey: apiKey ?? "missing-key" });
  // Enruta TODA llamada LLM de Stagehand (act/extract/observe/agent) por OpenRouter.
  const llmClient = new AISdkClient({ model: openrouter.chat(modelId) });

  // BROWSERBASE: usa BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID (cloud).
  // LOCAL (lo usado):
  const userDataDir = process.env.CHROME_USER_DATA_DIR?.trim(); // perfil persistente opcional
  return new Stagehand({
    env: "LOCAL",
    llmClient,
    localBrowserLaunchOptions: {
      headless,
      executablePath: process.env.CHROME_PATH ?? DEFAULT_CHROME,
      viewport: { width: 1280, height: 800 },
      ...(userDataDir ? { userDataDir } : {}),
    },
    verbose: 1,
  });
}
```

Notas clave:
- **`env` por precedencia**: argumento explícito → `STAGEHAND_ENV` → `"LOCAL"`.
- **Headless**: visible por defecto (`headless:false`) para ver el flujo; `HEADLESS=1` lo oculta.
- **Modelo LLM**: cambiar con `OPENROUTER_MODEL` (cualquier id de OpenRouter: `openai/gpt-4o`,
  `anthropic/claude-3.5-haiku`, etc.).
- **Perfil persistente**: `CHROME_USER_DATA_DIR` apunta a una carpeta dedicada que **persiste**
  entre corridas → la sesión del sitio se mantiene y se salta el login en corridas siguientes.
  **Para stephy, usar su PROPIO `chrome-user-data` dedicado** (carpeta distinta) para no chocar
  con otras sesiones.
- **API de página**: `stagehand.context.pages()[0]` o `stagehand.context.newPage()`.
  Métodos usados: `page.goto`, `page.locator(sel).fill/click/isVisible/count`, `page.keyPress("Enter")`,
  `page.waitForLoadState("networkidle")`, `page.evaluate(<string expr>)`, `page.url()`, `page.title()`.
  Acciones con LLM: `stagehand.act("<instrucción en lenguaje natural>")` (fallback cuando los
  selectores fallan). `stagehand.close()` al final.
- **Multi-tab**: el sitio puede abrir formularios en pestañas nuevas → buscar en **TODAS las pages**
  (`findPageWith`), no asumir `pages()[0]`. Patrón muy reutilizable.

---

## 3. Inicio de sesión / autenticación  (versión simple, SIN OTP)

stephy hace un **login estándar de usuario+contraseña, sin MFA/OTP**. El patrón heredado, reducido:

### Patrón recomendado
1. **Navegar a una página protegida** del sistema (p. ej. el dashboard tras login). Si hay sesión
   viva → carga; si no → el sitio redirige al formulario de login. Así se **detecta si hace falta
   loguear** (la URL contiene `/login`/`/signin` o el campo de usuario es visible).
2. Si la sesión persiste → **saltar todo el login** ("Already signed in").
3. Si hay que loguear:
   - **Usuario/email** → `locator.fill()` directo en el DOM → submit (Enter, fallback click).
   - **Password** → `locator.fill()` directo → submit.
4. **Las credenciales se escriben SIEMPRE directo en el DOM con `locator.fill()`** — NUNCA se
   envían al LLM. (El LLM solo como fallback para *encontrar* el botón de sign-in.)

### Patrón de selectores con fallback
Centralizar los selectores arriba del módulo de login como listas, probadas en orden:
```
USER_SELECTORS     = ['input[type="email"]', 'input[name="email"]', 'input[name="username"]', ...]
PASSWORD_SELECTORS = ['input[type="password"]', '#password', ...]
SUBMIT_SELECTORS   = ['button[type="submit"]', '#login-button', ...]
```
Cada paso usa `isVisibleOn()` para elegir el primer selector visible de su lista.

### Persistencia de sesión
- Vía **perfil persistente de Chrome** (`CHROME_USER_DATA_DIR`), NO vía `storageState`. La carpeta
  guarda cookies/localStorage → tras el primer login, las corridas siguientes lo saltan.

### Para stephy
- Cambiar URL del sistema y selectores del formulario al sistema real de stephy.
- El patrón "navegar a página protegida → detectar redirect a login → loguear solo si hace falta"
  es directamente reutilizable.

---

## 4. Conexiones (cómo se habla con la DB y servicios)

stagehand-amazon **NO usa el SDK de Supabase**: toda lectura/escritura de la DB pasa por **webhooks
de n8n**. stephy puede seguir ese patrón o ir directo a Supabase vía el MCP. Las dos vías:

### 4.1 Vía webhooks n8n (patrón heredado)
- Cada operación de DB es un `POST` a un webhook n8n con un payload JSON; n8n consulta/escribe en
  Supabase y devuelve un JSON. El código define interfaces TS tipadas del payload y la respuesta,
  hace `fetch` con manejo de errores HTTP, y persiste el resultado a un JSON en `data/`.
- **Lectura de ejemplo** (traer registros): `POST <webhook>` → devuelve `{ ... , items[], total }`.
- **Escritura de ejemplo** (actualizar registros): `POST <webhook>` con los cambios → devuelve
  `{ ok, actualizados, filas[] }`.
- **Instancia n8n compartida**: `https://n8n-n8n.40j1oe.easypanel.host` (hay **MCP de n8n**
  disponible, prefijo `mcp__ab9c309a-...`). stephy puede crear sus propios workflows ahí.

### 4.2 Vía MCP / SDK de Supabase directo (opción para stephy)
- **MCP de Supabase** disponible en el entorno (prefijo `mcp__838e5e5c-...`): permite
  `list_tables`, `execute_sql`, `apply_migration`, etc. sobre el proyecto.
- Para acceso desde el código: añadir `@supabase/supabase-js` y usar la URL + key del proyecto.
- **Proyecto**: `Mama SAN Amazon` · **project_id** `pdjxswivcgiwzrfexiiw` · región us-east-2 ·
  Postgres 17. (Existe otro proyecto `Bella y Lista` `ymbwcactwcekktejyihb` en la misma org — NO es este.)

### 4.3 Otros MCP disponibles en el entorno
- **Gmail** (`mcp__9c1b2b26-...`) — por si stephy necesita leer correos.
- **n8n** (`mcp__ab9c309a-...`) y **Supabase** (`mcp__838e5e5c-...`) — arriba.

---

## 5. ESTRUCTURA DE BASE DE DATOS (Supabase — compartida con stephy)

El esquema `public` tiene **49 tablas**. Abajo el detalle completo de las **7 tablas núcleo** que
tocan los flujos, más la lista de las auxiliares. (stephy usa estas mismas tablas; puede que añada
alguna adicional.)

### 5.1 `venta` — cabecera de cada orden de compra (33 cols)
PK `id_venta`. Una venta agrupa varios productos y puede ser de contado o en cuotas.

| Columna | Tipo | Uso |
|---|---|---|
| `id_venta` | integer (PK) | Identificador de la orden. Clave que enlaza todo. |
| `user_id` | integer (FK→usuarios) | Cliente dueño de la venta. |
| `monto_total_venta` / `monto_articulos` / `monto_shipping` / `monto_tax` | numeric | Montos. |
| `numero_articulos` | integer | Cantidad de ítems. |
| `numero_cuotas` | integer | Nº de cuotas (financiamiento). |
| `tipo_shipping` | text | aereo / maritimo. |
| `monto_pago_inicial` / `monto_financiado` | numeric | Inicial vs financiado. |
| `estado_venta` | text | 'en proceso' / 'completado' / etc. |
| `contado` | boolean (NOT NULL) | true = de contado; false = en cuotas. |
| `direccion_envio` | text | Dirección destino (texto). |
| `estatus_compra` | text | 'Por comprar' / 'Comprado' / etc. |
| `estatus_shipping_empresa` / `estatus_notificacion_cliente` | text | Estados logísticos/notif. |
| `fecha_creacion` / `fecha_modificacion` | date | Fechas. |
| `fecha_actualizacion_compra` / `_shipping` / `_notificacion` | timestamptz | Auditoría. |
| `saldo_aplicado` / `diferencia_*` / `monto_tarifa*` / `monto_descuento` / `porcentaje_descuento` | numeric | Ajustes y tarifas. |
| `estado_carrito` | text | Estado del carrito. |
| `notas` | text | Notas libres. |

### 5.2 `detalle_producto_venta` — línea de producto (la tabla más usada, 52 cols)
PK `id_articulo` (text). Cada fila es UN producto dentro de una venta. **Aquí viven los 3 trackings
por artículo.**

| Columna | Tipo | Uso |
|---|---|---|
| `id_articulo` | text (PK) | Id del artículo en la venta. |
| `id_venta` | integer (FK→venta) | Venta a la que pertenece. |
| `id_proveedor` | integer (FK→proveedor) | Proveedor. |
| `tipo_producto` | text | 'amazon' / 'shein' / 'temu' / 'walmart' / 'aliexpress'. **Filtra por origen.** |
| `cod_proveedor` | text | Código del proveedor (ASIN para Amazon, goods_id Temu, etc.). |
| `cod_articulo` | integer (NOT NULL) | Código interno del artículo. |
| `descripcion` / `imagen` / `product_url` | text | Datos del producto. |
| `precio_venta` / `cantidad` / `subtotal` | numeric/int | Precio y cantidad. |
| `costo_real` / `envio_real` / `tax_pagado` | numeric | Costos reales tras la compra. |
| `no_orden_prov` | text | **NOP** — número de orden del proveedor. Clave de match. |
| `tracking_proveedor` | text | Tracking del proveedor → courier USA. |
| `tracking_courier` | text | Tracking del courier (almacén Miami / StephyTracking receipts). |
| `tracking_vzla` | text | Tracking del tramo Venezuela. |
| `id_grupo` | uuid (FK→shipping_groups) | Grupo de envío al que pertenece el artículo. |
| `estatus_shipping` | varchar | Estado logístico por artículo (pipeline §5.8). |
| `estatus_notificacion` | varchar | Estado de notificación. |
| `estado_compra` / `estado_envio` / `estado_retencion` | text | Estados varios. |
| `empresa_logistica` | integer | Empresa logística. |
| `tipo_consignatario` | integer (FK→tipo_consignatario) | Tipo de consignatario. |
| `peso` / `peso_ai` / `product_dimensions(_ai)` (jsonb) / `costo_envio_*` | numeric/jsonb | Peso, dimensiones y costos de envío. |
| `talla` / `color` / `categoria_producto` | text | Atributos. |
| `es_envio_individual` | boolean | Marca de envío individual. |
| `fecha_actualizacion_shipping` / `_notificacion` | timestamptz | Auditoría. |

### 5.3 `shipping_groups` — grupo de envío (14 cols)
PK `id_grupo` (uuid). Agrupa artículos de una venta que viajan juntos. **Aquí viven los trackings
"master" por grupo.**

| Columna | Tipo | Uso |
|---|---|---|
| `id_grupo` | uuid (PK) | Id del grupo. Referenciado por `detalle_producto_venta.id_grupo`. |
| `id_venta` | integer (FK→venta) | Venta dueña del grupo. |
| `nombre_grupo` | varchar | Nombre del grupo. P. ej. `Envio Principal`, `Envio2`, `Envio3`. |
| `estatus_shipping` | varchar (NOT NULL) | Estado del grupo (mismo pipeline). |
| `estatus_notificacion` | varchar | Estado de notificación. |
| `tracking_master` | varchar | Tracking maestro del proveedor. |
| `tracking_master_courier` | varchar | Tracking maestro del courier (receipts Miami). |
| `tracking_master_vzla` | varchar | Tracking maestro Venezuela. |
| `carrier_id` | integer | Transportista. |
| `numero_vuelo` | text | Nº de vuelo. |
| `notas` | text | Notas. |
| `metadata` | jsonb | Metadatos. |
| `created_at` / `updated_at` | timestamptz | Auditoría. |

### 5.4 `usuarios` — clientes / consignatarios (30 cols)
PK `user_id`. El cliente final; aquí se guarda el **número de consignatario** de StephyTracking.

| Columna | Tipo | Uso |
|---|---|---|
| `user_id` | integer (PK) | Id del usuario. |
| `nombre` / `apellido` / `direccion_email` / `cedula` / `telefono` | text | Datos personales. |
| `direccion_envio` | text | Dirección de entrega. |
| `n_consignatario` | integer | **Nº de consignatario en StephyTracking** (NULL = falta crearlo). |
| `tipo_usuario` / `estatus_usuario` / `id_nivel` | text | Clasificación. |
| `monto_gastado` / `puntos` / `limite_credito` / `monto_restante_credito` / `saldo` | numeric | Crédito y puntos. |
| `numero_compras_realizadas` / `_contado` / `numero_cuotas_pagadas` / `compras_iniciadas` / `compras_efectivas` | integer | Métricas. |
| `auth_user_id` | uuid | Enlace a Supabase Auth. |
| `cedula_imagen_url` | text | Imagen de cédula. |
| `fecha_registro` / `fecha_ultima_compra` / `fecha_pago_ultima_cuota` | date | Fechas. |
| `terminos_aceptados` / `fecha_aceptacion_terminos` / `welcome_shown` / `contact_type` | bool/ts/text | Misc. |

### 5.5 `cuota` — cuotas de financiamiento (14 cols)
PK `id_cuota`. Las cuotas de una venta financiada.

| Columna | Tipo | Uso |
|---|---|---|
| `id_cuota` | integer (PK) | Id de la cuota. |
| `id_venta` | integer (FK→venta) | Venta a la que pertenece. |
| `numero_cuota` | integer | Orden de la cuota. |
| `monto` / `saldo_pendiente` / `monto_intereses_mora` / `monto_descuento` / `porcentaje_descuento` | numeric | Montos. |
| `razon_descuento` | text | Razón del descuento. |
| `fecha_limite_pago` / `fecha_efectiva_pago` | date | Fechas. |
| `estatus` | text | Estado de la cuota (validada/pendiente/etc.). |
| `created_at` / `updated_at` | timestamptz | Auditoría. |

### 5.6 `direcciones_envio` — direcciones del usuario (16 cols)
PK `id_direccion`, FK `user_id`. Direcciones estructuradas.
Campos: `nombre_direccion`, `direccion_completa`, `calle_avenida`, `numero_nombre_edificio`,
`numero_apartamento`, `ciudad`, `estado`, `codigo_postal`, `telefono_contacto`, `referencias`,
`es_predeterminada`, `activa`, `created_at`, `updated_at`.

### 5.7 `proveedor` — catálogo de proveedores (6 cols)
PK `id_proveedor`. Campos: `nombre`, `activo`, `logo_url`, `created_at`, `updated_at`.
Referenciado por `detalle_producto_venta.id_proveedor`.

### 5.8 Relaciones (resumen)
```
usuarios (user_id) 1──N venta (id_venta)
venta    (id_venta) 1──N detalle_producto_venta (id_articulo)
venta    (id_venta) 1──N shipping_groups (id_grupo)
venta    (id_venta) 1──N cuota (id_cuota)
usuarios (user_id) 1──N direcciones_envio (id_direccion)
proveedor(id_proveedor) 1──N detalle_producto_venta
shipping_groups (id_grupo) 1──N detalle_producto_venta (id_grupo)
```

Pipeline de `estatus_shipping` observado:
`Enviado Proveedor` → `Con recibo Almacen Miami` → `Con instruccion Almacen Miami` →
`Recibido almacen Miami` / `Recibido CCS` → `Por Entregar` → `Entregado` (+ `Extraviado USA`).

### 5.9 Las otras 42 tablas del esquema `public` (auxiliares — por si stephy las necesita)
`bancos`, `carritos_comp_shein`, `categorias_prohibidas`, `compra_minima`, `costo_envios`,
`costos_envio_ciudad`, `cron_job_failures`, `device_tokens`, `devoluciones`, `dimension_cache`,
`email_branding`, `email_logs`, `email_templates`, `email_verification_codes`, `empresa_shipping`,
`excepciones_productos_permitidos`, `factorincrementopuntos`, `historial_atrasos`,
`historial_compras`, `historial_notificaciones_cliente`, `historial_shipping`,
`historial_shipping_grupo`, `historial_shipping_producto`, `impuesto`, `nivel`, `notificaciones`,
`pago_cuota`, `pago_diferencia`, `pago_inicial`, `password_reset_codes`,
`pending_email_notifications`, `pending_push_notifications`, `productos_prohibidos_apelados`,
`profiles`, `r4_notifications`, `search_results`, `tarifas`, `tipo_cambio`, `tipo_consignatario`,
`tipos_pago`, `user_roles`, `verificacion_cuotas_logs`.

> Verificado en el esquema real: existen como **`usuarios`**, **`detalle_producto_venta`**,
> **`shipping_groups`**, **`venta`** (singular, no "ventas") y **`cuota`** (singular, no "cuotas").

---

## 6. Variables de entorno (genéricas, sin OTP)

| Variable | Para qué | Valor (por defecto) |
|---|---|---|
| `OPENROUTER_API_KEY` | Clave OpenRouter para el LLM de Stagehand. **SECRETO.** | (rotar/usar la propia) |
| `OPENROUTER_MODEL` | Id de modelo OpenRouter. | `google/gemini-3.5-flash` |
| `STAGEHAND_ENV` | `LOCAL` o `BROWSERBASE`. | `LOCAL` |
| `CHROME_PATH` | Ruta al binario de Chrome. | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `CHROME_USER_DATA_DIR` | Perfil persistente dedicado (mantiene sesión). | `...\stagehand-stephy\chrome-user-data` (usar uno propio) |
| `HEADLESS` | `1` para ocultar la ventana (default: visible). | (no set) |
| `BROWSERBASE_API_KEY` | Solo si `STAGEHAND_ENV=BROWSERBASE`. **SECRETO.** | (vacío) |
| `BROWSERBASE_PROJECT_ID` | Solo si Browserbase. | (vacío) |
| `LOGIN_URL` | URL del sistema a loguear. | (sistema de stephy) |
| `LOGIN_EMAIL` / `LOGIN_PASSWORD` | Credenciales del sistema. **PASSWORD = SECRETO.** | (las de stephy) |
| Webhooks n8n (`N8N_*_WEBHOOK_URL`) | Si stephy usa la vía webhook para DB. | crear los propios |
| `SUPABASE_URL` / `SUPABASE_KEY` | Si stephy habla con Supabase directo (SDK). | del proyecto `pdjxswivcgiwzrfexiiw` |

> `OPENROUTER_API_KEY` es obligatoria para el flujo con LLM. **Llamar `dotenv.config()` al inicio
> de cada script** (Stagehand no lo hace solo).

---

## 7. Patrones reutilizables para stephy

Lo que stephy debería **copiar/adaptar** en vez de reinventar:

1. **Factory de Stagehand** (`src/stagehand.ts`) — OpenRouter + Chrome local/Browserbase + perfil
   persistente. Reutilizable casi sin cambios; solo cambiar el `chrome-user-data` dedicado.
2. **Test de humo sin LLM** (`src/smoke.ts`) — lanza Chrome, navega, lee título. Valida la
   instalación de stephy antes de gastar tokens.
3. **Wrapper de webhook n8n para DB** — interfaces TS tipadas del payload, `fetch` con manejo de
   errores HTTP, persistencia a JSON. (O usar el MCP/SDK de Supabase directo, §4.2.)
4. **Helpers de navegación multi-tab**:
   - `findPageWith(selectors, timeoutMs)` — busca un selector en TODAS las pestañas.
   - `isVisibleOn(page, selectors)` — primer selector visible de una lista de fallbacks.
   - `submitStep(...)` — submit con Enter y fallback a click.
   - `page.evaluate(<string expr>)` para scraping de DOM (más fiable que closures serializados en
     Stagehand v3).
5. **Detección de sesión**: navegar a página protegida → si redirige a login, loguear; si no, saltar.
6. **Persistencia con archivado**: guardar salidas en `data/` y copiar un snapshot a
   `data/history/<timestamp>/` por corrida.
7. **Credenciales nunca al LLM**: `locator.fill()` directo en el DOM; el LLM solo para *encontrar*
   elementos cuando los selectores fallan.
8. **Manejo de errores best-effort**: los pasos de DB/webhook en try/catch que NO rompen el flujo
   principal; se registra el resultado en un JSON de reporte.

### Bootstrap sugerido para stephy
1. `pnpm init` con `"type":"module"`; copiar `tsconfig.json` (§1) y scripts (`smoke`, `typecheck`).
2. `pnpm add @browserbasehq/stagehand@^3 @openrouter/ai-sdk-provider@^1 dotenv@^17 zod@^3`
   y `pnpm add -D @types/node@^24 tsx@^4 typescript@^5`.
   (Si stephy accede a Supabase directo: `pnpm add @supabase/supabase-js`.)
3. Copiar `src/stagehand.ts` y `src/smoke.ts`. Verificar con `pnpm smoke`.
4. Crear su propio `chrome-user-data/` dedicado y un `.env` (cambiar `CHROME_USER_DATA_DIR`, URL y
   credenciales del sistema de stephy).
5. Implementar el login simple (§3, sin OTP) con los selectores/URL del sistema de stephy, y los
   wrappers de DB hacia las tablas documentadas en §5.

---

## 8. Notas de entorno

- **OS**: Windows 11. **Node**: v20+. **pnpm** 10.x.
- **Imports ESM**: usar extensión `.js` en los imports relativos aunque el archivo sea `.ts`.
- **dotenv**: Stagehand pide `dotenv@^16`; con `^17` en pnpm es solo warning; con npm usar
  `--legacy-peer-deps`. Llamar `dotenv.config()` al inicio de cada script.
- **Secretos**: nunca commitear `.env` (excluirlo en `.gitignore`). Rotar cualquier key que se
  herede de stagehand-amazon antes de reusarla.
- **MCPs disponibles**: Supabase (`mcp__838e5e5c-...`), n8n (`mcp__ab9c309a-...`),
  Gmail (`mcp__9c1b2b26-...`).
