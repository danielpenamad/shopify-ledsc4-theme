# Página backoffice — Whitelist + Aprobaciones

Esta página `/pages/admin-backoffice` reemplaza dos cosas que vivían en el
admin Shopify:

- **Edición a mano** del shop metafield `b2b.whitelist_emails` (Settings →
  Custom data → Shop → Metafields).
- **Doble cambio de tag** del flujo manual `pendiente → aprobado` /
  `pendiente → rechazado` descrito en
  [docs/backoffice-aprobaciones.md](backoffice-aprobaciones.md).

El motivo principal del cambio es el bug del doble click documentado en
W2: si el staff guarda dos veces (por ejemplo, primero quita `pendiente`
y luego añade `aprobado`), la condición de Flow
`'aprobado' IS IN tags AND 'pendiente' IS IN tags_previous` no se cumple
y W2 puede no disparar — la Company y el email 4 no se generan.

## 1. Cómo se accede

- URL: `/pages/admin-backoffice`.
- **Único requisito**: el customer logueado tiene tag `backoffice`. El
  page template hace `{% if customer.tags contains 'backoffice' %}` para
  decidir qué pintar; los no-backoffice ven una pantalla "Acceso
  restringido".
- **El gate Liquid es UX, NO seguridad.** La verificación real vive en
  cada edge function: cada request lleva un HMAC firmado server-side por
  Liquid, y la edge function vuelve a buscar al approver en la Admin API
  y verifica que tiene tag `backoffice`. Si alguien manipula el DOM o el
  storage del navegador, las edge functions devuelven 403 NOT_BACKOFFICE.

## 2. Arquitectura

```
                 +---------------------------------+
                 |  /pages/admin-backoffice        |
                 |  templates/page.admin-backoffice.json
                 |  ├── admin-backoffice-resumen   |  ← rinde HMAC + carga JS/CSS
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
       |    approve-customer        → flips tag, dispara W2   |
       |    reject-customer         → motivo+fecha, flips, W3 |
       |  Cada una: 🔒 assertBackofficeTag(approverId)        |
       +-------------------------+----------------------------+
                                 |
                                 | Admin API GraphQL 2025-10
                                 v
                            Shopify Store
```

### Reparto edge function ↔ Shopify Flow (W2 / W3)

| Acción | Hace la edge function | Lo hace Shopify Flow |
|---|---|---|
| Aprobar | Cambia tags atómicamente `pendiente→aprobado` (preserva tags no-estado). | W2 setea `b2b.fecha_aprobacion`, llama a `create-company-for-customer`, manda email 4. |
| Rechazar | Setea `b2b.motivo_rechazo` (si hay) + `b2b.fecha_rechazo` ANTES del cambio de tag. Luego cambia tags `pendiente→rechazado`. | W3 manda email 5 leyendo `motivo_rechazo`. |
| Whitelist | Mergea, dedup, valida, escribe `b2b.whitelist_emails` + `b2b.whitelist_last_update`. Dispara `promote-whitelist-matches` por HTTP. | Nada (W4 ya no necesita esperar 30 min para reaccionar). |

**Por qué este reparto:** evitar duplicar trabajo. Si la edge function
también seteara la fecha y llamara a `create-company-for-customer`, y W2
también hiciera lo mismo, hay carrera entre ambas y la Company creada por
la edge function sería sobreescrita-o-saltada por la idempotencia de W2.
Mejor que la edge function haga UNA cosa (cambiar tag) y Flow detecte el
cambio y siga con el resto, que es exactamente para lo que está W2.

### Por qué `customerUpdate(input: { tags })` y no `tagsAdd` + `tagsRemove`

