# 10 · Multidivisa (Currency-B)

## 1. Para qué sirve este documento

El portal B2B Outlet presenta precios al comprador en su divisa preferida (EUR, USD, GBP) mientras cierra todos los pedidos internamente en EUR. Esta separación entre **divisa de presentación** y **divisa de checkout** es la decisión de diseño central de Currency-B (mayo 2026), documentada como ADR en [D13](adrs/d13-multicurrency.md).

Este doc explica la implementación operativa: qué hace Shopify Markets nativamente, qué hace el theme custom (`currency-switcher.liquid`), cómo persiste la elección del comprador entre sesiones, cómo se propaga al Draft Order en `submit-order-request`, qué scripts hay para activar divisas adicionales, y la historia de PR-CURRENCY-A v1 (revertido).

No se cubre aquí: el modelo conceptual y las alternativas evaluadas — eso vive en D13. Ni los detalles del Draft Order más allá de los `customAttributes` de divisa (ver 07-solicitudes-pedido). Ni configuración de Markets en Shopify Admin (ese paso es manual, documentado al final del §3).

Lectores principales: cualquier dev o IA que tenga que añadir una divisa, modificar el switcher, debugear por qué un comprador no ve el precio que espera, o escalar Currency-B a checkout multidivisa real cuando llegue el momento.

## 2. Modelo: presentación vs. checkout

Currency-B es **presentación multidivisa**, no checkout multidivisa. La separación se sostiene en tres puntos:

| Capa | Quién gestiona | Divisa |
| --- | --- | --- |
| Precio mostrado en storefront | Shopify Markets (auto-rates) | EUR / USD / GBP según selección del comprador |
| `submit-order-request` (Edge function) | Theme + edge | Persiste la divisa elegida en `customAttributes` del Draft Order |
| Draft Order que ve el backoffice | Shopify Draft Orders | **Siempre EUR**. El precio es base, no se recalcula. |
| Facturación al cliente | Cliente (Odoo) | EUR. |

Implicación operativa: si un comprador en UK ve "GBP 84.50" en una ficha, esa cifra la calcula Shopify Markets en tiempo real aplicando su tipo de cambio actual EUR→GBP sobre el precio base EUR del producto. Cuando ese comprador envía la solicitud, el Draft Order que llega al backoffice se cierra en EUR al precio base — no en GBP. La divisa GBP queda anotada en `customAttributes` solo como pista para que el equipo comercial sepa qué moneda vio el comprador al evaluar la oferta.

El comprador nunca paga en GBP en este modelo. El Draft Order se convierte en pedido firme tras revisión comercial y la facturación es EUR. Currency-B es UX informativa para reducir fricción cognitiva al comprador internacional ("este producto cuesta unos 84 libras") sin asumir las complicaciones de checkout multidivisa real (gestión de tipos de cambio comerciales, reconciliación contable con varias divisas, divergencia entre precio mostrado y precio facturado por desfase de tasa). Razonamiento completo en D13 §Decisión y §Alternativas.

## 3. Activación de divisas en Shopify Markets

Shopify Markets es nativo y aplica tasas auto-actualizadas (basadas en sus proveedores estándar) cuando un Market tiene `localCurrencies: true`. El theme custom no mantiene una tabla de tipos de cambio propia.

### Configuración actual

Tres Markets activos:

| Market handle | Base currency | localCurrencies | Estado |
| --- | --- | --- | --- |
| `es` (ES) | EUR | n/a (default) | Default activo. EUR es la moneda base del store. |
| `uk` (UK) | GBP | `true` | Activado vía script. |
| `usa` (USA) | USD | `true` | Activado vía script. |

El Market default (ES + EUR) no necesita activación — es la base del store. Los otros dos se activaron una sola vez con el script `scripts/activate-market-currencies.mjs`.

### El script

`scripts/activate-market-currencies.mjs` es un one-shot idempotente. Lo que hace:

