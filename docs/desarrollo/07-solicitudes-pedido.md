# 07 · Solicitudes de pedido

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Describe la Fase D del portal: el sustituto del checkout nativo. El Customer aprobado arma su carrito, lo envía como **solicitud** (no como pedido), y un humano del backoffice lo revisa antes de convertirlo en orden real.

Cubre:

- Las 3 páginas que ve el Customer (`/pages/solicitar-pedido`, `/pages/mis-solicitudes`, `/pages/solicitud-detalle`).
- La 4ª página de confirmación post-submit (`/pages/solicitud-enviada`).
- Las 2 edge functions (`submit-order-request`, `list-order-requests`).
- Los 4 estados del Draft Order y su mapeo.
- Hook con Shopify Flow W5 y los 2 emails que dispara.
- Por qué el checkout nativo está deshabilitado y cómo se hace cumplir.

No cubre:

- Custom attributes y tags del Draft Order → ya documentados exhaustivamente en [01-data-model](01-data-model.md) §8.
- Cómo el backoffice revisa/aprueba/cancela una solicitud → [operador/](../operador/index.md) (eje aparcado).
- Multicurrency en detalle → [10-multicurrency](10-multicurrency.md) y [D13](adrs/d13-multicurrency.md).
- Emails transaccionales en detalle → [08-emails-transaccionales](08-emails-transaccionales.md).

## 1. Resumen ejecutivo

El checkout estándar de Shopify es **inalcanzable** para Customers B2B aprobados. En su lugar:

1. El Customer arma su carrito como siempre (`/cart`).
2. En lugar de "Comprar", el botón le manda a `/pages/solicitar-pedido`.
3. Allí confirma su comentario opcional y envía la solicitud.
4. La edge `submit-order-request` crea un `Draft Order` con tags `solicitud-b2b` + `pendiente-revision`.
5. El backoffice lo revisa en Admin → Orders → Drafts y decide qué hacer con él.
6. El Customer puede ver sus solicitudes históricas en `/pages/mis-solicitudes`.

Decisión arquitectónica: el flujo B2B real necesita revisión humana antes de tramitar (descuentos negociados, comprobar stock real, validar dirección de entrega, etc.). El checkout nativo no permite ese gate sin instalar apps de pago, así que se sustituye por solicitudes.

Cross-link: [D13](adrs/d13-multicurrency.md) describe Currency-B, que añade información de divisa mostrada al Draft Order para que el backoffice pueda interpretar el precio que vio el comprador.

## 2. Arquitectura

### Mapa de archivos

| Pieza | Path |
|---|---|
| Section "formulario de solicitud" | `sections/b2b-solicitud-form.liquid` (278 líneas) |
| Section "mis solicitudes" (lista) | `sections/b2b-mis-solicitudes.liquid` (356 líneas) |
| Section "detalle de solicitud" | `sections/b2b-solicitud-detalle.liquid` |
| Section "solicitud enviada" (confirmación) | `sections/b2b-solicitud-enviada.liquid` |
| Templates | `templates/page.solicitar-pedido.json`, `page.mis-solicitudes.json`, `page.solicitud-detalle.json`, `page.solicitud-enviada.json` |
| Edge submit | `supabase/functions/submit-order-request/index.ts` |
| Edge list | `supabase/functions/list-order-requests/index.ts` |
| Email cliente | `email-templates/07-solicitud-b2b-recibida.liquid` |
| Email backoffice | `email-templates/07b-backoffice-nueva-solicitud.liquid` |
| Flow walkthrough | `email-templates/WALKTHROUGH-W5.md` |

### Diagrama del flujo

