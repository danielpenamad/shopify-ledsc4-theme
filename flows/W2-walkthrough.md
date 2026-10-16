# W2 — Walkthrough click-a-click (alineado con el export `(4)` de oct-2026)

Workflow **W2 — Aprobación manual**. Dispara cuando se añade el tag
`aprobado` a un customer que ya no tiene `pendiente` (backoffice vía
`approve-customer`, cron `promote-whitelist-matches`, W1 en su rama de
instalador, o staff a mano). Sustituye a `W2-aprobacion-manual.md` como
referencia en el repo del "cómo está desplegado".

> **⚠️ Copia, no fuente de verdad.** Este documento refleja el export
> [`W2-aprobacion-manual.flow.json`](W2-aprobacion-manual.flow.json)
> (`W2 — Aprobación manual (4).flow`, oct-2026). El workflow vivo en Shopify
> puede haber cambiado después: **la verdad es siempre el workflow en el
> Admin**. Contrástalo antes de fiarte de lo que dice aquí (ver aviso en
> [README.md](README.md)). Si este documento y el export discrepan, manda el
> export.

## Piezas clave

- Trigger: **`Customer tags added`** (no existe `Customer updated` en Flow 2026).
  Se dispara con **cualquier** tag que se añada a **cualquier** customer
  (también lo usan W3 y W7), así que la condición de entrada es lo único que
  evita ejecuciones indeseadas.
- Condición de entrada: dos criterios AND, **uno sobre el estado actual del
  customer y otro sobre el evento del trigger**:
  1. `customer.tags` — **ningún** elemento es igual a `pendiente`
     (estado actual del customer).
  2. `tags` — **al menos un** elemento es igual a `aprobado`. Aquí `tags` es
     la lista de etiquetas **añadidas en este evento** del trigger
     (`Customer tags added`), **no** `customer.tags`.
- Sintaxis Flow Liquid para metafields de customer: **`{{ customer.<keyCamelCase>.value }}`** (snake_case → camelCase, con `.value`).
- Idioma de los emails: `customer.locale` **empieza por** `es` / `fr`; si no,
  inglés (ver más abajo).
- W2 **no** quita el tag `pendiente`, **no** escribe `b2b.fecha_aprobacion` y
  **no** envía email interno al backoffice. De eso se ocupan los productores
  del tag (`approve-customer` y `promote-whitelist-matches` hacen el flip de
  tags y escriben la fecha; W1 en su rama de instalador). W2 solo crea la
  Company y manda el email de bienvenida al cliente.

> **Por qué el criterio 2 mira las etiquetas del evento y no `customer.tags`.**
> Con la versión anterior (`customer.tags` contiene `aprobado`), cualquier
> tag añadido a un cliente **ya aprobado** (p. ej. `instalador`,
> `registro-completado`, un tag de segmentación puesto a mano) volvía a
> cumplir la condición — el cliente conserva `aprobado` y no tiene
> `pendiente` — y W2 se **reejecutaba**: otra llamada a
> `create-company-for-customer` y **reenvío del email de bienvenida**. Al
> exigir que `aprobado` esté entre las etiquetas *añadidas en el evento*,
> W2 solo corre en la transición real hacia aprobado.
>
> El criterio sobre `pendiente` se mantiene sobre `customer.tags` (estado
> actual) y sigue siendo necesario por la misma razón histórica: con
> `approve-customer` la edge reemplaza los tags de forma atómica
> (`customerUpdate(input: { tags })`), así que en el momento del trigger el
> customer ya es `[..., 'aprobado']` sin `pendiente`. Una condición del tipo
> "contiene `pendiente` AND contiene `aprobado`" (la original) nunca
> disparaba.

## Estructura final

Según los `links` del export:

```
Trigger  Customer tags added
 └→ Condition  (customer.tags: ningún elemento == 'pendiente')
               AND (tags del evento: algún elemento == 'aprobado')
    ├─ Verdadero
    │   └─ Send HTTP request → Supabase create-company-for-customer
    │       └─ Condition  customer.locale empieza por 'es'
    │           ├─ Verdadero → Send marketing email (ES)
    │           └─ Falso → Condition  customer.locale empieza por 'fr'
    │               ├─ Verdadero → Send marketing email (FR)
    │               └─ Falso → Send marketing email (EN, por defecto)
    └─ Falso (vacío)
```

