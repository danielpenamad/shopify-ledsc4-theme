# Supabase — LedsC4 B2B companion infra

Diez edge functions + cron + base de datos que cubren las piezas que Shopify
Flow no puede hacer por limitaciones de su sandbox de Run code (sin async,
sin `fetch`, sin `shopify.graphql`). Ver memoria `shopify-flow-schema.md`.

Vista de referencia arquitectónica del proyecto en `docs/desarrollo/11-supabase.md`.
Este README es la guía de setup operativa.

## Estructura

```
supabase/
  config.toml                                  verify_jwt por función (ver §verify_jwt). SoT del flag.
  .env.example                                 secrets a setear
  functions/
    register-b2b-customer/index.ts             Alta B2B — sustituye /account/register
    create-company-for-customer/index.ts       W1/W2 — crea Company + Contact + Location
    promote-whitelist-matches/index.ts          W4 — cron cada 30 min, re-evalúa whitelist
    list-pending-customers/index.ts            Backoffice — lista pendientes + counts
    update-whitelist/index.ts                  Backoffice — edita shop metafield whitelist
    approve-customer/index.ts                  Backoffice — tags pendiente→aprobado
    reject-customer/index.ts                   Backoffice — tags pendiente→rechazado + motivo
    submit-order-request/index.ts              Fase D — crea draft order desde /pages/solicitud
    list-order-requests/index.ts               Fase D — lista/detalle desde /pages/mis-solicitudes
    sftp-sync/index.ts                         Importer — descarga CSV del SFTP a Storage (verify_jwt=true)
  migrations/                                  10 migraciones SQL (ver §Migraciones)
```

**10 edge functions.** `config.toml` es la fuente de verdad del inventario. Si
este README y `config.toml` divergen, gana `config.toml`.

## ⚠️ `verify_jwt` y deploy — gotchas críticos

Supabase Gateway por defecto exige header `Authorization: Bearer <anon_jwt>` y
rechaza con **HTTP 401 Unauthorized antes de ejecutar la función** si no llega.

9 de las 10 funciones se invocan SIN ese header (storefront JS, Flow webhook,
pg_cron sin auth). Por eso `config.toml` declara `verify_jwt = false` para esas
9 — la auth real se valida dentro de cada función (HMAC, `X-Webhook-Secret`, o
ninguna en el caso de `promote-whitelist-matches`).

`sftp-sync` es la **única** con `verify_jwt = true`: no debe ser invocable
públicamente, así que exige el JWT. Su cron pasa `with_auth = true` a
`invoke_edge_function` para inyectar el header (ver §Cron).

**Cualquier deploy CLI (`supabase functions deploy`) lee `config.toml` y
sobrescribe los valores que el dashboard pueda haber tenido manualmente**.
Si una función pierde su `verify_jwt` correcto del fichero, su próximo deploy
romperá la integración (401 a nivel gateway, o función pública por error).
La fuente de verdad es el fichero — no el dashboard.

### Cuándo redeployear

- Cambio de código en `functions/<f>/index.ts`.
- Cambio en `config.toml` (incluida la flag `verify_jwt`).
- **Rotación de un secret leído por la función**. Sin redeploy, el container
  caliente sigue con el valor viejo en RAM y devuelve errores aunque el
  secret nuevo ya esté en Supabase. **Esto es la causa #1 de bugs falsos
  tipo "el token está mal pero ya lo cambié"**.

Comando para redeployearlas todas tras rotar un secret compartido (`SHOPIFY_ADMIN_TOKEN`
lo usan las 10):

```bash
supabase functions deploy \
  register-b2b-customer \
  create-company-for-customer \
  promote-whitelist-matches \
  list-pending-customers \
  update-whitelist \
  approve-customer \
  reject-customer \
  submit-order-request \
  list-order-requests \
  sftp-sync \
  --project-ref <project-ref>
```

## Funciones

Agrupadas por fase.

### Registro y aprobación

#### 1. `register-b2b-customer` (sustituye /account/register)

Form `/pages/acceso-profesional#registro` la invoca al enviar el alta B2B. Crea el customer en Admin API con tag `pendiente` + metafields `b2b.*` completos (`empresa`, `nif`, `sector`, `pais`, `volumen_estimado`, `fecha_registro`), y dispara `customerSendAccountInviteEmail` para que el usuario reciba el magic link y active la cuenta. Sustituye al flujo `/account/register` clásico que Shopify rompió al forzar new customer accounts (registro y login colapsados en OAuth, sin form de campos custom).

