# Traducciones

!!! info "Estado del documento"
    **Versión:** 0.1 · 12-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Administrador del negocio
    **Bloqueado por:** —

## Resumen

El portal B2B de LedsC4 está pensado para funcionar en varios idiomas. La mayor parte de las traducciones (productos, colecciones, textos de la interfaz) se generan automáticamente desde scripts y desde el theme — el administrador del negocio **no las traduce**. Lo único que el administrador edita rutinariamente son los textos visibles de la interfaz del portal (botones, mensajes de formulario, etiquetas) desde la app **Translate & Adapt** de Shopify.

Hay una regla de oro que conviene tener en cabeza desde el principio: **lo que tocas en Translate & Adapt puede pisarse**. Algunas traducciones las regeneran scripts del pipeline; otras las pisa el siguiente despliegue del theme desde el repositorio. Más abajo se explica qué casos son seguros y cuáles no.

## Idiomas activos

El portal tiene 6 locales cargados en Shopify, pero no todos están publicados (visibles) en el storefront:

| Locale | Rol | ¿Publicado en el portal? |
| --- | --- | --- |
| `es` | Primary / fuente | Sí |
| `en` | Secundario | Sí |
| `fr` | Secundario | No (cargado pero no publicado) |
| `de` | Secundario | No (cargado pero no publicado) |
| `it` | Secundario | No (cargado pero no publicado) |
| `pt-PT` | Secundario | No (cargado pero no publicado) |

- **Primary** significa que es el idioma fuente: todo el contenido se escribe primero en español. Los demás locales son traducciones de ese contenido fuente.
- **Cargado pero no publicado** significa que el locale está presente en Shopify y tiene traducciones almacenadas, pero los clientes del portal no lo ven en el selector de idioma del header.

Dónde se gestionan: **Shopify Admin → Settings → Store details → Languages**. Activar o desactivar la publicación de un locale es un toggle en esa pantalla. **Eliminar** un locale completo del shop es destructivo: borra todas las traducciones almacenadas. No lo hagas sin coordinarte con el equipo técnico.

## Capas de traducción del portal

El portal tiene seis capas de contenido traducible, cada una gestionada de forma distinta. Esta tabla es el mapa mental que necesitas tener antes de tocar nada:

| Capa | Dónde vive la traducción | Quién la escribe | ¿La edita el admin? |
| --- | --- | --- | --- |
| Productos (título, descripción, metafields traducibles) | Translations nativas de Shopify | Importador automático desde CSVs por locale del SFTP | **No.** La sobrescribe el siguiente run del importador. |
| Colecciones `cat-*` (título) | Translations nativas de Shopify | Script del equipo técnico que las proyecta a partir de los productos miembros | **No.** La regenera el script cuando se ejecuta. |
| Textos del theme (UI: botones, mensajes, formularios, etiquetas) | Locale files del theme | El repo del theme (`shopify-ledsc4-theme`); editable temporalmente en T&A | **Sí, en T&A, con caveat.** El próximo despliegue del theme pisa los cambios. |
| Páginas B2B (mensajes de cuenta en revisión / cuenta rechazada) | Metafields de página (`b2b.cuenta_revision_mensaje`, `b2b.cuenta_rechazada_mensaje`) | Admin a mano | **Sí, sin caveats.** Ningún script los toca. |
| Backoffice B2B (página `/pages/admin-backoffice`) | Strings hardcoded en el código del theme | Requiere cambio de código | **No.** Es uso interno, no internacionalizado: existe solo en español. |
| Emails transaccionales custom | Strings hardcoded en plantillas del theme | Requiere cambio de código | **No.** Hoy solo existen en español. |

Las notificaciones nativas de Shopify (Settings → Notifications) son un caso aparte y se cubren en el doc de [Emails](03-gestion-emails.md).

## Lo que SÍ edita el admin

Solo dos cosas, en dos sitios distintos:

### 1. Textos del theme — Translate & Adapt → Theme content

Son los strings de la interfaz del portal: textos de botones ("Solicitar pedido"), etiquetas de formularios ("Empresa", "Sector"), mensajes de feedback ("Tu solicitud está en revisión"), footer, etc. Estos textos están i18n-izados en el theme y tienen una entrada por locale.

**Cómo editarlos:**

