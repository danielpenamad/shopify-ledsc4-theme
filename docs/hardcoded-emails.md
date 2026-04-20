# Email backoffice — ubicaciones hardcoded

Flow no acepta variables (`{{ shop.metafields.b2b.email_backoffice }}`) en el
campo **To** de `Send internal email`. Solo literales. Por tanto el email del
backoffice está hardcoded en cada workflow que envía notificación interna.

**Literal actual (dev)**: `daniel.pena@creacciones.es`

Cuando pasemos a producción (plan Grow + cliente da OK), actualizar el
literal a la dirección real del backoffice LedsC4 en cada sitio listado abajo.

## Ubicaciones

Todas estas son ediciones en la **UI de Shopify Flow**, no en este repo.
Abre Apps → Flow → Edit cada workflow → localizar el step indicado.

| Workflow | Step | Campo | Valor actual |
|---|---|---|---|
| `W1 · Registro B2B` (rama Falso) | Send internal email (post-gate) | To | `daniel.pena@creacciones.es` |
| `W1 · Registro B2B` (rama Verdadero) | Send internal email (whitelist match) | To | `daniel.pena@creacciones.es` |
| `W2 · Customer aprobado` | Send internal email | To | `daniel.pena@creacciones.es` |
| `W3 · Customer rechazado` | Send internal email | To | `daniel.pena@creacciones.es` |
| `W5 · Solicitud B2B creada` (Fase D) | Send internal email | To | `daniel.pena@creacciones.es` |

## Procedimiento de cutover a producción

1. Confirmar con cliente la dirección real (p.ej. `backoffice@ledsc4.com`).
2. Actualizar shop metafield `b2b.email_backoffice` vía
   `node --env-file=.env.production scripts/set-shop-b2b-metafields.mjs`
   (este metafield se usa en los 5 emails marketing, que SÍ aceptan variables).
3. Entrar en cada workflow de la tabla y actualizar el To del
   `Send internal email` al valor real.
4. Probar con un registro real que llegan las notificaciones al nuevo
   destino.

## Por qué no podemos automatizar esto

Flow `Send internal email` rechaza variables Liquid en el campo To (es
una limitación documentada del action). Alternativas consideradas y
descartadas:

- **Send marketing email** con variable customer.email: funciona pero
  rompería la semántica (marketing → cliente, no interno → staff).
- **Send HTTP request** a un endpoint custom que reenvíe: añade
  complejidad por cuestión de literal.
- **Metafield lookup en Run code y pasar a Send internal email**: el
  valor lookuppeado tampoco se acepta en To.

Por eso: documentar y actualizar manualmente al cutover.
