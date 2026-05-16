# Currency-B · Test scenarios

Tests manuales para validar el currency switcher + persistencia 30 días
+ note_attributes en draft order.

**Pre-requisitos**:

- PR-CURRENCY-A mergeado y `node scripts/activate-market-currencies.mjs`
  ejecutado: UK con GBP + manualRate, USA con USD + manualRate.
- Edge function `submit-order-request` redeployada tras este PR
  (el código añade lectura de `currencyCode` del payload).
- Tema staging conectado a `feature/currency-B-theme`.
- 1 customer aprobado disponible (e.g.
  `daniel.pena+test-d-aprobado@creacciones.es`).
- Productos con precio definido (catálogo Outlet general).

Ejecutar desde la URL preview del tema staging.

---

## CB1 — Switcher visible en todas las cabeceras

**Setup**: navegador en modo incógnito (sin cookies previas).

1. Abrir `/pages/acceso-profesional` (anónimo).
2. **Verificar**: en `b2b-header-simple`, antes del link "Iniciar sesión",
   aparece un botón `€ EUR ▾`.
3. Login como aprobado, ir a `/collections/...`.
4. **Verificar**: en `b2b-header`, al lado del selector de idioma,
   aparece `€ EUR ▾`.

**Nota**: la home `/` para anónimos NO renderiza header (decisión de
diseño previa — hero full-page); no es bug.

---

## CB2 — Cambio EUR → USD muestra $ con 2 decimales

1. Logueado o no, en `/collections/...` con al menos 1 producto visible
   y precio renderizado (e.g. `12,30 €`).
2. Click en `€ EUR ▾` → panel abre con EUR/USD/GBP.
3. Click "$ USD".
4. **Verificar**: redirect (la URL no cambia, pero hay reload).
5. **Verificar**: el toggle ahora muestra `$ USD`. Todos los precios
   del listado se muestran como `$13.42` (símbolo $, 2 decimales,
   separador decimal según locale del Market USA).
6. **Verificar** (DevTools → Application → Cookies):
   `ledsc4_currency = USD`, expira en ~30 días.

---

## CB3 — Cambio a GBP muestra £ con 2 decimales

1. Desde el estado anterior (USD), click toggle → "£ GBP".
2. **Verificar**: precio renderizado como `£10.45` (símbolo £, 2
   decimales).
3. **Verificar**: cookie `ledsc4_currency = GBP`.

---

## CB4 — Vuelta a EUR muestra € con 2 decimales

1. Click toggle → "€ EUR".
2. **Verificar**: precio renderizado como `12,30 €` (símbolo €, 2
   decimales, formato es-ES).
3. **Verificar**: cookie `ledsc4_currency = EUR`.

---

## CB5 — Solicitud en USD → draft order con note_attributes

**Setup**: customer aprobado, cart con ≥1 línea.

1. Cambiar a USD (CB2).
2. Ir a `/cart` → click "Enviar solicitud de pedido".
3. En `/pages/solicitud`, marcar el aviso → "Confirmar y enviar".
4. **Verificar**: redirect a `/pages/solicitud-enviada?ref=...`.
5. En admin Shopify → Orders → Drafts → abrir el draft creado.
6. **Verificar** en "Additional details" (note_attributes):
   - `Moneda mostrada: USD`
   - `Símbolo moneda: $`
   - (también las atributos previos: `fuente`, `cbm_total`,
     `fecha_solicitud`).
7. Repetir con divisa GBP → comprobar `Moneda mostrada: GBP` y
   `Símbolo moneda: £`.
8. Repetir con divisa EUR → comprobar `Moneda mostrada: EUR` y
   `Símbolo moneda: €`.

**Nota**: el rate numérico NO se guarda por decisión (Dani).

---

## CB6 — Persistencia 30 días tras cerrar navegador

1. En CB3 quedamos en GBP. Cerrar pestaña.
2. Cerrar el navegador completo (asegurando que NO sea modo incógnito).
3. Reabrir → ir a `/collections/...`.
4. **Verificar**: el toggle muestra `£ GBP` y los precios siguen en £.
   El JS lee la cookie y, si por algún motivo el Market activo es
   distinto, hace 1 redirect silencioso para alinearlo.
5. DevTools → cookie `ledsc4_currency` sigue con valor `GBP` y
   expiración a ~29 días.

---

## CB7 — Default EUR si no hay cookie

1. DevTools → borrar la cookie `ledsc4_currency`.
2. Recargar `/collections/...`.
3. **Verificar**: la cookie se vuelve a crear con valor `EUR`.
4. **Verificar**: si el Market activo NO era EUR, hay 1 redirect a EUR;
   si ya era EUR, no hay redirect.

---

## CB8 — Anti-bucle de redirect

**Setup** (simulación de fallo): editar la cookie a un valor cuyo
country_code no esté soportado por el Market correspondiente (raro
en estado normal, pero validamos el anti-bucle).

1. DevTools → setear cookie `ledsc4_currency = USD`.
2. Recargar.
3. **Verificar**: si Shopify aplica el Market USA, todo OK.
4. **Verificar**: si por algún motivo el Market USA no se aplica, la
   página no entra en loop. JS pone un flag de `sessionStorage`
   (`ledsc4_currency_redirected = USD`) y NO reintenta hasta que la
   sesión se cierre o el usuario haga click manual en otra divisa.

---

## Notas operativas

- El cookie de Market interna de Shopify (`cart_currency` / `localization`)
  es manejado automáticamente por la plataforma cuando se hace POST a
  `/localization`. Nuestra cookie `ledsc4_currency` es complementaria
  para recordar la elección del usuario más allá del TTL de Shopify.
- Auto-detect por IP: DESACTIVADO por decisión Dani. Si en el futuro
  se quiere activar geo-redirect, hay que cambiar el default `EUR` del
  snippet `snippets/currency-switcher.liquid` (función `desired`)
  por una detección de país server-side via Liquid.
- El email transaccional `B2B · 07 · Solicitud recibida` aún no
  consume los note_attributes — la modificación llega en
  PR-CURRENCY-C.

## Notas técnicas

- **Path Liquid para detectar la divisa al enviar la solicitud**: se
  usa `cart.currency.iso_code` en `sections/b2b-solicitud-form.liquid`
  (no `localization.country.currency.iso_code`) para reflejar la divisa
  real con la que Shopify renderiza el carrito en Markets multidivisa.
  En Markets con `localCurrencies=true` (UK/USA en LedsC4), `cart.currency`
  es la fuente de verdad de lo que el visitante ve y elige; cualquier
  divergencia con `localization.country.currency` se resuelve a favor
  del cart.
- **Path Liquid en el switcher** (`snippets/currency-switcher.liquid`):
  se mantiene `localization.country.currency.iso_code` porque ahí se
  necesita la divisa del país activo del Market (lo que el switcher
  debe mostrar como "activo" en su toggle), no la divisa del cart —
  el switcher se renderiza también en rutas donde el cart está vacío
  (home, listados, páginas de portal) y `cart.currency` ahí podría
  no estar inicializado.
- **Guard del switcher en cabecera simple**: en pantallas terminales
  de estado (`page.b2b-cuenta-en-revision`, `page.b2b-cuenta-rechazada`)
  el switcher se OCULTA vía `template.suffix` check en
  `sections/b2b-header-simple.liquid`. Razón: el usuario no puede ver
  catálogo desde ahí, así que el switcher carecería de función y
  añadiría ruido visual. En la landing anónima
  `/pages/acceso-profesional` SÍ se renderiza para permitir pre-elegir
  divisa antes del login.
