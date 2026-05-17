# D8 · Columna `Predeterminado` del CSV: importar sin exponer

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ⚠️ aceptada provisional (pendiente confirmación cliente)
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada provisional · Fase I3 (abril 2026) · vigente. Bloqueada por confirmación del cliente sobre la semántica de la columna.

## Contexto

El CSV de surtido entregado por SFTP del cliente incluye una columna `Predeterminado` cuyo significado no ha quedado claro durante la negociación de Fase I. Hipótesis manejadas:

- Producto recomendado por defecto cuando el cliente compra una familia.
- Producto preferente comercialmente (lo que el cliente "quiere vender más").
- Producto que aparece como opción inicial en configuradores externos del cliente.
- Flag heredado de un sistema legacy del proveedor sin uso comercial actual.

Sin certeza sobre la semántica, exponer el campo al storefront es arriesgado:

- Si la interpretación es errónea, el comprador B2B verá un atributo confuso o contradictorio con el resto del catálogo.
- Si el cliente decide en el futuro que no debe exponerse, retirarlo del storefront requiere migración de UI.

A la vez, **bloquear la importación** descarta dato útil: si mañana se aclara la semántica, sin el histórico habría que reimportar manualmente meses de surtido.

## Decisión

**Importar la columna pero no exponerla al storefront**. Mantener el campo invisible hasta que el cliente confirme semántica.

Implementación:

- Bloque `predeterminado` en `scripts/mapping.json` con `visible_in_storefront: false`.
- Definition en `scripts/metafield-definitions.json` con `access.storefront: NONE`.
- Nombre interno en Admin: `Predeterminado` (no expuesto a comprador).

El metafield se popula en cada import incremental como cualquier otro. Es accesible vía Admin y Admin GraphQL, pero invisible vía Storefront API y Liquid.

## Alternativas consideradas

**Bloquear la importación de la columna.** Descartada: perdería dato histórico. Cuando el cliente confirme semántica, habría que reimportar manualmente.

**Importar y exponer sin saber.** Descartada: arriesga mostrar un atributo confuso al comprador B2B y compromete la confianza en el resto del catálogo.

## Consecuencias

- **Decisión bloqueante para futuras iteraciones**. Cuando el cliente confirme semántica, las acciones serán:
  1. Cambiar `access.storefront` a `PUBLIC_READ` en `metafield-definitions.json`.
  2. Aplicar la definition con `node scripts/apply-metafield-definitions.mjs`.
  3. Opcionalmente, añadir contexto al mapper o al template de ficha de producto para mostrar el campo con su significado correcto.
- **Dato presente pero invisible**. Los compradores no ven el campo. El staff sí puede consultarlo desde Admin → producto → metafields, útil para responder consultas internas.
- **Mapping y definition viven en el repo**. Cualquier cambio futuro pasa por PR (no se decide en Admin directamente). Documentado en [02-importer](../02-importer.md) §mapper.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1. El estado de decisión se mantiene en ⚠️ provisional (refleja el estado real del ADR, no una cabecera desfasada).
- **v0.1** (15-may-2026): primera publicación.