1. Lista todos los Markets vía `markets(first: 50)` query.
2. Para cada target (`uk` → GBP, `usa` → USD), comprueba si el Market ya tiene `localCurrencies=true` y `baseCurrency=<código esperado>`.
3. Si ya está activo, hace skip.
4. Si no, llama `marketUpdate` con `currencySettings: { localCurrencies: true, baseCurrency: <código> }`.

Sin OXR, sin cron, sin tabla de tipos de cambio en Supabase, sin edge function — solo una llamada GraphQL idempotente.

Ejecución:

```bash
SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_xxx \
node scripts/activate-market-currencies.mjs
```

Scopes Admin API requeridos: `read_markets`, `write_markets`.

### Limitación API: `localCurrencies` no admite `baseCurrencyManualRate`

La combinación `localCurrencies: true` + `baseCurrencyManualRate: <numero>` la rechaza la API con:

```
Manual exchange rates cannot be used when local currencies are enabled.
```

Documentado en el header del script. La consecuencia es que Currency-B usa **siempre auto-rates** — no hay manera de fijar manualmente la tasa EUR→USD o EUR→GBP mientras `localCurrencies` esté activo. Para fijar manualmente habría que desactivar `localCurrencies` y entrar en un modelo de pricing por Market, que es exactamente lo que se evita (D13 §Alternativas).

### Pasos previos manuales (no automatizados)

Antes de ejecutar el script, los Markets `uk` y `usa` deben existir como Markets en Admin → Settings → Markets. El script no los crea — solo activa la divisa en Markets preexistentes. Si un handle no existe en el listado del Admin, el script lo salta con un warning sin error fatal:

```
[skip] Market with handle "uk" not found — verifica los handles en admin.
```

Crear un Market en Admin es manual: clic en "Add market", elegir país/región, asignar locale e idiomas habilitados. Una vez el Market existe, el script se encarga de la divisa.

## 4. Currency switcher: UI y mapping

`snippets/currency-switcher.liquid` es la UI que ve el comprador. Se renderiza dentro de los headers públicos (`b2b-header.liquid`, `b2b-header-simple.liquid`), junto al selector de idioma. Visible para todos los visitantes — no está detrás del gate B2B porque ayuda al comprador a evaluar el catálogo antes de registrarse.

### Tres opciones expuestas

| Opción visible | Código divisa | Símbolo | `country_code` enviado al form |
| --- | --- | --- | --- |
| €  EUR | EUR | € | ES |
| $  USD | USD | $ | US |
| £  GBP | GBP | £ | GB |

El comprador no ve "Market" en la UI — solo divisa. El mapping `currency → country_code` está fijado en el snippet (en JS y en cada `<button data-country=...>`). Cambiar el mapping requiere editar el snippet (no es configurable desde Theme Editor).

### Mecanismo nativo: `{% form 'localization' %}`

El switcher usa el componente Shopify estándar `{% form 'localization' %}`. Al submit:

1. Se envía POST a `/localization` con `country_code=<ES|US|GB>` y `return_to=<URL actual>`.
2. Shopify cambia el `@inContext` del Market activo según `country_code`.
3. Shopify redirige a `return_to` con el cookie de Market actualizado.
4. En la nueva carga, `localization.country.currency.iso_code` ya devuelve la divisa del Market activo y todos los precios se renderizan en esa divisa.

El theme no implementa lógica de cambio de Market propia — toda la conmutación la hace Shopify nativamente vía el endpoint `/localization`. El JS del switcher solo dispara el submit del form en el momento adecuado.

### `return_to`: preservar la URL actual

El `return_to` se calcula en Liquid antes de renderizar el form, preservando path + query string:

```liquid
{%- assign return_path = request.path
  if request.query_string != blank
    assign return_path = return_path | append: '?' | append: request.query_string
  endif
-%}
<input type="hidden" name="return_to" value="{{ return_path | escape }}">
```

Sin ese cálculo, el redirect tras `/localization` lanzaría al comprador a la home. Con él, el comprador se queda en la misma ficha de producto, página de listado de colección, página de cuenta, etc. — solo cambia la divisa de los precios mostrados.

