# Walkthrough — carga de plantillas en Shopify Email

Guía paso a paso para cargar las 6 plantillas Liquid en Shopify Email.
Tiempo estimado: **15-20 min** (todas juntas, copy-paste).

> Hacer **antes** de activar los Flows W1-W4. Si los Flows se activan sin
> que las plantillas existan, los pasos "Send email" fallarán.

## 0 — Chequeo de capacidades

Abre Admin → **Marketing → Shopify Email**. Si es la primera vez que la
usas, te pide habilitar (gratis hasta 10k emails/mes).

Confirma que puedes crear plantillas custom:
- Topnav: **Emails** / **Templates** (nombre varía por plan).
- Si ves "Create template" o "Save as template", estás listo.
- Si solo ves templates prediseñados, sube al plan Grow.

## 1 — Proceso base (repetir para cada plantilla)

1. **Marketing → Shopify Email → Create email**
2. Opciones: **Blank** / **Start from scratch** (lo que permita editar HTML/Liquid raw).
3. Editor: cambia a **Edit code** / **HTML view** (icono `</>`).
4. Pega el contenido del `.liquid` correspondiente.
5. **Settings**:
   - **Template name**: ID exacto de la tabla siguiente (snake_case).
   - **Subject**: extraído del `Subject: ...` al principio del Liquid.
   - **From name**: `LedsC4 Outlet`
   - **From email**: `no-reply@ledsc4.com` (o el verificado en tu store)
6. **Save as template** (no enviar).
7. Repetir con la siguiente.

## 2 — Tabla de plantillas

| # | Template ID | Subject | Destinatario | Flow |
|---|---|---|---|---|
| 1 | `b2b_bienvenida_auto`      | Tu cuenta B2B de LedsC4 Outlet está activa           | `{{ customer.email }}` | W1 rama A |
| 2 | `b2b_solicitud_recibida`   | Hemos recibido tu solicitud de alta B2B              | `{{ customer.email }}` | W1 rama B |
| 3 | `b2b_backoffice_pendiente` | [B2B] Nuevo registro pendiente — `{{ empresa }}`     | `{{ shop.metafields.b2b.email_backoffice }}` | W1 rama B |
| 4 | `b2b_cuenta_aprobada`      | Tu solicitud B2B ha sido aprobada                    | `{{ customer.email }}` | W2 |
| 5 | `b2b_cuenta_rechazada`     | Estado de tu solicitud B2B                           | `{{ customer.email }}` | W3 |
| 6 | `b2b_bienvenida_reeval`    | Tu cuenta B2B de LedsC4 Outlet está activa           | `{{ customer.email }}` | W4 |

## 3 — Pasos concretos por plantilla

### Plantilla 1 · `b2b_bienvenida_auto`

- **Archivo**: `email-templates/01-bienvenida-auto.liquid`
- **Subject**: `Tu cuenta B2B de LedsC4 Outlet está activa`
- **Variables usadas**: `customer.first_name`, `customer.metafields.b2b.empresa`,
  `customer.metafields.b2b.nif`, `shop.url`, `shop.metafields.b2b.email_backoffice`

Pasos:
1. Create email → Start from scratch → `</>` Edit code
2. Pega desde la línea 9 del `.liquid` en adelante (omitir `{% comment %}...{% endcomment %}`
   y la línea `Subject: ...` — el subject va en su campo propio).
3. Template name: `b2b_bienvenida_auto`
4. Subject: ver tabla
5. Save as template

### Plantilla 2 · `b2b_solicitud_recibida`

- **Archivo**: `email-templates/02-solicitud-recibida.liquid`
- **Subject**: `Hemos recibido tu solicitud de alta B2B`
- **Variables**: `customer.first_name`, `shop.metafields.b2b.email_backoffice`

### Plantilla 3 · `b2b_backoffice_pendiente`

- **Archivo**: `email-templates/03-backoffice-nuevo-pendiente.liquid`
- **Subject**: `[B2B] Nuevo registro pendiente — {{ customer.metafields.b2b.empresa }}`
  (el subject es dinámico; Shopify Email lo permite)
