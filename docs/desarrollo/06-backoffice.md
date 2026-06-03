# 06 · Backoffice de aprobaciones

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Describe la página `/pages/admin-backoffice` y las 4 edge functions que sirven sus 3 acciones (aprobar, rechazar, gestionar whitelist). Cubre:

- Arquitectura de la página (template + 3 sections + JS + CSS).
- Auth dual-layer (gate UX por tag `backoffice` + HMAC server-side + assertBackofficeTag).
- Contrato de las 4 edge functions (inputs, outputs, errores).
- Reparto edge ↔ Flow W2/W3.
- Customer técnico y cutover al cliente final.

No cubre:

- Cómo se registra un anónimo → [05-registro-b2b](05-registro-b2b.md).
- El comportamiento del gate del storefront → [04-storefront-gate](04-storefront-gate.md).
- Configuración del rol staff "Backoffice Aprobaciones" en Shopify Admin → [administracion/00-vision-general](../administracion/00-vision-general.md). El rol existe como fallback manual; la operativa real pasa por esta página.

Decisión arquitectónica: [D7](adrs/d07-backoffice-page.md).

## 1. Acceso

- **URL**: `/pages/admin-backoffice`.
- **Único requisito**: el Customer logueado tiene tag `backoffice`.
- **Gate UX**: la section `admin-backoffice-resumen.liquid` hace `{% if customer and customer.tags contains 'backoffice' %}` para decidir qué pintar. Los Customers sin el tag ven una pantalla "Acceso restringido".
- **Page template**: `template_suffix=admin-backoffice`.
- **Gate del theme** ([04-storefront-gate](04-storefront-gate.md)) deja pasar la página sin tratamiento especial — es una page más, sin exempt explícito, que se autoprotege con su gate UX.

🔒 **El `{% if %}` es UX, NO seguridad.** Cada edge function repite la verificación server-side con `assertBackofficeTag(approverId)`: resuelve el Customer vía Admin API y comprueba `tags.includes('backoffice')`. Si alguien manipula el DOM o el storage, las edges devuelven `403 NOT_BACKOFFICE`.

## 2. Arquitectura

```
                 +---------------------------------+
                 |  /pages/admin-backoffice        |
                 |  templates/page.admin-backoffice.json
                 |  ├── admin-backoffice-resumen   |  ← renderiza HMAC + carga JS/CSS
                 |  ├── admin-backoffice-whitelist |
                 |  └── admin-backoffice-pendientes|
                 +-----+---------------------------+
                       |
                       | fetch (POST JSON con HMAC + customerId)
                       v
       +-----------------------------------------------------+
       |  Supabase edge functions (4)                         |
       |    list-pending-customers  → carga + counts + WL     |
       |    update-whitelist        → escribe metafields + WL |
       |    approve-customer        → flip tag, dispara W2    |
       |    reject-customer         → motivo+fecha, flip, W3  |
       |  Cada una: 🔒 assertBackofficeTag(approverId)        |
       +-------------------------+----------------------------+
                                 |
                                 | Admin API GraphQL 2025-10
                                 v
                            Shopify Store
```

### Archivos en código

| Pieza | Path | Líneas aprox |
|---|---|---|
| Template | `templates/page.admin-backoffice.json` | — |
| Section 1/3 — Resumen | `sections/admin-backoffice-resumen.liquid` | 110 |
| Section 2/3 — Whitelist | `sections/admin-backoffice-whitelist.liquid` | 63 |
| Section 3/3 — Pendientes | `sections/admin-backoffice-pendientes.liquid` | 85 |
| JS | `assets/admin-backoffice.js` | — |
| CSS | `assets/admin-backoffice.css` | — |
| Edge functions | `supabase/functions/{list-pending-customers,update-whitelist,approve-customer,reject-customer}/index.ts` | — |
| Script de creación del Customer técnico | `scripts/create-backoffice-customer.mjs` | — |

### Las 3 sections

**1. `admin-backoffice-resumen.liquid` (cabecera + HMAC)**:

- Carga `admin-backoffice.css` y `admin-backoffice.js`.
- Renderiza un wrapper raíz con data-attributes:
  - `data-bo-customer-id` (GID del approver).
  - `data-bo-base-url` (settings.backoffice_base_endpoint).
  - `data-bo-timestamp` (unix seconds).
  - `data-bo-signature` (HMAC SHA-256 calculado server-side).
- 4 KPI placeholders (pendiente, aprobado, rechazado, whitelist) — los rellena el JS tras el primer `list-pending-customers`.

