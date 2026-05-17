# Gestionar la whitelist

!!! info "Estado del documento"
    **Versión:** 1.1 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Operador back-office
    **Bloqueado por:** —

## Resumen

La **whitelist** es la lista de emails pre-aprobados. Cuando alguien con un email de esta lista se registra en el portal, su cuenta queda aprobada automáticamente, sin pasar por tu revisión. Sirve para no hacer esperar a clientes que el equipo comercial ya tiene identificados como válidos.

## Cuándo lo haces

Solo cuando un comercial te pasa una lista de emails para añadir, o cuando te piden retirar un email que ya no debe estar pre-aprobado. No hace falta mantener la whitelist por iniciativa propia.

## Cómo añadir emails

1. **Abre el backoffice:**
   🔗 [https://ledsc4-b2b-outlet.myshopify.com/pages/admin-backoffice](https://ledsc4-b2b-outlet.myshopify.com/pages/admin-backoffice)

2. **Localiza el bloque "Whitelist de emails pre-aprobados".**

3. **Pega los emails en el cuadro de texto.**
   Puedes pegarlos en cualquier formato — el sistema los separa solo. Funciona con:
    - Un email por línea
    - Emails separados por coma
    - Emails separados por punto y coma
    - Emails separados por espacios

   Ejemplos válidos:
juan@empresa.com
maria@empresa.com
pedro@empresa.com

   o también:
juan@empresa.com, maria@empresa.com, pedro@empresa.com

4. **Pulsa el botón para añadir.**

5. **Lee el resultado.**
   El sistema te dirá:
    - Cuántos emails nuevos se han añadido
    - Cuántos estaban ya en la lista (se ignoran, no es un error)
    - Cuántos no son emails válidos (te los muestra para que revises)

6. **Confirma con los números arriba.**
   El número "Emails en whitelist" sube. La "Última actualización" cambia a la fecha y hora de ahora.

## Cómo ver qué hay en la whitelist

En el mismo bloque, hay una opción para **desplegar la whitelist actual** y ver todos los emails que están cargados. Se muestran en una lista, un email por fila.

## Cómo quitar un email

Si te piden retirar un email de la whitelist, puedes hacerlo desde el mismo panel, sin avisar al administrador.

1. **Despliega la whitelist actual** (ver sección anterior).

2. **Busca el email que quieres retirar** en la lista.

3. **Pulsa el botón "Quitar"** que aparece en esa fila.

4. **Confirma.**
   Aparece una ventana de confirmación con el email concreto. Pulsa aceptar para retirarlo, o cancelar si te has equivocado de fila. Esta confirmación está para evitar quitar un email por error — léela antes de aceptar.

5. **Comprueba el resultado.**
   El email desaparece de la lista y el número "Emails en whitelist" baja.

Los emails se quitan **de uno en uno**. Si te pasan una lista larga para retirar, hazlo email por email.

!!! note "Quitar un email no afecta a clientes ya aprobados"
    Retirar un email de la whitelist **no des-aprueba a ningún cliente** que ya esté aprobado. El estado de un cliente aprobado es independiente de la whitelist: conserva su acceso con normalidad.

    Lo único que cambia es el futuro: ese email ya no provocará una aprobación automática. Y es reversible — si te equivocas, basta con volver a añadirlo con el cuadro de pegado.

## Qué pasa después

- Si un email de la whitelist **ya se ha registrado antes** y su solicitud estaba pendiente, se aprueba automáticamente en los siguientes 30 minutos sin que tengas que hacer nada más.
- Si un email de la whitelist **se registra a partir de ahora**, su cuenta se aprueba en el momento del registro.

## Si algo va mal

- **El sistema me dice que un email es inválido y estoy seguro de que está bien:** comprueba que no hay espacios al principio o al final, ni caracteres raros (acentos en la parte antes de la @, por ejemplo). Si sigue rechazándolo, avisa al administrador.
- **He pegado una lista enorme y solo se han añadido algunos:** los que faltan probablemente ya estaban en la lista. Comprueba la lista actual desplegándola.
- **He quitado un email por error:** vuelve a añadirlo con el cuadro de pegado. Recuperar un email retirado no tiene ninguna consecuencia.
- **No encuentro el botón "Quitar":** asegúrate de haber desplegado la whitelist actual; el botón aparece en cada fila de la lista, no en el cuadro de pegado.

## Cambios

- **v1.1** (17-may-2026): añadida la sección "Cómo quitar un email" y la nota sobre clientes aprobados; actualizada la sección de consulta y el apartado "Si algo va mal" para reflejar que el operador ya puede retirar emails desde el panel.
- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (12-may-2026): primera publicación
