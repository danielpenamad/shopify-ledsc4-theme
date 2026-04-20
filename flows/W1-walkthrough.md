# W1 — Walkthrough click-a-click (estado final Fase B)

Configuración real del workflow **W1 — Registro B2B** en Shopify Flow tal como
quedó tras Fase B (2026-04-19). Sustituye a `W1-registro.md` como fuente de
verdad del "cómo está desplegado".

## Piezas clave descubiertas en Fase B

- Flow Run code es sandbox puro: **sin `async`, sin `shopify.graphql`, sin `fetch`**.
- En Flow Run code, `customer.metafields` es **array plano** sin args: `metafields { namespace key value }`. Sin alias.
- `customer.email` / `customer.phone` deprecados → `defaultEmailAddress.emailAddress` / `defaultPhoneNumber.phoneNumber`.
- Flow numera Run codes como `runCode`, `runCode1`, `runCode2`… ignorando la descripción.
- Flow Liquid para metafields de customer: **`{{ customer.<keyCamelCase>.value }}`** (camelCase, sin namespace).
- `Send internal email`: **To no admite variables**. Solo literales.
- `Send marketing mail`: en plan Development requiere que la plantilla esté publicada; si es borrador, Flow **bloquea la activación** del workflow. Por eso en Fase B están desactivados (ver [docs/grow-migration-checklist.md](../docs/grow-migration-checklist.md)).

## Estructura final del workflow

```
Trigger  Customer created
 └→ Run code  parseAndNormalize      (runCode)
    └→ 4 × Update customer metafield  (empresa, nif, sector, pais)
       └→ Add tag 'pendiente'
          └→ Run code  whitelistCheck  (runCode1)
             └→ Condition  runCode1.whitelisted == true
                ├─ Verdadero (auto-aprobación)
                │   ├─ Remove tag 'pendiente'
                │   ├─ Add tag 'aprobado'
                │   ├─ Update metafield b2b.fecha_aprobacion
                │   ├─ Send HTTP request → Supabase create-company-for-customer
                │   ├─ Send internal email → backoffice (FYI + datos Company)
                │   └─ [PENDIENTE GROW] Send marketing mail → template 01
                └─ Falso (pendiente)
                    ├─ Send internal email → backoffice (nuevo pendiente)
                    └─ [PENDIENTE GROW] Send marketing mail → template 02
```

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**.
2. Rename a **`W1 — Registro B2B`**.

## Paso 1 — Trigger: Customer created

1. Select a trigger → `Customer created`.
2. Done.

## Paso 2 — Run code `parseAndNormalize` (primer Run code)

Acción **Ejecutar código**. Flow lo referenciará como `runCode`.

**Panel GRAPHQL** (input query):

```graphql
{
  customer {
    id
    createdAt
    defaultEmailAddress { emailAddress }
    firstName
    lastName
    note
    tags
    metafields {
      namespace
      key
      value
    }
  }
}
```

> `metafields` sin args devuelve lista plana. Sin alias.

**Panel JAVASCRIPT** (código):

```javascript
export default function main(input) {
  const note = input.customer.note || '';
  let parsed = {};
  try {
    parsed = note.trim().startsWith('{') ? JSON.parse(note) : {};
  } catch {
    parsed = {};
  }

  const mfList = input.customer.metafields || [];
  const mf = {};
  for (const node of mfList) {
    if (node?.namespace === 'b2b' && node?.key && node?.value) {
      mf[node.key] = node.value;
    }
  }

  const todayFromCreatedAt = input.customer.createdAt
    ? input.customer.createdAt.slice(0, 10)
    : '';

  const record = {
    empresa:          mf.empresa          || parsed.empresa          || '',
    nif:              mf.nif              || parsed.nif              || '',
    sector:           mf.sector           || parsed.sector           || '',
    pais:             mf.pais             || parsed.pais             || '',
    volumen_estimado: mf.volumen_estimado || parsed.volumen_estimado || '',
    fecha_registro:   mf.fecha_registro   || parsed.fecha_registro   || todayFromCreatedAt,
  };

  const emailRaw = input.customer.defaultEmailAddress?.emailAddress || '';

  return {
    empresa: record.empresa,
    nif: record.nif,
    sector: record.sector,
    pais: record.pais,
    volumen_estimado: record.volumen_estimado,
    fecha_registro: record.fecha_registro,
    needs_backfill_empresa:          !mf.empresa          && !!record.empresa,
    needs_backfill_nif:              !mf.nif              && !!record.nif,
    needs_backfill_sector:           !mf.sector           && !!record.sector,
    needs_backfill_pais:             !mf.pais             && !!record.pais,
    needs_backfill_volumen_estimado: !mf.volumen_estimado && !!record.volumen_estimado,
    needs_backfill_fecha_registro:   !mf.fecha_registro   && !!record.fecha_registro,
    emailLower: emailRaw.trim().toLowerCase(),
  };
}
```

**Panel SDL** (output schema):

```graphql
type Output {
  empresa: String!
  nif: String!
  sector: String!
  pais: String!
  volumen_estimado: String!
  fecha_registro: String!
  needs_backfill_empresa: Boolean!
  needs_backfill_nif: Boolean!
  needs_backfill_sector: Boolean!
  needs_backfill_pais: Boolean!
  needs_backfill_volumen_estimado: Boolean!
  needs_backfill_fecha_registro: Boolean!
  emailLower: String!
}
```

## Paso 3 — 4 backfill de metafields (no 6)

Por cada key, `Actualizar metacampo del cliente`:

| # | Key | Type | Value |
|---|---|---|---|
| 1 | `empresa` | `single_line_text_field` | (picker → runCode → empresa) |
| 2 | `nif` | `single_line_text_field` | (picker → runCode → nif) |
| 3 | `sector` | `single_line_text_field` | (picker → runCode → sector) |
| 4 | `pais` | `single_line_text_field` | (picker → runCode → pais) |

El Value sale como `{{ runCode.empresa }}` etc.

### ❌ Desactivados (originalmente 6, quedaron 4)

| Key | Por qué se desactivó | Cuándo reactivar |
|---|---|---|
| `volumen_estimado` | Opcional. Si el admin crea customer sin el valor, `runCode.volumen_estimado` es `""`. Shopify rechaza `single_line_text_field` con value vacío → halt del workflow. | No se reactiva. El form del storefront lo captura directo del usuario; backfill innecesario. |
| `fecha_registro` | `customer.createdAt` llega como epoch 0 en runtime de Flow (aunque funcionaba bien en preview). Resultado: fecha_registro = `1970-01-01`. Feo. | No se reactiva. El form del storefront lo manda como hidden input `{{ 'now' \| date: '%Y-%m-%d' }}`. |

Si en el futuro necesitas backfill para altas vía admin puro, envuelve el step en **`Comprobar si` → `runCode.needs_backfill_<key> == true`**. Así nunca se ejecuta con value vacío.

## Paso 4 — Add customer tag `pendiente`

Acción `Agregar etiquetas al cliente`. Tag: `pendiente`.

## Paso 5 — Run code `whitelistCheck` (segundo Run code)

Flow lo referenciará como `runCode1`.

**GRAPHQL**:

```graphql
{
  shop {
    metafields {
      namespace
      key
      value
    }
  }
  customer {
    id
    defaultEmailAddress { emailAddress }
  }
}
```

**JAVASCRIPT**:

```javascript
export default function main(input) {
  const mfList = input.shop?.metafields || [];
  let rawWhitelist = '';
  for (const node of mfList) {
    if (node?.namespace === 'b2b' && node?.key === 'whitelist_emails' && node?.value) {
      rawWhitelist = node.value;
      break;
    }
  }

  let whitelist = [];
  try {
    const parsed = rawWhitelist ? JSON.parse(rawWhitelist) : [];
    whitelist = parsed.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch {
    whitelist = [];
  }

  const email = (input.customer?.defaultEmailAddress?.emailAddress || '')
    .trim()
    .toLowerCase();

  return {
    whitelisted: whitelist.includes(email),
    whitelistSize: whitelist.length,
  };
}
```

**SDL**:

```graphql
type Output {
  whitelisted: Boolean!
  whitelistSize: Int!
}
```

## Paso 6 — Condition: `runCode1.whitelisted == true`

Un criterio simple:

- Campo: (picker) `runCode1.whitelisted`
- Operador: `Igual a`
- Valor: `true`

Se generan 2 ramas (Verdadero / Falso).

---

## Rama Verdadero — Auto-aprobación

### 6.1 Remove tag `pendiente`
### 6.2 Add tag `aprobado`
### 6.3 Update metafield `b2b.fecha_aprobacion`

- Type: `Fecha`
- Value: `{{ runCode.fecha_registro }}`

> En auto-aprobación, registro y aprobación son el mismo momento — reusamos la fecha.

### 6.4 Send HTTP request → Supabase `create-company-for-customer`

- **Method**: `POST`
- **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/create-company-for-customer`
  > Al migrar al Supabase del cliente, cambiar la URL por la nueva.
- **Headers**:
  - `Content-Type`: `application/json`
  - `X-Webhook-Secret`: (**Flow secret** `CREATE_COMPANY_WEBHOOK_SECRET`)
- **Body**:
  ```
  {"customerId":"{{ customer.id }}"}
  ```

Este step crea la Company B2B + Contact (customer existente) + Location y asigna la Location al catálogo "Outlet general". Idempotente. Ver [supabase/README.md](../supabase/README.md) para detalles.

### 6.5 Send internal email → backoffice (FYI)

- **To**: `daniel.pena+backoffice@creacciones.es` (literal, Flow no admite variables en To)
- **Subject**: `[B2B] Auto-aprobado: {{ runCode.empresa }}`
- **Body**: (ver `email-templates/03-backoffice-nuevo-pendiente.liquid` como base; en W1 rama Then lo adaptamos a "auto-aprobado + Company creada automáticamente").

### 6.6 ❌ DESACTIVADO — Send marketing mail (template 01)

**Pendiente Grow** (ver checklist). Cuando reactives:

- Template: `B2B · 01 · Bienvenida (auto)`
- To: auto (customer del trigger).

---

## Rama Falso — Pendiente

### 6.7 Send internal email → backoffice (nuevo pendiente)

- **To**: `daniel.pena+backoffice@creacciones.es`
- **Subject**: `[B2B] Nuevo registro pendiente — {{ runCode.empresa }}`
- **Body**: copy-paste de `email-templates/03-backoffice-nuevo-pendiente.liquid`.

### 6.8 ❌ DESACTIVADO — Send marketing mail (template 02)

**Pendiente Grow**.

- Template: `B2B · 02 · Solicitud recibida`

---

## Paso 7 — Guardar y activar

1. **Save**.
2. Toggle **Turn on** / Activar.

## Paso 8 — Export

1. `···` → **Export** → guardar en `flows/W1-registro.flow.json` (pendiente).

## Verificación end-to-end

**Escenario 2 validado** (2026-04-19): crear customer con email no-whitelist + 4 metafields obligatorios. Al guardar:

- Tag `pendiente` añadido.
- 4 metafields backfill (value = lo que pusiste en admin).
- Email llega a `daniel.pena+backoffice@creacciones.es` con los datos.
- No se crea Company (rama Falso no toca Company).
- Run history: todos los steps en verde.
