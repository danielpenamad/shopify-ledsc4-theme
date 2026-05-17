# 02 · Importer

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Describe el pipeline que sincroniza el catálogo LedsC4 desde el ERP del cliente (Microsoft Dynamics AX, publicado vía SFTP en 3 CSVs) hacia el shop Shopify. Cubre:

- Los 3 ficheros que publica el cliente y la regla de publicación cruzada (surtido AND stock>0 AND precio>0).
- La arquitectura por etapas: source → parse → map → write → report.
- Las 2 cadencias de ejecución (pesada nocturna + ligera cada 6h).
- Translate & Adapt como mecanismo multi-idioma.
- Pre-upload de imágenes con caché SHA-256.
- SKU state como source of truth para despublicar huérfanos.
- Tratamiento de anomalías acordado con el cliente (duplicados, valores no numéricos, normalización de whitespace).
- Overrides por SKU para tapar discrepancias entre el ERP y la decisión comercial del portal.

No cubre:

- Despliegue (GitHub Actions workflow, secrets, schedule de pg_cron) → [02b-importer-deploy](02b-importer-deploy.md).
- Configuración inicial de Shopify (catálogo, smart collections, colecciones cat-*) → [administracion/02-categorias-y-menu](../administracion/02-categorias-y-menu.md).
- Detalle exhaustivo del catálogo de metafields → [01-data-model](01-data-model.md).

Decisiones arquitectónicas relevantes: [D6](adrs/d06-catalogo-unico.md) (catalog único), [D9](adrs/d09-metafields-ampliados.md) (Fase I1), [D10](adrs/d10-3-csvs-sftp.md) (3 CSVs), [D11](adrs/d11-image-pre-upload.md) (pre-upload), [D12](adrs/d12-pipeline-split.md) (split sftp-sync ↔ GHA), [D14](adrs/d14-sku-state-fingerprint.md) (sku_state).

## 1. Resumen ejecutivo

El cliente publica desde su ERP **3 ficheros CSV en SFTP**, cada uno con su cadencia y responsabilidad:

```
SFTP del cliente
├─ /productos/listado_productos_ES.csv    (diario nocturno, 79 cols, idioma fuente)
├─ /productos/listado_productos_EN.csv    (diario nocturno, mismas filas, traducidas)
├─ /productos/listado_productos_IT.csv    (idem)
├─ /productos/listado_productos_DE.csv    (idem)
├─ /productos/listado_productos_FR.csv    (idem)
├─ /productos/listado_productos_PT.csv    (idem)
├─ /stock/stock.csv                       (cada 6h, 2 cols: SKU, INVENTARIO)
└─ /precios/precios_productos.csv         (diario nocturno, 2 cols: SKU, TARIFA)
```

### Regla de publicación

> Un producto se publica en el catálogo "Outlet general" **sí y sólo sí**:
> 1. Está en el fichero de surtido ES (lista de presencia).
> 2. Tiene stock > 0 en el fichero de stock.
> 3. Tiene precio > 0 en el fichero de precios.
>
> Si falla cualquiera, el producto se despublica (no se borra del shop) y aparece en el reporte.

Esta regla sustituye al criterio antiguo basado en el tag `Coleccion:2026`. El tag se conserva por compatibilidad pero deja de ser fuente de verdad. Detalle en [D10](adrs/d10-3-csvs-sftp.md).

## 2. Fuentes de verdad

### `scripts/mapping.json`

Contrato declarativo del importer. Cada columna del CSV de surtido (0-78) tiene una entrada con:

| Campo | Significado |
|---|---|
| `column_name_es` | Solo orientativo. El parser lee por **posición**, no por nombre (los nombres varían por locale y pueden cambiar con el tiempo). |
| `destination` | Dónde va el valor: `variant.sku`, `variant.barcode`, `product.body_html`, `product.images`, `metafield`, `ignore`. |
| `namespace` + `key` | Para `destination=metafield`. Determina el GID del metafield resultante. |
| `type` | Tipo Shopify del metafield (`single_line_text_field`, `number_decimal`, `number_integer`, `boolean`, `url`, `multi_line_text_field`). |
| `translatable` | Si el valor se envía a `translationsRegister` para los 5 locales no-fuente. |
| `filterable` | Si la columna alimenta los filtros del catálogo. |
| `pin_in_admin` | Si el metafield se fija en la cabecera de la ficha del producto en Admin. |
| `visible_in_storefront` | Si el metafield se expone al storefront (default `true`; `false` solo para `predeterminado`). |
| `image_position` | Para `destination=product.images`. Posición 0-5 (0 = imagen principal). |

Versión actual: `1.1.0` (10-may-2026). Cambios documentados en el bloque `_decisions_log` del propio JSON.

### `scripts/metafield-definitions.json`

47 metafield definitions a aplicar en el shop. Se gestiona con `scripts/apply-metafield-definitions.mjs` ([15-scripts](15-scripts.md)). Detalle exhaustivo del modelo en [01-data-model](01-data-model.md) §6.

### `scripts/sku-overrides.json` (añadido posterior)