- **Variables**: todos los metafields `b2b.*` del customer + `shop.admin_url`
- **From email override**: igualmente `no-reply@ledsc4.com`, pero el **To** va
  al metafield `shop.metafields.b2b.email_backoffice` — se configura en el paso
  **Send email** de W1, no en la plantilla.

### Plantilla 4 · `b2b_cuenta_aprobada`

- **Archivo**: `email-templates/04-cuenta-aprobada-manual.liquid`
- **Subject**: `Tu solicitud B2B ha sido aprobada`
- **Variables**: `customer.first_name`, `customer.metafields.b2b.empresa`,
  `customer.metafields.b2b.fecha_aprobacion`, `shop.url`

### Plantilla 5 · `b2b_cuenta_rechazada`

- **Archivo**: `email-templates/05-cuenta-rechazada.liquid`
- **Subject**: `Estado de tu solicitud B2B`
- **Variables**: `customer.first_name`, `customer.metafields.b2b.motivo_rechazo`
  (condicional Liquid — si está vacío, el email sale sin línea "Motivo"),
  `shop.metafields.b2b.email_backoffice`
- **Importante**: el bloque `{% if customer.metafields.b2b.motivo_rechazo != blank %}...{% endif %}`
  debe preservarse tal cual. Si el editor lo escapa, cambia a **HTML view** y pega en raw.

### Plantilla 6 · `b2b_bienvenida_reeval`

- **Archivo**: `email-templates/06-bienvenida-reevaluacion.liquid`
- **Subject**: `Tu cuenta B2B de LedsC4 Outlet está activa`
- Mismo contenido que la 1. Mantenemos ambas para evolución independiente.

## 4 — Fallback si Shopify Email no resuelve `customer.metafields.b2b.*`

Shopify Email resuelve directamente `customer.first_name`, `customer.email`,
etc. Con metafields custom **a veces** falla según versión. Test:

1. Envía un test del template 4 con un customer B2B que tenga los metafields
   poblados.
2. Si en el email recibido ves `{{ customer.metafields.b2b.empresa }}` literal
   en vez del valor, hace falta el workaround:

### Workaround — merge fields desde Flow

En el paso **Send email** de W1 / W2 / W3 / W4, añade un bloque
**Custom content** / **Merge tags** definiendo variables planas:

```
empresa            = {{ customer.metafields.b2b.empresa }}
nif                = {{ customer.metafields.b2b.nif }}
fecha_aprobacion   = {{ customer.metafields.b2b.fecha_aprobacion }}
motivo_rechazo     = {{ customer.metafields.b2b.motivo_rechazo }}
email_backoffice   = {{ shop.metafields.b2b.email_backoffice }}
```

Y en la plantilla sustituye:

```liquid
{{ customer.metafields.b2b.empresa }}     → {{ empresa }}
{{ customer.metafields.b2b.nif }}          → {{ nif }}
{{ customer.metafields.b2b.fecha_aprobacion }} → {{ fecha_aprobacion }}
{{ customer.metafields.b2b.motivo_rechazo }}  → {{ motivo_rechazo }}
{{ shop.metafields.b2b.email_backoffice }} → {{ email_backoffice }}
```

## 5 — Checklist

Marcar al guardar cada plantilla:

- [ ] `b2b_bienvenida_auto` (plantilla 1)
- [ ] `b2b_solicitud_recibida` (plantilla 2)
- [ ] `b2b_backoffice_pendiente` (plantilla 3)
- [ ] `b2b_cuenta_aprobada` (plantilla 4)
- [ ] `b2b_cuenta_rechazada` (plantilla 5)
- [ ] `b2b_bienvenida_reeval` (plantilla 6)
- [ ] Test de cada una con **Send test** al email de backoffice
- [ ] Ninguno muestra `{{ ... }}` literal en el body recibido

## 6 — Cuando termines

- Pasar al walkthrough de Flow: `flows/W1-walkthrough.md` en adelante.
- Si una plantilla se llama distinto de lo documentado, los `Send email`
  de los Flows no la encontrarán. Respetar el ID literal.
