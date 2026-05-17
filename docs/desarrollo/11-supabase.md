# 11 · Proyecto Supabase

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

El portal B2B Outlet usa un proyecto Supabase como capa de infraestructura que cubre todo lo que Shopify no puede hacer por sí mismo: edge functions que orquestan llamadas a la Admin API, una base de datos Postgres para estado operacional del importer, cron jobs, y un bucket de Storage para el staging de imports.

Este doc es el **mapa de referencia arquitectónica** del proyecto Supabase: qué componentes hay, qué hace cada uno, cómo se relacionan, y dónde está la fuente de verdad de cada cosa. No es la guía de setup paso a paso — eso vive en `supabase/README.md`, que este doc complementa y al que remite para procedimientos operativos.

Cobertura cruzada con otros docs del eje:
- Las edge functions individuales se documentan en el doc de su dominio: `register-b2b-customer` en 05-registro-b2b, las 4 de backoffice en 06-backoffice, `submit-order-request` y `list-order-requests` en 07-solicitudes-pedido, `sftp-sync` en 02b-importer-deploy, `create-company-for-customer` y `promote-whitelist-matches` en el contexto de los workflows (08, 04).
- El pipeline del importer (parse/map/write) se documenta en 02-importer y 02b-importer-deploy.
- Los secrets se inventarían en 14-secrets (cuando exista).

Aquí se da la vista de conjunto: el proyecto Supabase como una pieza, no las piezas sueltas.

Lectores principales: cualquier dev o IA que necesite entender la topología de la infra Supabase antes de tocar una función, debugear un cron, o migrar el proyecto a la cuenta del cliente.

## 2. Por qué Supabase

Shopify Flow tiene un sandbox de `Run code` muy limitado: sin `async`, sin `fetch`, sin acceso a `shopify.graphql` más allá de lo que el trigger expone. Cualquier lógica que necesite llamar a la Admin API con GraphQL completo, encadenar varias llamadas, procesar webhooks con verificación HMAC, o mantener estado entre ejecuciones, no cabe en Flow.

Supabase aporta cuatro capacidades que el theme y Flow no tienen:

| Capacidad | Para qué se usa |
| --- | --- |
| Edge functions (Deno) | Orquestación de Admin API con GraphQL completo, verificación HMAC, lógica de negocio que el storefront JS o Flow invocan por HTTP |
| Postgres | Estado operacional del importer (FSM de runs, fingerprint cache, image cache), config key/value del proyecto |
| pg_cron | Disparar trabajos periódicos (re-evaluación de whitelist, sync SFTP) sin un scheduler externo |
| Storage | Staging de los CSV descargados del SFTP del proveedor antes de procesarlos |

El proyecto Supabase es "companion infra": no es el producto, es el andamiaje que sostiene las partes del portal B2B que Shopify no resuelve nativamente.

## 3. Topología del proyecto

```
supabase/
  config.toml                  Config del proyecto. verify_jwt por función. SoT del flag.
  .env.example                 Plantilla de secrets a setear.
  README.md                    Guía de setup operativa (este doc remite a ella).
  functions/                   10 edge functions (ver §4).
  migrations/                  10 migrations SQL (ver §7).
  .temp/                       Artefactos del CLI. No versionar contenido relevante.
```

`project_id` en `config.toml`: `mbjvmhaglbhnxoccwyex` — es el proyecto de **desarrollo**. Al migrar a la cuenta del cliente cambia el `project_id` y el `project-ref` de todas las URLs. El procedimiento de migración está en `supabase/README.md §Setup en un proyecto nuevo`.

## 4. Edge functions

**Hay 10 edge functions.** `config.toml` es la fuente de verdad del inventario — declara las 10. El inventario completo con URLs, secrets requeridos por función y respuestas está en `supabase/README.md §Funciones`; este doc da la vista agrupada con cross-links al doc de dominio de cada una.