## 5. Persistencia: cookie `ledsc4_currency` y redirect 1-vez

Shopify gestiona el cookie de Market internamente (`cart_currency`, `localization`), pero hay dos casos donde queremos persistencia más fuerte:

1. El cookie de Market expira o el navegador lo borra → Shopify vuelve a aplicar el Market default (ES + EUR) en la siguiente visita.
2. El comprador llegó al portal vía un link directo a una página interna sin pasar por la home, y Shopify aún no tiene cookie de Market.

Para cubrir ambos, el switcher persiste la elección del comprador en una cookie propia `ledsc4_currency` con TTL de 30 días. La cookie es solo memoria local — Shopify nunca la lee; el JS del switcher la usa al cargar para detectar si el Market activo coincide con la última elección del comprador y forzar un redirect si no.

### Flujo en cada carga de página

Pseudocódigo del JS en el snippet:

```
desired = getCookie('ledsc4_currency')
if (!desired) {
  desired = 'EUR'
  setCookie('ledsc4_currency', 'EUR')
}

active = ACTIVE_CURRENCY   // inyectado server-side desde Liquid

if (desired != active) {
  // El Market activo no coincide con lo que el comprador eligió.
  // Submit silencioso del form para corregir.
  if (!sessionStorage.flag_redirected) {
    sessionStorage.flag_redirected = desired
    form.country_code = COUNTRY_BY_CURRENCY[desired]
    form.submit()
    return
  }
  // Si ya intentamos esta divisa en esta sesión y aún no aplicó,
  // no reintentar (anti-bucle).
}
```

### Anti-bucle: el flag de sessionStorage

Si el comprador eligió USD pero Shopify rechaza el Market USA (por ejemplo, porque el Market no soporta el país de la IP del comprador, o porque hay alguna restricción de envío), el redirect llega de vuelta con la divisa aún en EUR. Sin protección, el JS volvería a forzar el redirect en bucle infinito.

El flag `sessionStorage.ledsc4_currency_redirected` guarda la última divisa intentada **en esta sesión del navegador**. Si tras el redirect la divisa activa sigue sin ser la deseada, el flag impide reintentar. La cookie `ledsc4_currency` queda apuntando a USD (la elección del comprador es respetada), pero el switcher renderiza en EUR (la realidad de Shopify) hasta que:

- El comprador hace clic explícito en una opción del switcher (limpia el flag).
- El comprador inicia una sesión nueva (sessionStorage se borra).
- El comprador cambia el cookie manualmente o lo borra.

### Click en una opción del switcher

Al pulsar EUR/USD/GBP en el dropdown, el JS:

1. Setea `ledsc4_currency` a la divisa pulsada.
2. Borra el flag `sessionStorage.ledsc4_currency_redirected` (la elección manual sobrescribe cualquier intento previo fallido).
3. Setea `country_code` en el form al `ES/US/GB` correspondiente.
4. Submit del form → `/localization` → redirect.

La elección manual es siempre prioritaria sobre el estado de la cookie o el sessionStorage anteriores.

### Sin auto-detect por IP

Decisión explícita (D13): no se intenta detectar la divisa por la IP del comprador. Por defecto, todo comprador nuevo aterriza en EUR. Si la cookie vence, vuelve a aterrizar en EUR. Solo cambia de divisa si pulsa explícitamente otra opción.

Razonamiento: el portal está orientado a profesionales que llegan con intención, no a tráfico orgánico de retail. Imponer una divisa por geolocalización molesta más de lo que ayuda en un contexto B2B donde el comprador suele tener preferencias claras (algunos clientes UK quieren ver EUR porque facturarán en EUR; auto-detectar GBP les fuerza a cambiar manualmente).

## 6. Propagación al Draft Order

Cuando el comprador envía una solicitud de pedido, el JS de `/pages/solicitud` lee la cookie `ledsc4_currency` y la pasa en el body de la llamada a la edge `submit-order-request`:

