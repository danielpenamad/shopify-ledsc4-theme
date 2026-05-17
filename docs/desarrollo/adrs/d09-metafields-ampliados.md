# D9 · Modelo de metafields ampliado

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase I1 (marzo 2026) · vigente.

## Contexto

El modelo de metafields de Fase A definía 13 definitions repartidas entre `Customer` (perfil B2B), `Shop` (config global) y `Company` (datos comerciales B2B nativo). Suficiente para el flujo de aprobación y la creación de la Company, pero **insuficiente para representar las características técnicas del producto** que el CSV de surtido del cliente trae cada semana.

Necesidades surgidas en Fase I1:

- Atributos técnicos del producto (tipo de luz, temperatura de color, ángulo, IP, fuente de alimentación, regulación, etc.) — visibles al comprador en la ficha de producto.
- Familia y categoría del producto — para filtros del storefront y para la asignación a colecciones inteligentes.
- Material, acabado, garantía, accesorios — visibles al comprador.
- Etiqueta VF, tender text — uso interno.
- Identificadores cruzados (catálogo del cliente, referencia interna) — uso interno o expuesto según campo.

Sin estos atributos en metafields, el comprador B2B vería solo título, precio y stock. La ficha de producto quedaría comercialmente inutilizable.

## Decisión

Ampliar el modelo de metafields a **45 definitions totales**:

- **13 definitions de Fase A**, sin cambios. Reparto: `Customer` (perfil B2B), `Shop` (config global), `Company` (datos comerciales).
- **32 definitions nuevas en `ownerType=PRODUCT`**, namespace `product`. Atributos técnicos, comerciales e internos del producto.

Todas las definitions viven en `scripts/metafield-definitions.json` y se aplican con `scripts/apply-metafield-definitions.mjs`.

El script extendido implementa:

- **Dry-run** (`--dry-run`): muestra los cambios sin aplicarlos.
- **Clasificación de cada definition** en `Create` / `Unchanged` / `NeedsManualUpdate` / `DriftBlocked` / `UpdateBlockedByDependency`.
- **NO implementa `metafieldDefinitionUpdate`**: los diffs (cambios de tipo, validaciones, descripción) se reportan pero deben aplicarse manualmente desde Admin. Razón: la mutación es destructiva en ciertos casos (eliminar y recrear pierde valores históricos) y conviene revisar cada cambio.

11 definitions están marcadas `translatable: true` en `mapping.json` para que el importer las pase por Translate & Adapt: `tipo`, `familia`, `catalogo`, `garantia`, `etiqueta_vf`, `tender_text`, `material`, `acabado`, `fuente_luz`, `tipo_regulacion`, `accesorio`. Ver [09-i18n](../09-i18n.md).

## Alternativas consideradas

**Metafields ad-hoc sin definitions** (campos libres por producto). Descartada por:
- Sin definitions, los metafields no aparecen en filtros del storefront ni se exponen vía Storefront API con tipo correcto.
- El admin no puede validar valores, ordenar campos, ni gestionar internacionalización.

**Modelo extensible a metaobjects en lugar de metafields**. Descartada por:
- Los atributos del producto son escalares (string, number, list) — no requieren la estructura de un metaobject.
- Metaobjects añaden complejidad de relaciones y consultas sin valor en este caso.

**Importar atributos directamente como tags del producto.** Descartada por:
- Las tags no soportan tipos estructurados ni i18n.
- Mezcla criterios (la tag se usa también para colecciones inteligentes).

## Consecuencias

- **Detalle completo de las definitions en [01-data-model](../01-data-model.md)**. Este ADR documenta la decisión; el inventario campo a campo (nombre, tipo, validaciones, visibilidad) vive en el doc de modelo de datos.
- **Cambios de schema requieren PR** en `metafield-definitions.json`. Aplicar con `node scripts/apply-metafield-definitions.mjs`. Documentado en [15-scripts](../15-scripts.md).
- **Drift entre el repo y la tienda es posible**: si alguien añade una definition desde Admin sin tocar el JSON, el script la reporta como `DriftBlocked`. Resolver manualmente (borrar de Admin o añadir al JSON).
- **`metafieldDefinitionUpdate` no automatizado**: cualquier cambio de tipo o validaciones sobre una definition existente requiere intervención manual en Admin. Deuda conocida — pendiente evaluar si justificar el riesgo (algunos cambios sí son seguros, otros no).
- **Translations**: las 11 definitions traducibles dependen de T&A operativo en Fase I3.6. Documentado en [02-importer](../02-importer.md) §multi-idioma y [09-i18n](../09-i18n.md).
- **Image cache y fingerprint son decisiones separadas**: el doc viejo de `historia-decisiones.md` §D9 mezclaba este modelo con menciones a PR-IMG-2 (pre-upload de imágenes) y sku_state (fingerprinting de imports). Estas decisiones tienen sus propios ADRs: [D11](d11-image-pre-upload.md) y [D14](d14-sku-state-fingerprint.md).

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
