# Inventario de secrets — LedsC4 B2B Outlet

_Estado a 2026-05-09 — sujeto a actualización. Para handover de cierre del proyecto._

Documento vivo. Cada vez que se añada o retire un secret en alguno de los
tres planos (Supabase / local / GitHub), actualizar la fila correspondiente
con la fecha de creación y propósito.

> **Regla absoluta**: este fichero **nunca** contiene valores. Solo nombres,
> propósito, lectores y notas. Los valores viven en (a) los gestores de
> secrets de cada plano y (b) la cabeza de los humanos que los rotaron por
> última vez.

Tres planos:

1. **Supabase Edge Functions** — Project Settings → Edge Functions → Secrets.
2. **Local de desarrollo** — `shopify-ledsc4-theme.env` (gitignored).
3. **GitHub Actions** — Settings → Secrets and variables → Actions
   (5 secrets repo-level desde PR-A1, ver §3).

---

## 1. Secrets en Supabase (Edge Functions)

Tabla del estado a 2026-05-07. Marca con `*` los **auto-inyectados** por el
Edge Runtime (no se setean manualmente, vienen incluidos en cada invocación):

| Nombre | Propósito | Quién lo lee | Cuándo se creó | Notas |
|---|---|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | Dominio del shop (`ledsc4-b2b-outlet.myshopify.com`). | Cualquier function que llame a Shopify Admin API: `approve-customer`, `reject-customer`, `update-whitelist`, `list-pending-customers`, `register-b2b-customer`, `submit-order-request`, `list-order-requests`, `create-company-for-customer`, `promote-whitelist-matches`. (Y a futuro: `shopify-write` en I4.2-A.) | I0 (2026-04-19) | Cambia al migrar al shop del cliente. |
| `SHOPIFY_ADMIN_TOKEN` | Custom App access token (`shpat_…`). | Mismas que `SHOPIFY_STORE_DOMAIN`. | I0 (2026-04-19) | Rotar cada 90 días o si se sospecha leak. Custom App actual no tiene scope `read_locations` — flagged en pendientes. |
| `SHOPIFY_API_VERSION` | Pin de versión de Shopify Admin API (`2025-10`). | Mismas. | I0 (2026-04-19) | Subir cada quarter cuando Shopify saque versión nueva (validar tests antes). |
| `BACKOFFICE_HMAC_SECRET` | HMAC compartido entre Liquid SSR y las 4 functions del backoffice (auth del approver). | `approve-customer`, `reject-customer`, `update-whitelist`, `list-pending-customers`. | Fase BO (2026-05-04) | También en `theme/config/settings_data.json` como `settings.backoffice_hmac_secret`. Si se rota, rotar en ambos sitios. |
| `ORDER_REQUEST_HMAC_SECRET` | HMAC compartido entre Liquid y las functions de solicitudes de pedido. | `submit-order-request`, `list-order-requests`. | I0 | También en `settings.order_request_hmac_secret`. |
| `REGISTER_B2B_HMAC_SECRET` | HMAC compartido entre Liquid (form de alta B2B) y la function que persiste el customer. | `register-b2b-customer`. | I0 | También en `settings.register_b2b_hmac_secret`. |
| `CREATE_COMPANY_WEBHOOK_SECRET` | Header `X-Webhook-Secret` que Shopify Flow envía al disparar `create-company-for-customer`. | `create-company-for-customer`. | I0 | El valor también se configura en el step "Send HTTP request" del Flow W2. |
| `PROMOTE_WHITELIST_FUNCTION_URL` | URL completa de `promote-whitelist-matches` para que `update-whitelist` la invoque sin re-construirla. | `update-whitelist`. | Fase BO | Al migrar al proyecto del cliente, actualizar a la nueva URL. |
| `STOREFRONT_ORIGIN` | Origen permitido para CORS desde el storefront. | Functions invocadas desde JS del storefront (las del backoffice + solicitudes). | I0 | Coincide con `https://ledsc4-b2b-outlet.myshopify.com` o el custom domain. |
| `LEDSC4_SFTP_HOST` | Host del SFTP del cliente (`sftp.ledsc4.com`). | `sftp-sync` (I4.1). En el futuro también `shopify-write` indirectamente vía Storage. | Fase I4 (2026-05-07) | Verificar host_key tras cualquier rotación del servidor SFTP. |
| `LEDSC4_SFTP_PORT` | Puerto SSH (`22`). | `sftp-sync`. | Fase I4 | — |
| `LEDSC4_SFTP_USER` | Usuario del SFTP (`webslobs`). | `sftp-sync`. | Fase I4 | — |
| `LEDSC4_SFTP_PASSWORD` | Password del usuario. | `sftp-sync`. | Fase I4 | Rotar cuando el cliente haga cambio. |
| `LEDSC4_SFTP_BASE_PATH` | Directorio raíz que contiene `productos/`, `stock/`, `precios/`. | `sftp-sync`. | Fase I4 | — |
| `LEDSC4_SFTP_HOST_KEY` | Línea formato known_hosts del host key SSH (`<host> ssh-ed25519 AAAA...`). | `sftp-sync` para el `hostVerifier` byte-a-byte. | Fase I4 | Verificación crítica: si cambia, alguien rotó el host (legítimo) o estamos siendo MITM-ed. **Confirmar siempre con el cliente antes de actualizar.** |
| `LEDSC4_SFTP_HOST_KEY_FINGERPRINT` | Fingerprint humano-leíble (sha256). | (Ninguno por ahora — solo referencia operativa.) | Fase I4 | Útil para comparación visual cuando el cliente nos da un fingerprint nuevo. |
| `GITHUB_DISPATCH_TOKEN` | GitHub PAT fine-grained. `sftp-sync` lo usa tras marcar el run `downloaded` para invocar `POST /repos/danielpenamad/shopify-ledsc4-theme/dispatches` con `event_type=ledsc4-import` y `client_payload={run_id}` — dispara el workflow `ledsc4-import.yml` (Job 2). | `sftp-sync` (PR-A2). | Fase A — PR-A2 (2026-05-08) | Scope mínimo: **Contents=Write, Metadata=Read (auto)** sobre el repo `danielpenamad/shopify-ledsc4-theme`. NO requiere Actions write — el endpoint `POST /repos/{owner}/{repo}/dispatches` lo cataloga GitHub bajo Contents (confirmado vía header `x-accepted-github-permissions: contents=write`). Si missing al arrancar, sftp-sync devuelve HTTP 500 con `error_stage='secret_load'` ANTES de tocar SFTP/BD/Storage (fail-fast contra crons silenciosamente rotos). Si el dispatch HTTP falla en runtime (post-update a `downloaded`), es best-effort: se logguea + se incluye `dispatch_status='failed'` en la response, pero el row queda en `downloaded` y `workflow_dispatch` manual con el mismo `run_id` es el fallback documentado. Rotar anualmente o ante sospecha — ver **Procedimiento de rotación** debajo de la tabla. Al transferir el repo a la org del cliente, regenerar contra el nuevo path. |
| `SUPABASE_URL` * | URL del proyecto. | Cualquier function que necesite construir Storage URLs o crear cliente Supabase. | Auto-inyectado | No tocar. |
| `SUPABASE_ANON_KEY` * | Anon key (JWT). | Functions que validan JWT del request. | Auto-inyectado | No tocar. |
| `SUPABASE_SERVICE_ROLE_KEY` * | Service role key (JWT). Bypasses RLS y schema gates de PostgREST. | `sftp-sync` (Storage uploads). En el futuro `shopify-write` (Storage downloads + insert en `private.import_runs`). | Auto-inyectado | **Nunca exponer al cliente / al storefront.** |
| `SUPABASE_DB_URL` * | Connection string Postgres directa (pooler). | `sftp-sync` (Edge) para escribir a `private.import_runs` vía `postgres@3.4.4` — funciona en Edge Runtime (Deno) con auto-inyección. | Auto-inyectado | No tocar. NB: el Edge Runtime auto-inyecta esto y `postgres@3.4.4` SÍ funciona allí; en Node CLI desde local hace falta `pg` (ver §2). |

