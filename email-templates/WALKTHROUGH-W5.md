# W5 · Solicitud B2B creada — walkthrough

Flow que dispara los 2 emails (cliente + backoffice) al crearse un draft
order con tag `solicitud-b2b`. El draft lo crea la edge function
`submit-order-request` desde el storefront `/pages/solicitud`.

> **Lección Fase B repetida en W5**: Flow Liquid sandbox (el que se usa
> en Subject/To/Body de `Send internal email`) no accede a metafields
> dotted (`draftOrder.customer.metafields.b2b.empresa` → error
> "b2b no es válido"), ni a `draftOrder.note` directamente. Solución:
> un step `Run code` antes de los emails que aplana esos campos en
> `runCode.xxx`. Los `Send marketing mail` (email 07 al cliente) SÍ
> aceptan metafields directos porque usan Messaging Liquid, que es
> otro sandbox.

## 1. Crear el workflow

Apps → Flow → Create workflow → Start from scratch.

## 2. Trigger

- **Trigger**: `Draft order created`
- Sin customizar nada más.

## 3. Condicion / filtro

- Action: **Check if**
- Condition: `Draft order → Tags → contains → solicitud-b2b`
- Rama **Then** → sigue el flujo.
- Rama **Otherwise** → fin (no hacer nada).

## 4. Step: Run code (aplanar campos para los emails)

En la rama Then, añadir `Run code` (description libre, p.ej.
"Flatten draftOrder fields"):

```javascript
export default function main({ draftOrder }) {
  var customer = (draftOrder && draftOrder.customer) || {};
  var metafields = customer.metafields || [];

  function getMf(key) {
    for (var i = 0; i < metafields.length; i++) {
      var m = metafields[i];
      if (m && m.namespace === 'b2b' && m.key === key) {
        return m.value || '';
      }
    }
    return '';
  }

  var attrs = (draftOrder && draftOrder.customAttributes) || [];
  function getAttr(key) {
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      if (a && a.key === key) return a.value || '';
    }
    return '';
  }

  return {
    empresa: getMf('empresa') || (customer.displayName || ''),
    nif: getMf('nif'),
    sector: getMf('sector') || '—',
    cbmTotal: getAttr('cbm_total') || '0',
    note: (draftOrder && draftOrder.note2) || '',
    customerEmail:
      (customer.defaultEmailAddress && customer.defaultEmailAddress.emailAddress) || '',
    customerPhone:
      (customer.defaultPhoneNumber && customer.defaultPhoneNumber.phoneNumber) || '',
    // PR-CURRENCY-C: divisa que el cliente vio en el switcher al enviar.
    // Persiste como customAttribute desde submit-order-request (PR-CURRENCY-B).
    // Si el draft es previo a PR-CURRENCY-B, getAttr devuelve '' → el email
    // backoffice renderiza "no registrada".
    monedaMostrada: getAttr('Moneda mostrada'),
    simboloMoneda: getAttr('Símbolo moneda')
  };
}
```

- **Selecciona entradas** (GraphQL, sustituye el template por defecto):

```graphql
query {
  draftOrder {
    name
    note2
    customAttributes { key value }
    customer {
      displayName
      defaultEmailAddress { emailAddress }
      defaultPhoneNumber { phoneNumber }
      metafields { namespace key value }
    }
  }
}
```

  Notas importantes:
  - `note` NO existe en DraftOrder de Flow — usar `note2` (legacy).
  - `metafields` NO acepta argumento `namespace` en Flow schema — se
    pide el array completo y se filtra en JS (`m.namespace === 'b2b'`).
  - Si algún campo en `customer` (defaultEmailAddress, defaultPhoneNumber)
    da error, quítalo y déjalo vacío; el código devuelve `''` por
    defecto.

- **Definir salidas** (SDL):

```graphql
"Campos aplanados del draftOrder para los emails posteriores."
type Output {
  empresa: String!
  nif: String!
  sector: String!
  cbmTotal: String!
  note: String!
  customerEmail: String!
  customerPhone: String!
  monedaMostrada: String!
  simboloMoneda: String!
}
```

- La salida será accesible en los steps siguientes como `runCode.xxx`.

## 5. Step: Send marketing mail (cliente)

Tras el Run code, añadir `Send marketing mail`:

- **Template**: `B2B · 07 · Solicitud recibida` (ID `10751852872007`,
  ya creado en Messaging).
- **To**: `{{ draftOrder.customer.defaultEmailAddress.emailAddress }}`
  (Flow Liquid sandbox: usar esta ruta, NO `customer.email` que está
  deprecada).

> **Nota plan Grow**: en plan development este step queda como draft y
> no envía. Al pasar a Grow se envía efectivo. Ya documentado en
> `docs/grow-migration-checklist.md`.

## 6. Step: Send internal email (backoffice)

Tras el Send marketing mail, añadir `Send internal email`:

- **To**: `daniel.pena@creacciones.es`  
  (literal hardcoded — ver `docs/hardcoded-emails.md`).

