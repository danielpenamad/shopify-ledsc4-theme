# W6 — Walkthrough click-a-click (estado real, verificado contra export .flow)

Configuración real del workflow **W6 - Instaladores** en Shopify Flow,
reconstruida línea a línea contra el export `.flow` real del workflow
(`W6 - Instaladores.flow`, aportado por Dani). Es la pieza de Fase 3 que
genera la oferta PDF y avisa a ventas cuando un **instalador** envía una
solicitud desde el carrito — no existe spec conceptual previa (`W6-*.md`)
como en W1-W4: este documento es la primera fuente de verdad para W6.

> **✅ APLICADO.** El workflow está en producción — no hay nada pendiente
> de aplicar a mano en el Admin. Reconstruido a partir del JSON exportado
> (`···` → Export en el editor de Flow), igual que
> [W1-walkthrough.md](W1-walkthrough.md). Si vuelves a tocar el workflow en
> el Admin, reexporta y compara contra este documento para mantenerlo
> alineado — y actualiza también `flows/W6-instaladores.flow.json` en el
> mismo commit (ver `flows/README.md`).

## Regla de disparo (dos Conditions en cascada)

W6 dispara en **todo** draft order creado, pero solo actúa si pasa dos
filtros consecutivos:

| Condition | Campo | Filtra |
|---|---|---|
| 1 | `draftOrder.tags` incluye `"solicitud-b2b"` | Descarta cualquier draft order que no venga del flujo de solicitud B2B (`submit-order-request`) |
| 2 | `draftOrder.purchasingEntity.Customer.tags` incluye `"instalador"` | Descarta las solicitudes de **distribuidor** — esas siguen el flujo clásico de revisión manual (`b2b-solicitud-detalle.liquid` + backoffice), fuera de este workflow |

El tag `solicitud-b2b` lo pone
[`supabase/functions/submit-order-request/index.ts`](../supabase/functions/submit-order-request/index.ts)
al crear el draft order (`tags: ["solicitud-b2b", "pendiente-revision"]`,
línea ~326) — **para ambos roles**, instalador y distribuidor. El
discriminador real de W6 es la segunda Condition, el tag `instalador` del
customer (el mismo que pone `register-b2b-customer` / W1 — ver
[W1-walkthrough.md](W1-walkthrough.md)).

Solo cuando las dos Conditions dan Verdadero, W6 genera el PDF de la
oferta, avisa a ventas y envía la oferta al instalador. Para una solicitud
de distribuidor, W6 no hace absolutamente nada — el draft sigue su camino
normal de revisión.

## Piezas clave descubiertas

- Para leer los **tags del customer del draft order** en un picker de
  Condition, el path configurado es
  `draftOrder.purchasingEntity.Customer.tags` (no `draftOrder.customer.tags`).
  Distinto del `customer_id` de la acción de marketing mail (Paso 7), que sí
  usa `draftOrder.customer.id` directamente — cada acción de Flow expone el
  entorno a su manera, no asumir que todos los pickers comparten el mismo path.
- Los checks "¿el array de tags incluye X?" se configuran como una
  expresión **ANY** sobre el array (`tags_item` `Incluye` `"valor"`), no
  como una igualdad simple — a diferencia de W1, donde `runCode.sector`
  es un string escalar y usa `==` directo. Usar ANY/Incluye siempre que el
  campo del picker sea un array (tags), no un string.
- La acción **Send HTTP request** expone la respuesta a los pasos
  siguientes como `sendHttpRequest.body` — un **string crudo**, no un
  objeto ya parseado. El Run code siguiente (Paso 5) hace
  `JSON.parse(input.sendHttpRequest.body || "{}")` con try/catch — mismo
  patrón que se necesitaría para consumir cualquier otra respuesta HTTP
  desde Flow (por ejemplo, si en el futuro se quisiera leer la respuesta de
  `create-company-for-customer` en W1, que hoy se ignora).
- `generate-offer-pdf` es **idempotente** (metafield `b2b.pdf_url` en el
  draft como guard, ver comentario de cabecera de
  [`supabase/functions/generate-offer-pdf/index.ts`](../supabase/functions/generate-offer-pdf/index.ts)) —
  relevante porque el HTTP request de W6 (Paso 4) tiene `retry` en error de
  cliente/servidor: un reintento de Flow no duplica el PDF ni desincroniza
  los metafields de "última oferta" del customer.

## Estructura real del workflow