**¿Cómo añadir/editar uno?** Supabase Dashboard → Settings (cog) → Edge Functions → Secrets → Add new secret. Nombre exacto + valor. Las functions desplegadas leen el nuevo valor en la siguiente invocación (sin redeploy).

**¿Cómo listar los actuales sin valores?** `supabase secrets list --project-ref mbjvmhaglbhnxoccwyex` (CLI). Devuelve solo nombres + hashes.

### Procedimiento de rotación de `GITHUB_DISPATCH_TOKEN`

Cuando se regenera el PAT en GitHub (rotación anual o ante sospecha de
compromiso), el PAT anterior queda **invalidado al instante**. Para
evitar que el chain `sftp-sync → workflow` falle silenciosamente con
HTTP 401:

1. Generar el nuevo PAT en GitHub manteniendo los mismos permisos
   (`Contents=Write`).

2. Validar el PAT antes de actualizar Supabase con un `curl` directo a
   `GET /user`:

   ```sh
   curl -i "https://api.github.com/user" \
     -H "Authorization: Bearer <PAT-NUEVO>" \
     -H "Accept: application/vnd.github+json"
   ```

   Esperar HTTP 200 con `"login": "<owner>"` antes de seguir. Si
   devuelve 401 → el PAT no se copió bien.

3. Actualizar el secret en Supabase:

   ```sh
   supabase secrets set GITHUB_DISPATCH_TOKEN=<PAT-NUEVO> \
     --project-ref mbjvmhaglbhnxoccwyex
   ```

