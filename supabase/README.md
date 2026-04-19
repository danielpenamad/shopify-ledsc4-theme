# Supabase — LedsC4 B2B companion infra

Infraestructura mínima para cubrir W4 (re-evaluación de whitelist cada 30 min),
que Shopify Flow no puede hacer porque su Run code está en sandbox puro (sin
`fetch`, sin `shopify.graphql`, sin async). Ver memoria
`shopify-flow-schema.md`.

## Qué hay aquí

- **`functions/promote-whitelist-matches/`**: edge function TypeScript que
  consulta Shopify, filtra pendientes cuyo email está en la whitelist, y les
  añade el tag `aprobado`. Eso dispara W2 en Flow (fecha_aprobacion + emails).
- **`migrations/20260419120000_setup_cron.sql`**: helper SQL + schedule cron
  cada 30 min usando `pg_cron` + `pg_net`.
- **`config.toml`**: `verify_jwt = false` para que pg_cron pueda invocar la
  función sin JWT.

No hay tablas. La función no persiste nada — Shopify es la fuente de verdad.

## Setup en un proyecto nuevo (migración al cliente)

10 minutos desde cero.

### 1. Crear el proyecto en Supabase

En la cuenta destino, **New project**. Guarda el `project-ref` (la cadena
alfanumérica en la URL del dashboard).

### 2. Linkear el repo al proyecto

```bash
cd supabase/
supabase link --project-ref <project-ref>
```

### 3. Setear secrets

Dashboard → **Project Settings → Edge Functions → Secrets**. Añade:

| Nombre | Valor |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | `<tienda>.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | `shpat_...` (custom app con scopes read/write customers + read shop metafields) |
| `SHOPIFY_API_VERSION` | `2025-10` |

Alternativa CLI: `supabase secrets set NAME=value`.

### 4. Aplicar migraciones

```bash
supabase db push
```

Esto habilita `pg_cron` + `pg_net`, crea `private.invoke_edge_function()`, y
programa el cron.

### 5. Setear la URL base del proyecto

La migración inserta un seed en `private.config` con la URL del proyecto origen.
Tras migrar al proyecto del cliente, actualízala:

```sql
update private.config set value = 'https://<client-project-ref>.supabase.co'
where key = 'supabase_url';
```

(Usamos una tabla `private.config` en vez de `ALTER DATABASE SET app.*` porque
Supabase bloquea esos GUCs con el rol del MCP.)

### 6. Deploy de la edge function

```bash
supabase functions deploy promote-whitelist-matches
```

### 7. Verificar

Manualmente (sin esperar 30 min), invoca la función:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches
```

Respuesta esperada con whitelist vacía:
```json
{ "startedAt": "...", "promoted": 0, "reason": "empty_whitelist" }
```

Con whitelist poblada pero sin matches:
```json
{ "startedAt": "...", "promoted": 0, "totalPending": 3, "whitelistSize": 2, ... }
```

Con matches reales: el promoted > 0 y los tags de los customers afectados
deberían tener `aprobado` a los pocos segundos (Shopify admin).

## Observabilidad

- `cron.job_run_details` en Postgres registra cada ejecución del cron (éxito/fallo, output del http_post).
- `supabase functions logs promote-whitelist-matches` enseña logs de la edge function.

## Seguridad — nota para producción

En Fase B la función es **abierta** (`verify_jwt = false`, sin header de auth). Antes
de producción, añadir:
1. Un secret `CRON_SECRET` nuevo.
2. En el handler: rechazar request si `X-Cron-Secret` header no coincide.
3. En la migración: setear `app.cron_secret` y pasar el header desde `pg_net`.

Cambio localizado (un archivo + una migración), ~15 min.

## Por qué Supabase y no otro

- `pg_cron` + `pg_net` cubren cron + HTTP desde Postgres sin infra extra.
- Edge Functions TypeScript/Deno cubren la lógica sin necesidad de VM/servicio.
- MCP oficial → el dev puede desplegar e inspeccionar sin abrir el dashboard.
- Free tier sobra (la función tardará <2s y corre 48 veces al día).
