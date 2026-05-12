# Gestión de productos

!!! info "Estado del documento"
    **Versión:** 0.1 · 12-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Administrador del negocio
    **Bloqueado por:** —

## Resumen

El catálogo del portal B2B de LedsC4 viene íntegro de la importación: productos, variantes, stock, precios, descripciones, traducciones y casi todos los metafields. Como administrador del negocio, **no gestionas productos desde Shopify**. Tu rol con el catálogo se limita a entender de dónde sale cada cosa, no a editarla.

Este documento explica cómo entra el catálogo, qué debes evitar tocar, qué metafields existen y cuáles son los pocos campos editables a mano (que no son de producto sino de cliente, tienda y página).

## Cómo entran los productos al portal

Existe un **importador** que sincroniza el catálogo desde un CSV de surtido de LedsC4. Corre con dos cadencias distintas:

- **Cada 6 horas:** stock y precio de las variantes. Es la actualización frecuente, pensada para que el portal refleje el estado vivo del inventario y de las tarifas.
- **Todos los días a las 2:00 AM:** alta de productos nuevos y modificación de los campos de producto (título, descripción, metafields, imágenes, traducciones, etc.). Es la actualización pesada, una vez al día.

En cada run el importador recrea o actualiza los productos a partir del CSV. Cualquier dato de producto que veas en Shopify Admin es resultado de esta importación. Si lo editas a mano, el siguiente run del importador lo sobrescribirá: los cambios de stock o precio se pueden perder en menos de 6 horas; los del resto de campos, en la próxima ventana de 2:00 AM.

El importador y su mapeo de columnas están documentados técnicamente en el eje [Desarrollo](../desarrollo/index.md). Como administrador no necesitas conocerlos al detalle; basta con que sepas que existen y que el CSV de origen es la fuente de verdad del catálogo.

## Cómo se protege el acceso al portal

El portal B2B es una tienda Shopify pública por defecto, así que necesita una capa de protección para que solo los clientes aprobados puedan ver productos, precios y solicitar pedidos. Esa capa la implementa una app llamada **Locksmith**:

- Las páginas del portal (catálogo, fichas de producto, solicitud de pedido) están bloqueadas para visitantes no autenticados.
- Solo los clientes logados **y aprobados** (tag `aprobado` — ver más abajo) pueden acceder al contenido completo.
- Los clientes pendientes o rechazados ven páginas alternativas (`/pages/cuenta-en-revision` o `/pages/cuenta-rechazada`) con un mensaje explicativo.

La configuración de Locksmith la mantiene el equipo técnico desde Shopify Admin → Apps → Locksmith. **No la toques tú.** Cambiar sus reglas puede dejar el portal abierto al público o bloqueado para todos los clientes, dependiendo del cambio.

## Lo que NO debes hacer

- **No crear productos a mano.** El portal no contempla altas manuales. Cualquier producto que crees aparecerá en el portal hasta el siguiente run del importador, momento en el que puede quedar en estado inconsistente o desaparecer.
- **No editar campos de producto** (título, descripción, precio, stock, imágenes, tags, traducciones, metafields). Se pisarán en la siguiente importación.
- **No archivar ni borrar productos.** Si un producto no debe estar publicado, hay que quitarlo del CSV de surtido en origen. Si lo archivas en Shopify, la siguiente importación lo reactivará.
- **No asignar productos a colecciones a mano.** Las colecciones del portal (`cat-*`) están definidas en código y las regenera un script. La pertenencia de cada producto se decide por sus campos del CSV, no manualmente.
- **No crear nuevas colecciones.** Igual que el menú, las categorías son una estructura cerrada gestionada por script. Si necesitas una categoría nueva, avisa al equipo técnico.

## Caso excepcional: stock de urgencia

Existe un caso teórico en el que sí puede tener sentido editar un producto a mano desde Shopify: **corregir el stock de una variante** cuando hay un error grave que no puede esperar al siguiente run del importador (por ejemplo, un producto agotado físicamente que aparece como disponible).

