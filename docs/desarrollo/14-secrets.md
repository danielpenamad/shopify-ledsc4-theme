# 14 · Secrets

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

Inventario maestro de todos los secrets y valores de configuración del portal B2B Outlet: qué secret existe, para qué sirve, quién lo lee, en qué plano vive, y cómo se rota.

Este doc es la tabla de referencia única. Los docs 11, 12 y 13 mencionan secrets por componente (Supabase, repo, workflows) y remiten aquí para el inventario completo.

> **Regla absoluta**: este documento **nunca** contiene valores. Solo nombres, propósito, lectores y notas. Los valores viven en (a) los gestores de secrets de cada plano y (b) la cabeza de quien los rotó por última vez. Este doc se publica como sitio web — un valor aquí es un valor filtrado.

Lectores principales: cualquier dev o IA que necesite saber qué secret toca un componente, dónde está, o cómo rotarlo sin romper nada.

## 2. Los tres planos

Los secrets viven en tres sitios independientes. El mismo valor lógico (p. ej. el token de Shopify) puede tener que estar replicado en varios planos.

| Plano | Dónde se gestiona | Quién lo consume |
| --- | --- | --- |
| Supabase Edge Functions | Dashboard → Project Settings → Edge Functions → Secrets | Las 10 edge functions |
| Local de desarrollo | Fichero `shopify-ledsc4-theme.env` (gitignored) | Los scripts `.mjs` corridos desde la máquina de Dani |
| GitHub Actions | Settings → Secrets and variables → Actions | El workflow `ledsc4-import.yml` |

Plantillas versionadas (sin valores): `.env.example` en la raíz, `supabase/.env.example`. Ambas son parciales — este doc es el inventario completo.

## 3. Secrets en Supabase Edge Functions

Los consume el proyecto Supabase. Algunos se setean manualmente; otros los **auto-inyecta** el Edge Runtime (marcados con `*` — no se setean, vienen en cada invocación).

### Shopify

| Secret | Propósito | Quién lo lee |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Dominio del shop | Toda función que llame a la Admin API: las 9 que no son `sftp-sync` |
| `SHOPIFY_ADMIN_TOKEN` | Custom App access token (`shpat_…`) | Las mismas |
| `SHOPIFY_API_VERSION` | Pin de versión de la Admin API (`2025-10`) | Las mismas |

### HMAC y webhook secrets

| Secret | Propósito | Quién lo lee | Réplica obligatoria en |
| --- | --- | --- | --- |
| `BACKOFFICE_HMAC_SECRET` | HMAC entre Liquid SSR y las funciones de backoffice (auth del approver) | `list-pending-customers`, `update-whitelist`, `approve-customer`, `reject-customer` | `settings.backoffice_hmac_secret` en `config/settings_data.json` |
| `ORDER_REQUEST_HMAC_SECRET` | HMAC entre Liquid y las funciones de solicitudes | `submit-order-request`, `list-order-requests` | `settings.order_request_hmac_secret` |
| `REGISTER_B2B_HMAC_SECRET` | HMAC del form de alta B2B | `register-b2b-customer` | `settings.register_b2b_hmac_secret` |
| `CREATE_COMPANY_WEBHOOK_SECRET` | Valor del header `X-Webhook-Secret` que Shopify Flow envía | `create-company-for-customer` | El step "Send HTTP request" del Flow W2 |

Los tres HMAC y el webhook secret son **secretos compartidos**: si se rotan, hay que rotarlos en los dos (o tres) sitios a la vez, o la verificación falla.

### Configuración auxiliar

| Secret | Propósito | Quién lo lee |
| --- | --- | --- |
| `PROMOTE_WHITELIST_FUNCTION_URL` | URL completa de `promote-whitelist-matches`, para que `update-whitelist` la invoque sin reconstruirla | `update-whitelist` |
| `STOREFRONT_ORIGIN` | Origen permitido para CORS desde el storefront | Las funciones invocadas desde JS del storefront (backoffice + solicitudes + registro) |

### SFTP del proveedor

Todos los consume `sftp-sync`. El SFTP es del proveedor (LedsC4) — sus credenciales no cambian entre el sandbox de desarrollo y producción.

