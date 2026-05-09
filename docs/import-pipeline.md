# Pipeline de importación — LedsC4 B2B Outlet

Reemplaza al §9 de [`docs/arquitectura.md`](arquitectura.md) (que estaba
diseñado contra un formato hipotético "Excel multi-hoja + CSV 2-col" que
el cliente ha redefinido). Esta es la arquitectura real del importador
acordada con el cliente el 2026-05-04.

Estado a 2026-05-09: I1, I2, I3, I3.5, I3.6, I4.1, I4.2 e I4.3
implementadas y operativas. Pipeline corre automáticamente vía
pg_cron de Supabase (stock_only cada 6h UTC + full diario UTC
02:00). Última actualización: 2026-05-09.

---

## 1. Resumen

El cliente publica desde su ERP (Microsoft Dynamics AX) **3 ficheros CSV
en SFTP**, no uno único. Cada fichero tiene su propia frecuencia y
responsabilidad, y la publicación de un producto en el catálogo "Outlet
general" es resultado del cruce de los 3.

```
SFTP del cliente
├─ /productos/listado_productos_ES.csv    (semanal, surtido completo, 79 cols)
├─ /productos/listado_productos_EN.csv    (semanal, mismo SKU set, columnas traducidas)
├─ /productos/listado_productos_IT.csv    (idem)
├─ /productos/listado_productos_DE.csv    (idem)
├─ /productos/listado_productos_FR.csv    (idem)
├─ /productos/listado_productos_PT.csv    (idem)
├─ /stock/stock.csv                       (cada 6h, 2 cols: SKU, INVENTARIO)
└─ /precios/precios_productos.csv         (cada 6h, 2 cols: SKU, TARIFA)
```

Política de publicación (regla de oro):

> Un producto se publica en "Outlet general" **sí y sólo sí** está en el
> fichero de surtido **AND** tiene stock > 0 en el fichero de stock
> **AND** tiene precio > 0 en el fichero de precios.
>
> Si falla alguna condición, se despublica del catalog (no se borra del
> shop) y aparece en el reporte de la ejecución.

Este criterio sustituye al actual basado en el tag `Coleccion:2026`. El
tag se conserva por compatibilidad pero deja de ser fuente de verdad.

---

## 2. Decisiones arquitectónicas

| Decisión | Resultado | Por qué |
|---|---|---|
| **Multi-idioma** | Translate & Adapt + Admin API `translationsRegister` | App oficial Shopify, gratis, soportada por Dawn. Sin Markets. |
| **Multi-divisa** | NO (Fase 1 sólo EUR) | Aparcado a Fase 2 condicionada a tracción internacional real. Ver respuesta opción A en kickoff de cambio de alcance. |
| **Idiomas cargados** | Los 6 (ES,EN,IT,DE,FR,PT) | Coste marginal cero en pipeline. Coste tuyo: 0h adicionales vs 2 idiomas. |
| **Idiomas publicados** | A confirmar con cliente (probablemente ES + EN) | Decisión de negocio, no técnica. Activar uno extra es 5 min en admin. |
| **Lectura de columnas** | Por **posición** (column_index) | Requisito explícito del cliente: los nombres de columna pueden cambiar con el tiempo aunque el orden no. |
| **Idioma fuente** | ES | Es el idioma de partida en `product.title` y `product.body_html`. Las otras 5 traducciones se cargan vía `translationsRegister`. |
| **SKUs duplicados en surtido** | first wins + log warning | El cliente ha confirmado que los duplicados son bug de su export. |
| **SKU sin stock** | despublicar + reportar | Cliente confirma "se ocultan y se informa". |
| **Frecuencia de import** | 2 cron diferentes | Surtido semanal (pesado) + stock/precios cada 6h (ligero). Reduce coste y simplifica errores. |
| **Frecuencia API tipo de cambio** | N/A en Fase 1 | Sólo EUR. Cuando se active Markets en Fase 2, ECB daily rates (gratis, oficial UE). |

Mapping completo de las 79 columnas → Shopify en
[`scripts/mapping.json`](../scripts/mapping.json).

---

## 3. Arquitectura por capas

```
┌─────────────────────────────────────────────────────────────────────┐
│                       PIPELINE COMPLETO (semanal)                   │
└─────────────────────────────────────────────────────────────────────┘

  SFTP ─────┐
            │
            ▼
       ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
       │ source  │───▶│  parser  │───▶│  mapper  │───▶│  writer  │
       └─────────┘    └──────────┘    └──────────┘    └──────────┘
            │              │               │               │
            │              │               │               ▼
            │              │               │         ┌──────────┐
            │              │               │         │ reporter │
            │              │               │         └──────────┘
            │              │               │               │
            ▼              ▼               ▼               ▼
       Lee 8 CSVs    734 records     Modelo Shopify   Admin GraphQL
       del SFTP      por idioma      (Product, Tags,  productSet
                     + 2682 stock    Metafields,      productVariantUpdate
                     + N precios     Translations)    translationsRegister
                                                      productPublish/Unpublish
                                                                │
                                                                ▼
                                                        reports/
                                                        import-YYYY-MM-DD.csv

┌─────────────────────────────────────────────────────────────────────┐
│                      PIPELINE LIGERO (cada 6h)                      │
└─────────────────────────────────────────────────────────────────────┘

  SFTP /stock/ + /precios/  ──▶  parser  ──▶  reconciler  ──▶  writer
                                                  │
                                                  ▼
                                             Sólo cambia:
                                             - inventory_levels
                                             - variants.price
                                             - product publication state
```

