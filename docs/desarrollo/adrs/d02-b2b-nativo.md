# D2 · B2B nativo de Shopify

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · abril 2025 (Fase A) · vigente.

## Contexto

El portal necesita modelar tres dimensiones acopladas:

1. **Identidad comercial del cliente B2B** — razón social, fiscalidad, contactos. No es el `Customer` (que es la cuenta de login); es la empresa que compra.
2. **Precios diferenciados** — al menos un catálogo con precios distintos del retail, y arquitectura preparada para N catálogos por sector / país / volumen sin refactor.
3. **Permisos de compra** — qué productos puede ver y comprar cada cliente.

El kickoff F0 (abril 2025) propuso un esquema "Basic-friendly" basado en apps de pago:

- **Wholesale Club** para los price lists, atados a tags del customer.
- **Customer Fields** para los campos extra del registro (empresa, NIF, sector, etc.).
- **Locksmith** para el gate de catálogo.

Al detallar el modelo en Fase A se vio que ese esquema obligaba a duplicar lógica:

- El precio B2B vivía en Wholesale Club (atado a tags).
- El permiso de ver el catálogo vivía en Locksmith (atado a tags).
- El detalle del cliente vivía en Customer Fields (custom metafield app).
- La identidad de la empresa no existía como entidad de primera clase — era un metafield del `Customer`.

Cualquier cambio (renombrar un sector, modificar la regla de descuento, añadir un segundo catálogo) implicaba tocar tres apps distintas con sincronización implícita por tags.

## Decisión

Adoptar **Shopify B2B nativo** como fuente única de verdad para identidad comercial, precios y permisos:

- `Company` — entidad de primera clase, contiene razón social, fiscalidad, contactos (`CompanyContact`) y localizaciones (`CompanyLocation`).
- `Catalog` (tipo `CompanyLocationCatalog`) con `PriceList` propio. Vinculable a 1..N `CompanyLocation`.
- `Publication` del catalog para controlar qué productos están disponibles a cada Company.

Modelo operativo actual:

- 1 catálogo activo: **"Outlet general"** (EUR, `PERCENTAGE_DECREASE 0.0%` sobre shop).
- Cada `Customer` aprobado tiene una `Company` de un miembro, con su `CompanyLocation` asignada al catálogo.
- 745 productos publicados al catalog publication (filtrados por smart collection `coleccion-2026`).

La creación de la Company se orquesta desde `supabase/functions/create-company-for-customer/index.ts` — invocada por Shopify Flow W1 (rama whitelist) y W2 (aprobación manual) vía `Send HTTP request`. La función es idempotente: si la Company ya existe para el customer, no la duplica.

## Alternativas consideradas

**Wholesale Club + Customer Fields + Locksmith** (propuesta F0). Descartada por:

- Duplicación de lógica en tres apps con sincronización implícita por tags.
- `Company` no existe como entidad — todo recae sobre el `Customer`.
- Dependencias de apps de terceros con riesgo de subida de precio o cierre de API.
- Bloquea el rol staff "Backoffice Aprobaciones" (D1) porque los permisos de B2B nativo y los de Customer Fields se gestionan en sitios distintos.

**Construir desde cero con metafields del `Customer`**. Descartada por:

- Reinventar lo que Shopify B2B nativo ya resuelve (Companies, contactos, localizaciones).
- Sin soporte nativo en el storefront para precios diferenciados — habría que reimplementar todo el pricing en Liquid.

## Consecuencias

- **Forzó la decisión de plan Grow** ([D1](d01-plan-grow.md)) — B2B nativo solo está disponible en Grow y Plus.
- **Eliminó dos dependencias de apps de terceros** (Wholesale Club y Customer Fields). Locksmith se mantiene únicamente para el gate del storefront ([D4](d04-gate-hibrido.md)).
- **Multi-catalog-ready sin refactor** ([D6](d06-catalogo-unico.md)) — el modelo soporta N catalogs por shop y N CompanyLocations por catalog. Añadir un segundo catalog implica solo (a) crear el catalog y (b) modificar `create-company-for-customer` con el criterio de asignación.
- **Mutaciones GraphQL no expuestas a Flow**. La creación de Company requiere `companyCreate` + `companyContactCreate` + `companyLocationUpdate` + `publicationPublish`, encadenadas. Flow no las expone como acción nativa — motiva la edge function ([D3](d03-flow-supabase.md)).
- **Modelo de datos**: ver [01-data-model](../01-data-model.md) para metafields del `Customer` (`b2b.empresa`, `b2b.nif`, etc.) y de la `Company`.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