```json
{
  "customerId": "gid://shopify/Customer/123",
  "timestamp": 1712345678,
  "signature": "abc...",
  "note": "...",
  "items": [...],
  "currencyCode": "GBP"
}
```

La edge valida que `currencyCode` esté en el set permitido (`EUR`, `USD`, `GBP`) y cae a `EUR` si llega ausente, malformado o con un código no soportado:

```typescript
const ALLOWED_CURRENCIES = ["EUR", "USD", "GBP"] as const;
const rawCurrency = (body.currencyCode as string | undefined)?.toUpperCase();
const currencyCode = (ALLOWED_CURRENCIES as readonly string[]).includes(rawCurrency ?? "")
  ? (rawCurrency as string)
  : "EUR";
const currencySymbol = SYMBOL_BY_CURRENCY[currencyCode]; // "€" | "$" | "£"
```

Luego añade dos `customAttributes` al Draft Order:

```typescript
customAttributes: [
  { key: "fuente", value: "solicitud-b2b-frontend" },
  { key: "cbm_total", value: cbmTotal.toString() },
  { key: "fecha_solicitud", value: new Date().toISOString() },
  { key: "Moneda mostrada", value: currencyCode },
  { key: "Símbolo moneda", value: currencySymbol },
],
```

`customAttributes` se llaman `note_attributes` en la REST API y se muestran en el Admin del Draft Order bajo "Additional details" como pares clave/valor. Los labels en español (`"Moneda mostrada"` y `"Símbolo moneda"`) son lo que ve el equipo de backoffice — están en castellano deliberadamente para que sean legibles sin traducción mental.

### Por qué no se guarda el tipo de cambio numérico

D13 §Decisión lo explica: el equipo comercial no recalcula el precio en EUR desde el precio mostrado en GBP. El Draft Order ya viene en EUR (precio base del producto), y la divisa anotada es solo información de contexto. Persistir un `rate` numérico añadiría falsa precisión — la tasa que aplicó Shopify Markets en el momento del envío no es necesariamente la tasa que aplicaría en facturación si por algún motivo se intentara cobrar en GBP.

Si en algún momento se escala a checkout multidivisa real (Fase 2 hipotética), entonces sí habría que persistir tasa + timestamp para reconciliación. Hoy no se hace porque no se usa para nada.

### Confianza en `currencyCode` del client

El valor del `currencyCode` viene del client (JS storefront) y no está firmado. Un atacante podría enviar `currencyCode: "JPY"` en el body. La edge lo trata como informativo y lo valida contra el allowlist — si está fuera, cae a EUR sin error. No hay riesgo financiero porque el Draft Order se cierra siempre en EUR independientemente: el `currencyCode` no afecta al precio, solo al `customAttribute`.

Esto es deliberado y aceptable en el modelo Fase 1. En un modelo Fase 2 (checkout multidivisa real) habría que firmar la divisa con el HMAC junto al `customerId` y `timestamp` para evitar que un comprador manipule la divisa del checkout. Documentado como pendiente de Fase 2 en §9.

## 7. Historia: PR-CURRENCY-A v1 revertido

Antes de Currency-B (mayo 2026) hubo una primera implementación, **PR-CURRENCY-A v1**, que construyó infra completa para multidivisa con tasas propias. Lo que se construyó:

- **Tabla `currency_rates`** en Supabase con columnas `currency_code`, `rate`, `fetched_at`.
- **Edge function `refresh-currency-rates`** que consultaba OpenExchangeRates (OXR) diariamente con un API key y poblaba la tabla.
- **`pg_cron` job** que disparaba la edge cada 24h.
- **Extensión de `submit-order-request`** para leer la tabla `currency_rates` y guardar `currency_code` + `rate` + `rate_fetched_at` en `note_attributes` del Draft Order.

Al revisar la implementación contra el modelo de negocio real, se vio que toda esa infraestructura no cambiaba nada operativamente:

1. Los Draft Orders se cerraban en EUR igualmente (no había cálculo de precio que usara la tasa).
2. Las tasas guardadas no se leían en ningún punto downstream (el backoffice ignoraba `note_attributes.rate`).
3. OXR introducía dependencia externa con coste recurrente (~$15/mes para el plan que soporta más de 1000 calls/mes).
4. La tabla `currency_rates` y el cron añadían superficie de mantenimiento (monitoring de fallos del cron, recovery si OXR cae, refresh manual si la tasa se quedó stale).

Decisión: revertir todo y migrar a auto-rates nativas de Shopify Markets, que cubre el caso de uso (presentación de precios) sin tabla propia ni cron ni dependencia externa.

**Revertido en PR #78**. Lo que quedó:

- Tabla `currency_rates` borrada de Supabase.
- Edge function `refresh-currency-rates` borrada del repo.
- Job `pg_cron` eliminado vía migration.
- `submit-order-request` simplificado a solo `customAttributes` de divisa (sin rate numérico).

Cualquier referencia a `currency_rates`, `refresh-currency-rates`, OXR, o cron diario de tasas en docs históricas o commits previos a PR #78 se lee como histórica — no es parte del sistema actual. D13 §Historia documenta esto con más detalle.

## 8. Cómo añadir una divisa nueva

Pasos para activar una cuarta divisa (por ejemplo, AUD en un futuro Market Australia):

1. **Crear el Market en Shopify Admin**. Settings → Markets → Add market. Asignar país/región (e.g. Australia), locale, idiomas habilitados. Anotar el `handle` que Shopify asigna (normalmente `australia` o `au`).

2. **Añadir el target en `scripts/activate-market-currencies.mjs`**:

   ```javascript
   const TARGETS = [
     { handle: 'uk', currencyCode: 'GBP' },
     { handle: 'usa', currencyCode: 'USD' },
     { handle: 'australia', currencyCode: 'AUD' },  // ← nuevo
   ];
   ```

3. **Ejecutar el script**. Es idempotente — los Markets ya activos hacen skip. Solo aplica al nuevo.

4. **Añadir la opción al switcher**. Editar `snippets/currency-switcher.liquid` en cuatro sitios:

   - La lógica de `active_symbol` en el `{% liquid %}` inicial:

     ```liquid
     elsif active_currency == 'AUD'
       assign active_symbol = 'A$'
     ```

   - Una nueva `<li><button data-ledsc4-currency="AUD" data-country="AU">A$ AUD</button></li>` en el `<ul>` de opciones.

   - El mapping JS `COUNTRY_BY_CURRENCY`:

     ```javascript
     var COUNTRY_BY_CURRENCY = { EUR: 'ES', USD: 'US', GBP: 'GB', AUD: 'AU' };
     ```

5. **Añadir el código en la edge `submit-order-request`**:

   ```typescript
   const ALLOWED_CURRENCIES = ["EUR", "USD", "GBP", "AUD"] as const;
   const SYMBOL_BY_CURRENCY: Record<string, string> = {
     EUR: "€", USD: "$", GBP: "£", AUD: "A$"
   };
   ```

6. **Test E2E**. Comprador simulado en el storefront: abrir el switcher, seleccionar AUD, verificar que los precios cambian a AUD en una ficha de producto y en el carrito, enviar una solicitud, verificar que el Draft Order resultante muestra `Moneda mostrada: AUD` y `Símbolo moneda: A$` en Additional details.

Tiempo total: 30–60 minutos de implementación + test, sin downtime.

## 9. Cómo escalar a checkout multidivisa real (Fase 2)

Hipotético — no planificado, documentado por completitud. Cuando el volumen de pedidos no-EUR justifique el coste de infra, el camino sería:

1. **Pricing por Market en cada `PriceList`**. Shopify B2B soporta nativamente price lists con precios diferenciados por Market. Configurar precios explícitos en USD/GBP en cada Catalog B2B en lugar de depender de las auto-rates de presentación.