## Paso 0 — Crear

1. Apps → Flow → Create workflow → **`W2 — Aprobación manual`**.

## Paso 1 — Trigger

`Customer tags added`.

## Paso 2 — Check if (dos criterios AND)

En el dropdown IF superior: **Todos** (AND).

Criterio 1 (estado actual del customer):
- Dropdown: `Ningún customer / tags` (negación: "no contiene")
- Tags_item · Igual a · `pendiente`

Criterio 2 (`Agregar criterio` inferior; **etiquetas del evento del trigger**):
- Dropdown: `Al menos uno de tags` — el `tags` a secas que aporta el trigger
  `Customer tags added` (las etiquetas añadidas), **no** `customer / tags`.
- Tags_item · Igual a · `aprobado`

> Al reconstruirlo desde cero, elegir `tags` (variable del trigger) y no
> `customer / tags` en el criterio 2 es **todo** el fix de la reejecución.

## Paso 3 — Rama Verdadero

### 3.1 Send HTTP request → Supabase create-company-for-customer

- **Method**: `POST`
- **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/create-company-for-customer`
- **Headers**:
  - `Content-Type`: `application/json`
  - `X-Webhook-Secret`: `{{secrets.CREATE_COMPANY_WEBHOOK_SECRET}}` (Flow secret)
- **Body**:
  ```
  {"customerId":"{{ customer.id }}"}
  ```
- Reintento: `retry` en error de cliente y de servidor.

Crea Company B2B + Contact (customer existente) + Location, o une el contacto
a una Company existente según el modelo vigente de la función (ver
`CLAUDE.md`). Idempotente.

### 3.2 Email de bienvenida por idioma (Send marketing email)

Tras el HTTP se ramifica por `customer.locale` con el operador **`Empieza por`**
(`start_with?`), no `Es igual a`:

| Orden | Condición | Resultado |
|---|---|---|
| 1 | `customer.locale` **empieza por** `es` | Marketing email ES |
| 2 (rama Falso de 1) | `customer.locale` **empieza por** `fr` | Marketing email FR |
| — (rama Falso de 2) | cualquier otro locale | Marketing email EN (por defecto) |

Cada rama usa la acción nativa de Marketing activity (`customer_id` =
`customer.id`). Templates: `W2-aprobacion-ES` / `-FR` / `-EN` (ver
[docs/desarrollo/08-emails-transaccionales.md](../docs/desarrollo/08-emails-transaccionales.md) §4).

> **Por qué "empieza por" y no "es igual a".** `customer.locale` puede traer
> sufijo regional (`es-ES`, `fr-FR`, `fr-CA`, `en-GB`). Con `Es igual a` un
> `es-ES` no casa con `es` y cae al fallback EN — el cliente español recibía
> el email de aprobación en inglés. `Empieza por` cubre todas las variantes
> regionales y es el mismo criterio que W1, W3, W5 y W7.

## Rama Falso

Vacía. No hace falta nada.

## Paso 4 — Guardar y activar

Save + Turn on.

## Caveats

- **Solo corre cuando `aprobado` es uno de los tags añadidos en el evento.**
  Añadir cualquier otro tag a un cliente ya aprobado ya no re-ejecuta W2.
  Consecuencia buscada: volver a añadir explícitamente `aprobado` a un
  cliente que ya lo tiene (quitarlo y ponerlo) sí vuelve a ejecutarlo
  — llama otra vez a `create-company-for-customer` (idempotente) y reenvía
  la bienvenida.
- **Flip atómico.** El path manual antiguo (staff editando tags en Admin) ya
  no es la fuente canónica: operar desde `/pages/admin-backoffice`. Si por
  excepción se hace a mano, quitar `pendiente` y añadir `aprobado` en un solo
  Save.
- **Email de marketing y opt-in.** `Send marketing email` solo entrega a
  clientes con opt-in; ver `docs/desarrollo/05-registro-b2b.md`.

## Export

`···` → **Export** → [`flows/W2-aprobacion-manual.flow.json`](W2-aprobacion-manual.flow.json)
(export `(4)` de oct-2026: condición de entrada sobre las etiquetas del
evento + ramas de idioma con `empieza por`).