```
Trigger  Draft order created
 └→ Condition  ANY draftOrder.tags item WHERE item Incluye "solicitud-b2b"  [Paso 2]
    ├─ Falso → FIN (no es un draft de solicitud B2B)
    └─ Verdadero
       └→ Condition  ANY draftOrder.purchasingEntity.Customer.tags         [Paso 3]
                     item WHERE item Incluye "instalador"
          ├─ Falso → FIN (solicitud de distribuidor — flujo clásico de
          │          revisión, fuera de este workflow)
          └─ Verdadero
             └→ Send HTTP request → Supabase generate-offer-pdf            [Paso 4]
                (POST, retry en error de cliente/servidor)
                └→ Run code  parseOfferResponse  (runCode)                 [Paso 5]
                   (JSON.parse de sendHttpRequest.body → 14 campos con
                   fallback "": pdf_url/cp/locale/utm_*/total_oferta/
                   nombre/apellidos/email/telefono/nif)
                   └→ Send internal email → Víctor + Joan Carles           [Paso 6]
                      ("Solicitud SLOBs" — datos de contacto + link al PDF)
                      └→ Send marketing mail → instalador                  [Paso 7]
                         (Marketing Activity única, sin ramificar por locale)
```

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**.
2. Rename a **`W6 - Instaladores`** (nombre real del export).

_(Si el workflow ya existe, edítalo en el sitio — no hace falta recrearlo.)_

## Paso 1 — Trigger: Draft order created

1. Select a trigger → `Draft order created`.
2. Done.

## Paso 2 — Condition: ¿el draft es una solicitud B2B?

- Acción: `Condición`.
- Campo: (picker) array `draftOrder.tags`.
- Construir un **¿Alguno?** (ANY) sobre el array: por cada `tags_item`,
  `tags_item` `Incluye` `solicitud-b2b`.

**Rama Falso**: sin acciones — FIN. El draft no viene de
`submit-order-request` (o no tiene el tag por el motivo que sea);
ignorarlo.

**Rama Verdadero**: continúa con el Paso 3.

## Paso 3 — Condition: ¿el customer es instalador?

- Acción: `Condición`.
- Campo: (picker) array `draftOrder.purchasingEntity.Customer.tags`.
- **¿Alguno?** (ANY): por cada `tags_item`, `tags_item` `Incluye`
  `instalador`.

**Rama Falso**: sin acciones — FIN. Solicitud de distribuidor; sigue el
flujo clásico (`b2b-solicitud-detalle.liquid` + revisión de backoffice),
completamente fuera de este workflow.

**Rama Verdadero**: continúa con el Paso 4.

## Paso 4 — Send HTTP request → `generate-offer-pdf`

- **Method**: `POST`
- **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/generate-offer-pdf`
  > Al migrar al Supabase del cliente, cambiar la URL.
- **Headers**: `Content-Type: application/json`, `X-Webhook-Secret: {{secrets.GENERATE_OFFER_PDF_WEBHOOK_SECRET}}`
- **Body**: `{"draftOrderId":"{{draftOrder.id}}"}`
- **On client/server error**: `retry` (ambos).
- Genera el PDF de la oferta, lo sube a Shopify Files, escribe
  `b2b.pdf_url` en el draft y "última oferta" (`ultima_oferta_pdf`/`_ref`/
  `_total`) en el customer. Idempotente — ver "Piezas clave" arriba.

## Paso 5 — Run code `parseOfferResponse` (runCode)

Acción **Ejecutar código**. Flow lo referenciará como `runCode`.

**Panel GRAPHQL** (input query):

```graphql
query {
  shop {
    name
  }
  sendHttpRequest {
    body
  }
}
```

> `shop.name` no se usa en absoluto en el script — vestigio del editor de
> Flow (parece exigir al menos un campo del entorno además de
> `sendHttpRequest`). Inofensivo, no limpiar sin motivo.

**Panel JAVASCRIPT**:

```javascript
export default function main(input) {
  let body = {};
  try { body = JSON.parse(input.sendHttpRequest.body || "{}"); } catch { body = {}; }
  return {
    pdf_url:      body.pdf_url      || "",
    cp:           body.cp           || "",
    locale:       body.locale       || "",
    utm_source:   body.utm_source   || "",
    utm_medium:   body.utm_medium   || "",
    utm_campaign: body.utm_campaign || "",
    total_oferta: body.total_oferta || "",
    utm_term:     body.utm_term     || "",
    utm_content:  body.utm_content  || "",
    nombre:       body.nombre       || "",
    apellidos:    body.apellidos    || "",
    email:        body.email        || "",
    telefono:     body.telefono     || "",
    nif:          body.nif          || ""
  };
}
```

**Panel SDL** (output schema):

```graphql
type Output {
  pdf_url: String!
  cp: String!
  locale: String!
  utm_source: String!
  utm_medium: String!
  utm_campaign: String!
  total_oferta: String!
  utm_term: String!
  utm_content: String!
  nombre: String!
  apellidos: String!
  email: String!
  telefono: String!
  nif: String!
}
```

> Los 14 campos son el passthrough completo de `generate-offer-pdf` (ver
> comentario de cabecera "Output" en
> [`supabase/functions/generate-offer-pdf/index.ts`](../supabase/functions/generate-offer-pdf/index.ts)) —
> `nombre`/`apellidos`/`email`/`telefono`/`nif` se añadieron específicamente
> para que el email del Paso 6 pueda incluir los datos de contacto del
> instalador.

## Paso 6 — Send internal email → aviso "Solicitud SLOBs"

- **To**: `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
  > Mismos destinatarios que los emails internos de W1 — ver
  > [W1-walkthrough.md](W1-walkthrough.md), Paso 6.
