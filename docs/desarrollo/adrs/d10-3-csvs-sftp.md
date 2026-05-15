# D10 · 3 CSVs SFTP separados (importer)

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · 4-may-2026 (acordada con cliente) · vigente.

## Contexto

El cliente entrega el catálogo desde su ERP (Microsoft Dynamics AX) a un servidor SFTP. Tres dimensiones de datos viajan con frecuencias y módulos de origen distintos:

- **Surtido + atributos técnicos + descripciones** — set completo de productos con sus 79 columnas (familia, tipo, dimensiones, materiales, garantía, imágenes, etc.). Cambia poco — el ERP genera el export semanal.
- **Traducciones** — los atributos descriptivos (familia, tipo, material, descripciones largas) existen en 6 idiomas (ES, EN, IT, DE, FR, PT). El ERP del cliente genera cada idioma como un job de export independiente, no como columnas de un mismo fichero.
- **Stock y precios** — datos volátiles, viven en módulos separados del ERP. Frecuencia: varias veces al día.

Restricciones del cliente:

- El ERP no soporta export multi-hoja Excel automatizado — el formato disponible es CSV plano.
- Generar un único fichero consolidado implicaría sincronizar 3+ jobs ERP que hoy no están conectados.
- Los nombres de columna del export pueden cambiar con el tiempo, pero el orden no — el cliente garantiza estabilidad posicional.

## Decisión

El SFTP entrega **3 categorías de CSV** en directorios separados:

```
/productos/listado_productos_ES.csv    (semanal, surtido, 79 cols, idioma fuente)
/productos/listado_productos_EN.csv    (semanal, mismo SKU set, traducido)
/productos/listado_productos_IT.csv    (idem)
/productos/listado_productos_DE.csv    (idem)
/productos/listado_productos_FR.csv    (idem)
/productos/listado_productos_PT.csv    (idem)
/stock/stock.csv                       (cada 6h, 2 cols: SKU, INVENTARIO)
/precios/precios_productos.csv         (cada 6h, 2 cols: SKU, TARIFA)
```

Política de publicación (regla de oro):

> Un producto se publica en "Outlet general" si y solo si está en el fichero de surtido **AND** tiene stock > 0 **AND** tiene precio > 0. Si falla alguna condición, se despublica del catalog (no se borra del shop).

El idioma fuente es **ES** — `product.title` y `product.body_html` se construyen desde el fichero ES. Las traducciones se cargan vía `translationsRegister` desde los 5 CSVs restantes.

Lectura de columnas **por posición** (column_index), no por nombre. El parser valida el número de columnas (79 / 2 / 2); cualquier discrepancia dispara error duro.

## Alternativas consideradas

**1 CSV consolidado con columnas suffix por idioma.** Descartada: explosión de columnas (79 × 6 = 474), incompatible con la generación por jobs separados del ERP del cliente, y el archivo resultante supera límites razonables de gestión manual.

**Webhook directo desde el ERP del cliente.** Descartada: el cliente no tiene capacidad de ingeniería para mantener un push. SFTP es su contrato operativo estándar para integraciones.

**Frecuencia única (semanal o diaria) para todos los ficheros.** Descartada: el cliente genera surtido en pipeline semanal pesado, pero stock y precios cambian a diario. Forzar una frecuencia común duplicaría coste sin beneficio.

**Lectura por nombre de columna** (en lugar de por posición). Descartada por requisito explícito del cliente: prefiere garantizar el orden a comprometerse con la estabilidad de los nombres.

## Consecuencias

- **Dos cron jobs distintos** en lugar de uno único:
  - `import-surtido-semanal` (pipeline pesado: parser + mapper + writer completo).
  - `import-stock-precios` cada 6h (pipeline ligero: solo `inventory_levels` y `variants.price`).
- **Idioma fuente fijado en ES**. Cambiar el idioma fuente en el futuro implicaría rehacer la lógica del mapper (no afecta a las traducciones registradas, que son recurso aparte).
- **SKUs presentes en ES pero ausentes en otro idioma** — caso esperado en datos reales. El mapper omite la traducción del campo faltante; Translate & Adapt aplica fallback al idioma fuente automáticamente. Ver [02-importer](../02-importer.md) §multi-idioma.
- **Anomalías de datos**: los CSVs del cliente vienen con duplicados, valores no numéricos en columnas dimensionales, whitespace inconsistente. El parser y el mapper aplican reglas específicas para cada caso (first-wins en surtido, suma en stock, `null + warning` en valores no parseables). Detalle completo en [02-importer](../02-importer.md) §anomalías.
- **Lectura por posición** implica que reordenar columnas en el export del cliente rompe el pipeline. El parser valida el número de columnas pero **no detecta reordenamiento interno** con el mismo número de columnas — silenciosamente se asignan valores a campos equivocados. Deuda conocida; mitigación pendiente con checksum de cabecera o sample-row validation.
- **El criterio de publicación sustituye al tag `Coleccion:2026`**. El tag se conserva en los productos importados por compatibilidad transitoria, pero la fuente de verdad es el cruce surtido + stock + precio. Documentado en [D6](d06-catalogo-unico.md).

## Cambios

- **v0.1** (15-may-2026): primera publicación.
