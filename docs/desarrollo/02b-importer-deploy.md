# 02b · Importer — despliegue y operación

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Documenta el **despliegue y la operación** del importador descrito en [02-importer](02-importer.md). Cubre:

- Las 3 piezas que ejecutan el pipeline en producción (pg_cron, edge function `sftp-sync`, workflow GHA `ledsc4-import`).
- Cómo se encadenan (repository_dispatch event).
- El schema de `private.import_runs` y sus estados.
- El cron schedule en Supabase.
- Las migrations Postgres aplicadas.
- Cómo monitorizar runs y cómo intervenir cuando algo va mal.

No cubre:

- Qué hace el importador (parse / map / write / report) → [02-importer](02-importer.md).
- Inventario de secrets de la organización → [14-secrets](14-secrets.md).
- Edge functions no-importer (`register-b2b-customer`, `submit-order-request`, etc.) → docs correspondientes del eje.

Decisión arquitectónica: [D12](adrs/d12-pipeline-split.md) — split entre la edge function (que descarga del SFTP y guarda en Storage) y el workflow GHA (que ejecuta el writer real contra Shopify).

## 1. Topología

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Supabase (Postgres + Edge Runtime)                │
│                                                                              │
│   pg_cron        triggers @ 01:00/02:00/07:00/13:00/19:00 UTC                │
│       │                                                                      │
│       ▼                                                                      │
│   private.invoke_edge_function('sftp-sync', '{"kind":"stock_only|full"}',   │
│                                  with_auth=true)                             │
│       │                                                                      │
│       │  pg_net POST                                                         │
│       ▼                                                                      │
│   Edge function sftp-sync                                                    │
│       1. INSERT private.import_runs (status='started')                       │
│       2. Connect SFTP, validate host key                                     │
│       3. Download CSVs to memory → Upload to Storage                         │
│       4. UPDATE row (status='downloaded', files=[...])                       │
│       5. POST repository_dispatch a GitHub  ─────────────┐                   │
│       6. Response { run_id, dispatch_status, ... }       │                   │
└──────────────────────────────────────────────────────────│───────────────────┘
                                                           │
                                                           │