Tabla de excepciones por SKU que pisa el valor del CSV post-coerce en el mapper. Detalle, justificación y deuda asociada en §6.4. Introducido en PR #85 (14-may-2026).

### `private.sku_state`

Tabla Postgres en Supabase con una fila por SKU procesado. Source of truth para idempotencia y para despublicar huérfanos. Detalle en §8 y [D14](adrs/d14-sku-state-fingerprint.md).

| Columna | Tipo | Para qué |
|---|---|---|
| `sku` | text PK | Referencia del producto en el ERP. |
| `product_id` | text | GID Shopify del producto, una vez creado. |
| `last_fingerprint` | text | Hash determinista del input del último run (skip cuando coincide; Fase B, pendiente de activar). |
| `last_published` | boolean | Si en el último run quedó publicado. Usado por la fase unpublish-orphans. |
| `last_run_at` | timestamptz | Cuándo. |

## 3. Arquitectura por etapas

```
┌─────────────────────────────────────────────────────────────────────┐
│                  PIPELINE PESADO — surtido + precios                │
│                  cadencia: 1 vez/día (nocturna del cliente + 1h)    │
└─────────────────────────────────────────────────────────────────────┘

  SFTP ──┐
         │
         ▼
    ┌────────┐   ┌────────┐   ┌────────┐   ┌────────┐
    │ source │──▶│  parse │──▶│   map  │──▶│  write │
    └────────┘   └────────┘   └────────┘   └────┬───┘
                                                │
                                                ▼
                                         ┌──────────┐
                                         │ unpublish│──▶  productUpdate
                                         │ orphans  │     status=DRAFT
                                         └────┬─────┘
                                              │
                                              ▼
                                         ┌──────────┐
                                         │  report  │──▶  reports/
                                         └──────────┘     import-write-…/
                                                          {summary, changes, orphans}.csv

┌─────────────────────────────────────────────────────────────────────┐
│                  PIPELINE LIGERO — solo stock                       │
│                  cadencia: cada 6h                                  │
└─────────────────────────────────────────────────────────────────────┘

  SFTP /stock/  ──▶  parse  ──▶  reconcile  ──▶  inventorySetQuantities
                                      │
                                      ▼
                                Solo cambia:
                                - inventory_levels (qty real)
                                - status del producto si cruza el umbral
                                  (>0 ↔ 0 → publish/unpublish)
```

## 4. source

Adaptador único responsable de obtener los 8 CSVs del SFTP. Interfaz mínima: `getFile(remotePath) → Buffer`.

Hoy hay 2 implementaciones:

| Implementación | Donde lee | Cuándo se usa |
|---|---|---|
| Filesystem local | `samples/` o ruta pasada por `--samples-dir` | Desarrollo local + tests + CI |
| SFTP | host/user/key vía env vars (`SFTP_HOST`, `SFTP_USER`, `SFTP_PRIVATE_KEY`) | Producción (edge function `sftp-sync` en Supabase) |

El swap entre una y otra **no toca el resto del pipeline** — el parser y todo lo posterior trabaja sobre buffers en memoria.

## 5. parse — `scripts/import-parse.mjs`

Parser CSV **puramente sintáctico**:

- Lee cada CSV por **posición de columna**, no por nombre (los nombres varían por locale).
- Respeta quoting CSV estándar (comillas, escapes, saltos de línea dentro de campo).
- Normaliza vacíos / `NULL` / `-` → `null`.
- **No hace coerción de tipos** — los decimales con coma, booleanos `Si/No`, etc. se procesan en el mapper.

### Errores que NO detienen la ejecución (warning + skip)

| Caso | Comportamiento |
|---|---|
| SKU duplicado en surtido | **First wins** + warning (§9.2). |
| SKU duplicado en stock | **Suma de unidades** + warning con fórmula explícita (§9.1). |
| Fila con menos columnas que la cabecera | Skip + warning. |

### Errores que SÍ detienen la ejecución (exit code ≠ 0)

| Caso | Por qué |
|---|---|
| Cabecera con número de columnas distinto al esperado (79 surtido, 2 stock, 2 precios) | El layout del CSV cambió y la lectura por posición ya no es correcta. |
| Fichero ES ausente o vacío | Es el idioma fuente — sin él no hay producto. |
| SKU faltante en una fila (col 0 vacía) | El SKU es la PK del modelo. |

### Output del parser

`{ records: [{ col_0: "...", col_1: "...", ...col_78: "..." }], warnings: [...] }`.

Cada `record` tiene las 79 columnas como strings (o `null`). El mapper se encarga de interpretarlas.

## 6. map — `scripts/import-map.mjs`

Convierte los registros del parser al modelo Shopify aplicando coerción según el contrato de `mapping.json`. Por cada SKU del surtido ES genera:

| Salida | Contenido |
|---|---|
| `productInput` | title compuesto, body_html (ES), vendor=`LedsC4`, tags (incluyen `Familia:<valor>`), handle (= SKU en minúsculas). |
| `metafieldsInput` | N entradas, una por columna con `destination=metafield`. Coerción de tipos según `type`. |
| `imageInput` | M entradas (0-6), una por columna `Imagen web` / `Imagen ambiente 1-3` / `Detail Image 1-2` no vacía. |
| `translationsInput` | 5 (EN, IT, DE, FR, PT). Cada uno con todos los campos `translatable=true` del SKU. |

