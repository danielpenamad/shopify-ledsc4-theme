# Shopify Flow workflows — B2B LedsC4

Cada archivo `.md` en esta carpeta describe **un workflow** de Shopify Flow:
trigger, condiciones, variables, acciones y pseudocódigo. Se configura
manualmente en **Admin → Apps → Flow → Create workflow** porque la API
pública de Flow no permite crear workflows programáticamente (abril 2026).

## Orden de configuración

Los `.md` originales (`W1-registro.md` … `W4-whitelist-reeval.md`) describen el **diseño conceptual** de cada workflow. Los `*-walkthrough.md` (el que importa) describen la **config real** tal como quedó en Fase B tras descubrir las limitaciones de Flow. **Al configurar, seguir los walkthroughs, no los specs originales.**

1. [W1-walkthrough.md](W1-walkthrough.md) — ejecuta al crear un customer. Parse metafields, decide auto-aprobación vs pendiente, dispara Supabase para crear Company y emails al backoffice.
2. [W2-walkthrough.md](W2-walkthrough.md) — ejecuta cuando staff añade el tag `aprobado` a un cliente `pendiente`.
3. [W3-walkthrough.md](W3-walkthrough.md) — ejecuta cuando staff añade el tag `rechazado`.
4. [W4-walkthrough.md](W4-walkthrough.md) — **MOVIDO A SUPABASE**. Ver `supabase/`.
5. [W6-walkthrough.md](W6-walkthrough.md) — ejecuta al crear un draft order de solicitud B2B (`tags` incluye `solicitud-b2b`); si el customer es instalador, genera el PDF de la oferta (Supabase `generate-offer-pdf`), avisa a ventas y envía la oferta al instalador. No actúa sobre solicitudes de distribuidor.

## Dependencias

- Todos los workflows asumen que **Fase A** está aplicada (metafields + tags
  canónicos + catalog).
- Los workflows W1, W2 y W4 crean Companies B2B. Requiere plan Grow con B2B
  nativo habilitado y el catálogo "Outlet general" existente (creado en Fase A).
- Los emails (1–6) se envían con la acción nativa **`Send internal email`**
  de Flow (el store actual no tiene Shopify Email). Los `.liquid` de
  `/email-templates/` son la fuente del subject y body; se copy-paste
  inline en cada paso `Send internal email` del workflow correspondiente.
  Ver `email-templates/WALKTHROUGH.md`.

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

## Ficheros de esta carpeta — cuál es la fuente de verdad

Esta carpeta contiene tres tipos de fichero. **La fuente de verdad viva es el walkthrough.**

| Tipo | Fichero | Estado |
|---|---|---|
| Walkthrough | `Wx-walkthrough.md` | **Fuente de verdad.** Refleja la config real tal como está hoy en el admin de Flow. Es lo que hay que seguir para configurar o reconstruir un workflow. |
| Spec conceptual | `W1-registro.md` … `W4-whitelist-reeval.md` | Diseño conceptual original. Histórico — la implementación real divergió tras descubrir las limitaciones de Flow en Fase B. |
| Export JSON | `Wx-<slug>.flow.json` | **Snapshot de Fase B, desactualizado.** Captura de un momento del workflow en el admin; los workflows han evolucionado después (ver historial de PRs). NO reconstruir un workflow desde el `.flow.json` sin contrastar con el walkthrough. |

Solo W2 y W3 tienen `.flow.json` commiteado, y ambos son de Fase B. No reflejan los cambios posteriores (semántica de transiciones, limpieza de vestigios). Si se necesita un export al día, regenerarlo desde el admin y contrastarlo con el walkthrough antes de confiar en él.

## Cómo exportar un workflow (opcional)

Flow permite exportar un workflow como JSON desde el admin (botón "..." → "Export"). Es útil para inspeccionar o comparar, pero **el export no sustituye al walkthrough**: el JSON es una captura puntual y no documenta el porqué de cada paso. Si se exporta un workflow actualizado, guardarlo como `flows/Wx-<slug>.flow.json` y actualizar también el walkthrough correspondiente en el mismo commit, para que no vuelvan a divergir.
