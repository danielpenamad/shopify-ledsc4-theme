# Supabase — LedsC4 B2B companion infra

Dos edge functions + cron que cubren las piezas que Shopify Flow no puede
hacer por limitaciones de su sandbox de Run code (sin async, sin `fetch`,
sin `shopify.graphql`). Ver memoria `shopify-flow-schema.md`.

## Estructura

```
supabase/
  config.toml                                            verify_jwt=false para ambas functions
  functions/
    promote-whitelist-matches/index.ts                  W4 — cron cada 30 min
    create-company-for-customer/index.ts                W1/W2 — crea Company + Contact + Location
  migrations/
    20260419120000_setup_cron.sql                       pg_cron + pg_net + private.config + schedule
  .env.example                                           secrets a setear
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

### 6. Deploy de las dos functions

```bash
supabase functions deploy promote-whitelist-matches
supabase functions deploy create-company-for-customer
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