- **Subject**:
  `Nueva solicitud B2B · {{ runCode.empresa }} · {{ draftOrder.name }}`

- **Email body**: pegar el contenido completo de
  `email-templates/07b-backoffice-nueva-solicitud.liquid`. El body ya
  usa `{{ runCode.xxx }}` para empresa, nif, sector, note, emails,
  teléfonos, cbmTotal — no tocar.

## 7. Guardar y activar

- Save workflow.
- Activate (toggle ON).
- Naming sugerido: `W5 · Solicitud B2B creada`.

## 8. Test

1. Desde storefront preview (tema staging con Fase D) con customer
   aprobado: añadir 2 productos al cart → /pages/solicitud → enviar.
2. Verificar en admin → Orders → Drafts que el draft existe con tag
   `solicitud-b2b` + `pendiente-revision`.
3. Apps → Flow → W5 → Runs → verificar ejecución sin errores. El
   paso Run code debería mostrar el output JSON con empresa, nif, etc.
4. El email al backoffice llega (dev plan OK).
5. El marketing mail al cliente queda como draft en
   Marketing → Messaging (se enviará al pasar a Grow).

## Multi-divisa fase 1 (PR-CURRENCY-A + B + C)

Desde mayo 2026 LedsC4 Outlet opera con 3 monedas visibles en el switcher
de cabecera: **EUR (primaria), USD y GBP (referencia visual)**. La
implementación está en 3 piezas:

- **PR-CURRENCY-A v2** — Markets UK y USA activados con
  `localCurrencies = true` y `currencySettings.rateSource = AUTO`. Sin
  Shopify Payments. Las conversiones EUR→GBP y EUR→USD las aplica
  Shopify automáticamente usando los rates oficiales del día. Setup
  one-shot ejecutado vía `scripts/activate-market-currencies.mjs`.
- **PR-CURRENCY-B** — switcher EUR/USD/GBP en `b2b-header` y
  `b2b-header-simple`. Cookie `ledsc4_currency` (30 días) persiste la
  elección. La sección `b2b-solicitud-form` envía `cart.currency.iso_code`
  en el payload a `submit-order-request`, que lo persiste como
  customAttributes `Moneda mostrada` (e.g. `USD`) y `Símbolo moneda`
  (e.g. `$`) en el draft order.
- **PR-CURRENCY-C** (este PR) — los emails W5 leen esos customAttributes:
  - **Email cliente (07)** SOLO muestra el aviso si la divisa es USD o
    GBP. En EUR no se renderiza nada porque la divisa de facturación
    coincide con lo que el cliente vio. En USD/GBP se muestra un bloque
    azul (#f0f5ff fondo + #0051FF acento) con el disclaimer "La moneda
    oficial de la operación es EUR. Las conversiones se muestran como
    referencia visual y no constituyen el precio de facturación".
  - **Email backoffice (07b)** SIEMPRE muestra `Moneda mostrada al
    cliente: XXX (Y)` junto al CBM total, en la tabla de metadatos de
    la solicitud. En EUR: `EUR (€)`. En USD/GBP: `USD ($) — referencia
    visual, facturación en EUR`. Si el customAttribute no existe
    (solicitudes anteriores a PR-CURRENCY-B): `no registrada`.

**Importante**: la factura final SIEMPRE se emite en EUR
independientemente de la divisa que viera el cliente. USD y GBP son
exclusivamente referencia visual mientras navega y solicita; el rate
numérico NO se persiste en el draft order (decisión Dani) porque la
operación se cierra a precio EUR negociado por el comercial.

Si en el futuro se quiere mostrar el rate numérico aplicado en el
momento de la solicitud (e.g. "1 EUR = 0.84 GBP"), habría que añadir
una tercera customAttribute en `submit-order-request` y consumirla aquí.
Por ahora se omite.

## Gotchas conocidas de Flow (lecciones Fase A/B/D)

- **draftOrder** camelCase en sandbox Flow (NO `draft_order`
  snake_case — ese es el alias de Messaging Liquid en los marketing
  mails).
- **Metafields**: no accesibles directamente en Liquid — usar Run code
  para aplanarlos. El array llega como `[{namespace, key, value}, ...]`.
- **`draftOrder.note`** tampoco accesible en Liquid directo. Usar Run
  code. Y ojo: en la schema el campo se llama `note2` (legacy Shopify).
  En Liquid / input GraphQL escribir `note2`; en el output del Run code
  lo renombramos a `note` para los emails.
- **`customer.email`** deprecated. En Flow 2026 usar
  `customer.defaultEmailAddress.emailAddress`.
- **`Send internal email` To**: solo acepta literales, nunca Liquid.
- **`lineItems`** en draftOrder (camelCase); campo es `variantTitle`
  (no `variant_title`) y no expone `line_price` calculado — solo
  `quantity`, `sku`, `title`, `variantTitle`. Para importes, referir
  al CTA "Abrir en admin".
- **`draftOrder.legacyResourceId`**: numérico del draft para
  componer URL admin directa.
