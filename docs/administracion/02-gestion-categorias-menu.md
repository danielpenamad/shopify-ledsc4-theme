# Categorías y menú

!!! info "Estado del documento"
    **Versión:** 0.3 · 04-jun-2026
    **Estado:** ✅ completo
    **Audiencia:** Administrador del negocio
    **Bloqueado por:** —

## Resumen

Las categorías del portal B2B (lo que el cliente ve en el menú del header como Forlight, Architectural, Decorative, etc.) y el propio menú están **gestionados por scripts del equipo técnico**. Como administrador del negocio no creas categorías, no las renombras, no las reordenas y no editas el menú. Tu rol con las categorías es entender la estructura para poder verificar que un producto está donde el comercial te dice que debería estar.

## Cómo está organizado el catálogo

El menú del portal tiene una **estructura cerrada de 5 categorías padre**, cada una con sus categorías hijo (excepto la última, que es un padre suelto):

| Padre | Handle de colección | Tiene hijos |
| --- | --- | --- |
| Forlight | `cat-forlight` | Sí |
| Architectural | `cat-architectural` | Sí |
| Decorative | `cat-decorative` | Sí |
| Outdoor | `cat-outdoor` | Sí |
| Emergency | `cat-emergency` | Sí |

Los **5 padres son fijos**: no se añaden, no se quitan, no se renombran. El número y nombre de los **hijos** dentro de cada padre lo define el equipo técnico desde código. En total el portal tiene del orden de 53 colecciones con handle `cat-*` (los 5 padres más los 48 hijos).

### Cómo se ve desde fuera y desde dentro

- **Desde el portal** (lo que ve el cliente logado): los 5 padres aparecen en el header como un menú de navegación. Al pasar el ratón por encima de un padre, se despliega su submenú con los hijos (Emergency también, desde el alta de sus tipos en jun-2026).
- **Desde Shopify Admin → Products → Collections**: verás todas las colecciones `cat-*` listadas. Son **smart collections** definidas por reglas (no las pueblas tú a mano: los productos entran o salen automáticamente según sus campos del CSV de surtido).

### Sobre el orden dentro de los dropdowns

Dentro de cada padre, los hijos del submenú aparecen **ordenados automáticamente** por cantidad de productos, de mayor a menor. Lo hace el script que regenera el menú. **No se puede reordenar a mano**: si un comercial pide subir o bajar manualmente un hijo dentro del dropdown, la respuesta es que el orden lo decide el script y no se reordena desde Shopify. Si hay un motivo de negocio para cambiar el criterio de ordenación (por ejemplo, ordenar alfabéticamente, o destacar ciertos hijos), se cambia la lógica del script — eso es una petición al equipo técnico.

## Cómo se mantienen el menú y las categorías

El equipo técnico mantiene dos scripts que se encargan de toda la estructura:

- Un script crea y actualiza las **colecciones** `cat-*` (los 5 padres y sus hijos). Es idempotente: si la estructura ya está bien, no hace nada.
- Otro script reconstruye el **menú del header** para que refleje la jerarquía actual, ordenando los hijos por cantidad de productos.

Los scripts se ejecutan cuando el equipo técnico añade, quita o renombra categorías. Como administrador no los ejecutas tú y, en general, ni te enteras: el resultado lo ves en el portal y en Shopify Admin → Collections / Online Store → Navigation.

La documentación técnica de estos scripts está en el eje [Desarrollo](../desarrollo/index.md) (docs de scripts y de operaciones).

## Lo que NO debes hacer

- **No crear colecciones nuevas** desde Shopify Admin → Products → Collections. Las colecciones del portal son las `cat-*` y están definidas en código. Crear una colección a mano no la integra en el menú ni la cubre el script — queda huérfana y puede confundir.
- **No renombrar las colecciones** `cat-*`. El script las regenera y rompe la coherencia con los hijos esperados. Además, los títulos en otros idiomas vienen de la importación y se sobrescribirían igualmente.
- **No borrar ni archivar colecciones** `cat-*`. El script las recreará en su siguiente ejecución, pero mientras tanto el menú del portal puede quedar inconsistente.
- **No tocar la lista de productos de una colección** intentando añadir o quitar productos a mano. Son smart collections: la pertenencia se decide por los campos del CSV. Cualquier cosa que hagas a mano no tiene efecto duradero.
- **No editar el menú** desde Shopify Admin → Online Store → Navigation. El script reescribe el menú `main-menu`: añadir, quitar o reordenar entradas a mano se pierde en la siguiente ejecución.
- **No editar los títulos** de las colecciones (ni en español ni en otros idiomas). Los títulos vienen de la importación de catálogo, no se editan en Shopify (ver [Traducciones](04-traducciones.md)).

## Si algo va mal

- **Un producto no aparece en la categoría que esperaba:** comprueba primero en el portal logado como cliente aprobado, no desde Shopify Admin (la vista pública aplica los filtros de Locksmith y las traducciones, que pueden diferir de lo que ves en el admin). Si en el portal sigue sin aparecer, el problema es de **categorización del producto en el CSV de origen**, no del menú. Avisa al equipo comercial responsable del CSV.
- **Un producto aparece en una categoría que no encaja con su nombre comercial (ej. una lámpara titulada "Flexo" aparece en cat-forlight-sobremesa):** el metafield `tipo` no siempre coincide con la palabra del título — la pertenencia a la sub-categoría se decide por el metafield, no por el título. Si crees que es un error de catalogación, avisa al equipo técnico para revisar la regla.
- **El menú del portal no refleja una categoría que el equipo técnico me dijo que ya existe:** puede que el script de menú no se haya ejecutado todavía tras añadir la categoría. Avisa al equipo técnico para que lo confirmen.
- **He tocado una colección `cat-*` o el menú por error:** no intentes deshacerlo a mano. Avisa al equipo técnico y describe qué tocaste — los scripts restaurarán la estructura correcta en su próxima ejecución.
- **Un comercial me pide crear una categoría nueva o cambiar la jerarquía:** no es una tarea que puedas resolver. Traslada la petición al equipo técnico con el detalle del cambio que pide el negocio (qué categoría, dentro de qué padre, qué productos debería contener).

## Cambios

- **v0.3** (04-jun-2026): añadidos 15 hijos faltantes detectados en auditoría del feed Coleccion:2026 (Decorative: Superficie de Techo, Pie, Proyector, Pantalla Accesorio · Outdoor: Baliza, Empotrable de techo, Componente · Forlight: Luz de lectura, Chillout, Flexo, Módulo, Empotrable de pared · Architectural: Perfil · Emergency: Superficie de Pared, Superficie de Techo). Recuento actualizado a 5 + 48 = 53. Emergency pasa a tener dropdown.
- **v0.2** (16-may-2026): corregida una incongruencia interna — el cuerpo decía "los 6 padres" mientras la tabla lista 5. Son 5 (Forlight, Architectural, Decorative, Outdoor, Emergency). Precisado el conteo de colecciones (5 padres + 33 hijos). El eje Desarrollo, antes pendiente, ya está publicado.
- **v0.1** (12-may-2026): primera publicación