4. Re-deploy obligatorio (el Edge Runtime cachea env vars hasta el
   siguiente deploy):

   ```sh
   supabase functions deploy sftp-sync \
     --project-ref mbjvmhaglbhnxoccwyex
   ```

5. Verificar invocando `sftp-sync` con body `{}` y confirmando que el
   response trae `dispatch_status: "ok"`.

**Síntoma de PAT desincronizado entre GitHub y Supabase:**
`dispatch_status: "failed"` con `dispatch_error: "HTTP 401: Bad
credentials"` en el response de `sftp-sync`. El run queda en
`downloaded` pero el workflow no arranca. Disparable manualmente vía
`gh workflow run ledsc4-import.yml -f run_id=<uuid>` mientras se
resuelve.

### `private.config` — config compartida entre pg_cron y edge functions

No es estrictamente una tabla de secrets, pero sirve de "bag de
strings" para que las funciones SQL de pg_cron lean valores que
necesitan en runtime. Plain text por diseño — no almacenar nada
secreto aquí.

| Key | Propósito | Quién lo lee | Notas |
|---|---|---|---|
| `supabase_url` | URL base del proyecto (`https://<ref>.supabase.co`). Usada para construir la URL de cualquier edge function en `private.invoke_edge_function`. | `private.invoke_edge_function` (consumido por todos los crons del proyecto). | Sembrado en la migración inicial de cron (2026-04-19). Al migrar al proyecto del cliente, `UPDATE` esta fila con la nueva URL. |
| `supabase_anon_key` | Anon key del proyecto (formato JWT). Inyectada como `Authorization: Bearer <key>` cuando un cron invoca una edge function con `verify_jwt = true` (p. ej. `sftp-sync`). | `private.invoke_edge_function` con `with_auth = true`. | Sembrado como placeholder `REPLACE_ME_AFTER_MERGE` en la migración I4.3 (2026-05-09). **UPDATE manual obligatorio tras aplicar** la migración con el valor real (Project Settings → API → anon public). La función raise si el placeholder sigue ahí cuando se invoca. **No es secreto**: la anon key se publica en cualquier frontend que use el cliente Supabase. |

**¿Cómo añadir/editar valores?** SQL directo en Supabase Studio:

```sql
UPDATE private.config SET value = '<nuevo valor>' WHERE key = '<key>';
-- o
INSERT INTO private.config (key, value) VALUES ('<key>', '<value>')
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
```

---

## 2. Secrets en local (env files de desarrollo)

### `shopify-ledsc4-theme.env`

Archivo gitignored (`.gitignore` tiene `*.env` con whitelist solo para `*.env.example`). Symlinked desde `.env` para conveniencia. Vive **solo en máquinas de desarrollo** (Dani por ahora).

**Estado a 2026-05-07:**

| Nombre | Propósito | Notas |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | Para que los scripts CLI (`apply-metafield-definitions.mjs`, `import-write.mjs`, etc.) llamen a Shopify. | Mismo valor que el secret en Supabase. |
| `SHOPIFY_ADMIN_TOKEN` | Para CLI Shopify. | Mismo valor que el secret en Supabase. **No** mismo token que el de la theme app (Shopify CLI tiene el suyo). |
| `SHOPIFY_API_VERSION` | Pin de versión. | Mismo valor que en Supabase. |
| `SUPABASE_DB_URL` | Para que `node scripts/import-write.mjs --apply --with-db` upserte fingerprints en `private.sku_state` desde local (y `--stock-only` para `fingerprint_stock`). | **Session pooler** (puerto 5432, host `aws-0-<region>.pooler.supabase.com`, user `postgres.<project-ref>`). NO usar el tab "Direct" del Dashboard — en Free plan resuelve solo a IPv6 y no es ruteable desde redes con NAT IPv4. Última rotación 2026-05-07 (16-char alfanumérica) durante debugging del SCRAM bug. |