**2. `admin-backoffice-whitelist.liquid` (whitelist editor)**:

- Textarea + botón "Añadir a whitelist".
- Submit → edge `update-whitelist`.
- Renderiza la lista actual desde el response de `list-pending-customers`.

**3. `admin-backoffice-pendientes.liquid` (tabla de pendientes)**:

- Tabla con los pendientes (cap 250).
- Por fila: acciones "Aprobar" / "Rechazar" + textarea opcional para motivo de rechazo.

## 3. Contrato de las 4 edge functions

Las cuatro comparten:

| Atributo | Valor |
|---|---|
| Path base | `https://<project-ref>.supabase.co/functions/v1/` |
| Auth | HMAC-SHA256 sobre `<customerId>:<timestamp>` con `BACKOFFICE_HMAC_SECRET`. TTL 600s. Constant-time compare. |
| Verificación adicional | El Customer del HMAC debe tener tag `backoffice` (`assertBackofficeTag`). |
| `verify_jwt` | `false` en `supabase/config.toml`. La auth real es HMAC. |
| Métodos | POST + OPTIONS. CORS abierto. |
| Dry-run | Pasar `dryRun: true` en el body para previsualizar sin side effects. |
| Logs | JSON estructurado sin secrets (`{ level, event, fn, ...fields }`). |

### Códigos de error comunes

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `INVALID_INPUT` | `customerId` / `signature` / body mal formados. |
| 401 | `INVALID_SIGNATURE` | HMAC no coincide con el esperado. |
| 401 | `SIGNATURE_EXPIRED` | timestamp fuera de la ventana de 600s. |
| 403 | `NOT_BACKOFFICE` | Customer del HMAC no tiene tag `backoffice`. |
| 404 | `TARGET_NOT_FOUND` | En approve/reject, el `targetCustomerId` no existe. |
| 409 | `INVALID_STATE` | En approve/reject, el target no tiene tag `pendiente`. |
| 500 | `SHOPIFY_ERROR` | userErrors o HTTP fail al hablar con Admin API. |

### 3.1 `list-pending-customers`

| Campo | Valor |
|---|---|
| Input | `{ customerId, timestamp, signature }` |
| Output | `{ ok, pending: [{ id, email, empresa, nif, sector, fechaRegistro }], pendingTruncated, counts: { pendiente, aprobado, rechazado, whitelist }, whitelist: { emails, lastUpdate } }` |
| Cap | 250 pendientes (los más recientes). `pendingTruncated: true` si hay más. |

**Detalle de `counts`**: usa `customers(first: 250, query: "tag:'X'")` y devuelve `edges.length` por cada estado.

⚠️ **No se usa `customersCount(query:)`** — la API en versión 2025-10 ignora el filtro `query` en `customersCount` y devuelve siempre el total absoluto. Documentado como revisión 5-may-2026 en [D7](adrs/d07-backoffice-page.md). Si en el futuro se añaden edges que necesiten contar customers filtrados, replicar este patrón.

### 3.2 `update-whitelist`

| Campo | Valor |
|---|---|
| Input | `{ customerId, timestamp, signature, emails: "<texto libre>", dryRun? }` |
| Output | `{ ok, added, ignored_duplicates, invalid: [...], total_now, promote_triggered }` |

**Lógica**:

1. Split del input por `\n`, `,`, `;` y espacios.
2. Lowercase + dedup intra-input.
3. Valida cada entrada con regex razonable (email completo o `@dominio`).
4. Merge con la whitelist actual sin duplicar.
5. Escribe `b2b.whitelist_emails` (**tipo `json`**, no `list.*`) + `b2b.whitelist_last_update` (date_time).
6. POST fire-and-forget a `PROMOTE_WHITELIST_FUNCTION_URL` (env var). Si el POST falla, no se reintenta — el cron `promote-whitelist-matches` cada 30 min recoge el slack.

Output: `promote_triggered: true` si el POST salió OK; `false` si falló (el caller sabe que la promoción esperará al cron).

