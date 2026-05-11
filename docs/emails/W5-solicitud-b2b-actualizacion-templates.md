# Actualización de templates de email — Flow W5 (Solicitud B2B)

## Qué cambia en esta actualización

Hemos refrescado los dos emails del flujo de **solicitud de pedido B2B**
(Flow W5 en Shopify) para alinearlos con la identidad visual actual de
LedsC4: el callout amarillo/dorado que se usaba para destacar el
comentario del cliente pasa a ser azul corporativo (mismo azul que ya
aparece en la tienda online tras el cambio de paleta). Además, en el
email interno que recibe el equipo de backoffice se ha **eliminado la
línea "CBM total"** del bloque de datos de la solicitud, porque ya no se
usa operativamente.

Cambios visuales **mínimos** y conservadores: el resto de los emails
(estructura, copy, asunto, CTAs, datos de la solicitud, etc.) se mantiene
exactamente igual.

## Templates afectados

| Email | Destinatario | Fichero en el repo | Cambios |
|---|---|---|---|
| Solicitud B2B recibida | Cliente | [`email-templates/07-solicitud-b2b-recibida.liquid`](../../email-templates/07-solicitud-b2b-recibida.liquid) | Callout "Tu comentario" en azul corporativo (antes dorado). Sin más cambios. |
| Nueva solicitud B2B | Backoffice | [`email-templates/07b-backoffice-nueva-solicitud.liquid`](../../email-templates/07b-backoffice-nueva-solicitud.liquid) | Callout "Comentario del cliente" en azul corporativo + se elimina la línea "CBM total" de la tabla de la solicitud. |

> Nota técnica para quien suba los templates: el email al cliente vive
> en **Shopify Email** (app de marketing). El email al backoffice **no**
> es Shopify Email — vive directamente dentro del paso `Send internal
> email` del workflow W5 en la app **Shopify Flow**. Los pasos para
> aplicar los cambios son distintos para cada uno; ver más abajo.

## Cómo aplicar los cambios en Shopify

### A. Email al cliente — `07-solicitud-b2b-recibida.liquid`

Este es un email de marketing. Se gestiona desde la app **Shopify Email**.

#### Si el template ya existe en el admin

1. Entra en Shopify admin → **Marketing** → **Campaigns** (o **Email**, según versión).
2. Pestaña **Templates** → busca el template llamado **"Solicitud B2B recibida"** (o el nombre real que tenga en vuestro admin).
3. Pulsa **Edit** sobre la tarjeta del template.
4. En el repo, abre [`email-templates/07-solicitud-b2b-recibida.liquid`](../../email-templates/07-solicitud-b2b-recibida.liquid) y **copia todo el contenido** (puedes saltarte el bloque `<!-- ... -->` inicial si quieres — Shopify lo ignora al renderizar, pero tampoco molesta).
5. En el editor de Shopify Email, selecciona toda la versión actual del HTML y **pégala reemplazando el contenido anterior**.
6. **Subject** del email (si Shopify lo pide aparte): `Solicitud recibida · {{ draft_order.name }} · LedsC4 Outlet`.
7. Pulsa **Save**.

#### Si el template aún no existe (primera instalación)

1. Shopify admin → **Marketing** → **Campaigns** → **Templates** → **Create template**.
2. Elige **Custom code** (o "Start from blank HTML" según versión).
3. Pega el contenido entero de [`email-templates/07-solicitud-b2b-recibida.liquid`](../../email-templates/07-solicitud-b2b-recibida.liquid).
4. Configura:
   - **Template name**: `Solicitud B2B recibida`.
   - **Subject**: `Solicitud recibida · {{ draft_order.name }} · LedsC4 Outlet`.
   - **Sender name**: `LedsC4 Outlet` (o el remitente preferido).
   - **Sender email**: el que tengáis configurado para marketing transaccional.
5. **Save**.
6. Luego en Shopify Flow (paso B abajo) asegúrate de que el step `Send marketing mail` del workflow W5 referencia este template por nombre.

### B. Email al backoffice — `07b-backoffice-nueva-solicitud.liquid`

Este NO es un email de marketing — vive **dentro del workflow** de la app **Shopify Flow**.

1. Shopify admin → **Apps** → **Flow**.
2. Localiza el workflow llamado **"W5 · Solicitud B2B creada"** (o el nombre que tenga). Si está activo lo verás con el toggle en verde; si no, en gris.
3. Abre el workflow.
4. Dentro del workflow, localiza el paso **`Send internal email`** (suele ser el último, después del `Run code` y del `Send marketing mail`).
5. Pulsa sobre el paso para editarlo.
6. En el campo **Email body**, selecciona todo el contenido actual y bórralo.
7. En el repo, abre [`email-templates/07b-backoffice-nueva-solicitud.liquid`](../../email-templates/07b-backoffice-nueva-solicitud.liquid), copia todo el contenido (puedes saltarte el bloque `<!-- ... -->` inicial), y **pégalo en el campo Email body**.
8. **No cambies** los campos **Subject**, **To** ni el sender — siguen igual que antes.
9. Pulsa **Save** (arriba a la derecha del workflow).