| Secret | Propósito | Notas |
| --- | --- | --- |
| `LEDSC4_SFTP_HOST` | Host del SFTP | — |
| `LEDSC4_SFTP_PORT` | Puerto SSH | — |
| `LEDSC4_SFTP_USER` | Usuario del SFTP | — |
| `LEDSC4_SFTP_PASSWORD` | Password del usuario | Rotar cuando el proveedor lo cambie |
| `LEDSC4_SFTP_BASE_PATH` | Directorio raíz que contiene `productos/`, `stock/`, `precios/` | — |
| `LEDSC4_SFTP_HOST_KEY` | Línea formato `known_hosts` del host key SSH | Lo usa `sftp-sync` para verificar el host byte a byte. **Si cambia: o el proveedor rotó el host, o hay un MITM. Confirmar siempre con el proveedor antes de actualizar.** |
| `LEDSC4_SFTP_HOST_KEY_FINGERPRINT` | Fingerprint humano-legible (sha256) del host key | Solo referencia operativa — comparación visual cuando el proveedor da un fingerprint nuevo |

### GitHub dispatch

| Secret | Propósito | Notas |
| --- | --- | --- |
| `GITHUB_DISPATCH_TOKEN` | GitHub PAT fine-grained. `sftp-sync` lo usa, tras marcar un run `downloaded`, para hacer `POST /repos/.../dispatches` con `event_type=ledsc4-import` — dispara el workflow `ledsc4-import.yml` | Scope mínimo: **Contents=Write, Metadata=Read** sobre el repo. NO requiere Actions write — GitHub cataloga el endpoint `/dispatches` bajo Contents. Procedimiento de rotación abajo (§6) |

### Auto-inyectados por el Edge Runtime

No se setean manualmente — el Edge Runtime los provee en cada invocación.

| Secret | Propósito | Notas |
| --- | --- | --- |
| `SUPABASE_URL` * | URL del proyecto | No tocar |
| `SUPABASE_ANON_KEY` * | Anon key (JWT) | No tocar. Publicable por diseño — no es secreto en sentido estricto |
| `SUPABASE_SERVICE_ROLE_KEY` * | Service role key (JWT). Bypassa RLS y los gates de schema de PostgREST | **Nunca exponer al storefront ni al cliente** |
| `SUPABASE_DB_URL` * | Connection string Postgres (pooler) | No tocar. En el Edge Runtime el driver `postgres` funciona; desde Node CLI hace falta `pg` (ver §4 y 12-github-repo §5) |

### Cómo gestionarlos

Añadir/editar: Dashboard → Settings → Edge Functions → Secrets → Add new secret. Las funciones desplegadas leen el valor nuevo en la siguiente invocación — **salvo** rotación de un secret ya cacheado en un container caliente, que requiere redeploy (ver 11-supabase y §6). Listar sin valores: `supabase secrets list --project-ref <ref>`.

## 4. `private.config` — no es una tabla de secrets

`private.config` es una tabla key/value de Postgres que las funciones SQL de pg_cron leen en runtime (ver 11-supabase §6). **No almacena secretos** — es texto plano por diseño.

| Key | Propósito | Notas |
| --- | --- | --- |
| `supabase_url` | URL base del proyecto, para que `invoke_edge_function` construya las URLs de las edge functions | Sembrada en la migración inicial de cron. Al migrar al proyecto del cliente, `UPDATE` con la URL nueva |
| `supabase_anon_key` | Anon key (JWT), inyectada como `Authorization: Bearer` cuando un cron invoca una función con `verify_jwt = true` | Sembrada como placeholder `REPLACE_ME_AFTER_MERGE`. **UPDATE manual obligatorio tras aplicar la migración.** No es secreto — la anon key es pública |

Se incluye aquí porque es fácil confundirla con un almacén de secrets. No lo es: lo que va en `private.config` es config legible, no credenciales.

## 5. Secrets en los otros dos planos

### Local de desarrollo — `shopify-ledsc4-theme.env`

Fichero gitignored en la raíz del repo (`.gitignore` cubre `*.env` salvo `*.env.example`). Vive solo en máquinas de desarrollo.

