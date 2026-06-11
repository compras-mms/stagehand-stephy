# PROGRESO — proyecto `stagehand-stephy` (handoff entre sesiones)

> Estado y contexto para continuar en otra sesión. Última actualización: 2026-06-11.
> Acompaña a [`CONTEXT-stagehand-amazon.md`](CONTEXT-stagehand-amazon.md) (base genérica
> heredada de stagehand-amazon: stack, factory de Stagehand, estructura de la BD Supabase).

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

- [ ] Definir qué proceso automatizar dentro del dashboard (¿receipts? ¿instrucciones?
      ¿tracking courier?). Relacionado con los skills MAMÁ SAN de StephyTracking.
- [ ] Navegar el menú (☰) y mapear las rutas/pantallas necesarias (p. ej. `/tecnoship/1/receipts`).
- [ ] Conectar a Supabase si el proceso necesita leer/escribir (elegir webhook n8n vs SDK directo).
- [ ] Considerar rotar `OPENROUTER_API_KEY` (viene del .env de amazon).
- [ ] (Opcional) Hacer determinista el cambio de rol y el click de la tarjeta para reducir
      dependencia del LLM (`act()`), si se busca más velocidad/robustez.