- **URL**: `https://<project-ref>.supabase.co/functions/v1/register-b2b-customer`
- **Auth**: HMAC SHA256 de `<timestamp>:<nonce>` firmado por Liquid SSR con `settings.register_b2b_hmac_secret`. TTL 5 min. Constant-time compare.
- **Secrets requeridos**:
  - `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`.
  - `REGISTER_B2B_HMAC_SECRET` — DEBE coincidir con `settings.register_b2b_hmac_secret` del tema (set via Online Store → Themes → Customize → Theme settings → Endpoints B2B).
  - `STOREFRONT_ORIGIN` (opcional) — para CORS estricto en prod. Default `*`.
- **Scopes Shopify**: `read_customers`, `write_customers`.

**Respuestas**:

```json
// 200 — customer creado e invite enviado
{ "ok": true, "customerId": "gid://shopify/Customer/123", "inviteSent": true }

// 200 — customer creado pero invite falló (warning, no bloquea al usuario)
{ "ok": true, "customerId": "gid://shopify/Customer/123",
  "inviteSent": false, "warning": "INVITE_EMAIL_FAILED" }

// 409 — email ya en uso
{ "code": "EMAIL_ALREADY_EXISTS", "message": "..." }

// 400 — validación
{ "code": "VALIDATION_ERROR", "fieldErrors": { "nif": "...", "email": "..." } }

// 401 — HMAC inválido o caducado
{ "code": "SIGNATURE_EXPIRED" | "INVALID_SIGNATURE" }

// 502 — Shopify no disponible
{ "code": "SHOPIFY_UNAVAILABLE", "message": "..." }
```

**TODO hardening producción**: dedupe de nonce en KV para evitar replay dentro del TTL (hoy se confía en la ventana de 5 min + idempotencia por email). Ver header de la función para detalle.

#### 2. `create-company-for-customer` (W1 rama auto-aprobado + W2)

Flow la invoca vía `Send HTTP request` tras tagear al customer como `aprobado`. Crea Company B2B + Contact (customer existente) + Location, asigna al catálogo "Outlet general". Idempotente.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/create-company-for-customer`
- **Auth**: header `X-Webhook-Secret` con valor de env `CREATE_COMPANY_WEBHOOK_SECRET`.
- **Body**: `{ "customerId": "gid://shopify/Customer/123..." }`
- **Secrets requeridos**: los 3 Shopify + `CREATE_COMPANY_WEBHOOK_SECRET`.

**Respuestas**:

```json
{ "created": true, "companyId": "gid://...", "companyLocationId": "gid://...", "catalogId": "gid://..." }
// o
{ "skipped": true, "reason": "already_has_company", "companyId": "gid://..." }
// o
{ "error": "...", ... }
```

#### 3. `promote-whitelist-matches` (W4)

Cada 30 min `pg_cron` invoca esta función. Lee la whitelist (`shop.metafields.b2b.whitelist_emails`), pagina customers con tag `pendiente`, les añade `aprobado` a los matches. Eso dispara W2 en Shopify Flow (fecha_aprobacion + Company + emails).

- **URL**: `https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches`
- **Auth**: ninguna (`verify_jwt=false`, sin secret header). Solo accesible vía cron interno — la URL no es pública. TODO producción: añadir `X-Cron-Secret`.
- **Secrets requeridos**: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`.

### Backoffice (Fase BO)

Las 4 sirven la página `/pages/admin-backoffice`. Auth común: HMAC del `approver.id` firmado por Liquid SSR con `settings.backoffice_hmac_secret`, más verificación server-side del tag `backoffice` en cada request (`assertBackofficeTag`). El `{% if %}` del page template es solo UX — la seguridad real vive en cada handler.

#### 4. `list-pending-customers`