**Plantilla**: `shopify-ledsc4-theme/.env.example` (committed) + `supabase/.env.example` (committed, se está quedando desactualizado vs §1; pendiente refresh — ver "Plan de transferencia").

### Otras env vars opcionales para scripts one-shot

Estos NO son secrets, son overrides puntuales con defaults razonables. No es necesario tenerlos en `shopify-ledsc4-theme.env` salvo que se quiera customizar:

- `B2B_EMAIL_BACKOFFICE` → leído por `scripts/set-shop-b2b-metafields.mjs`. Default: `dani@creacciones.es`.
- `B2B_WHITELIST_EMAILS` → ídem. Default: lista vacía.
- `BACKOFFICE_CUSTOMER_EMAIL` → leído por `scripts/create-backoffice-customer.mjs`. Default: `daniel.pena+backoffice@creacciones.es`.

---

## 3. Secrets en GitHub Actions

### 3.1. Workflow `ledsc4-import.yml` (PR-A1, 2026-05-07)

`.github/workflows/ledsc4-import.yml` ejecuta el writer (`runFullImport` o
`runStockOnly` desde `scripts/import-write.mjs`) end-to-end contra un row de
`private.import_runs` ya en estado `downloaded`. Disparable solo manualmente
vía `workflow_dispatch` con inputs `run_id` (UUID) y `kind_override` opcional
(`full|stock_only`). El chain automático desde `sftp-sync` llega en PR-A2.

Secrets requeridos a nivel de **repo** (Settings → Secrets and variables →
Actions → New repository secret):

| Nombre | Propósito | Origen del valor |
|---|---|---|
| `SUPABASE_URL` | Endpoint REST de Storage (`<url>/storage/v1/object/<bucket>/<path>`) para descargar inputs y subir reports. | Supabase Dashboard → Settings → API → Project URL. Mismo valor que `SUPABASE_URL` auto-inyectado en Edge Functions (§1). |
| `SUPABASE_SERVICE_ROLE_KEY` | Authorization Bearer para descargar/subir a `ledsc4-imports` (bucket privado, bypass RLS). | Supabase Dashboard → Settings → API → service_role key. Mismo valor que el auto-inyectado en Edge Functions (§1). **Nunca exponer al storefront.** |
| `SUPABASE_DB_URL` | Connection string Postgres (Session pooler) para fetch del row, marcar `processing`, upsert de `private.sku_state` desde el writer y close de la run con counts + `report_storage_prefix`. | Supabase Dashboard → Settings → Database → Connection string → tab **Session pooler** (puerto 5432, host `aws-0-<region>.pooler.supabase.com`, user `postgres.<project-ref>`). NO usar Direct (Free plan = solo IPv6). El driver es `pg@^8.13` (no `postgres@3.4.4` por el bug SCRAM contra el pooler). |
| `SHOPIFY_SHOP` | Dominio del shop (ej. `ledsc4-b2b-outlet.myshopify.com`). El workflow lo mapea a `SHOPIFY_STORE_DOMAIN` para el writer. | Copy del secret `SHOPIFY_STORE_DOMAIN` en Supabase (§1). |
| `SHOPIFY_ADMIN_TOKEN` | Custom App access token (`shpat_…`) para Admin API GraphQL desde el writer. | Copy del secret `SHOPIFY_ADMIN_TOKEN` en Supabase (§1). |

**No** se setea `SHOPIFY_API_VERSION` — el writer aplica su default `2025-10`
(ver `scripts/import-write.mjs`). Si en algún momento se necesita pinear desde
GHA, añadirlo como secret repo-level y reflejarlo en el workflow.

**Cómo crearlos** (CLI, gh):

```sh
gh secret set SUPABASE_URL              -b "https://<project-ref>.supabase.co"
gh secret set SUPABASE_SERVICE_ROLE_KEY -b "<service_role_jwt>"
gh secret set SUPABASE_DB_URL           -b "postgresql://postgres.<ref>:<pwd>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
gh secret set SHOPIFY_SHOP              -b "ledsc4-b2b-outlet.myshopify.com"
gh secret set SHOPIFY_ADMIN_TOKEN       -b "shpat_..."
```

(O desde UI: Settings → Secrets and variables → Actions → New repository
secret, uno por uno.)

**Cómo disparar manualmente** (tras configurar los 5 secrets):

```sh
# Kind heredado del row (caso normal):
gh workflow run ledsc4-import.yml -f run_id=<uuid>

# Forzar kind:
gh workflow run ledsc4-import.yml -f run_id=<uuid> -f kind_override=stock_only
```

O desde la UI: Actions → "LedsC4 import — writer" → Run workflow.

