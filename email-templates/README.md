# Plantillas de email B2B — LedsC4 Outlet

6 bodies de email para los escenarios del workflow de registro y
aprobación. Todos los textos están en español. Estrategia mixta:

- **5 de ellos (al cliente) son HTML de Shopify Messaging** — marketing
  mail guardada como plantilla en admin, referenciada por nombre en la
  acción `Send marketing mail` de Flow.
- **1 de ellos (al backoffice) es texto plano inline** — body pegado
  dentro del step `Send internal email` de Flow (no permite variables en To).

| # | Archivo | Disparador | Destinatario |
|---|---|---|---|
| 1 | `01-bienvenida-auto.liquid` | W1 rama auto | cliente |
| 2 | `02-solicitud-recibida.liquid` | W1 rama pendiente | cliente |
| 3 | `03-backoffice-nuevo-pendiente.liquid` | W1 rama pendiente | backoffice |
| 4 | `04-cuenta-aprobada-manual.liquid` | W2 | cliente |
| 5 | `05-cuenta-rechazada.liquid` | W3 | cliente |
| 6 | `06-bienvenida-reevaluacion.liquid` | W4 tras añadir a whitelist | cliente |

**Email 6** tiene el mismo contenido que el 1. Se mantiene en archivo
separado para permitir evolución independiente (ver W4-whitelist-reeval.md).

## Cómo pegarlas en Flow

Cada `.liquid` contiene metadata (`{% comment %}`), una línea
`Subject: ...` y el cuerpo. Al configurar un paso `Send internal email`:

- **Subject** del Flow ← la línea `Subject: ...` sin el prefijo.
- **Body** del Flow ← todo lo que haya debajo (omitir `{% comment %}` y `Subject:`).

Guía completa paso a paso: [WALKTHROUGH.md](WALKTHROUGH.md).

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
