# 10 · Multidivisa (Currency cosmético)

!!! info "Estado del documento"
    **Versión:** 2.0 · 03-jun-2026
    **Estado:** ✅ vigente
    **Audiencia:** Equipo de desarrollo

!!! warning "Cambio de modelo desde v1.x"
    Hasta el 31-may-2026 este doc describía **Currency-B**, un modelo basado en Shopify Markets nativos con `localCurrencies: true`. Ese enfoque **se revirtió** en [PR #142](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/142) porque rompía la sesión cross-domain del B2B logueado (incidentes [#140](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/140), [#141](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/141)). El modelo vigente es **cosmético**: cookie + asset JS que reescribe los importes ya pintados por Liquid, sin tocar Markets. ADR vigente: [D16](adrs/d16-multicurrency-cosmetic.md), que supersede a [D13](adrs/d13-multicurrency.md).

## 1. Para qué sirve este documento

El B2B logueado del portal LedsC4 Outlet está clavado al Market ES — **EUR es la única divisa real** (carrito, Draft Order, factura). USD y GBP son solo **conversión de presentación en cliente** que un asset JS aplica sobre los importes que Liquid ya pintó. El comprador puede alternar entre EUR/USD/GBP en la cabecera; los importes muestran "≈ X,XX $" en cualquier modo no-EUR, con la nota "Precios orientativos · se factura en EUR".

Este doc explica la implementación operativa: pipeline de tasas (BCE/Frankfurter), switcher, asset conversor, anti-flash, propagación al Draft Order como `customAttribute` informativo, y la advertencia explícita de **no tocar Markets/presentment** (rompe la sesión cross-domain del B2B). Decisión arquitectónica completa en [D16](adrs/d16-multicurrency-cosmetic.md).

No se cubre aquí el modelo conceptual y por qué se descartó Markets nativos — eso vive en D16. Ni los detalles del Draft Order más allá de los `customAttributes` (ver [07-solicitudes-pedido](07-solicitudes-pedido.md)).

## 2. Modelo: presentación vs. checkout

Sigue siendo presentación multidivisa con checkout EUR. Lo que ha cambiado es **quién hace la conversión**:

| Capa | v1 (revertida) | v2 actual |
|---|---|---|
| Quién muta el precio mostrado | Shopify Markets nativo (`@inContext`, `localCurrencies`) | Asset JS del theme reescribe `textContent` de los nodos `[data-eur-amount]` |
| Quién mantiene las tasas | Shopify (auto-rates internas, no expuestas) | Edge function `update-fx-rates` que las cachea en metafield del shop |
| Fuente de tasas | Shopify (privada) | Frankfurter (BCE, pública, sin API key) |
| Frecuencia de refresco | "Cuando Shopify quiera" | Cron pg_cron lunes 06:00 UTC |
| Divisa del carrito y Draft | EUR (forzado en `submit-order-request`) | EUR (sin cambios) |
| Sesión cross-domain B2B | **Rota** al cambiar Market | Intacta — no se toca el Market |

| Capa actual | Quién gestiona | Divisa |
|---|---|---|
| Precio renderizado por Liquid en el HTML inicial | Shopify (Market ES) | **EUR (siempre)** |
| Precio que ve el comprador en pantalla | Asset JS reescribiendo el textContent | EUR, USD o GBP según cookie |
| `submit-order-request` (edge function) | Theme + edge | Persiste la divisa elegida en `customAttributes`; el draft se cierra en EUR |
| Draft Order que ve el backoffice | Shopify | **Siempre EUR** |
| Facturación al cliente | Cliente (Odoo) | **EUR** |

## 3. Pipeline de tasas

### EF `update-fx-rates`

Source: [`supabase/functions/update-fx-rates/index.ts`](../../supabase/functions/update-fx-rates/index.ts).

Idempotente. En cada invocación:

1. Crea (si no existe) la metafield definition `ledsc4.fx_rates` con `type=json` y `access.storefront=PUBLIC_READ` para que el storefront API la pueda leer sin auth.
2. Llama a la API pública de [Frankfurter](https://frankfurter.dev/) (datos BCE, sin API key) para obtener tasas EUR→USD y EUR→GBP frescas.
3. Hace `metafieldsSet` sobre el shop con valor:

   ```json
   {
     "base": "EUR",
     "USD": 1.0823,
     "GBP": 0.8567,
     "rate_date": "2026-06-02",
     "updated_at": "2026-06-03T06:00:14.302Z",
     "source": "frankfurter"
   }
   ```

| Atributo | Valor |
|---|---|
| `verify_jwt` | `false` (la invocación viene de pg_cron con anon, pero la EF no requiere auth porque solo escribe metafield, sin secret expuesto) |
| Trigger | POST con body vacío |
| Dependencias externas | Frankfurter (https://api.frankfurter.dev). Sin API key. |

### Cron schedule

Migration: [`supabase/migrations/20260531120000_setup_cron_fx_rates.sql`](../../supabase/migrations/20260531120000_setup_cron_fx_rates.sql).

| jobname | Schedule (UTC) | Comando |
|---|---|---|
| `update-fx-rates-weekly` | `0 6 * * 1` (lunes 06:00) | `SELECT private.invoke_edge_function('update-fx-rates', '{}'::jsonb, false);` |

Args tipados explícitamente (`'...'::text, '{}'::jsonb, false`) para evitar la ambigüedad entre los dos overloads de `private.invoke_edge_function` que rompió otros crons (ver [PR #146](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/146)).

### Verificar que sigue vivo

```sql
-- Cuándo fue la última ejecución del cron
SELECT j.jobname, r.start_time, r.status
FROM cron.job_run_details r
JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname = 'update-fx-rates-weekly'
ORDER BY r.start_time DESC
LIMIT 5;
```

Y desde el storefront:

```bash
# El metafield es storefront-readable; basta una query GraphQL pública
curl -s "https://<shop>.myshopify.com/api/2025-10/graphql.json" \
  -H "X-Shopify-Storefront-Access-Token: <token>" \
  -d '{"query":"{ shop { metafield(namespace:\"ledsc4\", key:\"fx_rates\") { value updatedAt } } }"}'
```

Si `updatedAt` no cambió en la última semana, el cron está roto.

## 4. Theme — switcher cosmético

### `snippets/currency-switcher.liquid`

Click → **setCookie + dispara CustomEvent**. Sin `{% form 'localization' %}`, sin redirect, sin sessionStorage anti-bucle (no hace falta — no hay bucle posible cuando no se cambia de Market).

```js
function setCurrency(code) {
  document.cookie = `ledsc4_currency=${code}; path=/; max-age=2592000; SameSite=Lax`;
  document.dispatchEvent(new CustomEvent('ledsc4:currency-changed', { detail: { code } }));
}
```

El switcher muestra el label inicial leyendo la cookie directamente — no consulta el Market activo (no le importa).

### `assets/ledsc4-currency-display.js`

Source: [`assets/ledsc4-currency-display.js`](../../assets/ledsc4-currency-display.js).

Al cargar y en cada `cartUpdate`:

1. Lee la cookie `ledsc4_currency`.
2. Lee `window.LEDSC4_FX` (inyectado por `layout/theme.liquid` desde el metafield).
3. Itera por todos los nodos con `[data-eur-amount]` (céntimos EUR crudos como entero, e.g. `9907` = 99,07 €).
4. Aplica la tasa, redondea a 2 decimales, formatea con `toLocaleString('es-ES')`, y reescribe `textContent`.
5. Si el nodo tiene `[data-fx-approx="1"]`, prefija `≈ ` para señalizar aproximación. Esto solo se aplica al primer precio de cada bloque (no se duplica el símbolo dentro de un "desde X,XX").
6. Añade la clase `ledsc4-fx-ready` al `<html>` para revelar los precios (ver §5 anti-flash).

Se suscribe a `PUB_SUB_EVENTS.cartUpdate` (event bus nativo del theme Dawn) para reaplicar tras AJAX del cart drawer y del cart page.

### Nodos con `data-eur-amount`

Snippets/sections instrumentados:

| Path | Qué precio carga |
|---|---|
| [`snippets/price.liquid`](../../snippets/price.liquid) | Listado, ficha, "desde X", precio comparativo |
| [`snippets/cart-drawer.liquid`](../../snippets/cart-drawer.liquid) | Drawer: line_price + drawer total |
| [`sections/main-cart-items.liquid`](../../sections/main-cart-items.liquid) | Cart page: line_price por item |
| [`sections/main-cart-footer.liquid`](../../sections/main-cart-footer.liquid) | Cart page: subtotal + total |

Cada uno emite tanto el valor en céntimos (`data-eur-amount="{{ price | times: 0 }}"`) como el HTML EUR formateado por Liquid como contenido inicial. El asset solo reescribe `textContent` si la cookie ≠ EUR.

## 5. Anti-flash

Sin tratamiento, un comprador con cookie USD vería 1 frame de precios EUR antes de que el asset reescriba. Solución triple:

1. **CSS condicional**: `layout/theme.liquid` inyecta un script inline ANTES del asset:
   ```html
   <script>
     if (document.cookie.match(/(^|;\s*)ledsc4_currency=EUR/) || !document.cookie.match(/ledsc4_currency=/)) {
       document.documentElement.classList.add('ledsc4-fx-ready');
     }
   </script>
   <style>
     :root:not(.ledsc4-fx-ready) [data-eur-amount] { visibility: hidden; }
   </style>
   ```
   EUR (default) nunca se oculta. Solo USD/GBP arranca invisible hasta que el asset añada la clase.

2. **Timeout de seguridad**: el asset añade `.ledsc4-fx-ready` también tras 1500ms pase lo que pase, para que un fallo de carga no deje el carrito en blanco indefinido.

3. **`<noscript>` de rescate**: si JS no carga, se revela CSS-only.

4. **`window.onerror` handler** que revela en caso de throw inesperado del asset.

EUR nunca se oculta — el script inline previo añade la clase de inmediato cuando la cookie es EUR (o no existe). El comprador EUR no ve diferencia con la situación pre-Currency.

## 6. Form de solicitud

[`sections/b2b-solicitud-form.liquid`](../../sections/b2b-solicitud-form.liquid) lee la cookie en el momento del submit y la incluye en el body que manda a `submit-order-request`:

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

La edge `submit-order-request` no se ha tocado para Currency v2 — sigue validando contra `["EUR", "USD", "GBP"]` con default EUR y guardando dos `customAttributes` en el Draft Order:

| customAttribute | Valor |
|---|---|
| `Moneda mostrada` | `EUR` ∥ `USD` ∥ `GBP` |
| `Símbolo moneda` | `€` ∥ `$` ∥ `£` |

**El draft se cierra siempre en EUR**, independientemente del `currencyCode`. La divisa es solo informativa para el equipo comercial (ver el `customAttribute` en Admin → Draft Order → Additional details).

## 7. Disclaimer i18n

En cualquier vista que muestre precios convertidos (ficha producto, carrito, form solicitud) aparece la frase **"Precios orientativos · se factura en EUR"** cuando la cookie ≠ EUR. Vive en `locales/*.json` bajo la clave `ledsc4.common.currency.fx_disclaimer`:

| Locale | Texto |
|---|---|
| es | Precios orientativos · se factura en EUR |
| en | Reference prices · billed in EUR |
| fr | Prix indicatifs · facturé en EUR |
| de | Richtpreise · Abrechnung in EUR |
| it | Prezzi orientativi · fatturato in EUR |
| pt-PT | Preços indicativos · faturado em EUR |

## 8. Cómo añadir una divisa nueva

Por ejemplo AUD:

1. **Actualizar `update-fx-rates`**: añadir `AUD` a la query Frankfurter (`?from=EUR&to=USD,GBP,AUD`). Re-deploy.
2. **Forzar refresco manual** del metafield: `SELECT private.invoke_edge_function('update-fx-rates', '{}'::jsonb, false);`
3. **Actualizar el switcher** [`snippets/currency-switcher.liquid`](../../snippets/currency-switcher.liquid): añadir el botón AUD con su símbolo `A$`.
4. **Actualizar el asset** [`assets/ledsc4-currency-display.js`](../../assets/ledsc4-currency-display.js): añadir `AUD` al mapping `SYMBOL_BY_CURRENCY = { EUR: '€', USD: '$', GBP: '£', AUD: 'A$' }`.
5. **Actualizar `submit-order-request`** [`supabase/functions/submit-order-request/index.ts`](../../supabase/functions/submit-order-request/index.ts): añadir `AUD` a `ALLOWED_CURRENCIES` y a `SYMBOL_BY_CURRENCY`.
6. **Test E2E**: cambiar la cookie a AUD, recargar, verificar que los precios cambian y que el draft generado tiene `Moneda mostrada: AUD`.

Tiempo total: ~30 min sin downtime. No requiere tocar Markets.

## 9. Lo que NO está en alcance (deliberadamente)

- **Quantity price breaks** (cart-drawer iteración por línea, quick-order-list): los precios viven dentro de strings i18n con `{{ 'sections.quick_order_list.each' | t: money: price }}`. Esos quedan en EUR — los cubre la nota global del disclaimer. Reconstruir los strings desde JS es desproporcionado para el uso real (cliente B2B viendo precio escalonado generalmente entiende EUR base).
- **`b2b-solicitud-detalle`**: los importes ya vienen formateados desde la edge function `list-order-requests`, fuera de scope del asset frontend. La nota global del disclaimer es suficiente.
- **Checkout multidivisa real**: aparcado. La razón sigue siendo la misma que en [D13](adrs/d13-multicurrency.md) §Alternativas: no se justifica con el volumen actual de pedidos no-EUR.

## 10. Por qué NO Markets

⚠️ **Aviso al lector**: si en algún punto de la operativa surge la tentación de "simplificar" volviendo al modelo Markets nativo, leer primero [D16](adrs/d16-multicurrency-cosmetic.md). Resumen breve:

- Cambiar Market con `{% form 'localization' %}` provoca cambio de `country_code` en la sesión.
- En el dominio del B2B logueado (`<shop>.myshopify.com/account` redirige a `shopify.com/<shopId>/account/...` y vuelve), ese cambio de `country_code` rompe la cookie de sesión cross-domain.
- El comprador termina deslogueado al cambiar de divisa. Pasó dos veces (PRs #140 y #141 fueron parches que no aguantaron; PR #142 revertió el modelo entero).
- Ningún mecanismo de "preservar sesión" sobrevivió a las pruebas con Shopify customer accounts. Por eso se eligió no tocar Markets en absoluto.

Si Shopify resuelve la sesión cross-domain B2B en futuras versiones de customer accounts, la decisión podría re-evaluarse. Hoy no.

## 11. Pendientes y deuda

- **Verificación automática del cron**: detección de `updated_at` del metafield `ledsc4.fx_rates` con más de 8 días → alerta. Hoy detección manual.
- **Fallback si Frankfurter cae**: la EF actual hard-fails si Frankfurter no responde. En tal caso, el metafield no se refresca y el asset usa la última tasa válida (degradación grácil). Pero no hay alerta. Mejora: añadir try/catch + fallback a un proveedor secundario (e.g. exchangerate.host) si Frankfurter falla 3 veces seguidas.
- **`note_attribute` no firmado**: el `currencyCode` del body de `submit-order-request` no está incluido en el HMAC. Un comprador podría manipularlo. No hay riesgo financiero porque el draft cierra en EUR igualmente, pero ensucia el campo informativo. Documentado en [D13](adrs/d13-multicurrency.md) §9 como Fase 2.

## Cambios

- **v2.0** (03-jun-2026): reescritura completa tras la reversión del modelo Markets en [PR #142](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/142). Vigente el modelo cosmético (cookie + asset JS + metafield BCE).
- **v1.0** (17-may-2026): primera publicación describiendo el modelo Markets nativo con `localCurrencies`. **Obsoleto desde el 31-may-2026** — ver D13/D16.