Agrupadas por fase y trigger:

### Registro y aprobación (Fase B2B + BO)

| Función | Trigger | Auth | Doc detallado |
| --- | --- | --- | --- |
| `register-b2b-customer` | Storefront JS (form `/pages/acceso-profesional#registro`) | HMAC `<timestamp>:<nonce>`, TTL 5 min | 05-registro-b2b |
| `create-company-for-customer` | Shopify Flow `Send HTTP request` (W1 rama auto-aprobado, W2) | Header `X-Webhook-Secret` | 04, contexto W1/W2 |
| `promote-whitelist-matches` | pg_cron cada 30 min | Ninguna (URL no pública, cron interno) | 04, contexto W4 |

### Backoffice (Fase BO)

Las 4 sirven la página `/pages/admin-backoffice`. Auth común: HMAC del `approver.id` firmado por Liquid SSR con `settings.backoffice_hmac_secret`, más verificación server-side del tag `backoffice` en cada request (`assertBackofficeTag`). El `{% if %}` del page template es solo UX — la seguridad real vive en cada handler.

| Función | Qué hace | Doc detallado |
| --- | --- | --- |
| `list-pending-customers` | Lista customers pendientes + counts. La invoca el JS al cargar y tras cada acción | 06-backoffice |
| `update-whitelist` | Edita el shop metafield `b2b.whitelist_emails` y dispara `promote-whitelist-matches` | 06-backoffice |
| `approve-customer` | Cambia tags atómicamente `pendiente`→`aprobado` (dispara W2) | 06-backoffice |
| `reject-customer` | Setea motivo + `fecha_rechazo` antes del cambio de tag (para que W3 envíe el email con motivo), luego `pendiente`→`rechazado` | 06-backoffice |

### Solicitudes de pedido (Fase D)

| Función | Trigger | Auth | Doc detallado |
| --- | --- | --- | --- |
| `submit-order-request` | Storefront JS (`/pages/solicitud`) | HMAC `customerId:timestamp`, TTL 600s | 07-solicitudes-pedido |
| `list-order-requests` | Storefront JS (`/pages/mis-solicitudes`, `/pages/solicitud-detalle`) | Mismo HMAC que submit | 07-solicitudes-pedido |

### Importer (Fase I4)

| Función | Trigger | Auth | Doc detallado |
| --- | --- | --- | --- |
| `sftp-sync` | pg_cron (5 jobs) o manual | **`verify_jwt = true`** | 02b-importer-deploy |

`sftp-sync` es la única función del proyecto con `verify_jwt = true`. Descarga los CSV del SFTP del proveedor a Storage y crea la row de tracking en `private.import_runs`. Como no debe ser invocable públicamente, exige el JWT — y por eso el cron pasa `with_auth = true` a `invoke_edge_function` (ver §6).

### El patrón `verify_jwt = false` y sus implicaciones

9 de las 10 funciones declaran `verify_jwt = false` en `config.toml`. Motivo: el Supabase Gateway, por defecto, exige header `Authorization: Bearer <anon_jwt>` y rechaza con **HTTP 401 antes de ejecutar la función** si no llega. Las 9 funciones se invocan sin ese header (storefront JS, Flow webhook, pg_cron sin auth), así que se desactiva el chequeo de gateway y **cada función valida su propia auth internamente** (HMAC, `X-Webhook-Secret`, o nada en el caso de `promote-whitelist-matches`).

Consecuencia crítica de operación: **cualquier `supabase functions deploy` lee `config.toml` y sobrescribe lo que el dashboard pueda tener configurado manualmente**. La fuente de verdad del flag `verify_jwt` es el fichero, no el dashboard. Si una función pierde su `verify_jwt = false` del fichero, el siguiente deploy la romperá con 401 a nivel gateway. Detalle en `supabase/README.md §verify_jwt y deploy`.

## 5. Base de datos

### Schemas