### 3.2. Granularidad: repo-level vs environment

Por ahora **repo-level**. Cuando se transfiera al cliente y se quiera un gate
extra antes de tocar producción, considerar moverlos a un environment
`production` con required reviewers. Para cron sin PR no hace falta.

---

## 4. Plan de transferencia al cliente

Cuando el cliente (LedsC4) reciba el sistema, hay que migrarlo de
"sandbox de Dani" a "proyecto del cliente" sin que ningún secret
quede en sitios fantasma. Lista de tareas:

### 4.1. Inventario de secrets que el cliente debe generar

Estos los **genera el cliente**, no los rotamos nosotros desde nuestros valores:
- `SHOPIFY_ADMIN_TOKEN` del shop de producción (no del sandbox).
- `LEDSC4_SFTP_PASSWORD` si el cliente prefiere rotarla en cutover.
- Los 4 HMAC secrets (`BACKOFFICE_*`, `ORDER_REQUEST_*`, `REGISTER_B2B_*`,
  `CREATE_COMPANY_WEBHOOK_SECRET`): generar nuevos con
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  y replicarlos en (a) Supabase secrets, (b) `theme/config/settings_data.json`
  para los 3 HMAC, (c) el step Send HTTP request del Flow W2 para
  `CREATE_COMPANY_WEBHOOK_SECRET`.
- DB password del nuevo proyecto Supabase (deriva el `SUPABASE_DB_URL`).

### 4.2. Inventario de secrets que se transfieren tal cual

Estos los pasamos del proyecto sandbox al del cliente sin regenerar:
- `LEDSC4_SFTP_HOST`, `_PORT`, `_USER`, `_BASE_PATH`, `_HOST_KEY`,
  `_HOST_KEY_FINGERPRINT`: el SFTP del cliente es siempre el mismo,
  no cambia entre sandbox y producción.
- `SHOPIFY_API_VERSION`: pin actual.
- `STOREFRONT_ORIGIN`: ajustar al dominio definitivo si difiere.

### 4.3. Inventario de cosas auto-inyectadas que el cliente NO toca

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_DB_URL`: vienen automáticamente con el proyecto Supabase nuevo
del cliente. NO copiamos los nuestros.

### 4.4. Checklist al hacer el cutover

- [ ] Crear proyecto Supabase nuevo en la org del cliente.
- [ ] Aplicar todas las migrations del repo (`supabase db push`).
- [ ] Crear bucket `ledsc4-imports` privado (one-shot ya en migration).
- [ ] Setear los ~15 secrets manuales (todo lo de §1 que NO esté marcado `*`).
- [ ] Re-deployar todas las Edge Functions (`supabase functions deploy --all`).
- [ ] Configurar 3 HMAC secrets en `theme/config/settings_data.json` y
      `CREATE_COMPANY_WEBHOOK_SECRET` en el step Send HTTP request del Flow W2.
- [ ] Configurar GitHub Actions secrets (§3) en el repo del cliente
      (asumiendo que el cliente toma el repo).
- [ ] Smoke test: invocar `sftp-probe` (si aún existe; si no, `sftp-sync`
      con `--limit=1`) y verificar host key + listing.
- [ ] Smoke test: invocar `shopify-write` (cuando exista, I4.2-A) sobre
      el run del paso anterior.
- [ ] Documentar en este fichero la fecha del cutover y borrar las
      referencias específicas a `mbjvmhaglbhnxoccwyex` (project ref del
      sandbox).

### 4.5. Qué NO transferimos

- **Nuestro `shopify-ledsc4-theme.env` local**: el cliente no necesita los
  secrets de nuestro sandbox. Reconstruye el suyo a partir de la plantilla
  `.env.example`.
- **Nuestros tokens personales** (Supabase CLI auth, GitHub PAT, etc.):
  el cliente usa los suyos.
- **Productos pre-existentes con handle basado en título** (745 SKUs): ver
  `docs/pendientes.md` [P3] — limpieza separada antes del cutover.

---

## Referencias

- `supabase/.env.example` — plantilla histórica de secrets en Supabase
  (parcial; este fichero es el inventario completo).
- `.env.example` — plantilla del env local.
- `docs/operations-runbook.md` — operaciones day-to-day, no secrets.
- `docs/import-pipeline.md` — flow del importer; los secrets de SFTP /
  Supabase / Shopify son los que aquí se inventarian.
- `docs/pendientes.md` — gaps abiertos (incluye un par relacionados con
  secrets: scope `read_locations` para el Custom App de Shopify, etc.).
