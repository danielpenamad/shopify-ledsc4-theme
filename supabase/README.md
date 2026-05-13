# Supabase — LedsC4 B2B companion infra

Cinco edge functions + cron que cubren las piezas que Shopify Flow no puede
hacer por limitaciones de su sandbox de Run code (sin async, sin `fetch`,
sin `shopify.graphql`). Ver memoria `shopify-flow-schema.md`.

## Estructura

```
supabase/
  config.toml                                            verify_jwt=false para las 5 funciones (ver §verify_jwt)
  functions/
    promote-whitelist-matches/index.ts                  W4 — cron cada 30 min
    create-company-for-customer/index.ts                W1/W2 — crea Company + Contact + Location
    submit-order-request/index.ts                       Fase D — crea draft order desde /pages/solicitud
    list-order-requests/index.ts                        Fase D — lista/detalle desde /pages/mis-solicitudes
    register-b2b-customer/index.ts                      Sustituye /account/register (roto en new accounts)
  migrations/
    20260419120000_setup_cron.sql                       pg_cron + pg_net + private.config + schedule
  .env.example                                           secrets a setear
```

## ⚠️ `verify_jwt` y deploy — gotchas críticos

Supabase Gateway por defecto exige header `Authorization: Bearer <anon_jwt>` y
rechaza con **HTTP 401 Unauthorized antes de ejecutar la función** si no llega.

Las 4 funciones del proyecto se invocan SIN ese header (storefront JS, Flow
webhook, pg_cron). Por eso `config.toml` declara `verify_jwt = false` para
las 4 — la auth real se valida dentro de cada función (HMAC, X-Webhook-Secret).

**Cualquier deploy CLI (`supabase functions deploy`) lee `config.toml` y
sobrescribe los valores que el dashboard pueda haber tenido manualmente**.
Si una función pierde su `verify_jwt = false` del fichero, su próximo deploy
romperá la integración con 401 a nivel gateway. La fuente de verdad es el
fichero — no el dashboard.

### Cuándo redeployear

- Cambio de código en `functions/<f>/index.ts`.
- Cambio en `config.toml` (incluida la flag `verify_jwt`).
- **Rotación de un secret leído por la función**. Sin redeploy, el container
  caliente sigue con el valor viejo en RAM y devuelve errores aunque el
  secret nuevo ya esté en Supabase. **Esto es la causa #1 de bugs falsos
  tipo "el token está mal pero ya lo cambié"**.

Comando para redeployearlas todas tras rotar un secret compartido (`SHOPIFY_ADMIN_TOKEN`):

```bash
supabase functions deploy \
  list-order-requests \
  submit-order-request \
  create-company-for-customer \
  promote-whitelist-matches \
  --project-ref <project-ref>
```

## Funciones

### 1. `promote-whitelist-matches` (W4)

Cada 30 min `pg_cron` invoca esta función. Lee la whitelist (`shop.metafields.b2b.whitelist_emails`), pagina customers con tag `pendiente`, les añade `aprobado` a los matches. Eso dispara W2 en Shopify Flow (fecha_aprobacion + Company + emails).

- **URL**: `https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches`
- **Auth**: ninguna en dev (`verify_jwt=false`, sin secret header). Solo accesible vía cron interno.
- **Secrets requeridos**: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`.

### 2. `create-company-for-customer` (W1 rama Then + W2)

Flow la invoca vía `Send HTTP request` tras tagear al customer como `aprobado`. Crea Company B2B + Contact (customer existente) + Location, asigna al catálogo "Outlet general". Idempotente.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/create-company-for-customer`
- **Auth**: header `X-Webhook-Secret` con valor de env `CREATE_COMPANY_WEBHOOK_SECRET`.
- **Body**: `{ "customerId": "gid://shopify/Customer/123..." }`
- **Secrets requeridos**: los 3 Shopify + `CREATE_COMPANY_WEBHOOK_SECRET`.

### 3. `submit-order-request` (Fase D)

`/pages/solicitud` la invoca desde JS al pulsar "Confirmar y enviar solicitud". Valida HMAC + tag aprobado + duplicate check (60min), calcula CBM total, crea Draft Order con tags `solicitud-b2b` + `pendiente-revision`. Trigger del email transaccional `02-solicitud-recibida` (W5).

- **URL**: `https://<project-ref>.supabase.co/functions/v1/submit-order-request`
- **Auth**: HMAC SHA256 de `customerId:timestamp` firmado por Liquid SSR con `ORDER_REQUEST_HMAC_SECRET`. TTL 600s. Constant-time compare.
- **Secrets requeridos**: los 3 Shopify + `ORDER_REQUEST_HMAC_SECRET`. Mismo valor en `settings.order_request_hmac_secret` de `config/settings_data.json` (compartido entre Liquid y edge).
- **Scopes Shopify**: `read_customers`, `read_draft_orders`, `write_draft_orders`, `read_products`.