2. **Eliminar el cierre forzado en EUR de `submit-order-request`**. Hoy el Draft Order ignora la divisa del comprador y se cierra en EUR. En Fase 2 el Draft Order debería heredar la divisa del Market activo (Shopify lo hace si el Market tiene pricing propio).

3. **Firmar `currencyCode` en el HMAC del frontend**. Hoy el HMAC firma `customerId:timestamp`. En Fase 2 firmar `customerId:timestamp:currencyCode` para evitar manipulación de la divisa por parte del comprador.

4. **Persistir tasa + timestamp en `customAttributes`**. Hoy no se persiste (D13 §Decisión). En Fase 2 sí — para reconciliación contable.

5. **Reconciliación contable en backend del cliente (Odoo)**. Hoy el cliente factura en EUR. En Fase 2 tendría que gestionar facturación en múltiples divisas, conversión a EUR para contabilidad, gestión de diferencias por tipo de cambio entre fecha de pedido y fecha de cobro.

6. **Política de tipos de cambio comercial**. Las auto-rates de Shopify Markets son aproximadas — para pedidos reales el cliente probablemente quiera aplicar un margen propio (tasa banco + spread). Esto se hace con `manualRate` en `currencySettings`, pero requiere desactivar `localCurrencies` y entrar en pricing explícito por Market. Trade-off documentado.

Estimación de coste: 2–4 semanas de implementación + setup contable + test E2E + período de paralelo con Fase 1. No iniciar sin demanda real y sin alineación previa con el equipo de finanzas del cliente.

## 10. Pendientes

- **Migration `pg_cron` removida en PR #78** — verificar que la migration de cleanup quedó aplicada en la BD de producción y staging. Si no, ejecutar manualmente. Verificación: `SELECT * FROM cron.job WHERE jobname LIKE '%currency%'` debe devolver vacío.

- **Documentar `customAttributes` del Draft Order completos en 07-solicitudes-pedido §X** — `Moneda mostrada` y `Símbolo moneda` se mencionan aquí pero pertenecen al inventario completo de attributes que debería estar en 07 (junto con `fuente`, `cbm_total`, `fecha_solicitud`). Cross-link cuando 07 lo documente.

- **Test de regresión del anti-bucle del switcher** — el flag `sessionStorage.ledsc4_currency_redirected` cubre el caso de Market rechazado, pero no hay test automatizado. Posible mejora: añadir test Playwright/Cypress que fuerce un Market deshabilitado y verifique que el JS no entra en redirect loop.

- **Auto-detect por IP como opción opcional** — D13 lo descarta como default, pero podría exponerse como toggle en settings del theme para casos específicos (e.g. landing dedicada a UK con auto-GBP). No es prioridad.

- **`country_code` vs `currencyCode` desacoplados** — hoy el mapping `EUR→ES, USD→US, GBP→GB` está hardcoded. Si en algún momento un Market cubre múltiples países con la misma divisa (e.g. Market "Eurozone" con EUR pero `country_code` ambiguo), habría que parametrizar. Hoy no aplica.

- **Símbolo moneda en `submit-order-request`** — el símbolo (`€`, `$`, `£`) se calcula tanto en el switcher (JS) como en la edge (TypeScript) de forma duplicada. Posible refactor: pasarlo desde el frontend en el body junto con `currencyCode`. Marginal — la duplicación son 3 líneas.

- **Detección de divisa del Market no coincidente con cookie en logs** — si el flag anti-bucle dispara (porque Shopify no aplicó el Market deseado), no hay logging server-side. El comprador queda con experiencia inconsistente (cookie GBP, precios EUR) sin que el equipo se entere. Posible mejora: enviar un beacon analytics al detectar el mismatch tras el redirect.

- **D13 referencia `presentation_currency` como label semántico** — el código real usa `"Moneda mostrada"` y `"Símbolo moneda"` como keys de los `customAttributes`. Decidir si renombrar las keys del código (más estricto) o aclarar en D13 que `presentation_currency` es el rol conceptual, no el nombre literal del atributo. Recomendación: aclarar en D13, mantener las keys en español que ve el backoffice.
