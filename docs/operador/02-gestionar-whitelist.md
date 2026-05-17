# Gestionar la whitelist

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Operador back-office
    **Bloqueado por:** —

## Resumen

La **whitelist** es la lista de emails pre-aprobados. Cuando alguien con un email de esta lista se registra en el portal, su cuenta queda aprobada automáticamente, sin pasar por tu revisión. Sirve para no hacer esperar a clientes que el equipo comercial ya tiene identificados como válidos.

## Cuándo lo haces

Solo cuando un comercial te pasa una lista de emails para añadir. No hace falta mantener la whitelist por iniciativa propia.

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

En el mismo bloque, hay una opción para **desplegar la whitelist actual** y ver todos los emails que están cargados. Es solo de consulta, no se puede editar desde ahí (solo añadir desde el cuadro de pegado).

## Qué pasa después

- Si un email de la whitelist **ya se ha registrado antes** y su solicitud estaba pendiente, se aprueba automáticamente en los siguientes 30 minutos sin que tengas que hacer nada más.
- Si un email de la whitelist **se registra a partir de ahora**, su cuenta se aprueba en el momento del registro.

## Si algo va mal

- **El sistema me dice que un email es inválido y estoy seguro de que está bien:** comprueba que no hay espacios al principio o al final, ni caracteres raros (acentos en la parte antes de la @, por ejemplo). Si sigue rechazándolo, avisa al administrador.
- **He pegado una lista enorme y solo se han añadido algunos:** los que faltan probablemente ya estaban en la lista. Comprueba la lista actual desplegándola.
- **No quiero que un email siga en la whitelist:** la whitelist solo permite añadir desde el panel. Para retirar un email, avisa al administrador.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (12-may-2026): primera publicación