Storefront JS (admin-backoffice) la invoca al cargar la página y tras cada acción para refrescar lista + counts.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/list-pending-customers`
- **Auth**: HMAC backoffice + `assertBackofficeTag`.
- **Secrets requeridos**: los 3 Shopify + `BACKOFFICE_HMAC_SECRET`.

#### 5. `update-whitelist`

Storefront JS la invoca al pulsar "Añadir a whitelist". Edita el shop metafield `b2b.whitelist_emails` y dispara `promote-whitelist-matches`.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/update-whitelist`
- **Auth**: HMAC backoffice + `assertBackofficeTag`.
- **Secrets requeridos**: los 3 Shopify + `BACKOFFICE_HMAC_SECRET` + `PROMOTE_WHITELIST_FUNCTION_URL` (URL de `promote-whitelist-matches`).

#### 6. `approve-customer`

Storefront JS la invoca al pulsar "Aprobar". Cambia tags atómicamente `pendiente`→`aprobado` vía `customerUpdate`; W2 hace fecha + Company + email.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/approve-customer`
- **Auth**: HMAC backoffice + `assertBackofficeTag`.
- **Secrets requeridos**: los 3 Shopify + `BACKOFFICE_HMAC_SECRET`.

#### 7. `reject-customer`

Storefront JS la invoca al pulsar "Rechazar". Setea motivo (si hay) + `fecha_rechazo` ANTES del cambio de tag para que W3 envíe el email de rechazo con el motivo poblado. Cambia tags atómicamente `pendiente`→`rechazado`.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/reject-customer`
- **Auth**: HMAC backoffice + `assertBackofficeTag`.
- **Secrets requeridos**: los 3 Shopify + `BACKOFFICE_HMAC_SECRET`.

### Solicitudes de pedido (Fase D)

#### 8. `submit-order-request`

`/pages/solicitud` la invoca desde JS al pulsar "Confirmar y enviar solicitud". Valida HMAC + tag aprobado + duplicate check (60min), calcula CBM total, crea Draft Order con tags `solicitud-b2b` + `pendiente-revision`. Trigger del email transaccional (W5).

- **URL**: `https://<project-ref>.supabase.co/functions/v1/submit-order-request`
- **Auth**: HMAC SHA256 de `customerId:timestamp` firmado por Liquid SSR con `ORDER_REQUEST_HMAC_SECRET`. TTL 600s. Constant-time compare.
- **Secrets requeridos**: los 3 Shopify + `ORDER_REQUEST_HMAC_SECRET`. Mismo valor en `settings.order_request_hmac_secret` de `config/settings_data.json` (compartido entre Liquid y edge).
- **Scopes Shopify**: `read_customers`, `read_draft_orders`, `write_draft_orders`, `read_products`.

#### 9. `list-order-requests`

`/pages/mis-solicitudes` y `/pages/solicitud-detalle` la invocan para listar solicitudes del customer logueado o ver una concreta por `ref`.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/list-order-requests`
- **Auth**: mismo HMAC que `submit-order-request`.
- **Secrets requeridos**: los 3 Shopify + `ORDER_REQUEST_HMAC_SECRET`.
- **Scopes Shopify**: `read_customers`, `read_draft_orders`.

### Importer (Fase I4)

#### 10. `sftp-sync`

`pg_cron` la invoca (5 jobs: 4 stock_only + 1 full). Descarga los CSV del SFTP del proveedor a Storage (bucket `ledsc4-imports`) y crea la row de tracking en `private.import_runs`. Manualmente invocable por Dani con anon/service key.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/sftp-sync`
- **Auth**: **`verify_jwt = true`** — exige `Authorization: Bearer <anon_jwt>`. NO pública. El cron pasa `with_auth=true` a `invoke_edge_function`.
- **Body**: `{ "kind": "full" }` o `{ "kind": "stock_only" }`.
- **Secrets requeridos**: credenciales SFTP del proveedor (ver `.env.example`).

## Base de datos

Dos schemas relevantes:

- **`public`** — sin tablas operacionales del portal. PostgREST lo expone vía la anon key, así que no se pone aquí nada que no deba ser legible públicamente.
- **`private`** — fuera del scope de PostgREST. `anon`/`authenticated` con permisos revocados. Solo accesible con service-role key o desde Studio si se añade `private` a "Exposed schemas".

Cuatro tablas, todas en `private`:

