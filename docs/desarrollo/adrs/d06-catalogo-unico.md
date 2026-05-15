# D6 · Catálogo único multi-ready

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase A (mayo 2025) · vigente.

## Contexto

Adoptado B2B nativo ([D2](d02-b2b-nativo.md)), Shopify ofrece dos posibilidades para modelar precios diferenciados:

1. **Un catalog por segmento de cliente** — un `CompanyLocationCatalog` distinto por sector (premium, distribuidor, instalador), país, o volumen. Cada catalog con su `PriceList` propio.
2. **Un catalog único** — un `CompanyLocationCatalog` con un `PriceList` común para toda la base de clientes. Diferenciación de precios vía descuentos aplicados en el Draft Order o vía price lists por Company individual si surge la necesidad.

El modelo de negocio actual no requiere segmentación de precios. Todos los compradores B2B aprobados ven el mismo precio outlet (descuento sobre PVP retail aplicado a nivel de price list global). Las negociaciones individuales (descuentos puntuales por volumen o cliente) se gestionan en el momento de la solicitud de pedido, no por estructura de catálogo.

## Decisión

Operar con **un catalog único** llamado "Outlet general":

- ID: vive en `private.config` como `catalog_id`.
- Divisa: EUR.
- Price list: `PERCENTAGE_DECREASE 0.0%` sobre el precio de shop (los precios B2B se aplican directamente como `price` en cada variante del producto, no como descuento porcentual).
- Productos publicados: 745, filtrados por la smart collection `coleccion-2026`.
- Todos los `CompanyLocation` (uno por Company aprobado) se vinculan a este catalog.

La asignación del catalog la hace la edge function `create-company-for-customer` ([D3](d03-flow-supabase.md)) durante la creación de la Company, leyendo el `catalog_id` de `private.config`.

## Alternativas consideradas

**Catalogs por sector** (premium / standard / distribuidor). Descartada por:
- El modelo de negocio actual no diferencia precios por sector.
- Añade complejidad operativa (mantener N price lists sincronizados con el catálogo) sin valor inmediato.
- Cambiar de N catalogs a 1 es más costoso que añadir uno cuando surja la necesidad real.

**Catalogs por país** (ES / FR / DE / IT / PT). Descartada por:
- Multicurrency se gestiona vía Shopify Markets ([D13](d13-multicurrency.md)), no vía catalogs.
- Los precios no varían por país en el modelo actual.

## Consecuencias

- **Multi-catalog-ready sin refactor**. El día que surja un segundo segmento, añadir un nuevo catalog implica:
  1. Crear el `CompanyLocationCatalog` + `PriceList` desde Admin o script.
  2. Persistir el nuevo `catalog_id` en `private.config` con una clave distinta (ej. `catalog_premium_id`).
  3. Añadir lógica de selección en `create-company-for-customer` (por ejemplo, leyendo un metafield del Customer que defina el segmento).
- **El criterio de "outlet" vive en la smart collection, no en el catalog**. Cambiar qué productos están en el outlet implica actualizar `coleccion-2026` (regla `product_tag EQUALS Coleccion:2026` durante cutover, sustituida por surtido + stock + precio a partir de I4 — ver [02-importer](../02-importer.md)).
- **Descuentos individuales se aplican en la solicitud de pedido**, no en el catalog. La edge function `submit-order-request` ([07-solicitudes-pedido](../07-solicitudes-pedido.md)) crea el Draft Order con los precios del catalog; cualquier negociación posterior se hace editando el Draft Order desde Shopify Admin.
- **Latencia de propagación de cambios en el price list**: Shopify tarda hasta 60 segundos en propagar cambios de price list a las CompanyLocation vinculadas. Documentado en [02-importer](../02-importer.md) como gotcha del flujo de actualización de precios.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