### 4. `list-order-requests` (Fase D)

`/pages/mis-solicitudes` y `/pages/solicitud-detalle` la invocan para listar solicitudes del customer logueado o ver una concreta por `ref`.

- **URL**: `https://<project-ref>.supabase.co/functions/v1/list-order-requests`
- **Auth**: mismo HMAC que `submit-order-request`.
- **Secrets requeridos**: los 3 Shopify + `ORDER_REQUEST_HMAC_SECRET`.
- **Scopes Shopify**: `read_customers`, `read_draft_orders`.

### 5. `register-b2b-customer` (sustituye /account/register)

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

Respuesta:
```json
{ "created": true, "companyId": "gid://...", "companyLocationId": "gid://...", "catalogId": "gid://..." }
// o
{ "skipped": true, "reason": "already_has_company", "companyId": "gid://..." }
// o
{ "error": "...", ... }
```

## Por qué dos functions en vez de una

Separación por trigger:
- `promote-whitelist-matches` corre con cron, no espera input (solo sirve para una acción concreta: re-evaluar pendientes).
- `create-company-for-customer` se invoca por demanda desde Flow con un customer específico.

Responsabilidades distintas + testeo independiente + auth distinto.

## Setup en un proyecto nuevo (migración al cliente)

10-15 min desde cero.

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
| `SHOPIFY_ADMIN_TOKEN` | `shpat_...` (custom app: read/write customers, companies, products, publications) |
| `SHOPIFY_API_VERSION` | `2025-10` |
| `CREATE_COMPANY_WEBHOOK_SECRET` | generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ORDER_REQUEST_HMAC_SECRET` | mismo valor que `settings.order_request_hmac_secret` en `config/settings_data.json`. |
| `REGISTER_B2B_HMAC_SECRET` | generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **MISMO valor** debe ponerse en theme settings → Endpoints B2B → "HMAC secret · register-b2b" (Online Store → Themes → Customize). |
| `STOREFRONT_ORIGIN` (opcional) | dominio del storefront (`https://ledsc4-b2b-outlet.myshopify.com` o el custom domain) para CORS estricto en prod. Default `*`. |

Alternativa CLI: `supabase secrets set NAME=value`.

### 4. Aplicar migración

```bash
supabase db push
```

Habilita `pg_cron` + `pg_net`, crea `private.config`, crea `private.invoke_edge_function()`, programa el cron.

### 5. Actualizar `private.config` con la URL del proyecto

```sql
update private.config set value = 'https://<project-ref>.supabase.co'
where key = 'supabase_url';
```

(La migración inserta la URL del proyecto de desarrollo; al migrar, actualizar.)

### 6. Deploy de las cinco functions

```bash
supabase functions deploy \
  promote-whitelist-matches \
  create-company-for-customer \
  submit-order-request \
  list-order-requests \
  register-b2b-customer
```

### 7. Actualizar el `Send HTTP request` de W1 y W2 en Shopify Flow

Apps → Flow → W1 → rama Verdadero → Send HTTP request → URL:
```
https://<NEW-project-ref>.supabase.co/functions/v1/create-company-for-customer
```

Igual en W2.

También actualizar el **Flow secret** `CREATE_COMPANY_WEBHOOK_SECRET` con el valor nuevo generado en el paso 3.

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

### 9. Verificar el cron

```sql
select jobname, schedule, active from cron.job where jobname = 'promote-whitelist-matches';
```

Debe mostrar `active=true`, schedule `*/30 * * * *`.

## Observabilidad

- `cron.job_run_details` en Postgres: cada ejecución del cron.
- `supabase functions logs <name>`: logs de cada invocación (incluyendo errores de GraphQL).
- Dashboard → Edge Functions → \<function\> → Logs: mismo contenido en UI.

## Nota de seguridad — abierto por defecto

Ambas functions tienen `verify_jwt = false`. `promote-whitelist-matches` no tiene auth (la URL no es pública y el cron interno es el único llamador). `create-company-for-customer` valida `X-Webhook-Secret`.

Si en producción quieres más defensa en profundidad:
- Cambiar `promote-whitelist-matches` a exigir también `X-Cron-Secret`.
- Rotar `CREATE_COMPANY_WEBHOOK_SECRET` periódicamente (actualizar tanto en Supabase secrets como en Flow secret).

## Limitaciones de address para Company creation

Al crear una Company nueva, Shopify exige `shippingAddress` con `address1 + city + zip + countryCode`. Como el form del storefront B2B **no** captura dirección (solo datos fiscales y sector), usamos placeholders:

- address1: `Por completar al primer pedido`
- city: `Madrid`
- zip: `28001`
- countryCode: `ES`

El comercial los completa al primer pedido real. Alternativa: añadir fields de dirección al form de registro en el storefront y pasarlos en el body del HTTP request.
