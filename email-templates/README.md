# Plantillas de email B2B — LedsC4 Outlet

6 plantillas para los 5 escenarios del workflow de registro y aprobación.
Todos los textos están en español. Formato: Liquid (Shopify Email templates).

| # | Archivo | Disparador | Destinatario | Template ID admin |
|---|---|---|---|---|
| 1 | `01-bienvenida-auto.liquid` | W1 rama auto | cliente | `b2b_bienvenida_auto` |
| 2 | `02-solicitud-recibida.liquid` | W1 rama pendiente | cliente | `b2b_solicitud_recibida` |
| 3 | `03-backoffice-nuevo-pendiente.liquid` | W1 rama pendiente | backoffice | `b2b_backoffice_pendiente` |
| 4 | `04-cuenta-aprobada-manual.liquid` | W2 | cliente | `b2b_cuenta_aprobada` |
| 5 | `05-cuenta-rechazada.liquid` | W3 | cliente | `b2b_cuenta_rechazada` |
| 6 | `06-bienvenida-reevaluacion.liquid` | W4 tras añadir a whitelist | cliente | `b2b_bienvenida_reeval` |

**Email 6** tiene el mismo contenido que el 1. Se mantiene como plantilla
separada para permitir evolución independiente (ver W4-whitelist-reeval.md).

## Cómo cargarlas en Shopify Email

Shopify Email no importa templates desde archivo. Proceso manual:

1. Admin → **Marketing → Shopify Email → Templates → Create template**.
2. Pega el contenido del `.liquid` correspondiente en el editor.
3. Guarda con el "Template ID admin" de la tabla anterior como nombre.
4. Enlaza cada template al Flow correspondiente en el paso "Send email".

## Variables disponibles

Por plantilla, según el `scope` del disparador:

- `{{customer.first_name}}`, `{{customer.last_name}}`, `{{customer.email}}`, `{{customer.phone}}`
- `{{customer.metafields.b2b.empresa}}`, `.nif`, `.sector`, `.pais`, `.volumen_estimado`
- `{{customer.metafields.b2b.fecha_registro}}`, `.fecha_aprobacion`, `.motivo_rechazo`
- `{{shop.name}}`, `{{shop.url}}`, `{{shop.admin_url}}` (solo admin emails)
- `{{shop.metafields.b2b.email_backoffice}}`

Si Shopify Email no expone directamente `metafields` en sus templates
(lo comprobamos al configurar), usar variables expuestas por el paso
"Send email" de Flow — definir ahí una plantilla "merge field" y mapear
metafields a variables planas (p.ej. `b2b_empresa` = `{{customer.metafields.b2b.empresa}}`).

## Personalización visual (fuera de alcance Fase B)

El texto está neutro, sin HTML. Shopify Email aplica estilos por defecto.
La personalización de diseño llega en una fase posterior (header con
logo, footer con datos de contacto, etc.).
