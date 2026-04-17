# W1 — Walkthrough click-a-click

Guía literal para configurar el workflow **W1 — Registro B2B** en Shopify
Flow. Complementa `W1-registro.md` (spec conceptual) con los clicks
exactos. Tiempo estimado: **20-30 min**.

> Requiere la app **Shopify Flow** instalada (Admin → Apps → Flow).
> Si no lo está: Admin → Apps → Add apps → buscar "Flow" → Install.

## Prerrequisitos (no arrancar sin esto)

- [ ] Plantillas **01, 02, 03** cargadas en Shopify Email (ver
  `email-templates/README.md`). Los nombres deben coincidir **exactamente**:
  - `B2B · 01 Bienvenida (auto)`
  - `B2B · 02 Solicitud recibida`
  - `B2B · 03 Backoffice: nuevo pendiente`
- [ ] Shop metafields `b2b.whitelist_emails` y `b2b.email_backoffice`
  poblados (ya hecho con `scripts/set-shop-b2b-metafields.mjs`).
- [ ] Fase A aplicada (catálogo "Outlet general" creado).

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow**
2. Top-right: **Create workflow**
3. Click en el título "Untitled workflow" (arriba a la izquierda) y rename a:
   **`W1 — Registro B2B`**

## Paso 1 — Trigger: Customer created

1. Click **Select a trigger**
2. En el buscador teclea `customer created`
3. Selecciona **Customer created** (origen: Shopify)
4. Click **Done** (no hay opciones de config)

## Paso 2 — Run code: `parse_and_normalize`

1. Click el **+** debajo del trigger → **Action** → busca `Run code`
2. Config:
   - **Name of this script**: `parse_and_normalize`
   - **Input query**: dejar la que Flow propone (customer con note, tags,
     metafields). Si te pide editar, añade explícitamente:
     ```graphql
     {
       customer {
         id email firstName lastName note tags
         metafield_empresa:  metafield(namespace: "b2b", key: "empresa") { value }
         metafield_nif:      metafield(namespace: "b2b", key: "nif") { value }
         metafield_sector:   metafield(namespace: "b2b", key: "sector") { value }
         metafield_pais:     metafield(namespace: "b2b", key: "pais") { value }
         metafield_volumen:  metafield(namespace: "b2b", key: "volumen_estimado") { value }
         metafield_fecha:    metafield(namespace: "b2b", key: "fecha_registro") { value }
       }
     }
     ```
   - **Code**: pega el bloque "Pre-procesado (Run code action 1)" de
     `flows/W1-registro.md` (líneas 26-48).
3. **Done**

## Paso 3 — Acciones de backfill de metafields

Por cada campo que el Run code marque como faltante (`backfill` output),
Flow crea un step con **Update customer metafield**. Hazlo en serie:

Por cada `key` de la lista `[empresa, nif, sector, pais, volumen_estimado, fecha_registro]`:

1. **+** → **Action** → **Update customer metafield**
2. Config:
   - **Customer**: `{{ trigger.customer.id }}`
   - **Namespace**: `b2b`
   - **Key**: `<key>` (uno por step)
   - **Type**: `single_line_text_field` (para todos **excepto** `fecha_registro` → `date`)
   - **Value**: `{{ parse_and_normalize.record.<key> }}`
3. Opcional — envolver en **Check if** `parse_and_normalize.backfill` contains `<key>`.
   Si no lo envuelves: `metafieldsSet` es idempotente y no romperá nada,
   solo reasignará el valor actual. OK dejar plano.

## Paso 4 — Add customer tags: `pendiente`

1. **+** → **Action** → **Add customer tags**
2. Config:
   - **Customer**: `{{ trigger.customer.id }}`
   - **Tags**: `pendiente`
3. **Done**

Este tag se quita después si se cumple la whitelist. Flow no duplica tags
→ safe.

## Paso 5 — (Opcional pero recomendado) Run code: `validate_nif`

1. **+** → **Action** → **Run code**
2. Config:
   - **Name**: `validate_nif`
   - **Input**: `parse_and_normalize.record`
   - **Code**: pega el bloque "Run code — validate_nif" de
     `flows/W1-registro.md` (líneas 108-137).
3. **Done**

Si decides no añadir validación server-side, saltar este paso y la rama
condicional que la usa.

## Paso 6 — Check if: NIF válido

1. **+** → **Condition** → **Check if**
2. Config:
   - **Condition**: `validate_nif.valid` **is equal to** `true`
3. **Done** → rama **Then** = resto del flujo. **Else** = branch error.

### Else (NIF inválido)

1. Dentro de **Else**: **+** → **Add customer tags** → tag `nif_invalido`
2. **+** → **Send email** (Shopify Email) → template
   `B2B · 03 Backoffice: nuevo pendiente` → to
   `{{ shop.metafields.b2b.email_backoffice }}`. **Subject override**:
   `ALERTA NIF inválido · {{ customer.email }}`
3. **End** de la rama else (no más steps).

## Paso 7 — Check if: email en whitelist

Dentro de la rama **Then** del paso 6:

1. **+** → **Condition** → **Check if**
2. Config:
   - **Condition**: `shop.metafields.b2b.whitelist_emails` **contains**
     `parse_and_normalize.emailLower`

> Si Flow no ofrece "contains" case-insensitive sobre list, inserta antes
> un **Run code** tipo `whitelist_contains` que devuelva `{ match: true/false }`
> haciendo el `includes` en JS. Úsalo como condition `whitelist_contains.match is true`.

### Rama A — Then: whitelist match → AUTO-APROBACIÓN

1. **Remove customer tags** → `pendiente`
2. **Add customer tags** → `aprobado`
3. **Update customer metafield**:
   - namespace: `b2b`, key: `fecha_aprobacion`, type: `date`,
     value: `{{ 'now' | date: '%Y-%m-%d' }}`
4. **Run code** — `create_company`:
   - **Input**: `trigger.customer` + `parse_and_normalize.record`
   - **Code**: pega el contenido de `flows/_helpers/create-company.js`.
     El export `module.exports = async function createCompanyForCustomer`
     — Flow lo ejecuta pasándole `{ input, shopify }`.
5. **Send email** → template `B2B · 01 Bienvenida (auto)` →
   to `{{ customer.email }}`.

### Rama B — Else: no match → PENDIENTE

1. (`pendiente` ya está puesto, no tocar tags)
2. **Send email** → template `B2B · 02 Solicitud recibida` →
   to `{{ customer.email }}`
3. **Send email** → template `B2B · 03 Backoffice: nuevo pendiente` →
   to `{{ shop.metafields.b2b.email_backoffice }}`

## Paso 8 — Guardar y activar

1. **Save** (top-right)
2. Toggle **Turn on**

## Paso 9 — Export a repo

1. Click `···` (esquina superior derecha del workflow) → **Export**
2. Guarda el fichero descargado como `flows/W1-registro.flow.json`
3. Commitear al repo.

## Verificación rápida

- Crea un customer vía Admin → Customers → Add customer con email
  **NO** en whitelist.
- En unos segundos: el customer debe tener tag `pendiente` y el email
  `daniel.pena+whitelist@creacciones.es` (no aplica aquí, es whitelist) —
  el destinatario del backoffice `daniel.pena+backoffice@creacciones.es`
  debe recibir email 3.
- Apps → Flow → **Run history** debe mostrar el run con verde.

Si algo falla, Run history enseña el step exacto y el error.
