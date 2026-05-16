# Resolución de incidencias

!!! info "Estado del documento"
    **Versión:** 0.2 · 16-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Operador de back-office
    **Bloqueado por:** —

## Resumen

Catálogo de las incidencias más frecuentes que te puedes encontrar como operador y cómo resolverlas. La regla general: **tu margen de actuación es limitado y está bien que lo sea.** Muchas incidencias se resuelven con "refresca la página" o "avisa al administrador". No tienes que arreglar el sistema; tienes que saber reconocer qué pasa y a quién escalarlo.

Si una incidencia no está en esta lista, o las instrucciones no la resuelven, **avisa al administrador**. No improvises sobre el portal.

## Cómo usar este documento

Las incidencias están agrupadas por dónde aparecen: acceso al backoffice, aprobación de altas, whitelist, quitar acceso, y cosas que te reportan los clientes. Busca tu situación en el grupo que corresponda.

Para todas ellas, el primer intento casi siempre es el mismo: **refresca la página del backoffice y vuelve a probar.** Muchos fallos aparentes son solo la pantalla desactualizada.

## Acceso al backoffice

### No me carga el backoffice / me dice "Acceso restringido"

Tu cuenta de cliente no tiene permisos de back-office. No es algo que puedas arreglar tú.

- Comprueba que has iniciado sesión con la cuenta correcta (la que te dieron para el back-office, no una cuenta de cliente normal).
- Si es la cuenta correcta y sigue saliendo "Acceso restringido", avisa al administrador para que revise los permisos de tu cuenta.

### Entré bien hace un rato y ahora me pide algo o falla al pulsar un botón

La sesión del backoffice caduca por seguridad pasado un tiempo. Si llevas la página abierta mucho rato y al pulsar Aprobar, Rechazar o Añadir a whitelist no pasa nada o ves un aviso de sesión caducada:

1. Refresca la página del backoffice.
2. Vuelve a iniciar sesión si te lo pide.
3. Repite la acción.

Esto es comportamiento normal, no un fallo. Refrescar la página renueva la sesión.

## Aprobación de altas

### No me llegan los emails de solicitud nueva

- Comprueba la carpeta de **spam** de tu correo.
- Comprueba que estás mirando el buzón correcto (el que el equipo configuró como destinatario de los avisos).
- Si no aparecen ni en spam, avisa al administrador: puede ser un problema de la automatización de avisos, que solo el equipo técnico puede revisar.

Recuerda que las altas de clientes que están en la whitelist **no generan email** — se aprueban solas. Si esperabas un aviso de alguien y no llega, comprueba con el comercial si esa persona estaba en la whitelist.

### El botón Aprobar o Rechazar no hace nada

1. Refresca la página y vuelve a intentarlo.
2. Si tras refrescar sigue sin responder, avisa al administrador.

No pulses el botón muchas veces seguidas pensando que no se ha registrado: espera, refresca, y comprueba en los números del bloque "Resumen" si la acción se aplicó.

### He aprobado o rechazado a quien no debía

- **Aprobé a alguien que debía rechazar:** quítale el acceso siguiendo [Quitar acceso](03-quitar-acceso.md).
- **Rechacé a alguien que debía aprobar:** avisa al administrador. Volver a dejar a esa persona como "pendiente" para re-aprobarla no siempre es posible desde el backoffice; el administrador lo resuelve más rápido desde Shopify.

En ambos casos, si tienes dudas antes de actuar, confirma con el comercial que hizo la petición.

### Hay más de 250 solicitudes pendientes

La tabla de pendientes muestra como máximo las 250 más recientes y te avisa de que hay más. Si ves ese aviso, significa que la revisión de altas va con retraso acumulado. Avisa al administrador — no es una incidencia que resuelvas tú pulsando botones, es una señal de que el flujo de trabajo necesita atención.

### Los datos de una solicitud parecen falsos o incoherentes

No decidas tú. Si el email parece personal en vez de corporativo, o la empresa y el NIF no cuadran, o el sector no encaja con un perfil B2B de iluminación: reenvía el email de notificación al comercial responsable y espera su respuesta antes de aprobar o rechazar.

## Whitelist

### El sistema dice que un email es inválido y yo lo veo bien

- Comprueba que no haya espacios al principio o al final del email.
- Comprueba que no haya caracteres raros, especialmente acentos en la parte anterior a la `@`.
- Vuelve a teclearlo a mano en lugar de pegarlo, por si venía con algún carácter invisible.
- Si tras eso sigue rechazándolo, avisa al administrador.

