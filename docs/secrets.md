# Inventario de secrets — LedsC4 B2B Outlet

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
   (todavía no poblado; se rellena al construir I4.2-A).

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
| `SUPABASE_URL` * | URL del proyecto. | Cualquier function que necesite construir Storage URLs o crear cliente Supabase. | Auto-inyectado | No tocar. |
| `SUPABASE_ANON_KEY` * | Anon key (JWT). | Functions que validan JWT del request. | Auto-inyectado | No tocar. |
| `SUPABASE_SERVICE_ROLE_KEY` * | Service role key (JWT). Bypasses RLS y schema gates de PostgREST. | `sftp-sync` (Storage uploads). En el futuro `shopify-write` (Storage downloads + insert en `private.import_runs`). | Auto-inyectado | **Nunca exponer al cliente / al storefront.** |
| `SUPABASE_DB_URL` * | Connection string Postgres directa (pooler). | `sftp-sync` (Edge) para escribir a `private.import_runs` vía `postgres@3.4.4` — funciona en Edge Runtime (Deno) con auto-inyección. | Auto-inyectado | No tocar. NB: el Edge Runtime auto-inyecta esto y `postgres@3.4.4` SÍ funciona allí; en Node CLI desde local hace falta `pg` (ver §2). |

**¿Cómo añadir/editar uno?** Supabase Dashboard → Settings (cog) → Edge Functions → Secrets → Add new secret. Nombre exacto + valor. Las functions desplegadas leen el nuevo valor en la siguiente invocación (sin redeploy).

**¿Cómo listar los actuales sin valores?** `supabase secrets list --project-ref mbjvmhaglbhnxoccwyex` (CLI). Devuelve solo nombres + hashes.

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

## 3. Secrets en GitHub (cuando lleguen)

**Estado a 2026-05-07:** _Pendiente — se poblará cuando se configure GitHub Actions en I4.2-A._

GitHub Actions necesitará invocar el writer (`scripts/import-write.mjs --apply --with-db`) desde un cron diario (full) y otro cada 6h (stock_only) sobre los CSVs ya descargados a Storage por `sftp-sync` (Job 1). Para eso requerirá:

| Nombre previsto | Propósito | Origen del valor |
|---|---|---|
| `SHOPIFY_STORE_DOMAIN` | Lo mismo que en Supabase / local. | Copy de Supabase secret. |
| `SHOPIFY_ADMIN_TOKEN` | Para mutations Shopify desde el cron. | Copy de Supabase secret. |
| `SHOPIFY_API_VERSION` | Pin. | Copy de Supabase secret. |
| `SUPABASE_URL` | Para inicializar cliente Supabase y descargar de Storage. | Copy de Supabase auto-inyectado (visible en dashboard). |
| `SUPABASE_SERVICE_ROLE_KEY` | Para descargar de Storage (bucket privado) con bypass de RLS. | Copy de Supabase auto-inyectado. |
| `SUPABASE_DB_URL` | Para upsert de fingerprints en `private.sku_state` (full + stock-only) desde el writer corriendo en GHA, vía `pg` driver. | **Session pooler URI** (5432, host `aws-0-<region>.pooler.supabase.com`) desde Supabase Dashboard → Settings → Database → Connection string → tab Session pooler. NB: el writer en CLI Node usa `pg` (no `postgres@3.4.4`) por bug SCRAM-SHA-256 contra el Session pooler. Edge Functions sí pueden usar `postgres@3.4.4` (allí funciona). |

**¿Cómo añadirlos en GitHub?** Settings → Secrets and variables → Actions → "New repository secret". Cada secret se referencia desde el workflow YAML como `${{ secrets.NOMBRE }}`.

**Decisión pendiente** sobre granularidad: secrets en el repo (todos los workflows pueden leerlos) vs en un environment dedicado (e.g. `production`) que pide review-gate antes de ejecutar el job. Para un cron sin pull-requests, repo-level está bien; cuando llegue I4.2-A confirmar.

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