- **Subject**: `Solicitud SLOBs – {{runCode.total_oferta}} – {{runCode.cp}} – {{draftOrder.name}}`
- **Body** (literal, del `.flow` real):
  ```
  Nueva solicitud de oferta de instalador.
    - Nº solicitud: {{draftOrder.name}}
    - Importe estimado: {{runCode.total_oferta}}
    - CP instalador: {{runCode.cp}}
    - Nombre: {{runCode.nombre}} {{runCode.apellidos}}
    - Email: {{runCode.email}}
    - Teléfono: {{runCode.telefono}}
    - CIF/NIF: {{runCode.nif}}
    - Oferta (PDF): {{runCode.pdf_url}}
    
  Atribución (UTMs): {{runCode.utm_source}} / {{runCode.utm_medium}} / {{runCode.utm_campaign}}
  Término: {{runCode.utm_term}} · Contenido: {{runCode.utm_content}}
  ```

## Paso 7 — Send marketing mail → oferta lista (instalador)

- **Marketing Activity**: `gid://shopify/MarketingActivity/204733972807` —
  **única, sin ramificar por locale** (a diferencia de los templates 01/02
  de W1, que sí tienen 3 variantes ES/FR/EN — ver
  [W1-walkthrough.md](W1-walkthrough.md), Paso 6). Si se quiere paridad de
  idioma con W1, falta añadir el mismo patrón de Condition por
  `customer.locale` con 3 Marketing Activities.
- **Customer**: `draftOrder.customer.id` — el instalador que envió la
  solicitud, no el remitente del email del Paso 6.
- La plantilla lee los metafields "última oferta" que `generate-offer-pdf`
  escribe en el customer (`b2b.ultima_oferta_pdf`/`_ref`/`_total`) —
  necesario porque las plantillas de Shopify Messaging **no reciben
  contexto de draft order** directamente (ver comentario de cabecera de
  `generate-offer-pdf/index.ts`, sección "Metafields del CUSTOMER").

**FIN del workflow.** No hay más pasos tras el marketing mail.

---

## Paso 8 — Guardar, activar y exportar

1. **Save**.
2. Toggle **Turn on** / Activar.
3. `···` → **Export** → guardar en `flows/W6-instaladores.flow.json`
   (hecho en el mismo commit que este documento).

## Verificación end-to-end

- **Solicitud de instalador** (draft con tags `solicitud-b2b` +
  `pendiente-revision`, customer con tag `instalador`): genera el PDF,
  llega el email "Solicitud SLOBs" a Víctor + Joan Carles, y el marketing
  mail al instalador con el enlace a su oferta.
- **Solicitud de distribuidor** (mismo tag `solicitud-b2b`, customer SIN
  tag `instalador`): W6 no hace nada — la Condition del Paso 3 corta ahí.
  Sigue el flujo clásico: aparece en `b2b-solicitud-detalle.liquid` /
  `mis-solicitudes` y en el backoffice para revisión manual.
- **Draft order que no es una solicitud B2B** (creado por otra vía, sin
  tag `solicitud-b2b` — p.ej. un draft manual desde Admin): W6 no hace
  nada — la Condition del Paso 2 corta ahí.
- **Reintento de Flow tras error transitorio** en el `Send HTTP request`
  del Paso 4: `generate-offer-pdf` es idempotente — no regenera el PDF ni
  duplica los metafields de "última oferta" (ver "Piezas clave").
