# Visión general

!!! info "Estado del documento"
    **Versión:** 0.1 · 12-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Administrador del negocio
    **Bloqueado por:** —

## Resumen

Mapa rápido para el administrador del portal B2B de LedsC4: qué se puede hacer desde el admin de Shopify, qué tareas requieren al equipo técnico, y dónde están las cosas críticas (catálogo, traducciones, emails, customers B2B).

## Accesos que necesitas

Como administrador del negocio necesitas **dos accesos**, no uno:

1. **Shopify Admin** — `https://ledsc4-b2b-outlet.myshopify.com/admin`
   Tu cuenta de staff de Shopify. Es donde gestionas productos, colecciones, plantillas de email y customers. Tienes que pedir al equipo técnico que te dé permisos de staff con rol de administrador. La URL puede cambiar cuando se defina el dominio definitivo del portal.

2. **Backoffice B2B** — `https://ledsc4-b2b-outlet.myshopify.com/pages/admin-backoffice`
   Página interna del portal para aprobar altas de clientes, gestionar la whitelist y quitar accesos. Se accede logado como customer con permisos de back-office, no con la cuenta de staff. Es la misma herramienta que usa el operador de back-office — el flujo completo está en el eje [Operador](../operador/index.md).

Guárdate los dos en favoritos. Vas a usar el primero a diario y el segundo de forma puntual.

## Qué puedes hacer tú desde el admin

Estas son las tareas que entran dentro de tu rol y que están documentadas en este eje:

| Tarea | Dónde | Documento |
| --- | --- | --- |
| Alta y edición de productos, stock, precios, descripciones | Shopify Admin → Products | [Gestión de productos](01-gestion-productos.md) |
| Asignar productos a colecciones existentes | Shopify Admin → Products / Collections | [Gestión de productos](01-gestion-productos.md) |
| Editar textos del theme (etiquetas de UI, mensajes del portal) | Shopify Admin → apps de traducción | [Traducciones](04-traducciones.md) |
| Editar plantillas de email transaccional | Shopify Admin → Settings → Notifications | [Emails](03-gestion-emails.md) |
| Aprobar / rechazar altas de clientes B2B | Backoffice B2B | [Operador → Aprobar altas](../operador/01-aprobar-altas.md) |
| Gestionar whitelist de emails pre-aprobados | Backoffice B2B | [Operador → Gestionar whitelist](../operador/02-gestionar-whitelist.md) |
| Quitar acceso a un cliente aprobado | Backoffice B2B | [Operador → Quitar acceso](../operador/03-quitar-acceso.md) |

## Qué NO debes tocar tú

Hay varias partes del portal que **están automatizadas** o vienen de **sistemas externos**. Si las modificas a mano desde el admin de Shopify, los procesos automáticos revertirán tu cambio o lo dejarán en estado inconsistente. Si necesitas cambiar algo de esta lista, no lo hagas directamente: avisa al equipo técnico.

- **Traducciones de productos y categorías.** Vienen ya traducidas desde la importación de catálogo. Si una traducción de producto o categoría está mal, hay que corregirla en origen (en el sistema que alimenta la importación), no en Shopify Admin. Editar las traducciones a mano en Shopify se perderá en la siguiente importación.
- **Estructura del menú de navegación** (header del portal con Forlight, Architectural, Decorative, DIY, Outdoor, Otros). El menú se regenera por script.
- **Alta de nuevas categorías** (colecciones con handle `cat-*`). Las categorías y su jerarquía padre/hijo están definidas en código.
- **Plantillas del theme** (cualquier archivo `.liquid`, CSS o JS del theme). El theme se despliega desde el repo `shopify-ledsc4-theme`.
- **Idiomas activos** del portal (alta o baja de locales).
- **Definición de nuevos emails administrativos internos** (avisos al equipo de LedsC4 más allá de los transaccionales estándar de Shopify). Sigue pendiente de definir, ver [Emails](03-gestion-emails.md).
- **Pipeline de importación** de productos, stock y traducciones (cualquier integración con ERP, proveedores o feeds externos).

La documentación técnica de los scripts y del pipeline vendrá en el eje [Desarrollo](../desarrollo/index.md).

## Tareas habituales y su cadencia

Como referencia, este es el ritmo típico de trabajo del administrador. Ninguna de estas tareas es reactiva a un aviso automático: las haces cuando te llega la información del equipo comercial o cuando detectas que toca.

| Tarea | Cadencia típica | Disparador |
| --- | --- | --- |
| Alta o edición de productos | Continuo | Cambio de catálogo desde el equipo comercial |
| Revisión de stock y precios | Semanal o según ciclo del ERP | Importación periódica del feed |
| Revisión de plantillas de email | Puntual | Cambio de copy o branding |
| Edición de textos del theme | Puntual | Cambio de copy en el portal |
| Aprobar altas de clientes | Reactivo | Email de notificación (el operador es el primer filtro; tú actúas si el operador escala) |
| Gestionar whitelist | Puntual | Petición del comercial responsable |

## Si algo va mal

- **No puedo entrar al Shopify Admin / no veo Products:** tu cuenta de staff no tiene los permisos necesarios. Avisa al equipo técnico para que ajuste el rol.
- **No puedo entrar al Backoffice B2B / me dice "Acceso restringido":** tu cuenta de customer no tiene permisos de back-office. Avisa al equipo técnico.
- **He tocado algo del menú o de las categorías `cat-*` por error:** no intentes deshacerlo a mano. Avisa al equipo técnico y describe qué tocaste — el script lo restaurará en el próximo run.
- **Una traducción de producto o categoría está mal:** no la edites en Shopify. Avisa al equipo comercial / responsable de la importación para que la corrija en origen.
- **No sé si una tarea es mía o del equipo técnico:** consulta la tabla "Qué NO debes tocar tú" de esta página. Si la duda persiste, pregunta antes de tocar.

## Cambios

- **v0.1** (12-may-2026): primera publicación
