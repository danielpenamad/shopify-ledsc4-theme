# Emails

!!! info "Estado del documento"
    **Versión:** 0.2 · 16-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Administrador del negocio
    **Bloqueado por:** —

## Resumen

El portal B2B envía dos tipos de email automático: las **notificaciones nativas de Shopify** (confirmación de cuenta, recuperación de contraseña, etc.) y los **emails del flujo B2B** (acuse de registro, bienvenida, aprobación, rechazo, acuse de solicitud de pedido). Este documento explica cuáles puedes editar tú como administrador, dónde se editan, cómo previsualizar un cambio antes de darlo por bueno, y qué partes no debes tocar.

La idea principal: **puedes editar el copy y el diseño de las plantillas, pero no los disparadores ni los destinatarios.** Cuándo se envía cada email y a quién lo decide la automatización, que mantiene el equipo técnico.

## Los dos tipos de email del portal

| Tipo | Qué incluye | Dónde se edita | ¿Lo editas tú? |
| --- | --- | --- | --- |
| Notificaciones nativas de Shopify | Activación de cuenta, recuperación de contraseña, y las notificaciones estándar de la tienda | Shopify Admin → Settings → Notifications | Sí, el copy y el HTML |
| Emails del flujo B2B | Acuse de registro, bienvenida, aprobación, rechazo, acuse de solicitud de pedido | Shopify Admin → Marketing → Email | Sí, el copy y el diseño de cada plantilla |

Ambos tipos los puedes editar, pero por vías distintas. Lo que **no** controlas en ninguno de los dos casos es el disparador (qué evento envía el email) ni el destinatario.

## Notificaciones nativas de Shopify

Son los emails que Shopify envía por su cuenta, sin pasar por la automatización del portal. El más importante para el portal B2B es el **email de activación de cuenta**: cuando un cliente se registra, recibe un email con un enlace para establecer su contraseña.

**Cómo se editan:**

1. Shopify Admin → **Settings → Notifications**.
2. Elige la notificación (por ejemplo, "Customer account invite").
3. Edita el asunto y el cuerpo en el editor.
4. Guarda.

**Limitación conocida:** las plantillas de Notifications solo se editan desde esta pantalla del admin. No hay forma de editarlas por código ni de versionarlas en el repositorio. Si haces un cambio aquí, queda solo en Shopify — anótalo en algún sitio si es importante, porque no hay histórico.

## Emails del flujo B2B

Son cinco emails que el portal envía a los clientes según su situación:

| Email | Cuándo lo recibe el cliente |
| --- | --- |
| Acuse de registro | Al registrarse, si su cuenta queda pendiente de revisión |
| Bienvenida | Al registrarse, si su email estaba en la whitelist y la cuenta se aprueba automáticamente |
| Aprobación | Cuando el operador aprueba su cuenta desde el backoffice |
| Rechazo | Cuando el operador rechaza su cuenta. Incluye el motivo, si el operador escribió uno |
| Acuse de solicitud de pedido | Cuando el cliente envía una solicitud de pedido desde el portal |

Cada uno de estos cinco emails existe en **tres idiomas** (español, inglés y francés), así que en total hay 15 plantillas. El sistema elige automáticamente el idioma según el del cliente.

**Dónde viven:** Shopify Admin → **Marketing → Email → Templates**. Cada plantilla tiene un nombre del tipo `W1-acuse-ES`, `W2-aprobacion-EN`, etc. La parte del nombre indica el email y el idioma.

### Editar el copy de una plantilla

1. Shopify Admin → **Marketing → Email → Templates**.
2. Localiza la plantilla por su nombre (por ejemplo, `W2-aprobacion-ES` para el email de aprobación en español).
3. Edita el HTML o el texto en el editor.
4. **No toques** estos elementos al editar: la estructura de tablas del HTML, el bloque de baja de suscripción, el píxel de seguimiento y la URL del logo. Si los quitas, Shopify no te dejará guardar la plantilla.
5. Guarda.

No hace falta tocar nada más: la automatización ya apunta a la plantilla y el cambio se aplica en el siguiente envío.

