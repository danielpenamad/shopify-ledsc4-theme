Qué tienes que hacer
En el admin de Shopify:

Arriba a la izquierda haz click en Apps. Busca Flow. Si no aparece, instálalo (es gratis, de Shopify mismo). Se instala en 10 segundos.
Dentro de Flow verás un botón grande Create workflow. Lo vas a pulsar 4 veces (una por cada workflow que diseñé).
Cada vez que pulses "Create workflow", Flow te pide 3 cosas:
Trigger (el "cuándo"): p.ej. "cuando un cliente se cree", "cuando un cliente se actualice", "cada 30 minutos".
Conditions (el "pero solo si..."): p.ej. "solo si el tag contiene pendiente".
Actions (el "haz esto"): p.ej. "añade el tag aprobado", "manda email", "ejecuta código".
Lo configuras arrastrando bloques. No hay que escribir código (salvo en un paso de uno de ellos).

Qué le copias de los 4 ficheros .md
Yo te dejé 4 recetas en la carpeta flows/:

W1-registro.md → la receta del primer workflow
W2-aprobacion-manual.md → la del segundo
W3-rechazo-manual.md → la del tercero
W4-whitelist-reeval.md → la del cuarto
Abres cada fichero, lees las secciones "Trigger", "Conditions" y "Actions", y las reproduces dentro de Flow clickando los bloques que se llamen igual. Es copiar-pegar conceptual, no texto.

Analogía: es como si yo te hubiera escrito una receta de cocina y tú fueras a la cocina (Flow) a reproducir los pasos. No estás inventando nada, solo ejecutando.

Cuánto tarda
El W2 y el W3 son los más cortos (5-10 min cada uno).
El W1 es el más largo porque tiene rama IF/ELSE (15-20 min).
El W4 tiene un paso "Run code" donde copias-pegas un snippet de JavaScript que ya te dejé escrito en el .md. 10-15 min.
Total: ~1 hora de click-click en el admin. No hay que pensar nada técnico, solo seguir las recetas.

Al terminar cada workflow
Hay un botón "..." → Export. Pulsas, te baja un fichero .flow.json, y lo guardas en la carpeta flows/ del repo con el nombre W1-registro.flow.json (o como se llame). Eso es para tener copia de lo que has configurado y poder replicarlo en otra tienda si hiciera falta.

¿Lo hago yo por ti?
No puedo — Shopify no expone una API pública para crear Flows desde código. Es clickeo en el admin obligatorio. Pero puedo:

Hacer una videollamada / screenshare virtual guiándote paso a paso.
Revisar que lo hayas montado bien leyendo el export .flow.json que me pegues.
Si te atascas en algún bloque, dime exactamente en cuál y te escribo los clicks.