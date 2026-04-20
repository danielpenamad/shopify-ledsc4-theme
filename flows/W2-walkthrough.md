# W2 — Walkthrough click-a-click (estado final Fase B)

Workflow **W2 — Aprobación manual**. Dispara cuando staff añade el tag
`aprobado` a un customer que aún tiene `pendiente`. Sustituye a
`W2-aprobacion-manual.md` como fuente de verdad del "cómo está desplegado".

## Piezas clave

- Trigger: **`Customer tags added`** (no existe `Customer updated` en Flow 2026).
- Condition combinando dos criterios AND sobre `customer.tags`:
  1. contiene `pendiente` (evita disparos si viene de W1 auto-aprobación, que ya quitó `pendiente` antes de añadir `aprobado`)
  2. contiene `aprobado` (lo que acaba de añadir el staff)
- Sintaxis Flow Liquid para metafields de customer: **`{{ customer.<keyCamelCase>.value }}`** (snake_case → camelCase, con `.value`).

## Estructura final

```
Trigger  Customer tags added
 └→ Condition  (customer.tags contiene 'pendiente' AND 'aprobado')
    ├─ Verdadero
    │   ├─ Remove tag 'pendiente'
    │   ├─ Update metafield b2b.fecha_aprobacion = customer.updatedAt
    │   ├─ Send HTTP request → Supabase create-company-for-customer
    │   ├─ Send internal email → backoffice (FYI + Company creada auto)
    │   └─ [PENDIENTE GROW] Send marketing mail → template 04
    └─ Falso (vacío)
```

## Paso 0 — Crear

1. Apps → Flow → Create workflow → **`W2 — Aprobación manual`**.

## Paso 1 — Trigger

`Customer tags added`.

## Paso 2 — Check if (dos criterios AND)

En el dropdown IF superior: **Todos** (AND).

Criterio 1:
- Dropdown: `Al menos uno de customer / tags`
- Tags_item · Igual a · `pendiente`

Criterio 2 (`Agregar criterio` inferior):
- Dropdown: `Al menos uno de customer / tags`
- Tags_item · Igual a · `aprobado`

## Paso 3 — Rama Verdadero

### 3.1 Remove tag `pendiente`

`Quitar etiquetas al cliente`. Tags: `pendiente`.

### 3.2 Update metafield `b2b.fecha_aprobacion`

- Metacampo: `Fecha de aprobación (b2b.fecha_aprobacion)`
- Tipo: `Fecha`
- Value: `{{ customer.updatedAt | date: "%Y-%m-%d" }}`

### 3.3 Send HTTP request → Supabase create-company-for-customer

- **Method**: `POST`
- **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/create-company-for-customer`
- **Headers**:
  - `Content-Type`: `application/json`
  - `X-Webhook-Secret`: (Flow secret `CREATE_COMPANY_WEBHOOK_SECRET`)
- **Body**:
  ```
  {"customerId":"{{ customer.id }}"}
  ```

Crea Company B2B + Contact (customer existente) + Location, y la asigna al catálogo "Outlet general". Idempotente.

### 3.4 Send internal email → backoffice

- **To**: `daniel.pena+backoffice@creacciones.es` (literal)
- **Subject**: `[B2B] Aprobado manual: {{ customer.empresa.value }}`
- **Body**:

```
Cliente B2B aprobado manualmente por staff. Company creada automáticamente.

Cliente:
- Nombre:    {{ customer.firstName }} {{ customer.lastName }}
- Email:     {{ customer.defaultEmailAddress.emailAddress }}
- Ver:       https://admin.shopify.com/store/ledsc4-b2b-outlet/customers/{{ customer.id | split: '/' | last }}

Datos B2B:
- Empresa:   {{ customer.empresa.value }}
- NIF:       {{ customer.nif.value }}
- Sector:    {{ customer.sector.value }}
- País:      {{ customer.pais.value }}

Company creada automáticamente vía Supabase.

— Flow: W2
```

> Para insertar las variables `{{ customer.<key>.value }}` usa el picker `{ }` del campo; Flow genera la sintaxis camelCase correcta (p.ej. `volumen_estimado` → `customer.volumenEstimado.value`).

### 3.5 ❌ DESACTIVADO — Send marketing mail (template 04)

**Pendiente Grow**. Cuando reactives:

- Template: `B2B · 04 · Cuenta aprobada (manual)`
- To: auto.

## Rama Falso

Vacía. No hace falta nada.

## Paso 4 — Guardar y activar

Save + Turn on.

## Caveat de la condición

La condición AND `customer.tags contiene pendiente AND aprobado` funciona
cuando el staff añade `aprobado` en el **mismo guardado** en que el tag
`pendiente` aún sigue presente. Si staff quita `pendiente` en un primer
guardado y luego añade `aprobado` en un segundo, al disparar el trigger
`customer.tags` ya no contiene `pendiente` → W2 no fire.

Documentar al staff en `docs/backoffice-aprobaciones.md` §3.1: ambos cambios
de tag en un solo "Save".

## Export

`···` → **Export** → `flows/W2-aprobacion-manual.flow.json` (pendiente).
