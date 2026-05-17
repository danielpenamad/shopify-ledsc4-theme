# Aprobar altas

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Operador back-office
    **Bloqueado por:** —

## Resumen

Cuando un usuario se registra en el portal B2B y **no** está en la lista de pre-aprobados (whitelist), su solicitud queda pendiente de revisión. Tu trabajo es decidir si se le da acceso o no.

## Cuándo lo haces

Solo cuando te llega un email de notificación de solicitud nueva. No hace falta entrar a comprobar pendientes si no has recibido aviso.

## Cómo lo haces

1. **Abre el backoffice:**
   🔗 [https://ledsc4-b2b-outlet.myshopify.com/pages/admin-backoffice](https://ledsc4-b2b-outlet.myshopify.com/pages/admin-backoffice)

2. **Baja hasta el bloque "Pendientes de aprobación".**
   Verás una tabla con todas las solicitudes que esperan decisión. Cada fila muestra:
    - Email del solicitante
    - Empresa
    - NIF
    - Sector
    - Fecha de registro

3. **Localiza la solicitud que te ha llegado por email.**
   Busca por el email del solicitante.

4. **Revisa los datos.**
   Comprueba que la información es coherente:
    - ¿El email parece corporativo y no de un buzón personal?
    - ¿La empresa y el NIF existen?
    - ¿El sector encaja con un perfil B2B de iluminación?

   Si tienes dudas, no decidas tú. Reenvía el email de notificación al comercial responsable y espera respuesta antes de actuar.

5. **Pulsa el botón que corresponda:**
    - **Aprobar** → el cliente queda con acceso al portal. Se le envía un email automático de bienvenida.
    - **Rechazar** → se abre un diálogo donde puedes escribir un motivo (opcional, máximo 500 caracteres). El motivo se incluye en el email automático que recibe el cliente. Si no escribes nada, se le manda el email de rechazo estándar sin motivo específico.

6. **Confirma que se ha aplicado.**
   Los números del bloque "Resumen" arriba se actualizan solos (Pendientes baja en 1, Aprobados o Rechazados sube en 1). Si no ves el cambio, refresca la página.

## Sobre el motivo de rechazo

Es opcional pero **recomendable** cuando el rechazo se debe a datos incorrectos que el cliente podría corregir (ej. "el NIF introducido no es válido, vuelva a intentar el registro con los datos correctos").

Para rechazos definitivos por criterio comercial (ej. competencia directa), deja el motivo vacío. El email estándar no da pistas innecesarias.

## Si algo va mal

- **El botón Aprobar/Rechazar no hace nada:** refresca la página y vuelve a intentarlo. Si sigue sin funcionar, avisa al administrador.
- **Apruebo a alguien que no debería:** se le quita el acceso siguiendo el proceso de [Quitar acceso](03-quitar-acceso.md).
- **Hay más de 250 solicitudes pendientes:** la tabla muestra solo las 250 más recientes y te avisa de que hay más. Avisa al administrador, porque significa que el flujo de revisión va con retraso.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (12-may-2026): primera publicación