Si llega a pasar:

1. **Shopify Admin → Products**, busca el producto.
2. Abre la variante afectada y ajusta el campo **Inventory**.
3. Avisa al equipo técnico o a quien gestione el CSV de surtido: el cambio que has hecho **se revertirá en la próxima importación de stock** (como máximo 6 horas más tarde), así que la corrección de fondo tiene que aplicarse también en origen.

En la práctica este caso no ha ocurrido. Está documentado por completitud; si vas a usarlo, conviene avisar antes para confirmar que es la vía correcta.

## Metafields del portal

Los metafields son campos personalizados que extienden los datos nativos de Shopify (producto, cliente, tienda, página). Las definiciones de todos los metafields del portal están en `scripts/metafield-definitions.json` y se crean/actualizan en Shopify mediante un script idempotente que mantiene el equipo técnico. **El JSON es la fuente de verdad**: no se dan de alta metafields a mano desde Shopify Admin → Settings → Custom data.

A continuación, el resumen por scope. Para el inventario completo de los metafields de producto (~38 campos: vatios, lúmenes, IP, IK, dimensiones, URLs de fichas, etc.), consulta directamente el JSON del repo.

### Producto

Todos los metafields de producto los rellena la **importación** desde el CSV de surtido. Ninguno se edita a mano: si lo haces, el siguiente run del importador lo pisa (a las 2:00 AM para la mayoría de campos, antes para los relacionados con stock o precio).

Lo único que necesitas saber como administrador:

- Existen y son consumidos por el theme (tabla de especificaciones de la ficha de producto, badges, links a fichas técnicas, fotometría, etiquetas energéticas, etc.).
- Si una especificación está mal en una ficha de producto, **se corrige en el CSV de origen**, no en Shopify.
- Si un metafield aparece vacío en producción, es porque la columna correspondiente del CSV venía vacía para ese producto.

### Variante

No hay metafields de variante. Las variantes usan solo campos nativos de Shopify (SKU, código de barras, precio, stock). Nada que gestionar.

### Cliente

El alta de cliente B2B (que hace el propio cliente al registrarse en el portal) escribe varios metafields en su ficha. Como administrador puedes consultarlos en **Shopify Admin → Customers → cliente → Custom data**, y en algún caso editarlos.

**Editables (visibles en la ficha del cliente):**

| Metafield | Tipo | Descripción | ¿Lo edita el admin? |
| --- | --- | --- | --- |
| `b2b.empresa` | single_line_text | Razón social del cliente | Solo si hay error claro de tipeo en el alta. Si el cliente vuelve a registrarse con el mismo email, el alta sobreescribe. |
| `b2b.nif` | single_line_text | Identificador fiscal | Igual que `empresa`. |
| `b2b.sector` | single_line_text | Sector de actividad (instalador, arquitecto, retail, etc.) | Igual que `empresa`. |
| `b2b.pais` | single_line_text | País de facturación. Reservado para futura multi-tarifa. | Igual que `empresa`. |
| `b2b.volumen_estimado` | single_line_text | Volumen anual declarado por el cliente | Igual que `empresa`. |

**Internos (gestionados por el sistema, NO tocar a mano):**

- `b2b.fecha_registro` — fecha de alta.
- `b2b.fecha_aprobacion` — se rellena al aprobar el cliente.
- `b2b.fecha_rechazo` — se rellena al rechazar el cliente.
- `b2b.motivo_rechazo` — texto que el operador puede escribir al rechazar; se muestra al cliente en la página de cuenta rechazada.

Editar estos a mano puede dejar al cliente en un estado incoherente (por ejemplo, con fecha de aprobación y de rechazo a la vez). Si necesitas cambiar el estado de un cliente, hazlo desde el backoffice B2B usando los flujos de [aprobar altas](../operador/01-aprobar-altas.md) o [quitar acceso](../operador/03-quitar-acceso.md).