┌──────────────────────────────────────────────────────────▼───────────────────┐
│                            GitHub Actions                                    │
│                                                                              │
│   Workflow ledsc4-import.yml                                                 │
│       trigger: repository_dispatch (event_type=ledsc4-import)                │
│                + workflow_dispatch (manual, mismo run_id)                    │
│                                                                              │
│       1. Fetch run metadata (kind, files, storage_prefix)                    │
│       2. Download files de Storage a ./tmp/inputs                            │
│       3. UPDATE row (status='processing')                                    │
│       4. Run writer (runFullImport o runStockOnly contra Shopify Admin API)  │
│       5. Upload reports a Storage runs/<id>/reports/                         │
│       6. Close row (status='completed' o 'failed' según writer-result.json)  │
└──────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                            Shopify (productos publicados/actualizados)
```

## 2. Edge function `sftp-sync` (Job 1)

Source: `supabase/functions/sftp-sync/index.ts`.

### Responsabilidad

Descargar los CSVs desde el SFTP del cliente y guardarlos en Supabase Storage. **No habla con Shopify**.

### Configuración

| Atributo | Valor |
|---|---|
| `verify_jwt` | `true` (default). pg_cron pasa el anon key como Bearer. |
| Trigger | POST con body JSON. |
| Body | `{ "kind": "full" }` o `{ "kind": "stock_only" }`. Default: `full`. |
| Storage bucket | `ledsc4-imports`. |
| Storage prefix | `runs/<uuid>/` (un prefix por run). |

### Flujo interno

1. **Parse payload + validate secrets**. Si falta `GITHUB_DISPATCH_TOKEN` falla antes de cualquier side effect.
2. **INSERT `private.import_runs`** con `status='started'`, devuelve `run_id` (UUID).
3. **UPDATE** del mismo row con `storage_prefix='runs/<run_id>/'` inmediatamente — visible aunque pasos siguientes fallen.
4. **Parse host key** desde `LEDSC4_SFTP_HOST_KEY` (formato known_hosts: `host type base64`).
5. **Connect SFTP** con `hostVerifier` byte-a-byte. Distingue fallo de host key vs auth vs connect en el `error_stage`.
6. **List + download + upload loop** por cada subdirectorio (`productos/`, `stock/`, `precios/` según `kind`):
   - Skip de directorios y archivos no-`.csv` (flag en `error_message` como informativo).
   - Buffer en memoria (Edge Runtime blocklist `Deno.lstatSync` que necesita `fastGet`).
   - Validate non-empty: zero-byte aborta el run entero.
   - Upload a Storage con `upsert: false` (cada run tiene prefix único; colisión = bug).
7. **UPDATE `import_runs`** con `status='downloaded'`, `downloaded_at`, `files=[...]`.
8. **POST `repository_dispatch`** a GitHub (`event_type=ledsc4-import`, `client_payload={run_id}`). **Best-effort** — si falla, el row queda en `downloaded` y el operador puede re-disparar con `workflow_dispatch` manualmente.
9. **Return JSON** con `run_id`, `dispatch_status`, `files_count`, `elapsed_ms`.

### Aislamiento de DB

`import_runs` vive en el schema `private`, **no expuesto** por PostgREST. La edge usa conexión directa Postgres vía `npm:postgres@3.4.4` con `SUPABASE_DB_URL`. Storage sí va por supabase-js (Storage API no está gated por db-schemas).

### Estados de salida (HTTP)

| HTTP | Cuándo |
|---|---|
| 200 | `status: ok` — run en `downloaded`, files subidos, dispatch ok o no. |
| 200 | `status: ok` pero `dispatch_status: failed` — download OK, dispatch a GHA falló (fallback manual). |
| 400 | `invalid_payload` (kind inválido). |
| 500 | `secret_load` (secrets faltan, incluido `GITHUB_DISPATCH_TOKEN`). |
| 502 | `host_key` / `auth` / `sftp_connect` / `sftp_list` / `sftp_download` / `storage_upload` / `db_*` — row marcado `failed` con `error_stage` correspondiente. |

## 3. Workflow `ledsc4-import.yml` (Job 2)

Source: `.github/workflows/ledsc4-import.yml`.

### Responsabilidad

Procesar un row de `private.import_runs` que ya está en `status='downloaded'`. **No habla con SFTP**. Habla con Storage (descarga los CSVs ya pre-bajados), Postgres (`import_runs` + `sku_state`) y Shopify Admin API.

### Triggers

| Trigger | Quién lo dispara | Payload |
|---|---|---|
| `repository_dispatch` | `sftp-sync` paso 8 | `event_type=ledsc4-import`, `client_payload={run_id}`. `kind` se resuelve desde `import_runs`. |
| `workflow_dispatch` | Manual (UI o `gh workflow run`) | `inputs.run_id` (required) + `inputs.kind_override` (optional choice: `''`/`full`/`stock_only`). |

**`kind_override` solo viaja por `workflow_dispatch`**. En `repository_dispatch` el `kind` se lee del row.

### Pasos

| # | Step | Qué hace |
|---|---|---|
| 0 | `checkout`, `setup-node@v4` (Node 20), `npm install` | Sin `cache: npm` ni `npm ci` — el repo ignora `package-lock.json` por política Shopify theme. |
| 1 | `Setup tmp dirs` | `mkdir -p tmp/inputs tmp/reports`. |
| 2 | `Fetch run metadata` | Lee la row con `SUPABASE_DB_URL` directo. **Strict guard**: solo procesa rows en `status='downloaded'`. Cualquier otro estado (`processing`, `completed`, `failed`) → bail. |
| 3 | `Download files from Storage` | Reproduce localmente la jerarquía `productos/stock/precios` desde el JSON `files` del row, en `./tmp/inputs/`. |
| 4 | `Mark run as processing` | UPDATE condicional `where status = 'downloaded'`. Si afecta 0 rows → carrera con otro disparo concurrente, bail. |
| 5 | `Run writer` | Importa `runFullImport` o `runStockOnly` de `scripts/import-write.mjs` con `dbConnection` abierta + `applyMode: true`. Captura stdout/stderr a `tmp/reports/run.log`. Si falla, escribe `tmp/writer-result.json` con `{ ok: false, stage: 'writer', message }`. |
| 6 | `Upload reports to Storage` (`if: always()`) | Sube recursivamente todo `tmp/reports/*` a `ledsc4-imports/runs/<id>/reports/`. Content-types correctos según extensión. |
| 7 | `Close import_runs row` (`if: always()`) | Lee `tmp/writer-result.json` y actualiza el row condicionalmente (`where status = 'processing'`). |

### Cierre del row (paso 7)

Tres caminos en función del estado de `writer-result.json`:

| Estado | UPDATE aplicado | Razón |
|---|---|---|
| `ok: true` | `status='completed', completed_at=now(), counts, report_storage_prefix` | Run exitoso. |
| `ok: false, stage='writer'` | `status='failed', failed_at=now(), error_stage='writer', error_message, report_storage_prefix, counts` | Fallo del writer en sí — el row ya estaba en `processing`. |
| `ok: false, stage='fetch_metadata' \| 'download' \| 'mark_processing'` | **No toca el row** | Fallo pre-writer — el row sigue en su estado original (`downloaded`). El operador puede re-disparar `workflow_dispatch` con el mismo `run_id`. |

El `where status = 'processing'` evita pisar rows que ya cambió otra ejecución concurrente. Si afecta 0 rows, log `warn` pero no falla el workflow (la operación ya hizo lo que tenía que hacer).

### Variables env del job

| Env | Source | Para qué |
|---|---|---|
| `RUN_ID` | `inputs.run_id` ∥ `event.client_payload.run_id` | UUID del row. Exactamente uno de los dos está set por invocación. |
| `KIND_OVERRIDE` | `inputs.kind_override` ∥ `''` | Solo vía `workflow_dispatch`. |
| `SUPABASE_URL` | `secrets.SUPABASE_URL` | Para Storage. |
| `SUPABASE_SERVICE_ROLE_KEY` | `secrets.SUPABASE_SERVICE_ROLE_KEY` | Bearer para Storage API. |
| `SUPABASE_DB_URL` | `secrets.SUPABASE_DB_URL` | Postgres directo (private schema). |
| `SHOPIFY_STORE_DOMAIN` | `secrets.SHOPIFY_SHOP` | Admin API. |
| `SHOPIFY_ADMIN_TOKEN` | `secrets.SHOPIFY_ADMIN_TOKEN` | Admin API. |
| `STORAGE_BUCKET` | hardcoded `ledsc4-imports` | — |
| `REPORT_PREFIX` | computed: `runs/<run_id>/reports/` | Path de destino de reports en Storage. |

### Timeout y permisos

| Atributo | Valor |
|---|---|
| `timeout-minutes` | 60. Si el writer tarda más, hay un problema (full run típico: ~12 min). |
| `permissions.contents` | `read`. El workflow no necesita escribir nada al repo. |

## 4. Schema `private.import_runs`

Migrations relevantes (en orden cronológico):

| Migration | Aporta |
|---|---|
| `20260507120000_import_runs.sql` | Tabla base con `id, kind, status, started_at, downloaded_at, completed_at, failed_at, files`. |
| `20260507130000_import_runs_to_private.sql` | Mueve la tabla del schema público a `private`. |
| `20260507160000_import_runs_counts_and_report_prefix.sql` | Añade `counts jsonb`, `report_storage_prefix text`, `error_stage text`, `error_message text`, `storage_prefix text`. |

### Columnas

| Columna | Tipo | Cuándo se rellena |
|---|---|---|
| `id` | uuid PK | INSERT inicial por `sftp-sync`. |
| `kind` | text (`full` ∥ `stock_only`) | INSERT inicial. |
| `status` | text | Cambios documentados abajo. |
| `started_at` | timestamptz default `now()` | INSERT inicial. |
| `storage_prefix` | text | Tras INSERT, por `sftp-sync` paso 3. |
| `downloaded_at` | timestamptz | `sftp-sync` paso 7. |
| `files` | jsonb | `sftp-sync` paso 7. Array de `{ name, path_in_storage, size_bytes, sftp_mtime }`. |
| `completed_at` | timestamptz | GHA paso 7, rama `ok`. |
| `failed_at` | timestamptz | GHA paso 7, rama `failed` o `sftp-sync` rama de error. |
| `error_stage` | text | Stage que falló. Vocabulario abajo. |
| `error_message` | text | Mensaje del error o nota informativa (flagged_unexpected_entries). |
| `counts` | jsonb | GHA paso 7, rama `ok` o `failed`. Buckets del writer (ok/warn/failed/hidden/unpublished_orphans/...). |
| `report_storage_prefix` | text | GHA paso 7. `runs/<id>/reports/`. |

### Estados (FSM)

```
                  INSERT
                    │
                    ▼
            ┌──────────────┐
            │   started    │  ← sftp-sync 1
            └──────┬───────┘
                   │ download + upload OK
                   ▼
            ┌──────────────┐
            │  downloaded  │  ← sftp-sync 7
            └──────┬───────┘
                   │ GHA mark processing (paso 3)
                   ▼
            ┌──────────────┐
            │  processing  │  ← GHA 4
            └──────┬───────┘
                   │
         ┌─────────┴──────────┐
         │                    │
         ▼                    ▼
   ┌───────────┐       ┌─────────┐
   │ completed │       │ failed  │
   └───────────┘       └─────────┘
```

Adicionalmente, **`failed`** es un estado terminal alcanzable desde `started` (fallos de sftp-sync) y desde `processing` (fallos del writer en GHA). El campo `error_stage` discrimina:

| `error_stage` | De dónde |
|---|---|
| `secret_load` / `host_key` / `auth` / `sftp_connect` / `sftp_list` / `sftp_download` / `storage_upload` / `db_insert` / `db_update` | `sftp-sync`. |
| `fetch_metadata` / `download` / `mark_processing` / `writer` / `upload_reports` | GHA workflow. |

### Re-runs

**No se re-ejecuta una row existente**. Para repetir un run hay que generar un `run_id` nuevo invocando `sftp-sync` otra vez. El strict guard del workflow (`only status='downloaded'`) lo hace cumplir.

Excepción: si el workflow falla en `fetch_metadata` / `download` / `mark_processing` (pre-writer), el row sigue en `downloaded` y `workflow_dispatch` manual con el mismo `run_id` lo retoma.

## 5. Schedule pg_cron

Migration: `20260509120200_setup_cron_sftp_sync.sql`. Define 5 cron jobs idempotentes (con `cron.unschedule` previo en bloque `DO/EXCEPTION`).

| jobname | Schedule (UTC) | kind | Madrid CET (invierno) | Madrid CEST (verano) |
|---|---|---|---|---|
| `sftp-sync-stock-01h` | `0 1 * * *` | `stock_only` | 02:00 | 03:00 |
| `sftp-sync-full-02h` | `0 2 * * *` | `full` | 03:00 | 04:00 |
| `sftp-sync-stock-07h` | `0 7 * * *` | `stock_only` | 08:00 | 09:00 |
| `sftp-sync-stock-13h` | `0 13 * * *` | `stock_only` | 13:00 | 14:00 |
| `sftp-sync-stock-19h` | `0 19 * * *` | `stock_only` | 19:00 | 20:00 |

Cada job ejecuta:

```sql
SELECT private.invoke_edge_function('sftp-sync', '{"kind":"<kind>"}'::jsonb, true);
```

El tercer parámetro `with_auth=true` indica que `invoke_edge_function` debe leer `supabase_anon_key` de `private.config` e inyectarlo como `Authorization: Bearer <key>` (porque la edge tiene `verify_jwt=true`).

### Por qué este orden

- `stock_only` a las 01h **antes** del `full` a las 02h: para tener stock fresco previo al run completo de la noche. Si el cliente actualiza precios en la nocturna (terminando ~01:30 local), el `full` de las 02:00 UTC lo recoge.
- `stock_only` cada 6h durante el día: actualiza inventario mientras el surtido y los precios siguen estables hasta la siguiente nocturna del cliente.
- DST: la hora local se desplaza ±1h sin afectar el orden de operaciones (el `full` sigue siendo justo después del primer `stock_only` del día).

## 6. Anon key en `private.config`

Migration: `20260509120000_seed_anon_key.sql`.

`pg_cron` necesita inyectar un Bearer al invocar la edge function. La key se guarda en `private.config(key='supabase_anon_key', value='<key>')` y `private.invoke_edge_function` la lee si el flag `with_auth=true`.

### Pasos manuales post-aplicación de migrations

```sql
-- 1. Update con la anon key real (Supabase Project Settings → API → anon public).
UPDATE private.config
SET value = '<paste anon key here>'
WHERE key = 'supabase_anon_key';

-- 2. Verificar que el cron está activo.
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname LIKE 'sftp-sync-%'
ORDER BY jobname;

-- 3. Disparar uno a mano para validar auth.
SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true);
-- Devuelve un bigint (request_id de pg_net) sin RAISE.
```

### Por qué plain text y no Vault

La anon key es **publicable por diseño**: viene incrustada en cualquier bundle de frontend que use el cliente Supabase. No es un secreto. Pasa el gate `verify_jwt` del Edge Runtime pero por sí sola no puede leer datos protegidos por RLS. Guardarla en `private.config` mantiene la coherencia con el patrón existente (`supabase_url`, `catalog_id`, etc.) y evita el overhead de Vault para una key no-secreta.

`sftp-sync` mantiene `verify_jwt = true` para que la URL pública siga rechazando requests sin JWT alguno.

## 7. Secrets requeridos

Inventario completo en [14-secrets](14-secrets.md). Resumen específico del importer:

### Supabase Edge Function (`sftp-sync`)

| Secret | Origen |
|---|---|
| `LEDSC4_SFTP_HOST` | Cliente |
| `LEDSC4_SFTP_PORT` | Cliente (típicamente 22) |
| `LEDSC4_SFTP_USER` | Cliente |
| `LEDSC4_SFTP_PASSWORD` | Cliente |
| `LEDSC4_SFTP_BASE_PATH` | Cliente (p. ej. `/ledsc4/exports`) |
| `LEDSC4_SFTP_HOST_KEY` | Validado con `sftp-probe` antes de poner aquí. Formato known_hosts. |
| `GITHUB_DISPATCH_TOKEN` | Fine-grained PAT scoped al repo `danielpenamad/shopify-ledsc4-theme` con permiso `Actions: read+write`. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL` | Auto-inyectados por Edge Runtime. |

### GitHub Actions repo secrets

| Secret | Para qué |
|---|---|
| `SUPABASE_URL` | Storage API. |
| `SUPABASE_SERVICE_ROLE_KEY` | Bearer para Storage. |
| `SUPABASE_DB_URL` | Postgres directo para `import_runs` + `sku_state`. |
| `SHOPIFY_SHOP` | `<shop>.myshopify.com` (domain). |
| `SHOPIFY_ADMIN_TOKEN` | Scopes: `read_customers, write_customers, read_products, write_products, read_inventory, write_inventory, read_translations, write_translations, read_files, write_files, read_publications, write_publications`. |

### Acuerdo de naming

`SHOPIFY_SHOP` (en repo secret) ↔ `SHOPIFY_STORE_DOMAIN` (en env del job). El workflow hace el mapeo en `env:` del job. **No renombrar uno sin el otro** o el writer no encuentra el dominio.

## 8. Cómo monitorizar runs

### SQL queries útiles

```sql
-- Últimas 20 ejecuciones de cualquier cron sftp-sync, con outcome al
-- nivel de cron (NO al nivel de writer — el cron solo sabe si invoke fue OK).
SELECT j.jobname, r.start_time, r.end_time, r.status, r.return_message
FROM cron.job_run_details r
JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname LIKE 'sftp-sync-%'
ORDER BY r.start_time DESC
LIMIT 20;

-- Estado real de cada run (la fuente de verdad).
SELECT id, kind, status, started_at, downloaded_at, completed_at, failed_at,
       error_stage, error_message
FROM private.import_runs
WHERE started_at >= now() - interval '24 hours'
ORDER BY started_at DESC;

-- Counts del writer para runs completed.
SELECT id, kind, completed_at, counts
FROM private.import_runs
WHERE status = 'completed' AND completed_at >= now() - interval '7 days'
ORDER BY completed_at DESC;

-- Runs colgados (sin transición desde processing en > 1h).
SELECT id, kind, started_at, downloaded_at
FROM private.import_runs
WHERE status = 'processing'
  AND started_at < now() - interval '1 hour';
```

### Reglas de interpretación

- `cron.job_run_details.status = 'succeeded'` significa que la query que invoca a `pg_net` devolvió OK. **No garantiza** que la edge function haya terminado bien (es asíncrona).
- El estado real está en `private.import_runs.status` (debe llegar a `completed`).
- La `return_message` del cron solo refleja errores SQL del invoke (p. ej. `supabase_anon_key no configurado`), no errores de la edge.

### Reports en Storage

Los CSVs generados por el writer viven en `ledsc4-imports/runs/<run_id>/reports/`. Accesibles vía Supabase Studio o:

```bash
# Listar reports de un run específico
curl -H "Authorization: Bearer $SERVICE_ROLE" \
  "https://<project>.supabase.co/storage/v1/object/list/ledsc4-imports" \
  -d '{"prefix":"runs/<run_id>/reports/"}'
```

## 9. Cómo intervenir

### Pausar todos los crons (sin borrarlos)

```sql
UPDATE cron.job SET active = false WHERE jobname LIKE 'sftp-sync-%';
```

Reactivar:

```sql
UPDATE cron.job SET active = true WHERE jobname LIKE 'sftp-sync-%';
```

### Borrar un cron concreto (irreversible — requiere re-aplicar migration)

```sql
SELECT cron.unschedule('sftp-sync-stock-13h');
```

### Re-disparar un run colgado en `downloaded` (dispatch falló)

```bash
gh workflow run ledsc4-import.yml \
  -f run_id=<uuid> \
  --repo danielpenamad/shopify-ledsc4-theme
```

O desde la UI: Actions → "LedsC4 import — writer" → Run workflow → pegar `run_id`.

### Re-disparar tras fallo pre-writer (status sigue en `downloaded`)

Mismo comando. El strict guard pasa porque el row sigue en `downloaded`.

### Re-procesar un run que ya está en `completed` o `failed`

**No se puede directamente** — el strict guard del workflow rechaza cualquier `status` que no sea `downloaded`. Hay que generar una nueva ejecución completa:

```bash
# Manual desde Supabase Studio (SQL Editor):
SELECT private.invoke_edge_function('sftp-sync', '{"kind":"full"}'::jsonb, true);
```

Esto re-descarga el SFTP, crea un row nuevo y dispara el workflow. **No se puede re-ejecutar contra los mismos CSVs ya en Storage** sin nueva descarga.

### Resetear un run colgado en `processing`

Si el workflow se cayó sin escribir el row (cancelación, runner muerto, etc.), el row queda en `processing` indefinidamente:

```sql
UPDATE private.import_runs
SET status = 'failed',
    failed_at = now(),
    error_stage = 'manual_reset',
    error_message = 'Workflow killed without writing result'
WHERE id = '<uuid>' AND status = 'processing';
```

Luego, si conviene, lanzar `sftp-sync` de nuevo.

## 10. Migrations cronológicas

| Migration | Fecha | Aporta |
|---|---|---|
| `20260419120000_setup_cron.sql` | 19-abr-2026 | Setup de pg_cron + `private.invoke_edge_function` inicial. |
| `20260507120000_import_runs.sql` | 7-may-2026 | Tabla `import_runs` base. |
| `20260507130000_import_runs_to_private.sql` | 7-may-2026 | Mueve `import_runs` al schema `private`. |
| `20260507140000_sku_state.sql` | 7-may-2026 | Tabla `private.sku_state` (idempotencia + unpublish orphans). |
| `20260507150000_sku_state_stock_columns.sql` | 7-may-2026 | Añade columnas para stock-only state. |
| `20260507160000_import_runs_counts_and_report_prefix.sql` | 7-may-2026 | Añade `counts`, `report_storage_prefix`, `error_*` a `import_runs`. |
| `20260509120000_seed_anon_key.sql` | 9-may-2026 | INSERT placeholder `supabase_anon_key='REPLACE_ME_AFTER_MERGE'` en `private.config`. |
| `20260509120100_invoke_edge_function_auth.sql` | 9-may-2026 | Extiende `private.invoke_edge_function` con `with_auth boolean default false`. Hard-fail si la key falta o es el placeholder. |
| `20260509120200_setup_cron_sftp_sync.sql` | 9-may-2026 | Los 5 cron jobs `sftp-sync-*` con `with_auth=true`. |
| `20260510120000_image_cache.sql` | 10-may-2026 | Tabla `private.image_cache` para deduplicar uploads a Shopify Files. |

## 11. Gotchas operativos

### Falla silenciosa si `GITHUB_DISPATCH_TOKEN` no está

La edge function `sftp-sync` la valida al inicio y hard-fails antes de cualquier side effect. Pero si alguien la quita después de que el deploy esté funcionando, **los runs quedan colgados en `downloaded`** indefinidamente. El response 502 lo dice pero hay que mirar la respuesta del cron — no hay alerta automática hoy.

Mitigación: query SQL en §8 (`runs colgados`) puesta en un dashboard.

### `repository_dispatch` no soporta `kind`

Por convención (D5 de PR-A2): `client_payload` solo lleva `run_id`. El `kind` se resuelve desde el row. Si en el futuro hace falta otro parámetro de control para el workflow, **NO añadirlo al `client_payload`** — añadirlo a `import_runs` y leerlo desde el row.

### Strict guard bloquea reruns

Es intencional. Si fallaste y quieres reintentar, **genera un run nuevo** invocando `sftp-sync` de cero. La única excepción es fallo pre-writer en GHA — ahí el row sigue en `downloaded` y se puede re-disparar con el mismo `run_id`.

### `workflow_dispatch` y `repository_dispatch` populan envs distintos

El workflow usa `inputs.run_id || github.event.client_payload.run_id`. Exactamente uno está set por invocación. Si en el futuro alguien añade un tercer trigger (p. ej. `schedule:`), tendrá que extender el `||` chain — no es automático.

### El workflow no cachea `node_modules`

El repo ignora `package-lock.json` por política de Shopify theme. Sin lockfile no se puede usar `cache: npm` ni `npm ci`. El `npm install` corre limpio en cada job (~30-40 s extra). **No reintroducir lockfile ni cache sin antes cambiar esa política** — afectaría a Shopify CLI que también lee el repo.

### Reports siempre se suben (`if: always()`)

Aunque el writer falle, el step 6 (`Upload reports to Storage`) corre. Esto es deliberado — los reports parciales son útiles para debugging. Si no hay reports (el writer falló antes de generar), el step termina con `no tmp/reports dir; nothing to upload` y sigue.

## 12. Pendientes y deuda

- **Alertas automáticas para runs colgados** (`processing` > 1h, `downloaded` > 1h sin dispatch). Hoy detección manual vía SQL.
- **Rotación de reports en Storage**. No hay política de eviction. Cada run deja CSVs en `runs/<id>/reports/`; tras 90 días se podrían archivar/borrar.
- **`workflow_dispatch` con reruns**: añadir un flag `force` que salte el strict guard para casos legítimos de reruns sobre el mismo `run_id`. Bajo riesgo de pisar runs en flight; no urgente.
- **Multi-environment para el dispatch**: hoy la URL `GITHUB_DISPATCHES_URL` está hardcoded. Si en Fase 2 hace falta sandbox vs cliente, parametrizar.
- **Migration `seed_anon_key` requiere paso manual** post-deploy (UPDATE con la key real). Documentado pero fácil de olvidar — candidato a script post-deploy.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