1. **Shopify Admin → Apps → Translate & Adapt**.
2. Selecciona el idioma de destino (ej. `English`).
3. En el menú de la izquierda: **Theme content**.
4. Busca el string que quieras cambiar. Los del portal viven bajo el namespace `ledsc4.*` (`ledsc4.common.*`, `ledsc4.product.*`, `ledsc4.acceso.*`, etc.) — usa el buscador con `ledsc4` para filtrarlos.
5. Edita y guarda. El cambio es inmediato en el portal.
6. **Verifica**: abre el portal logado como cliente aprobado, cambia al idioma editado desde el selector del header y comprueba que el texto se ve correctamente.

**Caveat importante:** Translate & Adapt edita directamente los locale files del theme activo. Cuando el equipo técnico hace un despliegue del theme desde el repositorio, el contenido del repo gana y tus ediciones se pierden. Si necesitas un cambio permanente, **avisa al equipo técnico** para que también lo apliquen en el repo. Los hot-fixes urgentes hechos directamente en T&A son válidos pero temporales hasta que se replican en el repo.

### 2. Mensajes de páginas B2B — metafields de página

Los textos que ven los clientes en `/pages/cuenta-en-revision` (mientras esperan aprobación) y `/pages/cuenta-rechazada` (si su registro ha sido rechazado) viven en metafields de cada página. Esto ya se cubre en [Gestión de productos → sección Página](01-gestion-productos.md#página).

Para editarlos en otros idiomas:

1. **Shopify Admin → Apps → Translate & Adapt**.
2. Selecciona el idioma de destino.
3. En el menú de la izquierda: **Other content → Pages → cuenta-en-revision** (o `cuenta-rechazada`).
4. Edita el campo **Metafields** correspondiente.

Estos metafields **no los toca ningún script**, así que las ediciones son permanentes.

## Lo que NO edita el admin

- **Traducciones de productos** (título, descripción, metafields traducibles como `material`, `acabado`, `fuente_luz`, etc.). Las sobrescribe el importador automático en su siguiente ejecución. Cualquier edición en T&A se pierde. Si una traducción de producto está mal, se corrige en los CSVs del SFTP, no en Shopify.
- **Traducciones de colecciones `cat-*`** (título). Las regenera el script de traducciones de categorías cuando lo ejecuta el equipo técnico. Mismo principio: si una traducción está mal, se corrige el origen (los metafields del producto en el CSV), no la colección en Shopify.
- **Textos del menú principal del header.** El menú no se traduce por separado: cada entrada hereda automáticamente el título traducido de la colección que enlaza. Si editas el texto del menu item en T&A o en Online Store → Navigation, el theme lo ignora.
- **Locale files del theme directamente** (`locales/*.json` en el repositorio). El admin no toca el repo. T&A es la única vía aprobada para editar textos del theme, sabiendo que el repo gana en el siguiente deploy.
- **Backoffice B2B** y **emails transaccionales custom**. Son ES-only por diseño; cambiarlos requiere modificación de código y un despliegue del theme.

## Si algo va mal

- **Un texto del portal aparece en español cuando debería estar en otro idioma:** comprueba primero que el idioma esté **publicado** en Settings → Store details → Languages (no solo cargado). Si lo está, comprueba si la sección donde aparece el texto está internacionalizada — el backoffice y los emails custom son ES-only por diseño, así que si el texto está ahí es esperado.
- **Una traducción que edité en T&A ha "desaparecido" después de un tiempo:** lo más probable es que la haya pisado o el pipeline (si era traducción de producto o colección) o un despliegue del theme (si era texto del theme). Avisa al equipo técnico para confirmarlo y para replicar el cambio en el origen correcto (CSV o repo).
- **Veo traducciones automáticas raras o sin sentido en productos** (por ejemplo, un nombre propio traducido literalmente — "Forlight" convertido en algo en francés): es un caso de auto-traducción de T&A. Avisa al equipo técnico: hay un proceso de limpieza específico para estos casos.
- **Falta un idioma en el selector del header del portal pero el equipo técnico me dijo que está cargado:** está cargado pero no publicado. Activa la publicación desde Settings → Store details → Languages si tienes los permisos; si no, avisa al equipo técnico.
- **He tocado un locale file del repo o la lista de idiomas por error:** no intentes deshacerlo a mano. Avisa al equipo técnico describiendo qué tocaste.
- **Necesito traducir algo del backoffice o de un email custom:** no se puede desde Shopify. Es una petición al equipo técnico para internacionalizar esa parte (cambio de código).

## Cambios

- **v0.1** (12-may-2026): primera publicación