| Nombre | Propósito | Notas |
| --- | --- | --- |
| `SHOPIFY_STORE_DOMAIN` | Para que los scripts CLI llamen a Shopify | Mismo valor que el secret en Supabase |
| `SHOPIFY_ADMIN_TOKEN` | Para los scripts CLI | Mismo valor que en Supabase. Distinto del token de la theme app (Shopify CLI tiene el suyo) |
| `SHOPIFY_API_VERSION` | Pin de versión | Mismo valor que en Supabase |
| `SUPABASE_DB_URL` | Para `import-write.mjs --apply --with-db` (upsert de fingerprints en `private.sku_state`) | **Session pooler** (puerto 5432, host `aws-0-<region>.pooler.supabase.com`, user `postgres.<project-ref>`). NO usar el tab "Direct" del Dashboard — en plan Free resuelve solo a IPv6 y no es ruteable desde redes NAT IPv4 |

Hay además tres env vars opcionales que **no son secrets** — overrides puntuales con defaults razonables, leídos por scripts one-shot: `B2B_EMAIL_BACKOFFICE`, `B2B_WHITELIST_EMAILS`, `BACKOFFICE_CUSTOMER_EMAIL`. No hace falta tenerlas en el `.env` salvo que se quiera customizar.

### GitHub Actions — el workflow `ledsc4-import.yml`

5 secrets a nivel de repositorio (Settings → Secrets and variables → Actions). Es el único workflow que usa secrets de repo (ver 13-github-actions §7).

| Nombre | Propósito | Origen del valor |
| --- | --- | --- |
| `SUPABASE_URL` | Endpoint de Storage para descargar inputs y subir reports | Mismo valor que el `SUPABASE_URL` auto-inyectado en Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Authorization Bearer para Storage (bucket privado) | Mismo valor que el auto-inyectado en Edge Functions. **Nunca exponer al storefront** |
| `SUPABASE_DB_URL` | Connection string Postgres (Session pooler) para leer la row, marcar `processing`, upsert de `sku_state`, cerrar el run | Tab **Session pooler** del Dashboard, no Direct. Driver `pg` (no `postgres`, por el bug SCRAM contra el pooler) |
| `SHOPIFY_SHOP` | Dominio del shop. El workflow lo mapea a `SHOPIFY_STORE_DOMAIN` | Copia del `SHOPIFY_STORE_DOMAIN` de Supabase |
| `SHOPIFY_ADMIN_TOKEN` | Custom App token para la Admin API desde el writer | Copia del `SHOPIFY_ADMIN_TOKEN` de Supabase |

`SHOPIFY_API_VERSION` **no** se setea en GHA — el writer aplica su default `2025-10`. Si hiciera falta pinearlo desde GHA, añadirlo como secret de repo y reflejarlo en el workflow.

Granularidad: hoy los 5 son repo-level. Cuando se transfiera al cliente y se quiera un gate antes de tocar producción, se pueden mover a un environment `production` con required reviewers.

## 6. Rotación de secrets

Principio general: tras rotar un secret que lee una edge function, **hay que redeployar la función**. Sin redeploy, el container caliente sigue con el valor viejo en RAM (ver 11-supabase §verify_jwt). Es la causa #1 de bugs falsos tipo "el token está mal pero ya lo cambié".

### Secrets compartidos entre planos

Cuando un valor está replicado, rotar **todos** los sitios a la vez:

- Los 3 HMAC (`BACKOFFICE_`, `ORDER_REQUEST_`, `REGISTER_B2B_`) → Supabase secret + `settings.*` en `config/settings_data.json`.
- `CREATE_COMPANY_WEBHOOK_SECRET` → Supabase secret + el step Send HTTP request del Flow W2.
- `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_STORE_DOMAIN` → Supabase + `shopify-ledsc4-theme.env` local + GitHub Actions (`SHOPIFY_SHOP` / `SHOPIFY_ADMIN_TOKEN`).

### Procedimiento de rotación de `GITHUB_DISPATCH_TOKEN`

Al regenerar el PAT en GitHub, el anterior queda invalidado al instante. Para que el chain `sftp-sync → workflow` no falle silenciosamente con HTTP 401:

1. Generar el PAT nuevo en GitHub con los mismos permisos (`Contents=Write`).
2. Validarlo antes de tocar Supabase, con un `curl` a `GET /user` — esperar HTTP 200 con el `login` correcto antes de seguir.
3. Actualizar el secret en Supabase: `supabase secrets set GITHUB_DISPATCH_TOKEN=<nuevo> --project-ref <ref>`.
4. Redeploy obligatorio: `supabase functions deploy sftp-sync --project-ref <ref>`.
5. Verificar invocando `sftp-sync` con body `{}` y confirmando `dispatch_status: "ok"` en la respuesta.