### 6.1 Construcción del title

Los CSVs no traen un campo `title` explícito. Composición:

```
title = "{familia} {tipo} {primera palabra de acabado}"
```

Ejemplo:

```
familia="Easy Square 120mm"  tipo="Empotrable de techo"  acabado="Blanco, Opal"
                                 ↓
title = "Easy Square 120mm Empotrable de techo Blanco"
```

Tras componer, el mapper colapsa secuencias de whitespace a un único espacio (`.replace(/\s+/g, ' ').trim()`). Aplica solo al title final — los metafields `familia`, `tipo`, `acabado` se guardan literales del export del cliente. Caso real que motivó la regla en §9.4.

### 6.2 Coerción de tipos

| Tipo del mapping | Conversión |
|---|---|
| `single_line_text_field` | String tal cual, trim. |
| `multi_line_text_field` | String tal cual, trim. |
| `url` | String tal cual, validación pragmática `^https?://`. |
| `number_decimal` | `Number(value)`. Coma decimal española normalizada a punto. NaN → `null` + warning. |
| `number_integer` | `Number(value)`. NaN → `null` + warning. |
| `boolean` | `"Si" → true`, `"No" → false`. Otros valores → `null` + warning. |

### 6.3 Reglas especiales

- **`familia`** → además del metafield, genera un tag `Familia:<valor>` en el productInput. Permite smart collections automáticas por modelo si el cliente lo pide.
- **`temperatura_color`** → conserva el texto tal cual (admite valores no numéricos como `TUNABLE WHITE`, `SW 3000-4000-6500K`).
- **`predeterminado`** → metafield con `visibleToStorefrontApi=false` hasta confirmación del cliente. Ver [D8](adrs/d08-predeterminado.md).
- **Acabado, Material, Familia, Tipo, Catálogo, Fuente de luz, Tipo regulación, Tender text** → `translatable=true`. Se preparan en el modelo para que el writer dispare `translationsRegister`.

### 6.4 Overrides por SKU (parche post-hoc, deuda técnica)