### He pegado una lista larga y solo se han añadido algunos

Es lo normal. El sistema te dice cuántos eran nuevos, cuántos ya estaban y cuántos eran inválidos. Los que "faltan" casi siempre **ya estaban** en la whitelist — no es un error. Despliega la whitelist actual para confirmarlo.

### Necesito quitar un email de la whitelist

El backoffice solo permite **añadir** emails a la whitelist, no quitarlos. Si hay que retirar un email, avisa al administrador.

### Añadí un email a la whitelist pero esa persona sigue como pendiente

Si la persona ya se había registrado **antes** de que la añadieras a la whitelist, su aprobación automática no es instantánea: el sistema la procesa en los **30 minutos** siguientes. Espera media hora y comprueba de nuevo. Si pasado ese tiempo sigue como pendiente, puedes aprobarla a mano desde el bloque de pendientes, o avisar al administrador.

## Quitar acceso

### No encuentro al cliente en el buscador de "Clientes aprobados"

- Prueba a buscar por otros campos: email exacto, nombre completo, nombre de la empresa.
- Si no aparece por ninguno, puede que ese cliente ya no tenga acceso (ya se le retiró antes) o que su email esté mal escrito.
- Si deberías encontrarlo y no aparece, avisa al administrador.

### He quitado el acceso a alguien por error

Recuerda que quitar acceso es una acción **directa, sin confirmación**. Si te has equivocado:

- Lo más rápido suele ser volver a aprobar a esa persona desde el bloque de pendientes, pero solo funciona si su cuenta vuelve a aparecer ahí.
- Si no reaparece como pendiente, avisa al administrador. Para él es rápido restaurar el acceso desde Shopify.

### El cliente dice que sigue entrando después de quitarle el acceso

Dile que **cierre sesión y vuelva a entrar**. Mientras tenga la sesión abierta puede que siga viendo el portal hasta que recargue. Si tras cerrar sesión y volver a entrar todavía accede, avisa al administrador.

## Incidencias que te reportan los clientes

Como operador no das soporte técnico a los clientes, pero a veces te llegan quejas. Esto es lo que puedes hacer con las más típicas:

### "No puedo entrar al portal" / "no recibí el email de activación"

Cuando alguien se registra recibe un email para activar su cuenta y poner contraseña. Si dice que no le llegó:

- Que compruebe su carpeta de spam.
- Si confirmas que la cuenta existe (la ves en pendientes o en aprobados) pero el email de activación no llegó, avisa al administrador: desde Shopify se puede reenviar la invitación de cuenta.

### "Veo el portal en español y debería estar en otro idioma"

No es una incidencia del backoffice. Anótalo y trasládalo al administrador — la gestión de idiomas no es tarea del operador.

### "Un precio o un producto está mal"

Nada que ver con el back-office. El catálogo, los precios y el stock vienen de la importación y los gestiona el equipo comercial / técnico. Traslada la queja a quien corresponda; tú no tocas el catálogo.

### "Me rechazasteis y no sé por qué"

Si rechazaste la cuenta con un motivo, el cliente lo habrá recibido en el email de rechazo. Si el motivo era subsanable (por ejemplo, un NIF mal escrito), puede volver a registrarse con los datos corregidos. Si fue un rechazo por criterio comercial, traslada la conversación al comercial responsable — no es una decisión que reabras tú.

## Cuándo escalar al administrador

Resumen rápido. Avisa al administrador siempre que:

- No puedas acceder al backoffice y no sea un problema de sesión caducada.
- Un botón siga sin responder después de refrescar la página.
- Haya que **quitar** un email de la whitelist.
- Haya que restaurar a alguien que rechazaste o a quien quitaste acceso por error y no reaparece como pendiente.
- Haya más de 250 solicitudes pendientes acumuladas.
- No lleguen los emails de aviso de solicitud nueva.
- Una incidencia no esté en este documento o las instrucciones no la resuelvan.

Escalar no es un fallo tuyo: el backoffice está pensado para que el operador haga las tres tareas habituales (aprobar, whitelist, quitar acceso) y para que todo lo demás lo resuelva quien tiene acceso completo al sistema.

## Cambios

- **v0.2** (16-may-2026): documento completado. Catálogo de incidencias frecuentes agrupadas por área (acceso al backoffice, aprobación, whitelist, quitar acceso, quejas de clientes) con su resolución estándar, más una guía de cuándo escalar al administrador.
- **v0.1** (12-may-2026): primera publicación · estructura inicial