Síntoma de PAT desincronizado: `sftp-sync` responde `dispatch_status: "failed"` con `HTTP 401: Bad credentials`. El run queda en `downloaded` pero el workflow no arranca — el fallback es disparar `ledsc4-import.yml` manualmente con `gh workflow run` y el `run_id`.

### Cadencia recomendada

- `SHOPIFY_ADMIN_TOKEN`: cada 90 días o ante sospecha de leak.
- `GITHUB_DISPATCH_TOKEN`: anual o ante sospecha.
- `SHOPIFY_API_VERSION`: subir cada trimestre cuando Shopify saca versión nueva (validar tests antes).
- HMAC y webhook secrets: sin cadencia fija; rotar ante sospecha o en el cutover al cliente.

## 7. Transferencia al cliente

Cuando LedsC4 reciba el sistema, hay que migrarlo del sandbox de desarrollo al proyecto del cliente sin que ningún secret quede en sitios fantasma. La transferencia ocurre por hitos, no de golpe.

### Clasificación de los secrets para el cutover

**Los genera el cliente** (no se copian del sandbox):
- `SHOPIFY_ADMIN_TOKEN` del shop de producción.
- Los 4 HMAC / webhook secrets — nuevos, generados con `randomBytes`, replicados en Supabase + `config/settings_data.json` (los 3 HMAC) + el Flow W2 (`CREATE_COMPANY_WEBHOOK_SECRET`).
- La DB password del proyecto Supabase nuevo (de la que deriva `SUPABASE_DB_URL`).
- `LEDSC4_SFTP_PASSWORD` si el cliente prefiere rotarla en el cutover.

**Se transfieren tal cual** (el recurso es el mismo en sandbox y producción):
- Los `LEDSC4_SFTP_*` salvo el password — el SFTP del proveedor no cambia.
- `SHOPIFY_API_VERSION`.
- `STOREFRONT_ORIGIN` — ajustar solo si el dominio definitivo difiere.

**Auto-inyectados — el cliente no los toca**:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` vienen con el proyecto Supabase. No se copian los del sandbox.

### Qué NO se transfiere

- El `shopify-ledsc4-theme.env` local de Dani — el cliente reconstruye el suyo desde `.env.example`.
- Los tokens personales de Dani (Supabase CLI auth, GitHub PAT personal) — el cliente usa los suyos.

El runbook de operaciones (16) cubrirá el checklist de cutover paso a paso y las fases del handover. Este doc cubre solo la parte de secrets.

## 8. Pendientes

- **`supabase/.env.example` desactualizado**. La plantilla versionada solo lista 4 secrets (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`, `CREATE_COMPANY_WEBHOOK_SECRET`). Faltan los 3 HMAC, `PROMOTE_WHITELIST_FUNCTION_URL`, `STOREFRONT_ORIGIN`, los 7 `LEDSC4_SFTP_*` y `GITHUB_DISPATCH_TOKEN`. Actualizar la plantilla para que cubra todos los secrets manuales de §3, o sustituirla por un enlace a este doc.

- **El Custom App de Shopify no tiene scope `read_locations`**. Anotado como gap conocido en el material legacy. Verificar si alguna función o el importer lo necesita y, si es así, ampliar los scopes del Custom App.

- **Archivar `docs/secrets.md` legacy**. El fichero plano `docs/secrets.md` era el inventario maestro previo a la estructura por ejes; su contenido vivo está ahora en este doc. Debe archivarse en `docs/_archive/` junto con el resto del material legacy plano (ver 12-github-repo §8).

- **HMAC sin cadencia de rotación definida**. Los 3 HMAC y el webhook secret no tienen una política de rotación periódica, solo "ante sospecha o en el cutover". Para producción a largo plazo conviene definir una cadencia.

- **Cross-link al runbook (16)**. El checklist de cutover paso a paso y las fases del handover (acceso al repo, transfer de ownership, transfer del proyecto Supabase, transfer del shop) deben vivir en el runbook de operaciones. Este doc cubre la clasificación de secrets; 16 cubre el procedimiento completo.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 16-may-2026.
