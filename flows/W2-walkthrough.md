# W2 — Walkthrough click-a-click

Workflow **W2 — Aprobación manual**. Se dispara cuando staff añade el tag
`aprobado` a un cliente que estaba `pendiente`. Complementa
`W2-aprobacion-manual.md`. Tiempo estimado: **8-12 min**.

## Prerrequisitos

- [ ] W1 configurado (o al menos: customer puede tener tag `pendiente` válido)
- [ ] Plantilla **`B2B · 04 Cuenta aprobada (manual)`** cargada en Shopify Email
- [ ] Catálogo "Outlet general" creado (Fase A)

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**
2. Rename a **`W2 — Aprobación manual`**

## Paso 1 — Trigger: Customer updated

1. Click **Select a trigger** → `Customer updated`
2. Origen: Shopify
3. **Done**

## Paso 2 — Check if: acaba de pasar a aprobado

1. **+** → **Condition** → **Check if**
2. Añade 3 sub-conditions conectadas con **AND**:

   | # | Campo | Operador | Valor |
   |---|---|---|---|
   | 1 | `customer.tags` | contains | `aprobado` |
   | 2 | `customer.tagsPrevious` o `customer.previous_tags` | does not contain | `aprobado` |
   | 3 | `customer.tagsPrevious` | contains | `pendiente` |

> Si el builder no expone `tagsPrevious`: usa el bloque **Customer attribute changed** con campo `tags` y configura
> "now contains `aprobado`" + "previously contained `pendiente`".

3. **Done**. Solo la rama **Then** se ejecuta; la **Else** la dejas vacía.

## Paso 3 — Remove customer tags: `pendiente`

Dentro de **Then**:

1. **+** → **Action** → **Remove customer tags**
2. Config:
   - **Customer**: `{{ trigger.customer.id }}`
   - **Tags**: `pendiente`

Idempotente: si ya no está, no rompe nada.

## Paso 4 — Update customer metafield: `b2b.fecha_aprobacion`

1. **+** → **Action** → **Update customer metafield**
2. Config:
   - **Customer**: `{{ trigger.customer.id }}`
   - **Namespace**: `b2b`
   - **Key**: `fecha_aprobacion`
   - **Type**: `date`
   - **Value**: `{{ 'now' | date: '%Y-%m-%d' }}`

## Paso 5 — Run code: `create_company`

1. **+** → **Action** → **Run code**
2. Config:
   - **Name**: `create_company`
   - **Input query**:
     ```graphql
     {
       customer {
         id email firstName lastName
         companyContactProfiles { id }
         metafield_empresa: metafield(namespace: "b2b", key: "empresa") { value }
       }
     }
     ```
   - **Code**: contenido íntegro de `flows/_helpers/create-company.js`.

El helper ya comprueba `companyContactProfiles` → salta si el customer ya
tenía company. Idempotente.

## Paso 6 — Check if: NO llegó via whitelist (evita doble email cuando dispare W4)

1. **+** → **Condition** → **Check if**
2. Condition: `customer.tags` **does not contain** `aprobado_via_whitelist`
3. **Done**

### Rama Then — enviar email 4

1. **+** → **Send email** → template `B2B · 04 Cuenta aprobada (manual)` →
   to `{{ customer.email }}`

### Rama Else — (no enviar)

Dejar vacía. El email 6 lo enviará W4 tras el cleanup.

## Paso 7 — Guardar y activar

1. **Save**
2. Toggle **Turn on**

## Paso 8 — Export

1. `···` → **Export** → guardar como `flows/W2-aprobacion-manual.flow.json`
2. Commit.

## Verificación rápida

- Crea un customer manual con tag `pendiente`.
- En su detalle, **quita** `pendiente` y **añade** `aprobado`. Guarda.
- Run history de W2 debe tener un run verde en segundos.
- En el customer:
  - Sin tag `pendiente`
  - Con tag `aprobado`
  - `b2b.fecha_aprobacion` = hoy
  - Company creada (ver sección **Companies** del customer)
- Customer recibe email 4 en su inbox.
