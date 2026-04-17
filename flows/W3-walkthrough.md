# W3 — Walkthrough click-a-click

Workflow **W3 — Rechazo manual**. Se dispara cuando staff añade el tag
`rechazado` a un cliente. Complementa `W3-rechazo-manual.md`. Tiempo: **5-8 min**.

## Prerrequisitos

- [ ] Accesible `email-templates/05-cuenta-rechazada.liquid` para pegar
  el body inline. El body contiene un `{% if customer.metafields.b2b.motivo_rechazo != blank %}`
  que Flow resuelve siempre que la query del trigger incluya el metafield.

---

## Paso 0 — Crear el workflow

1. Admin → Apps → Flow → Create workflow
2. Rename a **`W3 — Rechazo manual`**

## Paso 1 — Trigger: Customer updated

1. Select a trigger → `Customer updated`
2. **Done**

## Paso 2 — Check if: acaba de pasar a rechazado

1. **+** → **Condition** → **Check if**
2. 2 sub-conditions con **AND**:

   | # | Campo | Operador | Valor |
   |---|---|---|---|
   | 1 | `customer.tags` | contains | `rechazado` |
   | 2 | `customer.tagsPrevious` | does not contain | `rechazado` |

3. **Done**

## Paso 3 — Remove customer tags: `pendiente`

Dentro de **Then**:

1. **+** → **Action** → **Remove customer tags**
2. Config:
   - **Customer**: `{{ trigger.customer.id }}`
   - **Tags**: `pendiente`

## Paso 4 — Send email: plantilla 05

1. **+** → **Action** → **Send internal email**
2. Config:
   - **To**: `{{ customer.email }}`
   - **Subject**: `Estado de tu solicitud B2B`
   - **Body**: cuerpo de `email-templates/05-cuenta-rechazada.liquid`
     (omitir `{% comment %}` y la línea `Subject:`). El `{% if %}` del
     motivo se evalúa en Flow al enviar.

Importante: la **query del trigger** del workflow debe incluir
`metafield(namespace: "b2b", key: "motivo_rechazo") { value }` para que
el condicional Liquid tenga el dato. Si no lo tiene, el if cae al else
(mensaje genérico), que es el comportamiento deseado.

## Paso 5 — Guardar y activar

1. **Save**
2. Toggle **Turn on**

## Paso 6 — Export

1. `···` → **Export** → `flows/W3-rechazo-manual.flow.json`
2. Commit.

## Verificación rápida

**Con motivo**:

1. Customer pendiente existente → edita metafield `b2b.motivo_rechazo`
   con texto `No ha sido posible verificar la actividad profesional`.
   Guarda.
2. Tags: quita `pendiente`, añade `rechazado`. Guarda.
3. Run history de W3 debe mostrar verde.
4. Customer recibe email 5 con la línea "Motivo: ..." incluida.

**Sin motivo (variante)**:

1. Otro customer, no rellenas `motivo_rechazo`.
2. Cambias tag a `rechazado`.
3. Customer recibe email 5 sin la línea "Motivo", con el texto genérico.