```
        +-------------------+
        |  Customer aprobado |
        +---------+---------+
                  |
                  | arma carrito (/cart estándar)
                  v
        +-----------------------------+
        |  /pages/solicitar-pedido    |
        |  b2b-solicitud-form         |
        |  - Resumen del carrito      |
        |  - Textarea comentario      |
        |  - HMAC + customerId hidden |
        +-----+-----------------------+
              |
              | POST { customerId, timestamp, signature,
              |        note, items, currencyCode, force? }
              v
        +-----------------------------+        +--------------------+
        |  submit-order-request       | ─────► |  Shopify Admin API |
        |  - Verifica HMAC + TTL      |        |  draftOrderCreate  |
        |  - Verifica tag aprobado    |        +---------+----------+
        |  - Dedup 60min              |                  |
        |  - Calcula cbm_total        |                  v
        |  - Crea draft order         |        +--------------------+
        +-----+-----------------------+        |  Draft Order       |
              |                                |  tags:             |
              |                                |  - solicitud-b2b   |
              |                                |  - pendiente-      |
              |                                |    revision        |
              v                                +---------+----------+
        +-----------------------------+                  |
        |  /pages/solicitud-enviada   |                  | trigger
        |  ?ref=DXXXX                 |                  v
        +-----------------------------+        +--------------------+
                                               |  Shopify Flow W5   |
                                               |  - Flatten fields  |
        +-----------------------------+        |  - Email 07 cliente|
        |  /pages/mis-solicitudes     |◄──┐    |  - Email 07b BO    |
        |  b2b-mis-solicitudes        |   │    +--------------------+
        |  fetch list-order-requests  |   │
        +-----+-----------------------+   │ filtrado por customer_id
              |                           │  + tag solicitud-b2b
              | click ref                 │
              v                           │
        +-----------------------------+   │
        |  /pages/solicitud-detalle   |───┘
        |  ?ref=DXXXX                 |
        |  fetch list-order-requests  |
        |  con ref=                   |
        +-----------------------------+
```

## 3. Las 4 páginas

### `/pages/solicitar-pedido` — formulario de envío

Section `b2b-solicitud-form.liquid`. Lo que renderiza:

- Resumen del carrito (line items + cantidades + subtotal).
- Textarea de comentario opcional.
- Hidden inputs con los valores HMAC server-side:
  - `customerId` (GID del Customer logueado).
  - `timestamp` (`'now' | date: '%s'` Liquid).
  - `hmac` (`hmac_sha256` Liquid filter sobre `<customerId>:<timestamp>` con `settings.order_request_hmac_secret`).
- `currencyCode` y símbolo derivados de la moneda activa (Currency-B).
- Botón "Confirmar y enviar solicitud".

Al hacer submit, JS envía POST a `settings.order_request_endpoint`. En éxito redirige a `/pages/solicitud-enviada?ref=<draftName>`.

### `/pages/solicitud-enviada` — confirmación post-submit

Section `b2b-solicitud-enviada.liquid`. Página simple de "Tu solicitud ha sido recibida". Lee `?ref=DXXXX` para mostrar el identificador del draft.

### `/pages/mis-solicitudes` — historial del Customer

Section `b2b-mis-solicitudes.liquid`. Lo que hace:

1. Renderiza un wrapper con data-attributes: `customerId`, `timestamp`, `signature`, `baseUrl`.
2. El JS llama a `list-order-requests` con esos valores.
3. Renderiza la respuesta como tabla con badges de estado.

### `/pages/solicitud-detalle` — vista de una solicitud

Section `b2b-solicitud-detalle.liquid`. Llega con `?ref=DXXXX`. El JS llama a `list-order-requests?ref=DXXXX` y renderiza:

- Items con título, variante, SKU, cantidad, precio unitario, total.
- Comentario del Customer.
- Estado y fechas.

## 4. Estados del Draft Order

El estado se infiere de los **tags** del draft. Exactamente uno de los 4 estados está activo en cualquier momento (los tags son mutuamente excluyentes).

| Estado | Tag | Significado | Quién lo aplica |
|---|---|---|---|
| `pendiente-revision` | `pendiente-revision` | Default al crearse. Aún no revisado. | edge `submit-order-request`. |
| `en-tramite` | `en-tramite` | Backoffice está trabajando en él (pidiendo confirmación, ajustando precios, etc.). | Operativa manual en Admin. |
| `confirmada` | `confirmada` | Convertida en orden real. | Operativa manual al hacer "Convert to order" o equivalente. |
| `cancelada` | `cancelada` | Descartada (cliente no confirmó, sin stock, etc.). | Operativa manual. |

El **tag `solicitud-b2b` es permanente** (identificador de categoría). Permite filtrar Draft Orders generados por este flujo vs los creados manualmente por staff.