| Tabla | Propósito |
|---|---|
| `private.config` | Key/value de config del proyecto (`supabase_url`, `supabase_anon_key`) |
| `private.import_runs` | FSM de cada run del importer (`started`→`downloaded`→`processing`→`completed`\|`failed`) |
| `private.sku_state` | Fingerprint cache por SKU para imports incrementales (doble fingerprint full/stock) |
| `private.image_cache` | Cache sha256→Shopify file_id para el pre-upload de imágenes |

Ninguna con RLS — service-role only. Estado operacional va en `private`, no en `public` con RLS.

Un bucket de Storage: **`ledsc4-imports`** (privado). Staging del pipeline de import. Convención de rutas `runs/{import_run_id}/`.

## Migraciones

10 migraciones en `migrations/`, en orden cronológico:

| Migración | Qué hace |
|---|---|
| `20260419120000_setup_cron.sql` | `pg_cron` + `pg_net`, schema `private`, `private.config`, `private.invoke_edge_function`, cron de whitelist |
| `20260507120000_import_runs.sql` | Crea `public.import_runs` + bucket `ledsc4-imports` |
| `20260507130000_import_runs_to_private.sql` | Mueve `import_runs` a `private`, revoca permisos |
| `20260507140000_sku_state.sql` | Crea `private.sku_state` |
| `20260507150000_sku_state_stock_columns.sql` | Añade `fingerprint_stock` + `stock_last_seen_at` |
| `20260507160000_import_runs_counts_and_report_prefix.sql` | Añade `counts` + `report_storage_prefix` |
| `20260509120000_seed_anon_key.sql` | Slot `supabase_anon_key` en `private.config` (placeholder) |
| `20260509120100_invoke_edge_function_auth.sql` | Extiende `invoke_edge_function` con `with_auth` |
| `20260509120200_setup_cron_sftp_sync.sql` | 5 crons de `sftp-sync` |
| `20260510120000_image_cache.sql` | Crea `private.image_cache` |

## Cron

6 jobs programados:

| Job | Schedule (UTC) | Invoca | `with_auth` |
|---|---|---|---|
| `promote-whitelist-matches` | `*/30 * * * *` | `promote-whitelist-matches` | false |
| `sftp-sync-stock-01h` | `0 1 * * *` | `sftp-sync` `{kind:stock_only}` | true |
| `sftp-sync-stock-07h` | `0 7 * * *` | `sftp-sync` `{kind:stock_only}` | true |
| `sftp-sync-stock-13h` | `0 13 * * *` | `sftp-sync` `{kind:stock_only}` | true |
| `sftp-sync-stock-19h` | `0 19 * * *` | `sftp-sync` `{kind:stock_only}` | true |
| `sftp-sync-full-02h` | `0 2 * * *` | `sftp-sync` `{kind:full}` | true |

`private.invoke_edge_function(name, payload, with_auth)` es el helper `security definer` desde el que pg_cron invoca funciones. Con `with_auth=true` inyecta `Authorization: Bearer <anon_key>` leído de `private.config` — necesario para `sftp-sync` (`verify_jwt=true`).

## Setup en un proyecto nuevo (migración al cliente)

15-20 min desde cero.

### 1. Crear el proyecto en Supabase

Cuenta destino → **New project**. Guarda el `project-ref`.

### 2. Linkear el repo

```bash
cd supabase/
supabase link --project-ref <project-ref>
```

### 3. Setear secrets

Dashboard → **Project Settings → Edge Functions → Secrets**. Añade:

| Nombre | Valor |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `<tienda>.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | `shpat_...` (custom app: read/write customers, companies, products, draft orders, publications) |
| `SHOPIFY_API_VERSION` | `2025-10` |
| `CREATE_COMPANY_WEBHOOK_SECRET` | generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ORDER_REQUEST_HMAC_SECRET` | mismo valor que `settings.order_request_hmac_secret` en `config/settings_data.json` |
| `REGISTER_B2B_HMAC_SECRET` | generar con `randomBytes`. **MISMO valor** en theme settings → Endpoints B2B → "HMAC secret · register-b2b" |
| `BACKOFFICE_HMAC_SECRET` | generar con `randomBytes`. **MISMO valor** en theme settings → Endpoints B2B → "HMAC secret · backoffice" |
| `PROMOTE_WHITELIST_FUNCTION_URL` | `https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches` |
| `STOREFRONT_ORIGIN` (opcional) | dominio del storefront para CORS estricto en prod. Default `*` |
| Credenciales SFTP | host, puerto, usuario, clave del SFTP del proveedor (ver `.env.example`) |