El proyecto usa dos schemas relevantes:

- **`public`** — vacío de tablas operacionales del portal. PostgREST lo expone vía la anon key, así que **no se pone aquí nada que no deba ser legible por cualquiera con la anon key** (que es pública por diseño — viaja en el bundle del frontend).
- **`private`** — schema fuera del scope de PostgREST. Todas las tablas operacionales viven aquí. `anon` y `authenticated` tienen permisos revocados explícitamente. Solo accesible con service-role key (las edge functions) o desde Supabase Studio si el operador añade `private` a "Exposed schemas".

La migración `20260507130000_import_runs_to_private.sql` movió `import_runs` de `public` a `private` precisamente por esto: estaba expuesta a la anon key sin RLS. La decisión de diseño resultante: **estado operacional va en `private`, no en `public` con RLS**. Se evita la ceremonia de políticas RLS con bypass service-role; si en el futuro alguna tabla necesita ser legible desde el storefront, se añadirá a `public` con RLS restrictiva en ese momento.

### Tablas

Cuatro tablas, todas en `private`:

| Tabla | Propósito | Escrita por | Doc detallado |
| --- | --- | --- | --- |
| `private.config` | Key/value de config del proyecto (`supabase_url`, `supabase_anon_key`) | Migrations + UPDATE manual post-migración | §6 |
| `private.import_runs` | FSM de cada run del importer (`started`→`downloaded`→`processing`→`completed`\|`failed`) | `sftp-sync` + workflow `ledsc4-import.yml` | 02b-importer-deploy |
| `private.sku_state` | Fingerprint cache por SKU para imports incrementales (doble fingerprint: full + stock) | `scripts/import-write.mjs` | 02-importer, D14 |
| `private.image_cache` | Cache sha256→Shopify file_id para el pre-upload de imágenes | Helper de pre-upload del importer | D11 |

Ninguna tiene RLS activa — todas son service-role only. Es el mismo patrón en las cuatro y es deliberado (ver arriba).

Detalles no obvios de cada tabla:

- **`private.config`** sustituye a `ALTER DATABASE SET app.*`, que Supabase bloquea por permisos. Es la única vía de almacenar config a nivel proyecto legible desde funciones SQL `security definer`. `supabase_anon_key` se almacena en texto plano deliberadamente — la anon key es publicable por diseño (ver §6).

- **`private.import_runs`** tiene una FSM explícita con estados terminales `completed`/`failed`. Las columnas `counts` (jsonb) y `report_storage_prefix` se rellenan al cierre del workflow, no durante el run. La row de la primera invocación fallida de `sftp-sync` (bug `lstatSync` de `ssh2-sftp-client`) se borró en una migración de cleanup — es ruido del journey de implementación.

- **`private.sku_state`** lleva **dos fingerprints independientes**: `fingerprint` (runs full — producto + traducciones + publish state) y `fingerprint_stock` (runs stock-only — solo inventario). Decisión documentada en D14. `runStockOnly` hace UPDATE-only: si un SKU nunca pasó por un run full, su row no existe y stock-only loguea warning y hace skip.

- **`private.image_cache`** deduplica por identidad binaria (hash sha256), no por SKU. Dos SKU con la misma imagen comparten un único Shopify File. La cache sobrevive a la descatalogación de SKU. Sin política de evicción todavía — a 455 SKU × ~6 imágenes la tabla se mantiene pequeña.

### Storage

Un bucket: **`ledsc4-imports`** (privado, `public = false`). Es el staging del pipeline de import — `sftp-sync` descarga ahí los CSV del SFTP del proveedor con la service-role key, y el writer (Fase I4.2/workflow) los lee igual. Sin acceso anon ni signed URLs. Convención de rutas: `runs/{import_run_id}/` — cada run tiene su carpeta, y los reports van a `runs/{id}/reports/`.

## 6. Cron y el helper `invoke_edge_function`