### Mapeo en `list-order-requests`

La edge mapea tags → estado vía función `mapStatus(tags)`:

```javascript
function mapStatus(tags) {
  if (tags.includes("cancelada")) return "cancelada";
  if (tags.includes("confirmada")) return "confirmada";
  if (tags.includes("en-tramite")) return "en-tramite";
  if (tags.includes("pendiente-revision")) return "pendiente-revision";
  return "pendiente-revision"; // default safe
}
```

Orden de prioridad: si por error un draft tuviera dos state tags simultáneos, gana el más avanzado en el flujo (`cancelada` > `confirmada` > `en-tramite` > `pendiente-revision`). El default safe es `pendiente-revision`.

## 5. Contrato de `submit-order-request`

Detalles completos del Draft Order resultante (tags, custom attributes) en [01-data-model](01-data-model.md) §8. Aquí solo el contrato de la edge.

| Atributo | Valor |
|---|---|
| Path | `POST https://<project-ref>.supabase.co/functions/v1/submit-order-request` |
| Auth | HMAC-SHA256 sobre `<customerId>:<timestamp>` con `ORDER_REQUEST_HMAC_SECRET`. TTL 600s. |
| Verificación adicional | El Customer debe tener tag `aprobado` (no solo backoffice, no solo pendiente). |
| Dedup | 60 min — si el Customer ya tiene un draft con tag `pendiente-revision` creado en esa ventana, devuelve `warning: "recent_request"` sin crear. |

### Input

```json
{
  "customerId": "gid://shopify/Customer/...",
  "timestamp": 1747300000,
  "signature": "<64 hex>",
  "note": "Texto libre opcional, max 1000 chars",
  "items": [
    { "variantId": "gid://shopify/ProductVariant/...", "quantity": 2 }
  ],
  "currencyCode": "EUR",
  "force": false
}
```

`force: true` salta el dedup (para confirmar tras ver el warning).

### Output

**Éxito** (200):

```json
{
  "ok": true,
  "draftOrderId": "gid://shopify/DraftOrder/...",
  "draftOrderName": "D1042",
  "cbmTotal": 1.234
}
```

**Warning de duplicado** (200, no se ha creado nada):

```json
{
  "warning": "recent_request",
  "message": "Tienes una solicitud muy reciente. ¿Seguro que quieres enviar otra?",
  "recentDraft": {
    "id": "gid://shopify/DraftOrder/...",
    "name": "D1041",
    "createdAt": "2026-05-14T18:30:00Z"
  }
}
```

**Errores comunes**:

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `invalid_customerId` / `invalid_timestamp` / `invalid_signature_format` / `empty_cart` / `invalid_line_item` | Body mal formado. |
| 401 | `signature_expired` | timestamp fuera de 600s. UI debe pedir refresh. |
| 401 | `invalid_signature` | HMAC no coincide. |
| 403 | `customer_not_approved` | El Customer no tiene tag `aprobado`. |
| 404 | `customer_not_found` | El `customerId` no resuelve. |
| 500 | `draftOrderCreate_userErrors` | Shopify devolvió userErrors al crear el draft. |

### Lógica interna

1. Parse + validate input.
2. HMAC verify (TTL 600s, constant-time compare).
3. Fetch Customer + verificar tag `aprobado`.
4. Dedup check (salvo `force: true`).
5. Fetch variantes + sus `product.b2b.cbm_caja`. Calcular `cbm_total = Σ (qty × cbm_caja)`, 3 decimales.
6. `draftOrderCreate(input: {...})` con line items, tags `solicitud-b2b` + `pendiente-revision`, note, customAttributes (ver [01-data-model](01-data-model.md) §8).
7. Devuelve `{ ok, draftOrderId, draftOrderName, cbmTotal }`.

## 6. Contrato de `list-order-requests`

| Atributo | Valor |
|---|---|
| Path | `https://<project-ref>.supabase.co/functions/v1/list-order-requests` |
| Métodos | GET o POST. GET para refrescos sin payload, POST para detalle. |
| Auth | Mismo HMAC que `submit-order-request` (mismo secret, misma TTL). |
| Modos | Lista (`/`) o detalle (`?ref=DXXXX`). |
| Filtro server-side | `customer_id:N AND tag:solicitud-b2b`. Un Customer **solo ve sus drafts**. |