`CustomerInput.tags` (Admin API 2025-10) reemplaza el array de tags
**atómicamente** ("Updating tags overwrites any existing tags",
documentado en
[Shopify Admin GraphQL CustomerInput](https://shopify.dev/docs/api/admin-graphql/2025-10/input-objects/CustomerInput)).

El plan B (`tagsAdd ['aprobado']` antes que `tagsRemove ['pendiente']`)
es funcionalmente seguro porque W2 lee `tags_previous` del snapshot de
antes del cambio, no del estado intermedio — pero deja al customer un
instante con dos state tags simultáneos (`pendiente` Y `aprobado`), que
viola la invariante "exactamente uno de los tres tags" descrita en
[docs/data-model.md §2](data-model.md). Con plan A (atómico) ni siquiera
existe ese estado intermedio.

> **Nota para `audit-customer-state.js`:** si en algún momento se cambia
> a plan B, el script puede ver el estado transitorio (dos state tags) si
> corre en el milisegundo malo. Eso NO es bug — la edge function termina
> el cambio en su segunda call. No actualizar el script para "tolerar"
> ese estado pensando que es un fallo de invariante.

## 3. Contrato de las edge functions

Las cuatro funciones comparten:

- Path base: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/`
- Auth: HMAC-SHA256 sobre `<customerId>:<timestamp>` con `BACKOFFICE_HMAC_SECRET`. TTL 600s.
- Verificación adicional 🔒: el customer del HMAC debe tener tag `backoffice`.
- `verify_jwt = false` en `supabase/config.toml`.
- CORS abierto, métodos POST + OPTIONS.
- Logs JSON sin secrets (formato `{ level, event, fn, ...fields }`).
- `dryRun: true` en el body para previsualizar sin side effects.

### Códigos de error comunes

| HTTP | code | Cuándo |
|---|---|---|
| 400 | `INVALID_INPUT` | customerId/signature/body mal formados |
| 401 | `INVALID_SIGNATURE` | HMAC no coincide con el esperado |
| 401 | `SIGNATURE_EXPIRED` | timestamp fuera de la ventana de 600s |
| 403 | `NOT_BACKOFFICE` | customer del HMAC no tiene tag `backoffice` |
| 404 | `TARGET_NOT_FOUND` | en approve/reject, el target no existe |
| 409 | `INVALID_STATE` | en approve/reject, el target no tiene tag `pendiente` |
| 500 | `SHOPIFY_ERROR` | userErrors o HTTP fail al hablar con Admin API |

### `list-pending-customers`

- **Input** (POST JSON): `{ customerId, timestamp, signature }`.
- **Output**:
  ```json
  {
    "ok": true,
    "pending": [{ "id", "email", "empresa", "nif", "sector", "fechaRegistro" }],
    "pendingTruncated": false,
    "counts": { "pendiente": N, "aprobado": N, "rechazado": N, "whitelist": N },
    "whitelist": { "emails": ["..."], "lastUpdate": "ISO|null" }
  }
  ```
- Cap: 250 pendientes (los más recientes). Si hay más, `pendingTruncated: true` y el JS muestra un warning.
- Counts: vía `customersCount(query: "tag:'X'")` (Admin API 2025-10), exactos sin paginación.

### `update-whitelist`

- **Input**: `{ customerId, timestamp, signature, emails: "<texto libre>", dryRun? }`.
- **Lógica**: split por `\n`, `,`, `;`, espacios; lowercase; dedup intra-input; valida regex razonable; merge con whitelist actual sin duplicar; escribe `b2b.whitelist_emails` + `b2b.whitelist_last_update`; POST a `PROMOTE_WHITELIST_FUNCTION_URL` (env var) — fire-and-forget.
- **Output**: `{ ok, added, ignored_duplicates, invalid: [...], total_now, promote_triggered }`.
- Si W4 (cron 30 min) se queda como única vía, `promote_triggered: false` indica que el cliente aún no se promoverá hasta el siguiente tick.

### `approve-customer`

- **Input**: `{ customerId, timestamp, signature, targetCustomerId, dryRun? }`.
- **Lógica**: comprueba que el target tiene tag `pendiente`; reemplaza tags atómicamente preservando los no-estado y añadiendo `aprobado`.
- **Output**: `{ ok, customerId, taggedAt, previousTags, newTags }`.
- W2 hace fecha + Company + email 4. La edge function NO los toca.

### `reject-customer`

- **Input**: `{ customerId, timestamp, signature, targetCustomerId, motivo?, dryRun? }`.
- **Lógica**: comprueba `pendiente`; setea `b2b.motivo_rechazo` (si motivo no vacío) + `b2b.fecha_rechazo` (date) ANTES del flip; reemplaza tags atómicamente.
- **Output**: `{ ok, customerId, taggedAt, previousTags, newTags, motivoSet }`.
- W3 manda email 5.

## 4. Modelo de auth (Opción B)

Decidida en el plan de la fase BO. Coherente con el patrón de
`submit-order-request` y `list-order-requests`.

1. La sección `admin-backoffice-resumen.liquid` calcula:
   ```liquid
   {%- assign customer_gid = 'gid://shopify/Customer/' | append: customer.id -%}
   {%- assign now_ts = 'now' | date: '%s' -%}
   {%- assign hmac_payload = customer_gid | append: ':' | append: now_ts -%}
   {%- assign hmac_sig = hmac_payload | hmac_sha256: settings.backoffice_hmac_secret -%}
   ```
2. Escribe los tres valores en `data-bo-*` attributes del wrapper raíz.
3. `assets/admin-backoffice.js` los lee y los manda en cada request POST como `{ customerId, timestamp, signature }`.
4. Cada edge function:
   - Recalcula HMAC con su `BACKOFFICE_HMAC_SECRET` (env) y compara constant-time.
   - Verifica TTL ≤ 600s.
   - Resuelve customer y verifica `tags.includes('backoffice')`.
5. Si algo falla → 401/403. El JS muestra "La sesión ha expirado, recarga la página" para SIGNATURE_EXPIRED.

### Por qué no Opción A (token efímero)

El blast radius del HMAC backoffice es alto pero acotado: solo permite
operar **como ese approver concreto**. Para escalar a "robar identidad y
operar como otro" haría falta capturar el HMAC mid-flight (TLS protege)
o forzar al approver a firmar payloads ajenos (CSRF — mitigado por el
hecho de que cada section render trae un timestamp distinto y la TTL es
600s).

Si en el futuro queremos endurecer (por ejemplo, varios staff con
permisos distintos), se migra a Opción A (token JWT corto emitido por
una edge function intermedia) sin romper el contrato actual.

## 5. Variables de entorno y secretos

### Theme (`config/settings_data.json`)

| Setting | Valor por defecto | Para qué |
|---|---|---|
| `backoffice_base_endpoint` | `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/` | Base URL — el JS añade el nombre de cada función. Debe terminar en `/`. |
| `backoffice_hmac_secret` | (64 hex) | DEBE coincidir con `BACKOFFICE_HMAC_SECRET` en Supabase. |

### Supabase (`supabase secrets set`)

| Env | Para qué |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Idem que las otras funciones. |
| `SHOPIFY_ADMIN_TOKEN` | Idem. Scopes ya cubren read/write_customers + metafields. |
| `SHOPIFY_API_VERSION` | Opcional. Default 2025-10. |
| `BACKOFFICE_HMAC_SECRET` | DEBE coincidir con `settings.backoffice_hmac_secret`. |
| `PROMOTE_WHITELIST_FUNCTION_URL` | Opcional. URL de `promote-whitelist-matches` para disparar tras update-whitelist. Si está vacío, la re-evaluación esperará al cron de pg_cron (≤30 min). |

Comando de setup:

```bash
supabase secrets set \
  BACKOFFICE_HMAC_SECRET=<64-hex> \
  PROMOTE_WHITELIST_FUNCTION_URL=https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/promote-whitelist-matches \
  --project-ref mbjvmhaglbhnxoccwyex

supabase functions deploy \
  list-pending-customers update-whitelist approve-customer reject-customer \
  --project-ref mbjvmhaglbhnxoccwyex
```

## 6. Setup del customer backoffice

### Cómo crearlo

```bash
# Dry-run primero
SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
SHOPIFY_ADMIN_TOKEN=shpat_xxx \
node scripts/create-backoffice-customer.mjs

# Aplicar
node scripts/create-backoffice-customer.mjs --apply
```

Email por defecto: `daniel.pena+backoffice@creacciones.es`.

Override:

```bash
BACKOFFICE_CUSTOMER_EMAIL=staff@cliente.com \
node scripts/create-backoffice-customer.mjs --apply
```

Tras crear: en Admin → Customers → buscar email → "Send account invite".
El customer pone su password y ya puede entrar a `/account/login` y luego
a `/pages/admin-backoffice`.

### Cutover al cliente final

Antes de la entrega, el customer backoffice se sustituye por uno del
cliente. Pasos:

1. **Crear el customer del cliente** con el email real (ej. `staff@cliente.com`):
   ```bash
   BACKOFFICE_CUSTOMER_EMAIL=staff@cliente.com \
   node scripts/create-backoffice-customer.mjs --apply
   ```
2. En Admin: Customers → buscar `staff@cliente.com` → Send account invite. El cliente pone su password.
3. **Validar acceso** entrando como ese customer a `/pages/admin-backoffice`. Ver KPIs y tabla cargados sin errores.
4. **Eliminar el customer transitorio** (`daniel.pena+backoffice@creacciones.es`):
   - Admin → Customers → buscar email → quitar tag `backoffice` (mejor que delete: deja auditoría).
   - O `delete` si no se quiere preservar la cuenta.
5. Hecho. El cambio es una sola línea de env var (no hay lógica hardcoded).

> Si el cliente quiere varios staff (no en esta fase), el modelo
> aguanta sin refactor: cualquier customer con tag `backoffice` opera la
> página. El script idempotente puede crearlos uno a uno cambiando el
> env var.

## 7. Cómo testear el flujo end-to-end

### Setup local

1. Aplicar metafield definitions:
   ```bash
   node scripts/apply-metafield-definitions.mjs --dry-run
   node scripts/apply-metafield-definitions.mjs
   ```
2. Setear secrets en Supabase y deployar las 4 funciones (ver §5).
3. Crear el customer backoffice (ver §6).

### Flujo manual de test

1. Login como `daniel.pena+backoffice@creacciones.es` → ir a `/pages/admin-backoffice`.
2. Verificar que se cargan: KPIs (pendiente, aprobado, rechazado, whitelist), tabla de pendientes, lista actual de whitelist.
3. **Whitelist**: pegar 5 emails (mezcla de válidos, inválidos, duplicados con la lista, duplicados entre sí). Submit. Verificar que el feedback resume `added/duplicates/invalid` y que `b2b.whitelist_last_update` se refresca.
4. **Aprobar**: registrar un cliente nuevo desde `/pages/acceso-profesional` (form B2B + `b2b-register-v2.js` → edge function `register-b2b-customer`) → entrar al backoffice → aprobar la fila → verificar:
   - Tag `pendiente` fuera, `aprobado` dentro.
   - `b2b.fecha_aprobacion` rellenado por W2.
   - Company creada por `create-company-for-customer` (W2 la llama).
   - Email 4 en draft (Development) o enviado (Grow).
5. **Rechazar**: otro cliente nuevo → desde el backoffice → motivo "test rejection" → confirmar → verificar:
   - Tag flip + `b2b.fecha_rechazo` + `b2b.motivo_rechazo`.
   - W3 manda email 5 con el motivo.
6. **Acceso restringido**: logout, login con un customer aprobado normal (no backoffice) → ir a `/pages/admin-backoffice` → debe ver "Acceso restringido".
7. **Bypass attempt**: en DevTools, falsificar `data-bo-customer-id` con el ID de un aprobado normal y hacer click en aprobar → debe recibir 401 INVALID_SIGNATURE (porque el HMAC ya no encaja) o 403 NOT_BACKOFFICE.

### Tests aislados de las edge functions

Con `supabase functions serve` levantado en local, curl con HMAC válida:

```bash
SECRET=045d25bf60069a3d63ad3556124d1d56ccd8ea044e021bff33bcfa31a0ec3817
CID="gid://shopify/Customer/123456789"
TS=$(date +%s)
SIG=$(printf "%s:%s" "$CID" "$TS" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:54321/functions/v1/list-pending-customers \
  -H "Content-Type: application/json" \
  -d "{\"customerId\":\"$CID\",\"timestamp\":$TS,\"signature\":\"$SIG\"}"
```

## 8. Decisiones tomadas — resumen

- **Customer especial con tag `backoffice`**, no Locksmith. El bug "High-level job failure" con dos locks Entire Store ([ADR D4](historia-decisiones.md#d4)) no compensa añadir más superficie a Locksmith.
- **Liquid `{% if %}` es UX, seguridad server-side**. Cada edge function valida HMAC + tag.
- **1 staff ahora** (n staff sin refactor — la página y las funciones siempre miran el tag).
- **Vista plana** sin paginación ni filtros (cap a 250 con warning si se excede).
- **Trazabilidad mínima**: timestamps, sin actor (no nos importa quién aprobó cuando hay 1 staff).
- **Edge function como tag-flipper atómico**: W2/W3 hacen el resto — sin duplicación, sin carreras.
- **Secret separado** `BACKOFFICE_HMAC_SECRET` (no reutilizar el de solicitudes): el blast radius es distinto.

Detalle expandido en
[ADR D9](historia-decisiones.md#d9-p%C3%A1gina-backoffice-en-theme-con-tag-backoffice).

## 9. Limitaciones conocidas / pendientes

- Cap pendientes a 250. Si pasan de eso, warning y el resto no se muestra. Si duele algún día se rediseña con paginación o filtros — está abierto en `docs/pendientes.md`.
- `audit-customer-state.js` puede ver dos state tags si en algún futuro se cambia a plan B (`tagsAdd` antes que `tagsRemove`); no es bug — ver §2.
- Locksmith no aplica a `/pages/admin-backoffice` (page no es product/collection); el gate de `theme.liquid` exempts pages → la página solo se protege con su propio gate UX + las edge functions.