### 3.1 source

Adaptador único responsable de obtener los CSVs. En Fase 1 lee de
filesystem local (carpeta `samples/`); cuando se entreguen las
credenciales, se sustituye por adaptador SFTP **sin tocar el resto del
pipeline**.

Interfaz: `getFile(remotePath) → Buffer`.

### 3.2 parser

Lee cada CSV por **posición de columna**. **Puramente sintáctico**:
extrae strings respetando quoting CSV estándar, normaliza vacíos /
`NULL` / `-` → `null`, y nada más. **No hace coerción de tipos** —
los decimales con coma, booleanos `Si/No`, etc. se procesan en el
mapper, que es quien conoce el contrato del mapping.

Errores que no detienen la ejecución sino que se loguean:

- SKU duplicado en surtido (**first wins** — confirmado por cliente
  2026-05-06, ver §11.2).
- SKU duplicado en stock (**suma de unidades** — decisión cliente
  2026-05-05, ver §11.1).
- Fila con menos columnas que la cabecera (skip + warning).

Errores que sí detienen la ejecución:

- Cabecera con número de columnas distinto al esperado (79 surtido,
  2 stock, 2 precios).
- Fichero ES ausente o vacío (es el idioma fuente).
- SKU faltante en una fila (col 0 vacía).

### 3.3 mapper

Convierte los registros del parser al modelo de Shopify y **aplica
toda la coerción de tipos** según el contrato declarativo de
`mapping.json` (decimales con coma → punto, booleanos Si/No → true/
false, etc.). Por cada SKU genera:

- 1 `productInput` (title ES, body_html ES, vendor=LedsC4, tags…).
- N `metafieldsInput` (uno por columna con `destination=metafield`).
- M `imageInput` (Imagen web + ambientes 1-3 + detail 1-2, descartando
  URLs vacías).
- 5 `translationsInput` (EN, IT, DE, FR, PT) — uno por idioma, con
  todos los campos traducibles.

Reglas especiales del mapper:

- `Familia` → genera **también** un tag `Familia:<valor>` para que
  Shopify pueda crear smart collections automáticas por modelo si
  alguien lo pide en el futuro.