### Modo lista

GET: `?customerId=GID&timestamp=N&signature=HEX`.

Output:

```json
{
  "items": [
    {
      "id": "gid://shopify/DraftOrder/...",
      "name": "D1042",
      "createdAt": "2026-05-14T18:30:00Z",
      "status": "pendiente-revision",
      "totalItems": 12,
      "totalPrice": "1234.56"
    }
  ]
}
```

Cap: 50 solicitudes más recientes. Sin paginación adicional (si llega a hacer falta, se añade `before` cursor en el futuro).

### Modo detalle

GET: `?customerId=GID&timestamp=N&signature=HEX&ref=D1042`.

Output:

```json
{
  "id": "gid://shopify/DraftOrder/...",
  "name": "D1042",
  "createdAt": "2026-05-14T18:30:00Z",
  "status": "pendiente-revision",
  "note": "Comentario del cliente",
  "totalPrice": "1234.56",
  "subtotalPrice": "1020.00",
  "customAttributes": [
    { "key": "fuente", "value": "solicitud-b2b-frontend" },
    { "key": "cbm_total", "value": "1.234" },
    { "key": "fecha_solicitud", "value": "2026-05-14T18:30:45.123Z" },
    { "key": "Moneda mostrada", "value": "EUR" },
    { "key": "Símbolo moneda", "value": "€" }
  ],
  "lineItems": [
    {
      "title": "...",
      "variantTitle": "...",
      "quantity": 2,
      "sku": "...",
      "unitPrice": { "amount": "510.00", "currencyCode": "EUR" },
      "totalPrice": { "amount": "1020.00", "currencyCode": "EUR" }
    }
  ]
}
```

Si `ref` no existe o no pertenece al Customer → `404 not_found`.

Cap: 100 line items por solicitud. Más allá, sin paginación (deuda).

### Errores comunes

Mismos códigos que `submit-order-request`. Adicionalmente:

| HTTP | `error` | Cuándo |
|---|---|---|
| 404 | `not_found` | El `ref` no resuelve o no pertenece al Customer. |
| 405 | `method_not_allowed` | Método distinto de GET/POST/OPTIONS. |

## 7. Hook con Shopify Flow W5

Detalle en [08-emails-transaccionales](08-emails-transaccionales.md). Resumen:

| Pieza | Valor |
|---|---|
| Trigger | `Draft order created`. |
| Condition | `Tags contains 'solicitud-b2b'`. |
| Step 1 (Run code) | "Flatten draftOrder fields" — aplana `draftOrder.customer.metafields.b2b.empresa` a `runCode.empresa`, etc. Necesario porque el sandbox Liquid de Flow no soporta dotted access a metafields. |
| Step 2 (Send marketing email) | Email 07 al Customer (`07-solicitud-b2b-recibida.liquid`). El sandbox de Messaging sí soporta metafields directos. |
| Step 3 (Send internal email) | Email 07b al backoffice (`07b-backoffice-nueva-solicitud.liquid`). **Body inline**, To hardcoded — limitación de Flow. Subject: `Nueva solicitud B2B · {{ runCode.empresa }} · {{ draftOrder.name }}`. |

**Por qué Run Code intermedio**: el sandbox Liquid de Flow no parsea `draftOrder.customer.metafields.b2b.empresa` con notación dotted. El step de Run Code lo aplana a campos planos (`runCode.empresa`, `runCode.nif`, etc.) que sí se pueden interpolar en el subject del email interno. El email al cliente usa Messaging Liquid (otro sandbox) que sí acepta metafields, así que ese no necesita el flatten.

## 8. Checkout deshabilitado

Cómo se hace cumplir: el [04-storefront-gate](04-storefront-gate.md) tiene una rama específica.

```liquid
{%- elsif customer.tags contains 'aprobado' -%}
  {%- if gate_path contains '/checkout' -%}
    <script>window.location.replace({{ routes.cart_url | json }});</script>
  {%- endif -%}
```

Un Customer aprobado que llegue a `/checkout` (por bookmark, link directo, edición de URL) se redirige al carrito. Allí el botón "Comprar" del theme estándar ha sido reemplazado por uno que apunta a `/pages/solicitar-pedido`.