> El workflow seguirá en el estado en que estuviera (activo o desactivado);
> guardar el body no toca el estado.

#### Si el workflow W5 aún no existe (primera instalación)

Hay una guía paso a paso para crear el workflow desde cero en
[`email-templates/WALKTHROUGH-W5.md`](../../email-templates/WALKTHROUGH-W5.md).
Sigue esa guía y, cuando llegues al paso del `Send internal email`, pega
el contenido de [`email-templates/07b-backoffice-nueva-solicitud.liquid`](../../email-templates/07b-backoffice-nueva-solicitud.liquid)
como Email body.

## Cómo validar el cambio

Antes de activar el workflow en producción, conviene confirmar que los
emails se ven correctamente.

### Validación del email al cliente (Shopify Email)

1. Abre el template "Solicitud B2B recibida" en Shopify Email.
2. Pulsa **Preview** o **Send test email** (según versión).
3. Como destinatario, pon tu **propio email corporativo**.
4. Pulsa **Send** — el email llega en pocos segundos.
5. Abre el email recibido y comprueba en **Gmail (web)**, **Outlook (desktop si lo tienes)** y en el **móvil**:
   - El callout "Tu comentario" (si aparece en el preview, depende del payload mock que use Shopify) tiene **fondo azul muy claro y borde izquierdo azul corporativo**. No debe quedar ningún tono amarillo/dorado.
   - El bloque "Datos de la solicitud" muestra Referencia, Fecha e Importe estimado. Como antes — no debería haber CBM (este email nunca lo mostró).
   - El botón "Ver mis solicitudes" sigue siendo negro.
   - Footer con datos LEDS C4 intacto.

### Validación del email al backoffice (Shopify Flow)

Shopify Flow no tiene un botón "Send test" tan directo como Shopify Email,
así que se valida disparando un draft order de prueba:

1. Asegúrate de que el workflow W5 está **activado temporalmente** (toggle a verde) durante esta prueba.
2. Crea un draft order de prueba: Shopify admin → **Orders** → **Drafts** → **Create order**.
   - Añade 1 ó 2 productos cualesquiera.
   - En la sección **Tags** del draft, añade el tag `solicitud-b2b` (importante: sin este tag el workflow no entra).
   - En **Notes** del draft, escribe algo corto como "prueba paleta azul" — para verificar que el callout aparece.
   - **Save as draft** (no envíes al cliente, no completes el pedido).
3. Espera 30-60 segundos a que Flow procese el evento.
4. Comprueba en la cuenta de email del backoffice (la que tengáis configurada en el campo "To" del paso `Send internal email`):
   - El email debería haber llegado.
   - **Tabla "Solicitud"**: debe mostrar Referencia, Fecha e Importe estimado — y **NO** debe aparecer la línea "CBM total".
   - **Callout "Comentario del cliente"**: con el texto "prueba paleta azul" que metimos en Notes, en **fondo azul muy claro y borde izquierdo azul corporativo**.
   - El botón "Abrir en admin" sigue siendo negro y enlaza al draft order que acabas de crear.
5. Si todo se ve bien: **desactiva** el workflow W5 otra vez si estaba desactivado antes de la prueba.
6. Borra el draft order de prueba (Orders → Drafts → seleccionar → Delete) para no dejar ruido.

### Qué hacer si algo no se ve bien

- **El callout sigue saliendo dorado**: el navegador o cliente de correo está cacheando una versión vieja. Forzar refresco con Ctrl+F5 / Cmd+Shift+R en la vista web del email.
- **El callout sale sin color de fondo (azul perdido)**: probablemente Outlook está descartando el `background` del `<div>`. Avisar al equipo técnico — habría que pasar a un `<table>` para que Outlook lo respete.
- **Sigue apareciendo "CBM total" en el email backoffice**: el cambio se aplicó en el repo pero el body en Flow no se ha actualizado. Repetir paso B (sección "Cómo aplicar los cambios").

## Cuándo se enviarán estos emails en producción

- **Email al cliente** (Shopify Email): se envía automáticamente cuando un cliente B2B aprobado completa el envío de una **solicitud de pedido** desde el portal (`/pages/solicitud`). El envío lo dispara el workflow W5 al detectar el draft order con tag `solicitud-b2b`.
- **Email al backoffice** (Shopify Flow internal email): se envía en **el mismo momento** que el del cliente, dirigido a la cuenta comercial configurada en el paso `Send internal email` del workflow W5.

> **Estado actual del workflow W5**: **desactivado** en pre-producción.
> El workflow está documentado en
> [`email-templates/WALKTHROUGH-W5.md`](../../email-templates/WALKTHROUGH-W5.md)
> y los templates están en el repo, pero el workflow todavía no se ha
> creado / activado en el admin del cliente. Cuando se cree y se active,
> los emails empezarán a salir automáticamente.

## Histórico

- **2026-05-11** — Sustitución de paleta dorada (`#fff8e1` + `#d4a84a`) por paleta corporativa azul (`#f0f5ff` + `#0051FF`) en los callouts de comentario. Eliminación de la línea "CBM total" del email al backoffice. Cambios aplicados en los `.liquid` del repo; pendiente de pegar en Shopify Email + Shopify Flow del admin del cliente.