**Nota sobre el estado de aprobación:** el estado del cliente (`pendiente`, `aprobado`, `rechazado`) **no es un metafield**, es un **tag** del customer. Lo verás en Shopify Admin → Customers como tag. Lo gestiona el backoffice B2B automáticamente; no añadas, modifiques ni borres estos tags a mano — cambiarlos sin pasar por el backoffice deja el cliente en estado incoherente respecto a las fechas y al email automático que recibe.

### Tienda

Tres metafields a nivel de tienda. Algunos son editables; otros los mantiene el sistema.

| Metafield | Tipo | Descripción | ¿Lo edita el admin? |
| --- | --- | --- | --- |
| `b2b.email_backoffice` | single_line_text | Destinatario de los avisos automáticos de nuevo registro B2B | Sí, si el destinatario cambia. Se edita desde Settings → Custom data → Shop. Si no se ha rellenado, el sistema usa una dirección de fallback definida en el theme. |
| `b2b.whitelist_emails` | list.single_line_text | Lista de emails pre-aprobados | **No editar desde Settings.** Se gestiona desde el backoffice B2B (ver [Gestionar whitelist](../operador/02-gestionar-whitelist.md)). Editar a mano funciona pero se pisa la próxima vez que el operador toque la whitelist desde el backoffice. |
| `b2b.whitelist_last_update` | date_time | Timestamp de la última actualización de la whitelist | **No tocar.** Lo escribe el sistema automáticamente cada vez que la whitelist cambia. Se muestra en el KPI "Última actualización" del backoffice. |

### Página

Dos páginas del portal tienen metafields con el texto que se le muestra al cliente. Son **editables 100% a mano** y ningún script los toca. Es el único contenido del catálogo/portal que el administrador edita rutinariamente desde Shopify Admin.

| Metafield | Página | Descripción |
| --- | --- | --- |
| `b2b.cuenta_revision_mensaje` | `/pages/cuenta-en-revision` | Texto mostrado al cliente mientras su solicitud está pendiente de aprobación. |
| `b2b.cuenta_rechazada_mensaje` | `/pages/cuenta-rechazada` | Texto mostrado al cliente cuyo registro ha sido rechazado. |

Para editarlos: **Shopify Admin → Online Store → Pages**, abre la página correspondiente, baja hasta la sección **Metafields** y edita el campo. Los cambios son inmediatos. Si dejas el campo vacío, el portal muestra un texto de fallback definido en el theme.

## Si algo va mal

- **Un producto del CSV no aparece en el portal:** comprueba que la importación se ha ejecutado recientemente (alta y modificación de productos corre a las 2:00 AM). Si lleva más de un día sin correr, avisa al equipo técnico.
- **Un producto aparece con datos incorrectos** (precio, stock, especificaciones, traducción): se corrige en el CSV de origen. Cualquier corrección que hagas en Shopify se perderá en la próxima ventana del importador (6 h para stock/precio, 24 h para el resto).
- **Un producto está publicado y no debería estarlo:** quitar del CSV y esperar al siguiente run de productos (2:00 AM). No archives ni borres a mano.
- **Un cliente aparece con datos mal rellenados** (empresa con typo, sector incorrecto): editar los metafields editables (`b2b.empresa`, `b2b.nif`, `b2b.sector`, etc.) desde la ficha del cliente. Avisar al cliente si el error venía de su propio formulario.
- **Quiero cambiar el email destinatario de avisos B2B:** edita `b2b.email_backoffice` en Settings → Custom data → Shop. No hace falta avisar al equipo técnico.
- **Quiero cambiar el texto de la página de cuenta en revisión o rechazada:** edita el metafield de la página correspondiente (ver tabla "Página" arriba).
- **No sé si un campo lo controla la importación o lo puedo editar:** por defecto asume que lo controla la importación (es el caso del 95% del catálogo). Las únicas excepciones son los metafields de Cliente editables, los de Tienda señalados como editables, y los de Página.

## Cambios

- **v0.1** (12-may-2026): primera publicación
