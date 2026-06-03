# D16 · Multidivisa cosmética sin tocar Markets

!!! info "Estado del documento"
    **Versión:** 1.0 · 03-jun-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · 31-may-2026 (PR [#142](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/142)) · vigente.

**Supersede a [D13](d13-multicurrency.md)** (multidivisa con auto-rates de Shopify Markets).

## Contexto

[D13](d13-multicurrency.md) eligió el modelo "presentación multidivisa nativa": activar `localCurrencies: true` en los Markets `uk` y `usa`, y dejar que el switcher cambiara el `country_code` con `{% form 'localization' %}` para que Shopify aplicara su propia conversión. Implementado en `scripts/activate-market-currencies.mjs` y `snippets/currency-switcher.liquid` v1.

El modelo funcionó en compradores anónimos. **Falló sistemáticamente en B2B logueado**, que es el caso de uso principal del portal.

### Por qué falla en B2B logueado

Shopify customer accounts (B2B en plan Plus) hace navegación cross-domain entre:

- `<shop>.myshopify.com/account` (storefront del theme)
- `shopify.com/<shopId>/account/...` (dominio gestionado por Shopify, fuera del theme)

La sesión del comprador se persiste con cookies que dependen del `country_code` activo en el momento del login. Al cambiar de `country_code` vía `/localization`:

1. El primer dominio recibe nueva cookie con el nuevo `country_code`.
2. Al volver a `shopify.com/<shopId>/account`, ese dominio aún tiene la cookie vieja.
3. Shopify detecta inconsistencia y desloguea al comprador silenciosamente.

[PR #140](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/140) intentó parchearlo enviando `currency_code` adicional al form. [PR #141](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/141) intentó hacer el `return_to` absoluto para sobrevivir el 307 cross-domain. Ninguno cerró el agujero: hubo casos reproducibles de logout tras cambio de divisa que requirieron al comprador volver a autenticarse y perder el carrito.

### Lo que el cliente realmente necesita

Tras revisar el caso de uso con el equipo comercial:

- El comprador B2B típicamente sabe que va a facturar en EUR (es lo que la factura llevará). No necesita "ver el precio real en GBP".
- Sí valora **una referencia mental aproximada** ("este producto cuesta unas 84 libras") para evaluar el catálogo internamente.
- No necesita cambiar de Market — la divisa de la factura no depende de su selección visual.
- Necesita que la sesión B2B (drafts, historial de pedidos, listas) sobreviva al cambio de divisa.

Cumplir esos cuatro requisitos sin desestabilizar la sesión es incompatible con tocar Markets/presentment.

## Decisión

**Conversión cosmética en cliente sin tocar Markets.**

| Pieza | Responsabilidad |
|---|---|
| EF [`update-fx-rates`](../../supabase/functions/update-fx-rates/index.ts) | Cron semanal lunes 06:00 UTC. Consulta Frankfurter (BCE), persiste tasas en metafield `ledsc4.fx_rates` (json, storefront PUBLIC_READ). |
| Switcher [`snippets/currency-switcher.liquid`](../../snippets/currency-switcher.liquid) | Click → setCookie + `CustomEvent`. **No** somete `{% form 'localization' %}`. **No** cambia de Market. |
| Asset [`assets/ledsc4-currency-display.js`](../../assets/ledsc4-currency-display.js) | Lee cookie + `window.LEDSC4_FX`. Reescribe `textContent` de nodos `[data-eur-amount]`. Reaplica tras `cartUpdate`. |
| Disclaimer | "Precios orientativos · se factura en EUR" en cualquier vista con precios cuando la cookie ≠ EUR. |
| Edge `submit-order-request` | Sin cambios estructurales — sigue validando `["EUR", "USD", "GBP"]` y guardando `customAttributes`. El draft cierra siempre en EUR. |

Anti-flash con tres failsafes (CSS condicional + timeout 1500ms + `<noscript>`) descritos en [10-multicurrency §5](../10-multicurrency.md).

**El Market activo siempre es ES y nunca se cambia.** Toda la conversión USD/GBP es client-side y solo afecta al `textContent` mostrado. El backend (carrito, draft, factura) ignora la cookie completamente.

## Alternativas consideradas

### Markets nativos con `localCurrencies` (D13)

El modelo que esta ADR supersede. Descartado por la incompatibilidad con sesiones B2B cross-domain documentada en §Contexto. Implementación revertida en PR #142.

### Cambiar Market solo para anónimos, mantener EUR para logueados

Híbrido posible: detectar si el comprador está logueado y permitir/bloquear el switch de Market según eso. Descartado por dos razones:

1. **Experiencia inconsistente entre estados**: un comprador no autenticado vería precios "reales" en GBP, se loguearía, y al loguear volvería a EUR. UX confusa.
2. **El B2B Outlet es overwhelmingly logueado**: la página pública es solo el `gate` ([04-storefront-gate](../04-storefront-gate.md)). No hay catálogo browseable sin login. Optimizar el caso anónimo no aporta valor real.

### OXR / tipos de cambio propios

Descartado ya en D13. La razón sigue vigente: dependencia externa con coste, sin valor operacional (los pedidos cierran en EUR). Frankfurter es público y sin API key, así que para Currency v2 sí se puede usar — pero solo como fuente para el metafield, no como tabla relacional en Supabase.

## Consecuencias

- **El B2B logueado no se desloguea al cambiar de divisa.** Objetivo principal cumplido.
- **EUR sigue siendo la única divisa transaccional.** Sin reconciliación contable adicional.
- **No hay overhead de mantener Markets activos**: `uk` y `usa` se pueden dejar inactivos (o existir como Markets sin `localCurrencies`) sin afectar nada.
- **El asset JS introduce dependencia de carga**: si el asset no carga (CDN caído, bloqueado por extensiones), los importes pueden quedar invisibles si la cookie ≠ EUR. Mitigado con el triple failsafe (CSS condicional + timeout + `<noscript>`).
- **Las tasas son menos frescas que las de Shopify Markets**: refresco semanal vs. diario/intradiario. Aceptable para un caso de uso "orientativo" donde la cifra es referencia, no precio definitivo. Documentado con el disclaimer.
- **`customAttributes` queda como dato informativo** (igual que en D13). El backoffice sigue viendo el draft en EUR; la divisa elegida queda anotada para análisis comercial.
- **Cambiar el modelo en el futuro** (e.g. checkout multidivisa real) implicaría volver a tocar Markets, con el mismo riesgo de sesión documentado aquí. Si Shopify resuelve la sesión cross-domain B2B en futuras versiones, re-evaluar.

## Scripts retirados

Como consecuencia de revertir el modelo Markets:

- `scripts/activate-market-currencies.mjs` (ya no necesario; los Markets pueden quedar como están).

Como consecuencia de no usar Markets:

- La activación inicial de `localCurrencies` en `uk` y `usa` se puede revertir (`marketUpdate` con `localCurrencies: false`) pero no es estrictamente necesario — el switcher ignora el Market activo y reescribe en cliente igualmente. Decisión: dejarlo como está hasta nuevo aviso.

## Referencias

- [PR #142](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/142) — implementación del modelo cosmético (31-may-2026).
- [PR #141](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/141) — intento de fix con `return_to` absoluto (no resolvió la raíz).
- [PR #140](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/140) — intento de fix con `currency_code` adicional (idem).
- [D13](d13-multicurrency.md) — ADR supersedida.
- [10-multicurrency](../10-multicurrency.md) — implementación operativa v2.

## Cambios

- **v1.0** (03-jun-2026): primera publicación. Decisión implementada y desplegada en `main` el 31-may-2026 (PR #142).
