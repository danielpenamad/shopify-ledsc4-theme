# D13 · Multidivisa con auto-rates de Shopify Markets

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · PR-CURRENCY-B (mayo 2026) · vigente. Supersede a la implementación de PR-CURRENCY-A v1 (revertida en PR #78).

## Contexto

El catálogo se sirve en 6 idiomas ([D10](d10-3-csvs-sftp.md), [09-i18n](../09-i18n.md)), pero los precios se almacenan internamente en una sola divisa: **EUR**. Para compradores B2B que operan en otros mercados (FR, DE, IT, PT) hay una pregunta abierta: ¿cómo se les muestran los precios?

Tres modelos posibles:

1. **EUR-only**: todos los compradores ven el precio en EUR, sin presentación adaptada. Es la situación de partida.
2. **Presentación multidivisa, checkout EUR**: el storefront muestra precios estimados en la divisa local del comprador (USD, GBP, etc.) usando tipos de cambio aproximados; el checkout cierra en EUR. UX informativa, no transaccional.
3. **Multidivisa real con checkout en divisa local**: el comprador ve precios en su divisa, paga en su divisa, las solicitudes de pedido se cierran y reconcilian en esa divisa.

El modelo 3 requiere infra adicional sobre Shopify B2B:
- Tipos de cambio precisos y frescos (margen comercial, no banco central).
- Almacenamiento de precios B2B en múltiples divisas o cálculo en runtime.
- Reconciliación contable en backend del cliente con divisas distintas.

El modelo de negocio actual del cliente **no requiere checkout multidivisa**. Todos los pedidos se cierran en EUR — la solicitud de pedido es interna al cliente y la facturación es siempre en EUR. La presentación en divisa local es solo orientativa para el comprador internacional.

### Historia: PR-CURRENCY-A v1 (revertido)

La primera implementación (`PR-CURRENCY-A v1`) construyó infraestructura completa para multidivisa, incluyendo:

- Tabla `currency_rates` en Supabase.
- Edge function que consultaba OpenExchangeRates (OXR) diariamente con un API key.
- `pg_cron` job para refrescar tasas cada 24h.
- Extensión de `submit-order-request` para guardar la divisa y la tasa en `note_attributes` del Draft Order.

Al revisar la implementación contra el modelo de negocio real, se vio que toda esa infraestructura no cambiaba nada operativamente: los pedidos seguían cerrándose en EUR, las tasas guardadas no se usaban en ningún cálculo posterior, y OXR introducía una dependencia externa con coste recurrente. **Se revirtió en PR #78** sin pérdida funcional.

## Decisión

**Fase 1: presentación multidivisa con auto-rates de Shopify Markets.** Sin checkout multidivisa real.

Implementación:

- **`scripts/activate-market-currencies.mjs`**: activa las divisas correspondientes a los mercados que el cliente quiera cubrir (EUR, USD, GBP, etc.) en Shopify Markets. Shopify gestiona internamente los tipos de cambio aplicando sus propias tasas (basadas en proveedores estándar) — el cliente no mantiene la tabla.
- **`snippets/currency-switcher.liquid`**: incluido en `b2b-header.liquid`. Permite al comprador cambiar la divisa de presentación. Shopify resuelve el precio en runtime aplicando la tasa actual del Market.
- **`submit-order-request`**: guarda la divisa seleccionada por el comprador en `note_attributes` del Draft Order (`presentation_currency: USD`, etc.). Es solo informativa — el Draft Order se cierra en EUR igualmente.

No hay:
- Tabla de tipos de cambio propia.
- Edge function de refresco.
- Cron job de tasas.
- Cálculo en pricing logic propio.

Todo lo que afecta a la presentación de precios lo hace Shopify nativamente.

## Alternativas consideradas

**EUR-only (statu quo).** Descartada parcialmente: el cliente quería al menos presentación adaptada para reducir fricción en compradores internacionales que evalúan el catálogo. Es lo que motivó iniciar Fase Currency.

**Multidivisa real con checkout en divisa local.** Aparcada (no descartada). No se justifica con el volumen actual de pedidos no-EUR. Mismo argumento YAGNI que [D6](d06-catalogo-unico.md) — el modelo está listo para escalar cuando haya demanda real, pero no se construye proactivamente.

**Tipos de cambio propios con OpenExchangeRates** (PR-CURRENCY-A v1). Implementada y revertida. Por qué se revirtió:

- Las tasas guardadas no se usaban en ningún cálculo (los Draft Orders se cerraban en EUR independientemente).
- OXR es dependencia externa con coste recurrente.
- La tabla `currency_rates` y el cron añadían superficie de mantenimiento sin valor operacional.
- Shopify Markets ya provee tasas auto-actualizadas para presentación, suficientes para el caso de uso.

## Consecuencias

- **Precisión de tasas no garantizada para pedidos**. Las tasas de Shopify Markets son aproximadas y se actualizan según su propio criterio. Para pedidos comerciales reales sería insuficiente, pero como el checkout es siempre EUR el comprador no se ve afectado financieramente — solo es referencia visual.
- **`note_attributes.presentation_currency` queda como pista de uso**. El cliente puede revisar (manualmente en Admin o vía analítica) qué divisa eligió cada comprador para evaluar si justificaría escalar a multidivisa real.
- **No hay reconciliación contable** distinta de la actual. Todos los pedidos cierran en EUR, la facturación es EUR, no se introducen complicaciones contables.
- **Activar una nueva divisa es trivial**: editar `scripts/activate-market-currencies.mjs` con el nuevo Market + currency, ejecutar, y aparece en el `currency-switcher` automáticamente. Documentado en [10-multicurrency](../10-multicurrency.md).
- **Escalar a checkout multidivisa real** implicaría:
  1. Configurar pricing por Market en cada `PriceList` (Shopify nativo lo soporta).
  2. Eliminar el cierre automático en EUR de `submit-order-request`.
  3. Implementar reconciliación contable en el backend del cliente con divisas distintas.
  Documentado como futuro escalado en [10-multicurrency](../10-multicurrency.md).
- **PR-CURRENCY-A v1 revertido**: cualquier referencia a `currency_rates`, edge function OXR, o cron diario de tasas en docs anteriores debe leerse como histórica.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