- `Incluye bombilla` → mapea texto "Si"/"No" a boolean.
- `Temperatura color` → conserva texto tal cual ("3000K", "TUNABLE
  WHITE") porque hay valores no numéricos.
- **Valores no numéricos en columnas declaradas como `number_decimal`
  o `number_integer`** (ej. "Min 30 - Max 415", "∅145") → `null` +
  warning. Decisión cerrada del cliente, ver §11.3.
- `Predeterminado` → metafield con `visible_in_storefront=false` hasta
  que el cliente confirme su semántica (ver [historia-decisiones.md
  D8](historia-decisiones.md#d8-mapping-csv-predeterminado-pendiente)).

### 3.4 writer

Aplica cambios contra Shopify Admin GraphQL en este orden:

1. **`productSet`** (mutation 2025-01) — upsert de producto + variants
   + metafields + media en una llamada. Idempotente por `handle` o
   por `sku` de la variante.
2. **`translationsRegister`** — registra traducciones EN/IT/DE/FR/PT
   para `product.title`, `product.body_html`, y los metafields
   marcados `translatable=true`.
3. **`publishablePublish`** / **`publishableUnpublish`** sobre el
   publication del catalog "Outlet general", según las reglas de §1.

Modo `--dry-run`: simula todas las llamadas, escribe el reporte, no
ejecuta mutaciones.

### 3.5 reporter

Genera 3 outputs en cada ejecución, archivados en `reports/`:

- **`import-YYYY-MM-DD-summary.txt`** — totales: nuevos, modificados,
  ocultados, errores.
- **`import-YYYY-MM-DD-changes.csv`** — detalle por SKU: estado
  anterior, estado nuevo, motivo.
- **`import-YYYY-MM-DD-hidden.csv`** — SKUs ocultos en esta ejecución
  con la causa (sin stock / sin precio / no en surtido). Este es el
  fichero que el cliente revisa.

Si hay errores duros, exit code != 0 — el cron dispara alerta a
backoffice.

---

## 4. Multi-idioma con Translate & Adapt

### 4.1 Modelo

Shopify maneja traducciones como recursos separados del producto. El
`product.title` y `product.body_html` viven en el idioma "fuente" del
shop (ES en nuestro caso). Las versiones EN/IT/DE/FR/PT se almacenan
como `Translation` registradas vía API.

### 4.2 Qué se traduce

Sólo los campos marcados `translatable=true` en `mapping.json`. En
total:

- `product.title` (cuando aplique — los CSVs no traen título de
  producto explícito; lo construimos a partir de Familia + Tipo, ver
  §5).
- `product.body_html` (← Descripción).
- 9 metafields traducibles: Tipo, Familia, Catálogo, Garantía, Etiqueta
  V/f, masterfile.tender_text, Material, Acabado, Fuente de luz, Tipo
  regulación, Accesorio.

### 4.3 Activación en storefront

La carga de traducciones es invisible al cliente final hasta que se
publica el idioma en `Settings → Store details → Languages`. Es un
toggle, no un deploy. La recomendación a documentar para el cliente
es:

- **Publicar de entrada**: ES (default), EN.
- **Cargados pero no publicados**: IT, DE, FR, PT.
- **Activación posterior** (1 toggle): cuando haya cliente B2B real en
  ese idioma.

### 4.4 SKU presente en ES pero ausente en otro idioma

El parser registra el caso. El mapper omite la traducción del campo
faltante para ese SKU/idioma — la app Translate & Adapt mostrará el
fallback al idioma fuente automáticamente. No es bloqueante.

---

## 5. Construcción del título del producto

Los CSVs **no traen un campo `title` explícito**. El nombre comercial
hay que componerlo. Propuesta de regla:

```
title = "{Familia} {Tipo} {Acabado_corto}"
```

donde `Acabado_corto` es la primera palabra de la columna Acabado (para
no inflar el título). Ejemplo:

```
Familia=Easy Square 120mm  Tipo=Empotrable de techo  Acabado=Blanco, Opal
                                  ↓
title = "Easy Square 120mm Empotrable de techo Blanco"
```

Esta regla es **tentativa** y se valida con el cliente al hacer el
primer dry-run sobre datos reales. Es trivial cambiarla — vive en el
mapper, no afecta al resto.

---

## 6. Hosting y scheduling

Decisión heredada del §9 de arquitectura.md: **Supabase edge function +
pg_cron**, mismo runtime que `promote-whitelist-matches`,
`submit-order-request`, `list-order-requests`,
`create-company-for-customer`.

Justificación: el procesamiento de 734 productos (ES) + 5 traducciones
+ stock/precios cabe en los timeouts y memoria de Deno Edge. Si en
producción aparece un cuello (probable: las imágenes), partimos en
chunks de 50 SKUs por invocación.

Cron previsto:

- `import-surtido-semanal` → domingos 03:00 UTC.
- `import-stock-precios` → cada 6h en :15 (03:15, 09:15, 15:15, 21:15
  UTC) — desfase de 15 min respecto al horario "redondo" para no
  competir con otros jobs de Shopify.

---

## 7. Pendientes antes de implementar

Bloqueantes:

- [ ] Acceso SFTP del cliente (host, user, key, paths confirmados).
- [ ] Fichero de surtido **definitivo** (el de muestra tiene 1 SKU
      duplicado que el cliente ha confirmado como bug de su export).

No bloqueantes (se pueden cerrar en paralelo):

- [ ] Cliente confirma idiomas a **publicar** en storefront.
- [ ] Cliente valida la regla de construcción del title (§5) tras
      primer dry-run.
- [ ] Cliente confirma la semántica de la columna `Predeterminado`.

---

## 8. Plan de implementación

Cuatro fases, cada una se manda a Claude Code como prompt
auto-contenido con `--dry-run` obligatorio y validación previa:

| Fase | Entregable | Bloqueante | Estado |
|---|---|---|---|
| **I1** | Ampliar `metafield-definitions.json` con los 30+ metafields nuevos del mapping. Aplicar con `apply-metafield-definitions.mjs`. | Ninguno — se puede ejecutar ya | ✓ aplicado 2026-05-08 (32 definitions namespace `product` en el shop, 1 BLOCKED por dependencia smart-collection — `product.catalogo`). |
| **I2** | Implementar parser + mapper contra ficheros locales `samples/`. Sin escribir en Shopify. Genera reporter completo. | I1 | ✓ implementado y probado contra `samples/`. |
| **I3** | Conectar writer (productSet + translationsRegister + publication). Probar con subset de 10 SKUs. | I2 + datos reales del SFTP | ✓ I3 (PR #17) + I3.5 metafield translations (PR #18) + I3.6 unpublish orphans (PR #36). Run productivo end-to-end 2026-05-08. |
| **I4** | Sustituir source local por adaptador SFTP. Configurar pg_cron Supabase. Smoke test extremo a extremo. | I3 + credenciales SFTP | ✓ I4.1 sftp-sync deployado (PR original) + I4.2 GHA writer deployado (PR-A1/A2) + I4.3 cron schedule (PR #37, mergeado y aplicado 2026-05-09). |

I1 e I2 se pueden empezar **ya** sin esperar al SFTP. I3 e I4 esperan
al cliente.

<!-- Numeración histórica: §9 vacío. La sección sobre Conector ERP que
     antes ocupaba §9 vive ahora en este propio documento (§10 en
     adelante); ver también la nota de superseded en
     docs/arquitectura.md §9. La numeración se mantiene para no
     invalidar referencias externas existentes. -->

---

## 10. Cómo correr I2 localmente

I2 es el dry-pipeline: parser + mapper + reporter. Lee los CSVs de
muestra, cruza surtido + stock + precios, y produce un report
detallado de qué pasaría si ejecutáramos el writer (I3). **No
escribe nada en Shopify.**

### Comando

```bash
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs --samples-dir=samples
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs --verbose
```

(El `--env-file` no es necesario en I2 — cero llamadas a Shopify —
pero se mantiene por homogeneidad con I3/I4.)

### Output

Carpeta nueva por ejecución: `reports/import-<ISO timestamp>/` con:

- **`summary.txt`** — totales legibles (input, cross-check, errors,
  warnings, paths).
- **`changes.csv`** — 1 fila por SKU del surtido con
  `would_publish, publish_reason, title, n_metafields,
  n_translations, n_images, has_warnings`.
- **`hidden.csv`** — subset de `changes.csv` donde
  `would_publish=false`, con `publish_reason, in_surtido,
  in_stock, stock_qty, in_precios, price`. Es el fichero clave a
  revisar con el cliente para validar la regla "se ocultan y se
  informa".
- **`warnings.csv`** — 1 fila por warning emitido por parser o
  mapper. Columnas `source, severity, sku_or_row, locale, kind,
  message`.

Exit code 0 si solo hay warnings. ≠0 si hay errores duros.

### Estructura de `samples/`

```
samples/
├─ productos/listado_productos_{ES,EN,IT,DE,FR,PT}.csv
├─ stock/stock.csv
└─ precios/precios_productos.csv
```

Estos ficheros son los que entregó el cliente el 2026-05-04 (ver
[`samples/README.md`](../samples/README.md)). En I4 se reemplazan
por adaptador SFTP que escribe en la misma estructura local antes
de ejecutar el script.

### Arquitectura de los 3 scripts

- [`scripts/import-parse.mjs`](../scripts/import-parse.mjs) — parser
  CSV puramente sintáctico, devuelve strings normalizados (vacíos→
  null). Sin coerción de tipos. Sin conocimiento del mapping ni de
  Shopify. Reusable para validación SFTP en I4.
- [`scripts/import-map.mjs`](../scripts/import-map.mjs) — mapper.
  Aplica coerción por tipo (decimales con coma ES, booleanos
  Si/No, etc.) según `mapping.json`. Construye el modelo Shopify
  por SKU: producto + variants + metafields + 5 traducciones.
  Iterates solo sobre SKUs del surtido ES (single source of truth)
  y consulta stock/precios vía `Map<sku, value>` para O(1).
- [`scripts/import-report.mjs`](../scripts/import-report.mjs) —
  orquestador. Carga mapping, llama parsers en paralelo, llama
  mapper, escribe los 4 reports.

### Política de publicación (recordatorio)

Un producto sale como `would_publish=true` ⇔ está en surtido ES
**AND** stock>0 **AND** precio>0. Si falla alguna condición:

- `missing_stock` — SKU del surtido ausente del fichero de stock.
- `stock_zero` — SKU en stock con `INVENTARIO=0`.
- `missing_price` — SKU del surtido + stock>0 ausente de precios.
- `price_zero` — SKU en precios con `TARIFA=0`.

Prioridad en caso de fallar varias: missing_stock > stock_zero >
missing_price > price_zero (presencia antes que valor). La primera
no satisfecha gana.

---

## 10b. Cómo correr I3 localmente

I3 es el writer real: parser + mapper + writer. Lee los CSVs de
muestra, construye el modelo Shopify, y por cada SKU `would_publish=true`
ejecuta 3 mutaciones contra Shopify Admin GraphQL en orden:
`productSet` → `translationsRegister` → `publishablePublish`.

### Comando

```bash
# Dry-run (no llama a Shopify; reporte de lo que haría)
node scripts/import-write.mjs

# Apply real (requiere SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN)
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply

# Subset (--limit=N o --sku=<sku>) para iteración rápida
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply --limit=5
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply --sku=05-6398-21-M1
```

### Idempotencia

El writer es idempotente. Re-ejecutar con los mismos inputs:

- **`productSet`** identifica por `handle = sku.toLowerCase()`. Crea el
  producto si no existe; lo actualiza in-place si existe. No duplica.
- **Imágenes** se suben con `duplicateResolutionMode=REPLACE` y
  filename estable `{sku}-{position}` (sin extensión, alineado con que
  los URLs de `files.ledsc4.com` no la traen). Re-runs reemplazan las
  mismas filas; no acumulan duplicados.
- **`translationsRegister`** es upsert por `(resourceId, locale, key)`.
  El digest se refresca contra `translatableResource` antes de cada
  registración, así que cambios en el contenido fuente se propagan.
- **`publishablePublish`** sobre un producto ya publicado es no-op.

### Output

Carpeta nueva por ejecución: `reports/import-write-<ISO timestamp>/`:

- **`summary.txt`** — totales por mutation (ok/failed/skipped) +
  conteo de SKUs procesados + 5 sample product IDs para spot-check.
- **`changes.csv`** — 1 fila por SKU del mapper (publishables +
  hidden), con columnas `sku, handle, product_id, product_set_status,
  product_set_errors, product_translations_registered,
  metafield_translations_registered, translation_errors,
  publish_status, publish_errors, overall`.

### Alcance de las traducciones (post-I3.5)

El writer registra dos clases de traducciones por SKU publishable:

1. **Producto** — `title` y `body_html` en EN/FR/DE/IT/pt-PT
   (5 locales × 2 fields = hasta 10 entries por SKU). El `resourceId`
   es el GID del producto; el digest se obtiene de
   `translatableResource(resourceId: <productGid>).translatableContent`.
2. **Metafields traducibles** — los marcados `translatable: true` en
   `mapping.json`. **Cada metafield es un recurso traducible
   independiente con su propio GID y digest** (la API no usa una
   capability "translatable" en la definition; esa capability no
   existe en `MetafieldCapabilities` del schema 2025-10). El flujo
   por SKU es:
   - `productSet` retorna `product.metafields { id namespace key }`.
   - **Bulk fetch de digests** vía `translatableResourcesByIds` con
     todos los GIDs de metafields traducibles en una sola llamada.
   - Una llamada `translationsRegister` por metafield con `key:"value"`
     y todos los locales en un solo batch.

   Optimización: si el valor del locale es **igual al valor ES** o
   **vacío**, se omite (Shopify hace fallback al primario, así que el
   resultado UX es idéntico y ahorramos llamadas).

   Los 8 metafields actualmente traducibles son: `tipo`, `familia`,
   `catalogo`, `material`, `acabado`, `tipo_regulacion`, `fuente_luz`,
   `tender_text`. Para añadir o quitar, basta con flipar `translatable`
   en `mapping.json` — no requiere ningún cambio en Shopify.

### Performance

En la tienda de pruebas (Development plan, ~450 publishables):

- **I3 inicial** (sin metafield translations): ~688s primera apply,
  ~460s re-apply.
- **I3.5** (con metafield translations): añade ~5-8 llamadas extra por
  SKU (1 bulk digest fetch + ~5-7 registros por metafield). Tiempo
  total escalado proporcionalmente.

Sequencial, sin paralelismo. Suficiente para el cron diario de I4
(precios y surtido).

### Fase I3.6 — Despublicar SKUs que salen del surtido

Tras el bucle de publishables, el writer ejecuta una fase de
**unpublish orphans**: SKUs que en runs previos quedaron publicados
(`private.sku_state.last_published = true`) pero que en el run actual
no aparecen entre los publishables (porque salieron del surtido,
perdieron stock, o perdieron precio).

**Decisión**: despublicar = `productUpdate(input: { id, status: DRAFT })`.

- **No se archiva** ni se borra. El producto queda en DRAFT, oculto
  de la storefront pero recuperable; si vuelve al surtido en runs
  futuros, el flujo regular `productSet` lo pasa a `ACTIVE`
  automáticamente (la mutation siempre envía `status: 'ACTIVE'` para
  los publishables, así que reabilita el producto sin código extra).
- **Source of truth**: `private.sku_state.last_published`. La fase
  **NO itera** sobre el shop entero — los productos que el writer
  no ha creado quedan ignorados por diseño. Ediciones manuales del
  catálogo en el admin de Shopify no se ven afectadas.

**Persistencia**: tras despublicar con éxito (o tras detectar que el
producto ya no existe en el shop, p. ej. borrado manual por el
operador), `sku_state.last_published` pasa a `false`. En caso de
fallo (userError o error inesperado), `last_published` se mantiene
en `true` para que el siguiente run reintente.

**Reuso de infraestructura**: la fase usa el mismo `ctx`,
rate-limiter (`capacity=50, refill=10/s`) y `concurrency=4` que el
bucle principal. La query de resolución `sku → productId` es la
misma que el path stock-only (`productVariants(query: "sku:X")`),
con verificación exacta de SKU para evitar matches fuzzy.

**Output**: `<reportDir>/orphans.csv` con columnas
`sku,product_id,status,errors`. `summary.txt` añade la línea
`Unpublished orphans: ok=N failed=M not_found=K`. La row de
`private.import_runs.counts` añade el bucket
`unpublished_orphans: { ok, failed, not_found }`.

**Cuándo NO se ejecuta**: si `dbConnection` no se ha pasado al
writer (CLI sin `--with-db`, o llamada library sin `dbConnection`),
la fase entera se salta silenciosamente — sin sku_state como
source of truth no hay forma de saber qué SKUs hemos publicado en
el pasado.

---

## 11. Tratamiento de anomalías en datos del cliente

Decisiones acordadas con el cliente sobre cómo tratar los datos
"sucios" detectados durante el diseño del pipeline (I2). Cada caso
documenta la regla aplicada hoy, su justificación, y la respuesta
literal del cliente cuando existe.

### 11.1 Duplicados en `stock.csv` — **suma de unidades**

Cuando un SKU aparece múltiples veces en el fichero de stock, las
unidades de las distintas filas se **suman** y el resultado es el
INVENTARIO efectivo del SKU.

> "En el caso que en stock_productos.csv aparezca duplicado, sumemos
> las unidades de stock que indique (en este caso de ejemplo seria
> 53+1)."
> — Cliente, 2026-05-05.

Implementación en `parseStock` ([scripts/import-parse.mjs](../scripts/import-parse.mjs)).
Cada agregación genera un warning con la fórmula explícita
(`53+1=54`, `10+5+2=17`, etc.) para que el operador vea en cada
report si la frecuencia de duplicados es estable o crece — útil
como canario de calidad del export del cliente.

Caso real en muestras (2026-05-04): `AH12-12V8W1OUWT` aparece 2
veces (rows 1823, 1824) con valores `53` y `1`. Resultado en el
modelo: `inventario = 54`. (Es además un SKU orphan respecto al
surtido, así que no entra al modelo Shopify; el ejemplo sirve solo
de ilustración del comportamiento del parser.)

**Edge case defensivo** — si alguna de las filas duplicadas trae un
valor no numérico, decimal, o negativo, la suma se cancela: se
aplica first-wins para ese SKU y se emite un warning de severidad
alta listando todos los valores vistos. No esperado en datos reales
del ERP, pero el comportamiento existe para que cualquier desviación
sea visible y no silenciosamente corrompa el inventario.

### 11.2 Duplicados en `listado_productos_*.csv` (surtido) — **first-wins**

Cuando un SKU aparece múltiples veces en el fichero de surtido, se
mantiene la **primera ocurrencia** y se descarta el resto, emitiendo
un warning. Razón conceptual: agregar productos no tiene sentido
semántico (no es un campo numérico aditivo como stock; son atributos
descriptivos que entrarían en conflicto entre filas).

**Confirmado por el cliente el 2026-05-06.** Cita literal: *"Coge la
primera aparición"*. Sin cambios de código respecto al
comportamiento que ya implementaba el parser desde I2.

Caso real en muestras: `05-6424-81-81` aparece 2 veces en los 6
ficheros de idioma (mismo bug en cada locale, indicando que el
duplicado nace en el export y no en la traducción). El cliente
confirmó previamente que es bug de su export.

### 11.3 Valores no numéricos en columnas dimensionales — **`null` + warning**

Las columnas declaradas como `number_decimal` o `number_integer` en
[`scripts/mapping.json`](../scripts/mapping.json) (`dim_largo_mm`,
`dim_ancho_mm`, `dim_alto_mm`, `proyeccion_mm`, `peso_neto_kg`,
`vatios`, `lumenes`, `lumenes_reales`, `cri`) ocasionalmente
contienen valores no numéricos en los datos del cliente. Tres
patrones conocidos:

- **Rangos textuales** ("Min 24 Max 425", "Max 1930", "min 30 - max 415") —
  productos con dimensión ajustable (alargadores, cuelgues
  regulables).
- **Rangos puramente numéricos** ("36-61", "600-1980", "800-2500") —
  misma semántica de dimensión ajustable, pero sin prefijo textual.
  Tras el fix de 2026-05-07 (`Number()` en vez de `parseFloat`/`parseInt`
  en `coerce`) ambos formatos caen en el mismo path
  `null + warning numeric_unparsable`. Antes del fix los rangos
  numéricos eran truncados silenciosamente al primer número (`"36-61"`
  → `36`).
- **Diámetros con símbolo** ("∅78", "Ø1.010", "ø145") — notación
  técnica habitual de luminarias circulares.

En las muestras del 2026-05-04 hay **57 valores afectados en 55 SKUs**
(~7.5% del surtido) — los 54 originales + 3 SKUs adicionales descubiertos
por el fix de rangos numéricos: 05-4787-BW-BW (Largo "36-61"),
00-5694-05-05 (Alto "600-1980"), 00-7382-05-05 (Alto "800-2500").

> **Nota sobre los símbolos ∅/Ø/ø.** Estos caracteres aparecen
> también en el campo `familia` como parte del nombre comercial del
> modelo (`Umbrella Ø1000`, `Phuket ø1320mm`, `Korg Ø500mm`,
> `Gea Power LED Round ø180mm` — 112 SKUs en las muestras). En
> `familia` son **intencionales** y no requieren tratamiento
> especial: viajan tal cual al `title` compuesto y al metafield
> `product.familia`. La regla de §11.3 sólo aplica a las columnas
> declaradas como `number_decimal` / `number_integer` del mapping.

Decisión: **el mapper escribe `null` en el metafield correspondiente
y emite un warning**. El producto se carga normalmente con el resto
de sus campos; solo esa dimensión concreta queda vacía.

> "Hagamos que los 52 productos no carguen esa dimensión concreta.
> Si necesitan esa información, ya tienen nuestra página web
> (ledsc4.com) y la ficha técnica."
> — Cliente, 2026-05-05.

No se intenta heurística de extracción ("tomar el max del rango",
"strip ∅") — el cliente prefiere preservar la integridad del tipo
numérico de Shopify (filtros por rango, comparaciones) a expensas
de perder el dato literal en estos casos. La descripción del
producto y la ficha técnica enlazada (`ficha_url`) cubren la
información para el cliente final.

### 11.4 Normalización de whitespace en `title` compuesto

Tras componer `{Familia} {Tipo} {Acabado_corto}`, el mapper colapsa
cualquier secuencia de whitespace (espacios, tabs, newlines) a un
único espacio y trimea bordes (`.replace(/\s+/g, ' ').trim()`).
**Sólo se aplica al `title` final** — los metafields `familia`,
`tipo`, `acabado` se guardan literales del export del cliente, sin
normalizar. Si el cliente arregla el dato en origen, los metafields
reflejarán la mejora sin que el código bloquee el cambio.

**Caso que motivó la regla** (validación post-I2): la serie de 6
SKUs `Gea Power LED Round  ø180mm` / `ø130mm` (familias 55-9663,
55-9665, 55-9667 con sus variantes CA-CL/CA-CM/CA-37) tiene **doble
espacio interno** en el campo `familia` por bug del export del
cliente (`"Gea Power LED Round  ø180mm"`, dos espacios entre `Round`
y `ø180mm`). Sin la normalización, el `title` resultante
arrastraba ese doble espacio y Shopify lo mostraba como product
title visualmente sucio. Con la regla, el `title` queda como
`"Gea Power LED Round ø180mm Empotrable de suelo Acero"`. El
metafield `product.familia` para esos 6 SKUs sigue almacenado tal
cual viene del export, con el doble espacio.

---

## 12. Cadencia de actualización de los ficheros del SFTP

Confirmado por el cliente 2026-05-06. El SFTP es **transporte**:
el ERP genera los ficheros en su propia cadencia y los publica al
bucket. El conector (Fase I4) lee de allí.

| Fichero(s) | Frecuencia | Notas |
|---|---|---|
| `productos/listado_productos_*.csv` (6 locales) | **Diaria, nocturna** | Surtido completo + descripciones + atributos + URLs de imágenes y PDFs. El conector debe procesarlo una vez al día. |
| `precios/precios_productos.csv` | **Diaria, nocturna** | Junto con el surtido. Cambios de tarifa se propagan al día siguiente. |
| `stock/stock.csv` | **Cada 6 horas, configurable** | Por defecto cada 6h, ajustable según volumen real. Es el cron "ligero" del pipeline. |

**Implicaciones para I4**:

- Los crons del importador deben alinearse con la cadencia del
  cliente. No tiene sentido leer surtido cada 6h si solo se
  actualiza nocturnamente. Programación propuesta:
  - `import-surtido-precios` → 1×/día, ~04:00 UTC (después de la
    ventana nocturna del cliente, que típicamente termina entre
    01:00 y 03:00 hora local).
  - `import-stock` → cada 6h en :15 (`03:15, 09:15, 15:15, 21:15`
    UTC), parametrizable vía env si el cliente cambia su
    cadencia interna.
- El surtido y los precios pueden combinarse en una misma
  ejecución de cron (mismo trigger horario). Stock va en su
  propio cron por su cadencia distinta.
- Si la nocturna del cliente se retrasa o se cae un día,
  detectaremos ficheros con el mismo timestamp del día anterior.
  El conector debe ser tolerante a esto — re-ejecutar sobre
  datos sin cambios es no-op (idempotente).

---

## 13. I4.3 — pg_cron schedule de sftp-sync

Tres migraciones en orden alfabético (timestamps ascendentes):

| Migración | Path | Qué hace |
|---|---|---|
| A | [`supabase/migrations/20260509120000_seed_anon_key.sql`](../supabase/migrations/20260509120000_seed_anon_key.sql) | INSERT placeholder `supabase_anon_key='REPLACE_ME_AFTER_MERGE'` en `private.config`. **Tras aplicar la migración, hacer UPDATE manual con la anon key real**. |
| B | [`supabase/migrations/20260509120100_invoke_edge_function_auth.sql`](../supabase/migrations/20260509120100_invoke_edge_function_auth.sql) | Extiende `private.invoke_edge_function` con `with_auth boolean default false`. Si `with_auth=true`, lee `supabase_anon_key` de `private.config` y lo inyecta como `Authorization: Bearer <key>`. Hard-fail si la key falta o es el placeholder. Hacia atrás compatible: el cron `promote-whitelist-matches` no pasa el flag → comportamiento idéntico a hoy. |
| C | [`supabase/migrations/20260509120200_setup_cron_sftp_sync.sql`](../supabase/migrations/20260509120200_setup_cron_sftp_sync.sql) | 5 jobs `cron.schedule` con `with_auth=true`, idempotentes (`cron.unschedule` previo en bloque DO/EXCEPTION). |

### Schedule

| jobname | Schedule (UTC) | UTC | Madrid CET (invierno) | Madrid CEST (verano) |
|---|---|---|---|---|
| `sftp-sync-stock-01h` | `0 1 * * *` | 01:00 | 02:00 | 03:00 |
| `sftp-sync-full-02h` | `0 2 * * *` | 02:00 | 03:00 | 04:00 |
| `sftp-sync-stock-07h` | `0 7 * * *` | 07:00 | 08:00 | 09:00 |
| `sftp-sync-stock-13h` | `0 13 * * *` | 13:00 | 14:00 | 15:00 |
| `sftp-sync-stock-19h` | `0 19 * * *` | 19:00 | 20:00 | 21:00 |

Todos los días de la semana. La hora local se desplaza ±1h con DST sin
afectar el orden de operaciones (full siempre justo después del primer
stock del día).

### Pasos manuales tras aplicar las migraciones

```sql
-- 1. Update la anon key real en private.config (la del proyecto Supabase
--    actual, sección Project Settings → API → anon public).
UPDATE private.config
SET value = '<paste anon key here>'
WHERE key = 'supabase_anon_key';

-- 2. Verificar que el cron está activo y correctamente quoteado.
SELECT jobname, schedule, command, active
FROM cron.job
WHERE jobname LIKE 'sftp-sync-%'
ORDER BY jobname;

-- 3. (Opcional) Disparar uno a mano para validar que la auth funciona.
SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true);
-- Debería devolver un bigint (request_id de pg_net) sin RAISE.
```

### Cómo pausar / desactivar un cron

```sql
-- Pausar todos los crons de sftp-sync (sin borrarlos):
UPDATE cron.job SET active = false WHERE jobname LIKE 'sftp-sync-%';

-- Reactivar:
UPDATE cron.job SET active = true WHERE jobname LIKE 'sftp-sync-%';

-- Borrar uno concreto (irreversible — requiere re-aplicar la migración):
SELECT cron.unschedule('sftp-sync-stock-13h');
```

### Cómo monitorizar runs

```sql
-- Últimos 20 disparos de cualquier cron sftp-sync, con outcome:
SELECT j.jobname, r.start_time, r.end_time, r.status, r.return_message
FROM cron.job_run_details r
JOIN cron.job j ON j.jobid = r.jobid
WHERE j.jobname LIKE 'sftp-sync-%'
ORDER BY r.start_time DESC
LIMIT 20;

-- Cruzar con los rows de import_runs creados (uno por disparo exitoso):
SELECT id, kind, status, started_at, completed_at, error_stage
FROM private.import_runs
WHERE started_at >= now() - interval '24 hours'
ORDER BY started_at DESC;
```

`cron.job_run_details.status = 'succeeded'` significa que la query que
invoca a `pg_net` devolvió OK; **no garantiza** que la edge function haya
terminado bien (es asíncrona). El estado real está en
`private.import_runs.status` (debe llegar a `completed`) y en la columna
`error_stage` si falló. La `return_message` del cron solo refleja errores
SQL del propio invoke (p. ej. `supabase_anon_key no configurado`).

### Por qué la anon key vive en `private.config` plain text

La anon key de Supabase es **publicable por diseño**: viene incrustada
en cualquier bundle de frontend que use el cliente Supabase. No es un
secreto. Pasa el gate `verify_jwt` del Edge Runtime pero por sí sola no
puede leer datos protegidos por RLS. Guardarla en `private.config` (la
misma tabla que `supabase_url`) mantiene la coherencia con el patrón
existente y evita el overhead de Vault para una key no-secreta.

`sftp-sync` mantiene `verify_jwt = true` para que la URL pública del
edge function siga rechazando requests sin JWT alguno.
