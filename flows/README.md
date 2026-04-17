# Shopify Flow workflows — B2B LedsC4

Cada archivo `.md` en esta carpeta describe **un workflow** de Shopify Flow:
trigger, condiciones, variables, acciones y pseudocódigo. Se configura
manualmente en **Admin → Apps → Flow → Create workflow** porque la API
pública de Flow no permite crear workflows programáticamente (abril 2026).

## Orden de configuración

1. `W1-registro.md` — ejecuta al crear un customer. Parse nota/metafields,
   decide auto-aprobación vs pendiente, dispara emails 1, 2, 3 o 6.
2. `W2-aprobacion-manual.md` — ejecuta cuando staff añade el tag `aprobado`
   a un cliente `pendiente`.
3. `W3-rechazo-manual.md` — ejecuta cuando staff añade el tag `rechazado`.
4. `W4-whitelist-reeval.md` — scheduled (cada 30 min). Busca pendientes que
   ahora matcheen la whitelist y los aprueba automáticamente.

## Dependencias

- Todos los workflows asumen que **Fase A** está aplicada (metafields + tags
  canónicos + catalog).
- Los workflows W1, W2 y W4 crean Companies B2B. Requiere plan Grow con B2B
  nativo habilitado y el catálogo "Outlet general" existente (creado en Fase A).
- Los emails (1–6) se gestionan con **Shopify Email**, cada uno como plantilla
  guardada en Admin → Marketing → Shopify Email → Templates. Los textos de
  referencia están en `/email-templates/`.

## Convenciones compartidas

### Variables que leen todos los workflows

| Variable | Fuente |
|---|---|
| `{{customer.email}}` | directo del customer |
| `{{customer.first_name}}`, `{{customer.last_name}}` | directo |
| `{{customer.phone}}` | directo |
| `{{customer.metafields.b2b.empresa}}` etc. | customer metafields |
| `{{shop.metafields.b2b.whitelist_emails}}` | shop metafield (list de strings) |
| `{{shop.metafields.b2b.email_backoffice}}` | shop metafield (string) |

### Tags canónicos

Exactamente uno de: `pendiente`, `aprobado`, `rechazado`.

### Catálogo B2B

- Title: `Outlet general`
- Type: `CompanyLocationCatalog`
- Creado en Fase A (ver `docs/data-model.md`)

### Company creation

Cada cliente aprobado se convierte en **Company de 1 miembro**:
- Company name = `customer.metafields.b2b.empresa`
- Un único CompanyLocation, por defecto `Default` o el nombre de la empresa
- CompanyLocation asignada al catálogo "Outlet general"

Flow no tiene una acción nativa "Crear Company B2B" (comprobar en el builder
al configurarlo — si Shopify la añadió desde enero 2026, usarla). En su
defecto, usar la acción **Run code** con JavaScript y la Admin GraphQL API
interna. Snippet de referencia en `flows/_helpers/create-company.js`.

### Idempotencia

Cada workflow debe ser **idempotente** (re-ejecutar sin duplicar efectos):
- Antes de añadir un tag, comprobar que no esté ya.
- Antes de crear una Company, comprobar que el cliente no tenga ya
  `companyContactProfiles`.
- Antes de enviar email, comprobar que no se haya enviado ya (usar un
  metafield `b2b.email_enviado_<id>` o el log de Flow si tiene dedupe).

## Cómo exportar los workflows a este repo

Cuando termines de configurar en el admin, **exporta cada workflow como JSON**
(botón "..." → "Export") y guárdalo como `flows/Wx-<slug>.flow.json`. Esto
permite versionarlos y reconstruirlos en otro tenant.

El pseudocódigo en los `.md` es la **fuente de verdad conceptual**; el
`.flow.json` es la implementación actual.