Esto es una capa más en el gate, no un comportamiento nuevo aquí — pero es relevante para entender por qué la solicitud es la única vía de salida desde el carrito.

## 9. Theme settings y secrets

### Theme settings

| Setting | Valor | Para qué |
|---|---|---|
| `order_request_endpoint` | `https://<project-ref>.supabase.co/functions/v1/submit-order-request` | URL del POST de envío. |
| `order_request_hmac_secret` | (64 hex) | **DEBE coincidir** con `ORDER_REQUEST_HMAC_SECRET` en Supabase. |

### Supabase env vars

| Env | Para qué |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Idem otras edges. |
| `SHOPIFY_ADMIN_TOKEN` | Scopes: `read_customers`, `write_draft_orders`, `read_products`. |
| `SHOPIFY_API_VERSION` | Opcional. Default `2025-10`. |
| `ORDER_REQUEST_HMAC_SECRET` | DEBE coincidir con `settings.order_request_hmac_secret`. |

Inventario completo en [14-secrets](14-secrets.md).

## 10. Currency-B (multicurrency)

Detalle en [10-multicurrency](10-multicurrency.md) y [D13](adrs/d13-multicurrency.md). Resumen del impacto en Fase D:

- El form `b2b-solicitud-form.liquid` lee la moneda activa del Customer (Shopify Markets) y la incluye en el POST como `currencyCode`.
- La edge `submit-order-request` la valida contra `["EUR", "USD", "GBP"]`; si llega inválida o ausente → default `EUR`.
- Se persiste como custom attributes `Moneda mostrada` + `Símbolo moneda` en el Draft Order ([01-data-model](01-data-model.md) §8).
- **No se persiste rate numérico** — decisión consciente: el backoffice no necesita recalcular precios, solo saber qué divisa veía el comprador. El rate real lo aplica Shopify Markets en checkout (que aquí no aplica) y, en su lugar, en la conversión a orden real desde el draft.

PR-CURRENCY-A original (tabla `currency_rates` + edge OXR + cron diario) fue **revertido en PR #78** y sustituido por este modelo más simple — está en la sección "obsoleto" del historial.

## 11. Gotchas conocidos

### Dedup 60 min y estados avanzados

El dedup busca drafts con tag `pendiente-revision` (no `solicitud-b2b` solo) creados en los últimos 60 min. **Si un draft pasa a `en-tramite` antes de los 60 min**, el dedup ya no lo detecta — el Customer puede reenviar y crear un segundo draft.

Esto es **comportamiento intencional**: si un draft ya está en trámite (backoffice trabajando), una nueva solicitud del mismo Customer es probablemente legítima (segunda compra en el mismo día). Documentar como esperado, no como bug.

### Customer Account UI Extensions no implementadas

La pantalla de detalles de orden de Customer Account (Shopify-hosted) no muestra los Draft Orders. Mostrar las solicitudes ahí requeriría una Customer Account UI Extension, fuera del scope del theme. La página `/pages/mis-solicitudes` es el sustituto.

### Sin paginación de line items

Cap 100 items por draft en `list-order-requests`. Si un Customer envía una solicitud con > 100 items, el detalle pierde los excedentes. No ha aparecido en producción; deuda menor pendiente.

### Notificación al cliente al cambiar estado

Hoy **no existe**. Cuando el backoffice cambia un draft de `pendiente-revision` a `en-tramite`, `confirmada` o `cancelada`, el Customer **no recibe email**. Identificado como mejora post-MVP en `test-scenarios-fase-d.md` (material crudo).

## 12. Pendientes y deuda

- **Notificación automática al cliente** al cambiar estado del draft. Mejora post-MVP.
- **Validar dedup vs `en-tramite`**: confirmar que la lógica actual (busca solo `pendiente-revision`) es la deseada. Hoy se asume que sí.
- **Paginación de line items**: hoy cap 100. Si llega a doler, añadir `after` cursor a la query GraphQL del detalle.
- **Cap 50 solicitudes** en lista: si un Customer pasa de 50 históricos, el más antiguo desaparece de la vista. Hoy bajo impacto.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