**Importante — nunca elimines una plantilla.** Si necesitas cambiar una plantilla, edítala; no la borres para recrearla. La automatización referencia cada plantilla por un identificador interno: si la borras y creas una nueva, el identificador cambia y el email deja de enviarse sin avisar. Editar una plantilla existente es seguro; borrarla y recrearla rompe el envío.

### Cómo previsualizar y testear un cambio

Antes de dar por bueno un cambio de copy:

1. Con la plantilla abierta en el editor de Marketing → Email, usa la opción **Test campaign** (enviar campaña de prueba).
2. Envíatela a tu propio correo.
3. Comprueba en el email recibido: que el texto se ve correcto, que el logo carga, que el formato no se ha roto, y que los enlaces funcionan.
4. Si la plantilla usa el nombre del cliente u otra variable, en la prueba aparecerá vacía o con un valor de ejemplo — es normal, en el envío real se rellena.

Haz siempre la prueba antes de considerar terminado el cambio. El editor no siempre refleja cómo se verá el email en el buzón real.

### Qué cambia y qué no cambia por idioma

Las 15 plantillas comparten la misma estructura (cabecera con logo, cuerpo, pie con la dirección legal). Solo cambian el cuerpo y el pie según el idioma. Si cambias el copy de un email, recuerda que tienes que **editar las tres versiones de idioma** de ese email — editar solo `W2-aprobacion-ES` deja el inglés y el francés con el texto antiguo.

## Lo que NO debes tocar

- **Los disparadores de los emails.** Cuándo se envía cada email lo decide la automatización (Shopify Flow), que mantiene el equipo técnico. No es algo que se configure desde Marketing → Email.
- **Los destinatarios.** A quién llega cada email también lo decide la automatización. Hay además unos avisos internos que van al equipo de LedsC4 (no a los clientes); su destinatario está fijado en la automatización y cambiarlo es una petición al equipo técnico.
- **Eliminar plantillas.** Como se explica arriba, romper el identificador interno deja el email sin enviarse. Editar siempre, nunca borrar y recrear.
- **Añadir un idioma nuevo.** Crear las plantillas de un cuarto idioma y conectarlas a la automatización es trabajo del equipo técnico.

## Emails administrativos internos

Más allá de los avisos internos que ya existen (notificación al equipo de LedsC4 cuando hay un registro nuevo o una solicitud de pedido), no hay por ahora un catálogo definido de emails administrativos internos adicionales. Si el negocio necesita nuevos avisos automáticos al equipo, es una definición pendiente que hay que acordar con el equipo técnico: qué evento los dispara, a quién llegan y con qué contenido.

## Si algo va mal

- **He editado una plantilla y el email sigue llegando con el texto antiguo:** comprueba que editaste la plantilla del idioma correcto. Si el cliente recibe el email en español, el cambio tiene que estar en la plantilla `-ES`. Recuerda que cada email tiene tres plantillas de idioma.
- **Un cliente dice que no ha recibido un email:** que compruebe primero su carpeta de spam. Si no aparece, avisa al equipo técnico — puede ser un fallo de la automatización, que solo ellos pueden revisar.
- **He borrado una plantilla por error:** avisa al equipo técnico de inmediato. Hay que recrearla y volver a conectarla a la automatización; no es algo que se resuelva solo editando.
- **Quiero cambiar a quién llegan los avisos internos del equipo:** es una petición al equipo técnico. El destinatario está fijado dentro de la automatización.
- **No sé si un email es una notificación nativa o del flujo B2B:** las nativas se editan en Settings → Notifications (activación de cuenta, recuperación de contraseña); las del flujo B2B se editan en Marketing → Email (acuse, bienvenida, aprobación, rechazo, acuse de solicitud).

## Cambios

- **v0.2** (16-may-2026): documento completado. Cubre las notificaciones nativas de Shopify, las 15 plantillas del flujo B2B (5 emails × 3 idiomas), cómo editar el copy, cómo previsualizar con Test campaign, y la advertencia de no eliminar plantillas. La sección de emails administrativos internos sigue abierta a definición de negocio.
- **v0.1** (12-may-2026): primera publicación · estructura inicial