!!! warning "Tipo `json` para superar el límite de 128 entradas"
    Antes de [PR #139](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/139) (28-may-2026) el metafield era `list.single_line_text_field`. Shopify cap esos tipos a **128 entradas**, y al pegar listas más grandes el `metafieldsSet` fallaba. Ahora es `type: "json"` — el formato del valor sigue siendo un array JSON de strings, así que los lectores (`promote-whitelist-matches`, `list-pending-customers`, `readWhitelist`) no se tocaron. Techo efectivo nuevo: ~5 MB del valor (decenas de miles de emails). **No recrear como `list.*`** si en algún re-setup la migración aparece por defecto así.

### 3.3 `approve-customer`

| Campo | Valor |
|---|---|
| Input | `{ customerId, timestamp, signature, targetCustomerId, dryRun? }` |
| Output | `{ ok, customerId, taggedAt, previousTags, newTags }` |

**Lógica**:

1. Comprueba que el target tiene tag `pendiente`. Si no → `409 INVALID_STATE`.
2. `customerUpdate(input: { id, tags: [...] })` **atómico** — reemplaza array de tags, preservando los no-estado y añadiendo `aprobado` (quita `pendiente`).
3. **NO toca metafields ni Company** — esa parte la hace W2.

**Reparto con W2**:
- Edge → cambia tags.
- W2 → setea `b2b.fecha_aprobacion`, llama a `create-company-for-customer`, manda email 4.

### 3.4 `reject-customer`

| Campo | Valor |
|---|---|
| Input | `{ customerId, timestamp, signature, targetCustomerId, motivo?, dryRun? }` |
| Output | `{ ok, customerId, taggedAt, previousTags, newTags, motivoSet }` |

**Lógica**:

1. Comprueba que el target tiene tag `pendiente`.
2. **Antes** del flip: setea `b2b.motivo_rechazo` (si `motivo` no vacío) + `b2b.fecha_rechazo` (date today).
3. `customerUpdate(input: { id, tags: [...] })` atómico — reemplaza array, añade `rechazado`, quita `pendiente`.

**Reparto con W3**: edge setea motivo+fecha+flip; W3 manda email 5 leyendo `b2b.motivo_rechazo`.

## 4. Reparto edge function ↔ Shopify Flow

| Acción | Hace la edge | Lo hace Flow |
|---|---|---|
| Aprobar | Flip atómico `pendiente → aprobado`. | W2 setea `b2b.fecha_aprobacion`, invoca `create-company-for-customer`, manda email 4. |
| Rechazar | Setea `b2b.motivo_rechazo` (si motivo) + `b2b.fecha_rechazo` **antes** del flip. Luego flip atómico `pendiente → rechazado`. | W3 manda email 5 leyendo `motivo_rechazo`. |
| Whitelist | Mergea, dedup, valida, escribe `b2b.whitelist_emails` + `b2b.whitelist_last_update`. POST fire-and-forget a `promote-whitelist-matches`. | Nada — la edge dispara la promoción directa, sin esperar al cron. |

**Por qué este reparto**: evitar duplicar trabajo. Si la edge también seteara la fecha y llamara a `create-company-for-customer`, y W2 hiciera lo mismo, habría carrera entre ambas y la Company creada por la edge sería sobreescrita por la idempotencia de W2. Mejor que la edge haga UNA cosa (cambiar tag) y Flow detecte el cambio y siga.

### Por qué `customerUpdate(input: { tags })` y no `tagsAdd` + `tagsRemove`

`CustomerInput.tags` (Admin API 2025-10) reemplaza el array de tags **atómicamente** ("Updating tags overwrites any existing tags").

El plan B (`tagsAdd ['aprobado']` antes que `tagsRemove ['pendiente']`) deja al customer un instante con dos state tags simultáneos (`pendiente` Y `aprobado`), que viola la invariante "exactamente uno de los tres tags" descrita en [01-data-model](01-data-model.md) §2.

> **Nota para `audit-customer-state.js`**: si en algún momento se cambia a plan B, el script puede ver el estado transitorio si corre en el milisegundo malo. Eso **no es bug** — la edge function termina el cambio en su segunda call. No actualizar el script para "tolerar" ese estado pensando que es un fallo de invariante.

## 5. Modelo de auth detallado

Coherente con el patrón de `submit-order-request` y `list-order-requests`.

### Flujo técnico

1. **Theme renderiza HMAC**. La section `admin-backoffice-resumen.liquid` calcula:
   ```liquid
   {%- assign customer_gid = 'gid://shopify/Customer/' | append: customer.id -%}
   {%- assign now_ts = 'now' | date: '%s' -%}
   {%- assign hmac_payload = customer_gid | append: ':' | append: now_ts -%}
   {%- assign hmac_sig = hmac_payload | hmac_sha256: settings.backoffice_hmac_secret -%}
   ```
2. **Escribe los 3 valores** en `data-bo-customer-id`, `data-bo-timestamp`, `data-bo-signature` del wrapper raíz.
3. **`assets/admin-backoffice.js` los lee** y los manda en cada request POST como `{ customerId, timestamp, signature }`.
4. **Cada edge function**:
   - Recalcula HMAC con `BACKOFFICE_HMAC_SECRET` (env) y compara constant-time.
   - Verifica TTL ≤ 600s.
   - Resuelve el Customer y verifica `tags.includes('backoffice')`.
5. Si algo falla → 401/403. El JS muestra "La sesión ha expirado, recarga la página" para `SIGNATURE_EXPIRED`.

### Por qué este modelo y no token efímero

El blast radius del HMAC backoffice es alto pero acotado: solo permite operar **como ese approver concreto**. Para escalar a "robar identidad y operar como otro" haría falta capturar el HMAC mid-flight (TLS protege) o forzar al approver a firmar payloads ajenos (CSRF — mitigado: cada section render trae un timestamp distinto y la TTL es 600s).

Si en el futuro hay varios staff con permisos distintos, se puede migrar a token JWT corto emitido por una edge intermedia sin romper el contrato actual.

## 6. Theme settings y secrets

### Theme settings (`config/settings_data.json`)

| Setting | Valor | Para qué |
|---|---|---|
| `backoffice_base_endpoint` | `https://<project-ref>.supabase.co/functions/v1/` | Base URL — el JS añade el nombre de cada función. **Debe terminar en `/`**. |
| `backoffice_hmac_secret` | (64 hex) | **DEBE coincidir** con `BACKOFFICE_HMAC_SECRET` en Supabase. |

### Supabase env vars

| Env | Para qué |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Idem que las otras edge functions. |
| `SHOPIFY_ADMIN_TOKEN` | Idem. Scopes ya cubren read/write_customers + metafields. |
| `SHOPIFY_API_VERSION` | Opcional. Default `2025-10`. |
| `BACKOFFICE_HMAC_SECRET` | **DEBE coincidir** con `settings.backoffice_hmac_secret`. |
| `PROMOTE_WHITELIST_FUNCTION_URL` | Opcional. URL de `promote-whitelist-matches` para disparar tras `update-whitelist`. Si está vacío, la re-evaluación esperará al cron de pg_cron (≤30 min). |

Comando de setup:

```bash
supabase secrets set \
  BACKOFFICE_HMAC_SECRET=<64-hex> \
  PROMOTE_WHITELIST_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/promote-whitelist-matches \
  --project-ref <project-ref>

supabase functions deploy \
  list-pending-customers update-whitelist approve-customer reject-customer \
  --project-ref <project-ref>
```

Inventario completo de secrets en [14-secrets](14-secrets.md).

## 7. Customer técnico backoffice

### Modelo

El Customer técnico **no representa a una persona física** — es el contenedor del tag `backoffice` que da acceso a la página. Sus credenciales se comparten con el staff autorizado.

Email transitorio durante desarrollo: `daniel.pena+backoffice@creacciones.es`. Para el cliente final se sustituye antes de la entrega.

### Creación

Script idempotente: `scripts/create-backoffice-customer.mjs`.

```bash
# Dry-run primero
SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_xxx \
node scripts/create-backoffice-customer.mjs

# Aplicar
node scripts/create-backoffice-customer.mjs --apply
```

Email por defecto: `daniel.pena+backoffice@creacciones.es`. Override:

```bash
BACKOFFICE_CUSTOMER_EMAIL=staff@cliente.com \
node scripts/create-backoffice-customer.mjs --apply
```

Tras crear: en Admin → Customers → buscar el email → "Send account invite". El Customer establece su password y ya puede entrar a `/account/login` y luego a `/pages/admin-backoffice`.

### Cutover al cliente final

Antes de la entrega, el Customer técnico transitorio se sustituye por uno del cliente:

1. **Crear el Customer del cliente** con el email real:
   ```bash
   BACKOFFICE_CUSTOMER_EMAIL=staff@cliente.com \
   node scripts/create-backoffice-customer.mjs --apply
   ```
2. En Admin: Customers → buscar `staff@cliente.com` → Send account invite. El cliente establece su password.
3. **Validar acceso** entrando como ese Customer a `/pages/admin-backoffice`. Verificar KPIs y tabla cargados sin errores.
4. **Quitar tag `backoffice` del Customer transitorio** (`daniel.pena+backoffice@creacciones.es`). Preferible a delete: deja auditoría. O delete si no se quiere preservar la cuenta.

Procedimiento completo en [16-operations-runbook](16-operations-runbook.md) §cutover.

### N staff (futuro)

Cualquier Customer con tag `backoffice` opera la página. El script idempotente puede crearlos uno a uno cambiando el env var. Hoy hay 1 staff operativo; pasar a N no requiere refactor.

## 8. Testing end-to-end

### Setup local

1. Aplicar metafield definitions:
   ```bash
   node scripts/apply-metafield-definitions.mjs --dry-run
   node scripts/apply-metafield-definitions.mjs
   ```
2. Setear secrets en Supabase y deployar las 4 funciones (ver §6).
3. Crear el Customer backoffice (§7).

### Flujo manual de test

1. Login como `daniel.pena+backoffice@creacciones.es` → ir a `/pages/admin-backoffice`.
2. Verificar carga: 4 KPIs, tabla de pendientes, lista actual de whitelist.
3. **Whitelist**: pegar 5 emails (mezcla de válidos, inválidos, duplicados con la lista, duplicados entre sí). Submit. Verificar feedback `added/duplicates/invalid` y que `b2b.whitelist_last_update` se refresca.
4. **Aprobar**: registrar un cliente nuevo desde `/pages/acceso-profesional` ([05-registro-b2b](05-registro-b2b.md)) → entrar al backoffice → aprobar la fila → verificar:
   - Tag `pendiente` fuera, `aprobado` dentro.
   - `b2b.fecha_aprobacion` rellenado por W2.
   - Company creada por `create-company-for-customer` (W2 la llama).
   - Email 4 enviado (la tienda corre en plan Grow desde el cutover del 13-may-2026).
5. **Rechazar**: otro cliente nuevo → desde el backoffice → motivo `"test rejection"` → confirmar → verificar:
   - Tag flip + `b2b.fecha_rechazo` + `b2b.motivo_rechazo`.
   - W3 manda email 5 con el motivo.
6. **Acceso restringido**: logout, login con un Customer aprobado normal (no backoffice) → ir a `/pages/admin-backoffice` → debe ver "Acceso restringido".
7. **Bypass attempt**: en DevTools, falsificar `data-bo-customer-id` con el ID de un aprobado normal y hacer click en aprobar → debe recibir `401 INVALID_SIGNATURE` (HMAC ya no encaja) o `403 NOT_BACKOFFICE`.

### Tests aislados de las edge functions

Con `supabase functions serve` levantado en local, curl con HMAC válida:

```bash
SECRET=<64-hex>
CID="gid://shopify/Customer/123456789"
TS=$(date +%s)
SIG=$(printf "%s:%s" "$CID" "$TS" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:54321/functions/v1/list-pending-customers \
  -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$CID\",\"timestamp\":$TS,\"signature\":\"$SIG\"}"
```

## 9. Gotchas conocidos

### `customersCount(query:)` no respeta filtros

API GraphQL 2025-10 ignora el `query:` en `customersCount`. Devuelve siempre el total absoluto. Solución usada: `customers(first: 250, query:)` + `edges.length`. Documentado en [D7](adrs/d07-backoffice-page.md) §Revisión 5-may-2026.

Para futuras edges que necesiten contar customers filtrados: replicar el patrón con paginación. **No usar `customersCount(query:)`**.

### Locksmith no aplica a `/pages/admin-backoffice`

Locksmith Lock 806866 cubre productos y colección `all`. La página `/pages/admin-backoffice` es page → no la cubre. El gate del theme tampoco la exempt — la protección viene del gate UX `{% if %}` + HMAC server-side.

Si en el futuro alguien añade un Lock Entire Store, tener cuidado: esta página debe quedarse fuera (su gate UX la auto-protege; un Lock genérico la haría inaccesible o introduciría redirects en cascada).

### Tag flip atómico mantiene la invariante

Ver §4. El `customerUpdate(input: { tags })` reemplaza el array atómicamente. Si en el futuro se vuelve a `tagsAdd + tagsRemove`, hay un instante donde el Customer tiene dos state tags. `audit-customer-state.js` puede reportarlo como error duro, pero **no es bug** — la edge termina la operación en su segunda call.

## 10. Pendientes y deuda

- **Bulk actions** (aprobar/rechazar N a la vez): esperar a volumen real. Hoy el caso de uso es 1-5 aprobaciones por sesión, no se justifica.
- **Bug `customersCount(query:)`**: abrir issue Shopify cuando se cierre el resto del proyecto. Hoy convivimos con el workaround.
- **Cap de 250 pendientes**: warning si se excede, el resto no se muestra. Si llega a doler se rediseña con paginación o filtros.
- **N staff con permisos distintos** (no en esta fase): si en el futuro se requiere "este puede aprobar pero no editar whitelist", migrar a Opción A (token JWT corto) sin romper el contrato actual.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