> **Aviso al lector**: esta sección documenta un mecanismo **introducido tarde** (PR #85, 14-may-2026) que rompe el principio de fuente única de verdad en el que se basaba el resto del importer. Es una concesión a la realidad operativa, no un patrón a generalizar. Antes de añadir un override nuevo, leer §6.4.3.

#### 6.4.1 Qué hace

El cron nocturno reescribe `product.catalogo` y `product.tipo` desde el CSV del ERP en cada run. Cualquier corrección manual en Admin se pierde al siguiente cron — el ERP es la fuente de verdad por diseño.

Para los casos donde la unidad de negocio del cliente exige que el portal muestre una clasificación distinta a la que devuelve su propio ERP, el mapper aplica un override declarativo **post-coerce, pre-write** desde `scripts/sku-overrides.json`:

| Pieza | Path | Función |
|---|---|---|
| Tabla de excepciones | `scripts/sku-overrides.json` | Datos. Versionado en git — el PR review es la auditoría. |
| Loader | `scripts/lib/sku-overrides.mjs` | Lógica. Importado por el mapper. Resolve a `null` para SKUs no listados. |
| Punto de aplicación | `scripts/import-map.mjs` | Después de la coerción de tipos, antes de construir el `productInput`. |
| Tests | `scripts/sku-overrides.test.mjs` | 95 tests. |

Cuando un SKU listado en `sku-overrides.json` pasa por el mapper, el valor del CSV se sustituye por el del override. Se emite warning por cada pisado para que el operador lo vea en el reporte.

**Campos override soportados hoy**: `catalogo`, `tipo`. Ampliable a cualquier columna `destination=metafield` cambiando el loader.

#### 6.4.2 Dos shapes admitidos

```json
{
  "rules": [
    {
      "sku": "05-9876-12-12",
      "catalogo": "Forlight"
    },
    {
      "sku": "DE-0148-BLA",
      "catalogo": "Forlight",
      "tipo": {
        "es": "Sobremesa",
        "en": "Table lamp",
        "fr": "Lampe de table",
        "de": "Tischleuchten",
        "it": "Lampade da tavolo",
        "pt-PT": "Candeeiro de mesa"
      }
    }
  ]
}
```

| Shape | Comportamiento | Cuándo usarlo |
|---|---|---|
| String (flat) | El mismo valor se aplica a los 6 locales. | Cuando el cliente nunca traduce esa columna en su ERP (típico de `catalogo`). |
| Objeto `{es, en, fr, de, it, pt-PT}` (per-locale) | Cada locale recibe su valor. | Cuando hace falta preservar traducciones canónicas que el CSV no entrega coherentemente. |

#### 6.4.3 Por qué existe esto y por qué es deuda

El mecanismo se introdujo el 14-may-2026 (PR #85) para resolver una solicitud de la unidad de negocio del cliente: reorganizar el menú visible del portal de 6 a 5 categorías padre, **sin tocar el ERP**. Antes de este PR, el contrato del importer era simple y limpio:

```
ERP del cliente  =  fuente única de verdad  =  estado del portal
```

Tras este PR, el contrato se rompe para 55 SKUs:

```
ERP del cliente + scripts/sku-overrides.json (en este repo)  =  estado del portal
```

Implicaciones operativas:

- **Fuente de verdad dividida**: para saber qué categoría tiene un producto en el portal hay que consultar el ERP **y** el override. Si difieren, gana el override.
- **Inconsistencias visibles deliberadas**: productos con título "Flexo" aparecen en la subcategoría Sobremesa. Un producto Chillout aparece como huérfano en Forlight porque no existe subcategoría Chillout. Detalle en el doc de cierre del PR ([`docs/proyectos/cierre-pr-cat-restructure.md`](../proyectos/cierre-pr-cat-restructure.md) §5.2 — pendiente de mover al repo).
- **Coste operativo permanente**: cada producto nuevo del ERP con un patrón similar a los 55 reclasificados exige decisión manual sobre si añadirlo al override o no.

La forma correcta de resolver una reclasificación es **arreglar el ERP del cliente**. El override existe porque ese cambio en el ERP requería coordinación con un equipo externo y plazos no compatibles con la ventana solicitada. Es deuda asumida con los ojos abiertos, no una decisión arquitectónica.

#### 6.4.4 Política para nuevos overrides

Antes de añadir un SKU al fichero:

1. **¿Puede el cliente arreglarlo en su ERP?** Si sí — aunque sea lento — preferir esa vía y dejar el override solo como puente temporal con compromiso de revertirlo.
2. **¿Cuántos SKUs afecta?** Más de 10 → probable bug del mapping o del ERP, no caso para override.
3. **¿Es permanente o temporal?** Temporal (campaña, estacionalidad) → **no** debería entrar al override.
4. **¿Implica cambiar `tipo` además de `catalogo`?** Si sí, valorar inconsistencias visibles antes (cf. caso Flexo).

#### 6.4.5 Reversibilidad

Vaciar `sku-overrides.json` (dejar `{ "rules": [] }`) y esperar al siguiente cron de las 02:00 UTC devuelve el portal al estado dictado por el ERP. Es una salida limpia, sin pérdida de datos.

Procedimiento completo de reversión del PR #85 documentado en el doc de cierre del proyecto ([`docs/proyectos/cierre-pr-cat-restructure.md`](../proyectos/cierre-pr-cat-restructure.md) §6 — pendiente de migrar al repo desde el archivo local).

#### 6.4.6 SKU presente en ES pero ausente en otro idioma

El parser registra el caso por fichero. El mapper omite la traducción del campo faltante para ese SKU/idioma — Translate & Adapt mostrará el fallback al idioma fuente automáticamente. No bloquea.

## 7. write — `scripts/import-write.mjs`

El writer aplica cambios contra Shopify Admin GraphQL. Es el bloque más complejo (~80 KB de código). Por cada SKU `would_publish=true` ejecuta este pipeline:

### 7.0 Pre-upload de imágenes (Files API)

Antes de tocar el producto en sí, todas las imágenes referenciadas se aseguran de existir en Shopify Files. Detalle en §11.

Por cada URL de `files.ledsc4.com`:

1. **Rate limit CDN**: `cdnBucket.acquire(1)` — bucket compartido del run que serializa las descargas a **1 req cada 1.5 s** (SLA de cortesía probado en diagnóstico: 337 HEADs sin un solo 429).
2. **Fetch del binario** a memoria (timeout 15 s) + `sha256` + sniff MIME (header → fallback magic-byte).
3. **Cache lookup** en `private.image_cache(sha256 → shopify_file_id)`. Hit → reusar el File existente, salir.
4. **Miss** → `stagedUploadsCreate(resource:IMAGE)` → POST multipart al target → `fileCreate(originalSource: resourceUrl)` → polling de `MediaImage.status` hasta `READY` o `FAILED` (techo 15 s).
5. **Cache write**: `INSERT … ON CONFLICT (sha256) DO UPDATE last_used_at=now()`.

El helper vive en `scripts/lib/image-upload.mjs`. **Nunca lanza** — cada modo de fallo (`fetch_failed`, `fetch_timeout`, `unsupported_mime`, `staged_upload_failed`, `file_create_failed`, `file_status_failed`) devuelve `{ ok:false, kind, message }` y el slot pasa a `null` en `productSet.input.files[]` (no se borra la imagen existente del producto).

### 7.1 `productSet`

Mutation Shopify Admin API 2025-10. Upsert atómico de producto + variants + metafields + media en una sola llamada.

| Pieza | Identificador | Comportamiento |
|---|---|---|
| Product | `handle = sku.toLowerCase()` | Crea si no existe, actualiza in-place si existe. No duplica. |
| Variant | `sku` | Igual. Single-variant por producto (no hay variantes B2B en este negocio). |
| Imágenes | `FileSetInput.id` → File pre-subido en paso 0 | Slots cuyo resolve falló se omiten (no se borra la imagen existente del producto). |
| Metafields | `(namespace, key)` | Upsert. Si el valor cambia, se sobrescribe. |

### 7.2 `translationsRegister`

Por cada SKU publishable se registran dos clases de traducciones:

**1. Producto** (`title` y `body_html` en EN/IT/DE/FR/PT):

- `resourceId` = GID del producto.
- Digest obtenido de `translatableResource(resourceId: <productGid>).translatableContent`.
- Hasta 5 locales × 2 fields = **10 entries por SKU**.

**2. Metafields traducibles** (los marcados `translatable: true` en `mapping.json`):

- Cada metafield es un recurso traducible **independiente** con su propio GID y digest.
- Flujo por SKU:
  - `productSet` retorna `product.metafields { id namespace key }`.
  - Bulk fetch de digests vía `translatableResourcesByIds` con todos los GIDs en una llamada.
  - Una llamada `translationsRegister` por metafield con `key:"value"` y todos los locales en un solo batch.

**Optimización**: si el valor del locale es igual al valor ES o vacío, se omite (Shopify hace fallback al primary locale, así que el resultado UX es idéntico y ahorramos llamadas).

Los **8 metafields actualmente traducibles** son: `tipo`, `familia`, `catalogo`, `material`, `acabado`, `tipo_regulacion`, `fuente_luz`, `tender_text`. Para añadir o quitar uno basta con flipear `translatable` en `mapping.json` — no requiere ningún cambio en Shopify.

### 7.3 `publishablePublish` / `publishableUnpublish`

Sobre la publication del catalog "Outlet general", según las reglas de §1. Detalle del catalog en [01-data-model](01-data-model.md) §7.

`publishablePublish` sobre un producto ya publicado es no-op (idempotente).

### 7.4 Polling de `product.media[*].status`

Cada 500 ms hasta techo 15 s o salir de `PROCESSING` para todas las MediaImage del producto. **Defensa en profundidad** — con Files pre-subidos en `READY` la clonación al producto es casi instantánea, pero captura los fallos post-asociación de Shopify (p. ej. `pixel limit exceeded` sobre ciertas imágenes >20 MP).

Devuelve `{ready, failed, processing, firstError}` que se vuelcan al `changes.csv`. Tunable vía `options.mediaPollMs` y `options.mediaPollMaxMs`.

### 7.5 Estados por SKU

| Estado | Significado |
|---|---|
| `OK` | productSet + translations + publish OK **y** todas las imágenes terminaron `READY`. |
| `WARN` | productSet/translations/publish OK pero al menos una imagen falló (resolve previo o `MediaImage.status: FAILED/PROCESSING` al cierre del polling). El producto está en Shopify, solo le faltan imágenes — el siguiente cron las recupera (la caché evita re-bajar las que ya quedaron READY; solo se reintenta el slot fallido). |
| `FAILED` | userErrors síncronos en `productSet`, `translations` o `publish`. El producto puede no existir o estar incompleto a nivel estructural. |
| `HIDDEN` | No publishable (no cumple §1). |
| `DRY_RUN` | `--dry-run`, sin tocar Shopify. |

## 8. SKU state y unpublish de huérfanos

Tras el bucle de publishables, el writer ejecuta una fase de **unpublish-orphans**: SKUs que en runs previos quedaron publicados (`private.sku_state.last_published = true`) pero que en el run actual no aparecen entre los publishables (salieron del surtido, perdieron stock, o perdieron precio).

### Acción

`productUpdate(input: { id, status: DRAFT })`.

- **No se archiva** ni se borra. El producto queda en DRAFT, oculto del storefront pero recuperable.
- Si vuelve al surtido en runs futuros, el flujo regular `productSet` lo pasa a `ACTIVE` automáticamente (la mutation siempre envía `status: 'ACTIVE'` para los publishables).

### Source of truth

`private.sku_state.last_published`. La fase **NO itera** sobre el shop entero — los productos que el writer no ha creado quedan ignorados por diseño. Ediciones manuales del catálogo en Admin no se ven afectadas.

### Persistencia

Tras despublicar con éxito (o detectar que el producto ya no existe en el shop, p. ej. borrado manual por el operador), `sku_state.last_published` pasa a `false`. En caso de fallo (userError o error inesperado), `last_published` se mantiene en `true` para que el siguiente run reintente.

### Reuso de infraestructura

La fase usa el mismo `ctx`, rate-limiter (`capacity=50, refill=10/s`) y `concurrency=4` que el bucle principal. La query de resolución `sku → productId` es la misma que el path stock-only (`productVariants(query: "sku:X")`), con verificación exacta de SKU para evitar matches fuzzy.

### Cuándo NO se ejecuta

Si `dbConnection` no se ha pasado al writer (CLI sin `--with-db`, o llamada library sin `dbConnection`), la fase entera se salta silenciosamente — sin sku_state como source of truth no hay forma de saber qué SKUs hemos publicado en el pasado.

### Skip por fingerprint (Fase B, pendiente)

Tabla `sku_state` también tiene `last_fingerprint` (hash determinista del input del SKU). Cuando se active la Fase B, el writer comparará el fingerprint del run actual con el almacenado y saltará el SKU completo si coinciden — ahorrando ~95% de las mutations en runs sin cambios. Detalle en [D14](adrs/d14-sku-state-fingerprint.md).

## 9. Tratamiento de anomalías en datos del cliente

Decisiones acordadas con el cliente sobre cómo tratar datos "sucios" detectados durante el diseño del pipeline. Cada caso documenta la regla aplicada hoy, su justificación y la respuesta literal del cliente.

### 9.1 Duplicados en `stock.csv` — suma de unidades

Cuando un SKU aparece múltiples veces en `stock.csv`, las unidades se **suman** y el resultado es el INVENTARIO efectivo.

> "En el caso que en stock_productos.csv aparezca duplicado, sumemos las unidades de stock que indique (en este caso de ejemplo seria 53+1)."
> — Cliente, 2026-05-05.

Implementación en `parseStock`. Cada agregación emite un warning con la fórmula explícita (`53+1=54`, `10+5+2=17`, etc.) — útil como canario de calidad del export del cliente.

**Edge case defensivo**: si alguna fila duplicada trae valor no numérico, decimal, o negativo, la suma se cancela, se aplica first-wins para ese SKU y se emite warning de severidad alta.

### 9.2 Duplicados en `listado_productos_*.csv` (surtido) — first-wins

Cuando un SKU aparece múltiples veces en el fichero de surtido, se mantiene la **primera ocurrencia** y se descarta el resto, emitiendo warning.

> "Coge la primera aparición."
> — Cliente, 2026-05-06.

Razón conceptual: agregar productos no tiene sentido semántico (no es aditivo como stock; son atributos descriptivos que entrarían en conflicto).

### 9.3 Valores no numéricos en columnas dimensionales — `null` + warning

Las columnas declaradas como `number_decimal` o `number_integer` (`dim_largo_mm`, `dim_ancho_mm`, `dim_alto_mm`, `proyeccion_mm`, `peso_neto_kg`, `vatios`, `lumenes`, `lumenes_reales`, `cri`) ocasionalmente contienen valores no numéricos. Tres patrones conocidos:

| Patrón | Ejemplo | Causa |
|---|---|---|
| Rangos textuales | `"Min 24 Max 425"`, `"min 30 - max 415"` | Productos con dimensión ajustable (alargadores, cuelgues). |
| Rangos puramente numéricos | `"36-61"`, `"600-1980"`, `"800-2500"` | Misma semántica, sin prefijo textual. |
| Diámetros con símbolo | `"∅78"`, `"Ø1.010"`, `"ø145"` | Notación técnica de luminarias circulares. |

Decisión:

> "Hagamos que los 52 productos no carguen esa dimensión concreta. Si necesitan esa información, ya tienen nuestra página web (ledsc4.com) y la ficha técnica."
> — Cliente, 2026-05-05.

El mapper escribe `null` en el metafield correspondiente y emite un warning. El producto se carga normalmente con el resto de sus campos; solo esa dimensión concreta queda vacía. **No se intenta heurística** ("tomar el max del rango", "strip ∅") — preserva la integridad del tipo numérico de Shopify.

Nota sobre `∅/Ø/ø`: aparecen también en el campo `familia` como parte del nombre comercial (`Umbrella Ø1000`, `Phuket ø1320mm`). En `familia` son intencionales y viajan tal cual al `title` compuesto y al metafield `product.familia`. La regla solo aplica a columnas declaradas como número.

### 9.4 Whitespace en `title` compuesto

Tras componer `{familia} {tipo} {acabado_corto}`, el mapper colapsa whitespace a un único espacio y trimea (`.replace(/\s+/g, ' ').trim()`).

**Solo se aplica al title final** — los metafields se guardan literales del export. Si el cliente arregla el dato en origen, los metafields reflejarán la mejora sin que el código bloquee el cambio.

Caso real: la serie de 6 SKUs `Gea Power LED Round  ø180mm` (con doble espacio entre `Round` y `ø180mm`, bug del export). Sin la normalización, el title quedaba visualmente sucio en Shopify. Con la regla, el title queda `"Gea Power LED Round ø180mm Empotrable de suelo Acero"`; el metafield `product.familia` sigue con el doble espacio.

## 10. Idempotencia

El writer es idempotente. Re-ejecutar con los mismos inputs:

- **`productSet`** identifica por `handle = sku.toLowerCase()`. Crea si no existe, actualiza in-place. No duplica.
- **Imágenes** se suben con `duplicateResolutionMode=REPLACE` y filename estable `{sku}-{position}`. Re-runs reemplazan las mismas filas, no acumulan duplicados.
- **`translationsRegister`** es upsert por `(resourceId, locale, key)`. El digest se refresca contra `translatableResource` antes de cada registración, así que cambios en el contenido fuente se propagan.
- **`publishablePublish`** sobre un producto ya publicado es no-op.

Esto permite que un run abortado a la mitad pueda re-correrse sin efectos secundarios.

## 11. Imágenes — caché y polling

### `private.image_cache`

Tabla Postgres en Supabase. Keyed por `sha256` del binario:

| Columna | Tipo |
|---|---|
| `sha256` | text PK |
| `shopify_file_id` | text |
| `mime_type` | text |
| `bytes` | integer |
| `created_at` | timestamptz |
| `last_used_at` | timestamptz |

Sobrevive a la descatalogación de SKUs y permite que dos SKUs distintos con la misma foto compartan el mismo File en Shopify. **No hay política de eviction** — al volumen actual (~455 productos × hasta 6 imgs) la tabla cabe holgada.

Migration: `supabase/migrations/20260510120000_image_cache.sql`.

### Rate limit a la CDN del cliente

`cdnBucket.acquire(1)` serializa las descargas a **1 req cada 1.5 s**. Es el SLA de cortesía probado en diagnóstico: 337 HEADs sin un solo 429.

Tunable vía `options.cdnRateLimit`. Tirar para abajo cuando la telemetría confirme que la CDN aguanta más.

### Polling de status post-upload

Cada 500 ms hasta techo 15 s o salir de `PROCESSING`. Devuelve `{ready, failed, processing, firstError}`. Si quedan imágenes `processing` al cierre del polling, el SKU pasa a estado `WARN` y el siguiente run reintenta esos slots (la caché evita re-bajar las que ya quedaron `READY`).

Tunable vía `options.mediaPollMs` y `options.mediaPollMaxMs`.

## 12. Multi-idioma — Translate & Adapt

### Modelo

Shopify maneja traducciones como recursos separados del producto. El `product.title` y `product.body_html` viven en el idioma "fuente" del shop (ES en nuestro caso). Las versiones EN/IT/DE/FR/PT se almacenan como `Translation` registradas vía `translationsRegister`.

### Qué se traduce

Solo los campos marcados `translatable=true` en `mapping.json`:

- `product.title` (compuesto en cada locale).
- `product.body_html` (← columna `Descripción`).
- 8 metafields traducibles (§7.2).

### Activación en storefront

La carga de traducciones es **invisible** al cliente final hasta que se publica el idioma en `Settings → Store details → Languages`. Es un toggle, no un deploy.

Recomendación a documentar para el cliente:

- **Publicar de entrada**: ES (default), EN.
- **Cargados pero no publicados**: IT, DE, FR, PT.
- **Activación posterior** (1 toggle): cuando haya cliente B2B real en ese idioma.

## 13. Reportes generados

Cada run del writer crea una carpeta `reports/import-write-<ISO timestamp>/` con:

### `summary.txt`

Totales legibles:

```
Total publishables processed: 745
  ok:            720
  warn:          18
  failed:         7
  hidden:        N (no publishables)

Image pre-upload (CDN): resolved=2682 (cache_hit=1820 fresh=862) failed_slots=12
Product media (post-poll): ready=2670 failed=8 processing=4
Unpublished orphans: ok=3 failed=0 not_found=1
```

### `changes.csv`

1 fila por SKU del mapper (publishables + hidden), con columnas:

`sku, handle, product_id, product_set_status, product_set_errors, product_translations_registered, metafield_translations_registered, translation_errors, publish_status, publish_errors, media_ready_count, media_failed_count, media_processing_count, media_first_error, overall`

`media_first_error` truncado a 200 chars — preferentemente el `mediaErrors[0].details` de Shopify; si no hay pero sí hubo fallo de resolve, el primer warning del helper.

### `orphans.csv`

Output de la fase unpublish-orphans (§8). Columnas: `sku, product_id, status, errors`.

### `warnings.csv`

1 fila por warning del parser o mapper. Columnas: `source, severity, sku_or_row, locale, kind, message`.

### `hidden.csv`

Subset de `changes.csv` donde el SKU no se publicó. Columnas: `sku, publish_reason, in_surtido, in_stock, stock_qty, in_precios, price`.

Es el fichero clave a revisar con el cliente para validar la regla "se ocultan y se informa".

### Prioridad en `publish_reason`

Si un SKU falla varias condiciones, gana la primera no satisfecha en este orden:

`missing_stock > stock_zero > missing_price > price_zero` (presencia antes que valor).

### Exit code

- `0` — sin errores duros (warnings sí pueden existir).
- `2` — al menos un SKU `failed`.

`WARN` (imágenes no recuperadas) **NO cuenta como error duro** — el producto está bien, solo necesita un retry del siguiente cron.

## 14. CLI flags y modos de ejecución

### Dry-run sintáctico — `import-report.mjs`

Lee CSVs locales o de SFTP, cruza surtido + stock + precios, genera reporte. **No escribe nada en Shopify**.

```bash
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs --samples-dir=samples
node --env-file=shopify-ledsc4-theme.env scripts/import-report.mjs --verbose
```

Output: `reports/import-<ISO timestamp>/{summary.txt, changes.csv, hidden.csv, warnings.csv}`.

### Writer real — `import-write.mjs`

```bash
# Dry-run (no llama a Shopify; reporte de lo que haría)
node scripts/import-write.mjs

# Apply real (requiere SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_TOKEN)
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply

# Subset para iteración rápida
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply --limit=5
node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply --sku=05-6398-21-M1
```

### Flags reconocidos

| Flag | Default | Para qué |
|---|---|---|
| `--apply` | `false` | Sin él, dry-run (no llama a Shopify). |
| `--limit=N` | `null` | Procesa solo los primeros N SKUs del orden del surtido. |
| `--sku=<sku>` | `null` | Procesa solo el SKU indicado. |
| `--samples-dir=<path>` | `samples/` | Path de los CSVs locales. |
| `--with-db` | `false` | Conecta a Postgres para usar `sku_state` y la fase unpublish-orphans. Sin él, esa fase se salta. |
| `--verbose` | `false` | Logs detallados por SKU. |
| `--cdn-rate-limit=<n>` | `1.5` | Segundos entre HEADs a `files.ledsc4.com`. |

### Performance esperado

En tienda de pruebas (Development plan, ~450 publishables):

- **Primera apply** (sin cache): ~688 s.
- **Re-apply** (cache caliente): ~460 s.
- **I3.5** (con metafield translations): añade ~5-8 llamadas extra por SKU. Tiempo total escalado proporcionalmente.

Sequencial, sin paralelismo a nivel SKU. Suficiente para el cron diario.

## 15. Gotchas conocidos

### `productSet` no soporta `translations` inline

Hay que llamar a `translationsRegister` aparte. Por eso son 3 mutations (productSet → translationsRegister × 2 → publishablePublish), no una. El orden importa: la traducción necesita el GID del producto, que devuelve `productSet`.

### Pixel limit de Shopify

Imágenes con > 20 MP fallan en `MediaImage.status` con `pixel limit exceeded`. La caché las marca como `failed` y no se reintentan automáticamente — hay que pre-procesar (resize) en la fuente o en un pipeline intermedio. Hoy es 0.3% de las imágenes; el WARN del SKU es el indicador.

### `translationsRegister` no respeta el orden del input

Si se pasan 5 locales en una llamada, el orden de los resultados en la response puede no coincidir con el del input. No es problema para el writer (no asume orden), pero un dev que añada lógica nueva debe saberlo.

### `publishablePublish` requiere el publication GID exacto

No basta con el GID del catalog. Resuelto dinámicamente en `scripts/lib/shopify-collections.mjs::resolveOnlineStorePublicationId()` y equivalente para el catalog B2B.

### `Coleccion:2026` legacy

El tag `Coleccion:2026` se sigue asignando por compatibilidad con la smart collection histórica, pero la fuente de verdad de la publicación es la regla del §1, no el tag. Si en el futuro se elimina la smart collection, también se puede dejar de asignar el tag — no afecta al gate ni al storefront.

### Translatable `accesorio` vs `accesorio_url`

Cambio del 10-may-2026: `accesorio` (`single_line_text_field`) → `accesorio_url` (`url`). Shopify no permite cambiar el `type` de una definition existente. Solución: se creó `accesorio_url` nueva y la vieja `product.accesorio` quedó como deuda técnica (cleanup en PR separado, ver `_decisions_log` de `mapping.json`).

### El override por SKU rompe la fuente única de verdad

Documentado en §6.4. Para 55 SKUs el estado del portal no es deducible del ERP solo — hay que cruzar con `scripts/sku-overrides.json`. Antes de añadir un override nuevo, leer §6.4.4.

## 16. Pendientes y deuda

- **Activar skip por fingerprint** ([D14](adrs/d14-sku-state-fingerprint.md) Fase B). Hoy el writer corre el pipeline completo en cada SKU; con fingerprint, saltaría ~95% en runs sin cambios.
- **Migrar `cierre-pr-cat-restructure.md` al repo** (`docs/proyectos/`). Hoy vive solo en local. Cosechar de él la política Vía 1/2/3 + checklist + procedimiento de reversión hacia `16-operations-runbook.md` cuando se redacte.
- **Revisión trimestral de `sku-overrides.json`**. Para cada regla, verificar si el ERP ya refleja el estado deseado y, si es así, retirarla. La salida limpia siempre es preferible a la acumulación — el mecanismo de §6.4 no debería convertirse en un cementerio de excepciones permanentes.
- **Cleanup de `product.accesorio` legacy** tras migrar todos los SKUs a `accesorio_url`.
- **Eviction policy en `image_cache`**. Hoy ninguna. Si la tabla crece mucho (cambio de fotos masivo del cliente), añadir TTL o LRU.
- **Pre-procesado de imágenes >20 MP**: hoy fallan en Shopify; el WARN es informativo pero no resoluble desde el importer. Mover a un step previo (worker que las reescala) o pedir al cliente.
- **Confirmar semántica de `predeterminado`** con el cliente. Hoy importado pero oculto del storefront ([D8](adrs/d08-predeterminado.md)).
- **Multicurrency Fase 2**: hoy solo EUR. Cuando se active, ECB daily rates (gratis, oficial UE). Aparcado.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