Alternativa CLI: `supabase secrets set NAME=value`.

### 4. Aplicar migraciones

```bash
supabase db push
```

Aplica las 10 migraciones: extensiones, schema `private`, las 4 tablas, el bucket, los helpers y los 6 crons.

### 5. Actualizar `private.config`

Dos UPDATE manuales obligatorios — las migraciones siembran valores del proyecto de desarrollo / placeholders:

```sql
update private.config set value = 'https://<project-ref>.supabase.co'
where key = 'supabase_url';

update private.config set value = '<anon key real>'
where key = 'supabase_anon_key';
```

La anon key viene de Project Settings → API. Si se olvida el segundo UPDATE, los crons de `sftp-sync` fallan ruidosamente (excepción en `cron.job_run_details`); el cron de whitelist sigue OK porque usa `with_auth=false`.

### 6. Deploy de las 10 functions

```bash
supabase functions deploy \
  register-b2b-customer \
  create-company-for-customer \
  promote-whitelist-matches \
  list-pending-customers \
  update-whitelist \
  approve-customer \
  reject-customer \
  submit-order-request \
  list-order-requests \
  sftp-sync
```

### 7. Actualizar los `Send HTTP request` en Shopify Flow

Apps → Flow → W1 → rama auto-aprobado → Send HTTP request → URL:
```
https://<NEW-project-ref>.supabase.co/functions/v1/create-company-for-customer
```

Igual en W2. También actualizar el **Flow secret** `CREATE_COMPANY_WEBHOOK_SECRET` con el valor nuevo del paso 3.

### 8. Verificar

```bash
# promote-whitelist-matches
curl -X POST https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches

# create-company-for-customer (con un customer ID válido)
curl -X POST https://<project-ref>.supabase.co/functions/v1/create-company-for-customer \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: <tu-secret>" \
  -d '{"customerId":"gid://shopify/Customer/123..."}'
```

Respuestas esperadas en el §Funciones.

### 9. Verificar los crons

```sql
select jobname, schedule, active from cron.job order by jobname;
```

Deben aparecer los 6 jobs con `active=true`: `promote-whitelist-matches` (`*/30 * * * *`) y los 5 `sftp-sync-*`.

## Observabilidad

- `cron.job_run_details` en Postgres: cada ejecución de cada cron.
- `select jobname, schedule, active from cron.job`: estado de los jobs programados.
- `supabase functions logs <name>`: logs de cada invocación (incluyendo errores de GraphQL).
- Dashboard → Edge Functions → \<function\> → Logs: mismo contenido en UI.
- Tabla `private.import_runs`: estado de los runs del importer.

## Nota de seguridad — abierto por defecto

9 de 10 funciones con `verify_jwt = false`; cada una valida su auth internamente:

- `promote-whitelist-matches`: sin auth (la URL no es pública, el cron interno es el único llamador).
- `create-company-for-customer`: `X-Webhook-Secret`.
- Las 4 de backoffice: HMAC backoffice + `assertBackofficeTag`.
- `submit-order-request` / `list-order-requests`: HMAC del customer.
- `register-b2b-customer`: HMAC `<timestamp>:<nonce>`.

`sftp-sync` es la única con `verify_jwt = true`.

Hardening adicional pendiente para producción:
- Añadir `X-Cron-Secret` a `promote-whitelist-matches`.
- Dedupe de nonce para `register-b2b-customer` (anti-replay).
- Rotar `CREATE_COMPANY_WEBHOOK_SECRET` y los HMAC periódicamente (actualizar tanto en Supabase secrets como en Flow secret / theme settings).

## Limitaciones de address para Company creation

Al crear una Company nueva, Shopify exige `shippingAddress` con `address1 + city + zip + countryCode`. Como el form del storefront B2B **no** captura dirección (solo datos fiscales y sector), usamos placeholders:

- address1: `Por completar al primer pedido`
- city: `Madrid`
- zip: `28001`
- countryCode: `ES`

El comercial los completa al primer pedido real. Alternativa: añadir fields de dirección al form de registro en el storefront y pasarlos en el body del HTTP request.