### `private.invoke_edge_function`

Función SQL `security definer` que es el punto único desde el que pg_cron invoca edge functions. Lee la URL base del proyecto de `private.config` y hace `net.http_post` vía `pg_net`.

Firma actual (tras la extensión de I4.3):

```sql
private.invoke_edge_function(
  function_name text,
  payload jsonb default '{}'::jsonb,
  with_auth boolean default false
) returns bigint
```

El parámetro `with_auth` se añadió al final de la firma para no romper los callers existentes:

- **`with_auth = false`** (default) — solo header `Content-Type`. Sirve para funciones con `verify_jwt = false`. Lo usa el cron de `promote-whitelist-matches`.
- **`with_auth = true`** — además lee `supabase_anon_key` de `private.config` e inyecta `Authorization: Bearer <anon_key>`. Necesario para invocar funciones con `verify_jwt = true`. Lo usan los 5 crons de `sftp-sync`.

Si `with_auth = true` pero `supabase_anon_key` falta, está vacío, o sigue siendo el placeholder `REPLACE_ME_AFTER_MERGE`, la función lanza excepción. Esto hace que un UPDATE manual olvidado tras la migración sea ruidoso (aparece en `cron.job_run_details`) en lugar de un fallo silencioso.

### Por qué la anon key en texto plano

La anon key es publicable por diseño — viaja en el bundle de cualquier frontend Supabase. Es el pase JWT de gateway para cualquier request, pero **no puede leer datos protegidos por RLS por sí sola**. Almacenarla en `private.config` sigue el mismo patrón que `supabase_url` y permite que pg_cron la lea desde la misma función `security definer` que ya frontea las invocaciones. No es un secreto en el sentido de `SHOPIFY_ADMIN_TOKEN` — es un identificador público.

### Cron jobs

6 jobs programados, en 2 migraciones:

| Job | Schedule (UTC) | Invoca | `with_auth` |
| --- | --- | --- | --- |
| `promote-whitelist-matches` | `*/30 * * * *` (cada 30 min) | `promote-whitelist-matches` | false |
| `sftp-sync-stock-01h` | `0 1 * * *` | `sftp-sync` `{kind: stock_only}` | true |
| `sftp-sync-stock-07h` | `0 7 * * *` | `sftp-sync` `{kind: stock_only}` | true |
| `sftp-sync-stock-13h` | `0 13 * * *` | `sftp-sync` `{kind: stock_only}` | true |
| `sftp-sync-stock-19h` | `0 19 * * *` | `sftp-sync` `{kind: stock_only}` | true |
| `sftp-sync-full-02h` | `0 2 * * *` | `sftp-sync` `{kind: full}` | true |

Los 4 stock-only corren cada 6h empezando a la 01:00 UTC; el full una vez al día a las 02:00 UTC. En hora local Madrid el desplazamiento por DST es ±1h (invierno CET = UTC+1, verano CEST = UTC+2) — se acepta porque los jobs siguen cayendo en horas no-pico.

Todas las migraciones de cron son idempotentes: hacen `cron.unschedule` (en bloque `DO/EXCEPTION`) antes de `cron.schedule`, así que se pueden re-aplicar sin duplicar jobs.

## 7. Migraciones

10 migraciones en `supabase/migrations/`, en orden cronológico:

| Migración | Qué hace |
| --- | --- |
| `20260419120000_setup_cron.sql` | Habilita `pg_cron` + `pg_net`, crea schema `private`, `private.config`, `private.invoke_edge_function`, programa el cron de whitelist |
| `20260507120000_import_runs.sql` | Crea `public.import_runs` (FSM del importer) + bucket Storage `ledsc4-imports` |
| `20260507130000_import_runs_to_private.sql` | Mueve `import_runs` de `public` a `private` (sacarla del scope de PostgREST), revoca permisos residuales, borra row de cleanup |
| `20260507140000_sku_state.sql` | Crea `private.sku_state` (fingerprint cache para imports incrementales) |
| `20260507150000_sku_state_stock_columns.sql` | Añade `fingerprint_stock` + `stock_last_seen_at` a `sku_state` (doble fingerprint full/stock) |
| `20260507160000_import_runs_counts_and_report_prefix.sql` | Añade `counts` (jsonb) + `report_storage_prefix` a `import_runs` |
| `20260509120000_seed_anon_key.sql` | Inserta el slot `supabase_anon_key` en `private.config` con placeholder `REPLACE_ME_AFTER_MERGE` |
| `20260509120100_invoke_edge_function_auth.sql` | Extiende `invoke_edge_function` con el parámetro `with_auth` |
| `20260509120200_setup_cron_sftp_sync.sql` | Programa los 5 crons de `sftp-sync` |
| `20260510120000_image_cache.sql` | Crea `private.image_cache` (cache sha256→Shopify file_id) |

Dos pasos manuales obligatorios tras aplicar las migraciones en un proyecto nuevo:

1. `UPDATE private.config SET value = 'https://<project-ref>.supabase.co' WHERE key = 'supabase_url';` — la migración siembra la URL del proyecto de desarrollo.
2. `UPDATE private.config SET value = '<anon key real>' WHERE key = 'supabase_anon_key';` — la migración siembra el placeholder.

Si se olvida el paso 2, los crons de `sftp-sync` fallan ruidosamente (excepción visible en `cron.job_run_details`); el cron de whitelist sigue funcionando porque usa `with_auth = false`.

## 8. Observabilidad

| Qué | Dónde |
| --- | --- |
| Ejecuciones de cron | Tabla `cron.job_run_details` en Postgres |
| Estado de los jobs programados | `select jobname, schedule, active from cron.job` |
| Logs de invocación de una función | `supabase functions logs <name>` o Dashboard → Edge Functions → \<función\> → Logs |
| Estado de los runs del importer | Tabla `private.import_runs` (vía SQL editor o Studio con `private` expuesto) |

## 9. Pendientes

- **`promote-whitelist-matches` sin auth**. Declarada `verify_jwt = false` y sin secret header — depende de que la URL no sea pública. `config.toml` ya tiene anotado el TODO de producción: añadir header `X-Cron-Secret` y validarlo en el handler. Pendiente de hardening.

- **Replay de nonce en `register-b2b-customer`**. El header de la función documenta que hoy se confía en la ventana TTL de 5 min + idempotencia por email para evitar replay. El hardening de producción sería dedupe de nonce en una KV store. Pendiente anotado en la propia función.

- **`.temp/` en el repo**. El directorio `supabase/.temp/` contiene artefactos del CLI. Verificar que está en `.gitignore` y que no se versiona nada sensible.

- **Sin política de evicción en `image_cache` ni GC en `import_runs`**. A volumen actual (455 SKU, runs diarios) ninguna de las dos tablas crece de forma problemática, pero a largo plazo `import_runs` acumula una row por cada invocación de `sftp-sync` (5/día = ~1825/año). No urge, pero conviene un GC de runs completados con más de N meses.

- **`project_id` de desarrollo hardcoded**. `config.toml` lleva `project_id = "mbjvmhaglbhnxoccwyex"` y `setup_cron.sql` siembra esa URL. Al migrar al cliente hay que cambiar ambos sitios + el UPDATE de `private.config`. Documentado en `supabase/README.md §Setup`, pero es un punto frágil — cross-link a 14-secrets y al runbook de migración (16) cuando existan.

- **Cross-link a 14-secrets**. El inventario completo de secrets (los 3 Shopify, los HMAC, los webhook secrets, `STOREFRONT_ORIGIN`) debe vivir en 14-secrets. Este doc los menciona por función; 14 debe ser la tabla maestra. Pendiente de crear 14.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 16-may-2026.
