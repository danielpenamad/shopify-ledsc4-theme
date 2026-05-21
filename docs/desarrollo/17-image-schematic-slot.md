# 17 · Slot del esquema técnico (PR-IMG-3)

!!! info "Estado del documento"
    **Versión:** 1.0 · 21-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Cubre PR-IMG-3, la PR que añade el **esquema técnico** del producto como última imagen del carrusel de cada SKU vivo. Complementa [02-importer §11 Imágenes](02-importer.md#11-imágenes--caché-y-polling), donde se describe el pre-upload y el caché por sha256 que esta PR reusa sin modificar.

Cubre:

- Qué es un **slot derivado** (URL construida desde el SKU, no respaldado por columna del CSV).
- Configuración declarativa en `mapping.json` (`derived_images.slots`).
- Construcción del slot en el mapper y su consumo en el writer.
- Discriminación entre **ausencia esperada** (404 → `missing`, no es WARN) y **fallo real** (timeout/upload/etc → `failed`, sí WARN).
- Telemetría: línea `Technical schematic` en `summary.txt` y columna `schematic_status` en `changes.csv`.
- Procedimiento operativo de **hidratación quirúrgica** del caché (cuándo se necesita, cómo se ejecuta).

No cubre:

- Pre-upload genérico (cdnBucket, `image_cache`, `reconcileImageCache`) → [02-importer §7.0 y §11](02-importer.md#70-pre-upload-de-imágenes-files-api).
- Despliegue del workflow → [02b-importer-deploy](02b-importer-deploy.md).
- Material de administración/operador → docs separadas (no en `docs/desarrollo/`).

## 1. Resumen ejecutivo

Cada producto del catálogo LedsC4 tiene un **esquema técnico** (dibujo de cotas) disponible en la CDN del cliente en la URL `https://files.ledsc4.com/png/{SKU}`. Esta URL **no aparece en ningún CSV del feed**: se construye a partir del SKU.

PR-IMG-3 añade ese esquema como una imagen más del producto, con dos invariantes:

- **Posición fija al final del carrusel.** Nunca imagen principal, nunca intercalado entre fotos comerciales. El orden del array `model.product.images` es el orden del carrusel, y el slot derivado se hace `push` al final tras todas las fotos del CSV.
- **`altText` propio** del slot: `"Esquema técnico — {SKU}"`. No hereda el alt de las fotos. Sin extensión de fichero en el texto (el endpoint sirve tanto PNG como JPEG; ver §8.1).

No hay cron separado: PR-IMG-3 es una extensión del paso 0 (pre-upload de imágenes) del writer pesado existente. La URL del esquema se procesa por el mismo `resolveImageToShopifyFileId` que las URLs del CSV — mismo `cdnBucket`, mismo dedupe por sha256 contra `private.image_cache`, mismo upload a Shopify Files, misma asociación vía `productSet.input.files[].id`.

## 2. Arquitectura

### 2.1 Por qué no hay cron separado

Los esquemas son una URL más por SKU. El paso 0 del writer ya conoce cómo:

- Descargar binarios de `files.ledsc4.com` con politeness rate.
- Deduplicar por `sha256` contra `private.image_cache`.
- Subir a Shopify Files vía `stagedUploadsCreate` + `fileCreate`.
- Asociar al producto vía `FileSetInput.id`.

Añadir el esquema como un slot más del array reaprovecha esa infraestructura completa. Un cron separado duplicaría rate-limit del CDN, lógica de caché y telemetría sin ganancia.

### 2.2 Flujo dentro de `processSku`

```
processSku(sku)
  ↓
  resolveImagesForSku(model)         ← procesa N+1 slots (N fotos CSV + 1 esquema)
    ↓
    para cada slot en model.product.images:
      resolveImageToShopifyFileId(url, …)   ← idéntico para foto y esquema
    ↓
    devuelve { resolved, warnings, expectedAbsences, schematicStatus }
  ↓
  buildProductSetInput(model, { resolvedImages })
    ↓
    files[].push({ id: r.fileId, alt: img.alt })   ← alt propagado si presente
  ↓
  productSet(input)
```

El slot derivado no recibe trato especial dentro de `resolveImageToShopifyFileId`: la URL `https://files.ledsc4.com/png/{SKU}` se acepta como cualquier otra. La discriminación ocurre **fuera** del helper, en `resolveImagesForSku`, usando la marca `img.derived` que añade el mapper (§4.4).

### 2.3 Diferencias vs slots del CSV

| Propiedad | Slot del CSV (col 58-63) | Slot derivado (esquema) |
|---|---|---|
| Origen de la URL | Columna del CSV | Construida desde SKU |
| Marca en `model.product.images[i]` | sin `derived` | `derived: 'esquema_tecnico'` |
| Campo `alt` | ausente | `"Esquema técnico — {SKU}"` |
| Posición en carrusel | `image_position` 0-5 | Final del array (siempre tras las fotos) |
| Fallo 404 | WARN | `schematic_status=missing`, no WARN (§5.3) |
| Otros fallos | WARN | WARN (§5.3) |

## 3. Configuración declarativa — `mapping.json`

PR-IMG-3 introduce una nueva sección en `scripts/mapping.json`:

```json
"derived_images": {
  "$comment": "Slots de imagen sintéticos NO respaldados por columna del CSV...",
  "slots": [
    {
      "id": "esquema_tecnico",
      "url_template": "https://files.ledsc4.com/png/{SKU}",
      "alt_template": "Esquema técnico — {SKU}"
    }
  ]
}
```

Campos por slot:

| Campo | Significado |
|---|---|
| `id` | Identificador estable del slot. Se propaga a `img.derived` y al campo `expectedAbsences[].derived`. Permite distinguir slots derivados aguas abajo si en algún momento hay más de uno. |
| `url_template` | URL del recurso, con `{SKU}` como placeholder. Sustitución literal vía `replaceAll('{SKU}', sku)`. |
| `alt_template` | `altText` final que va a `FileSetInput.alt`. Mismo placeholder `{SKU}`. No se asume extensión de fichero. |

El array `slots` es ordenado: el orden listado es el orden en que se añaden al final del carrusel. Hoy hay exactamente un slot (el esquema). Si en el futuro se añadiera otro slot derivado (p. ej. una etiqueta energética como imagen), basta con añadirlo aquí — sin tocar código en `import-map.mjs` ni en `import-write.mjs`.

## 4. Construcción en el mapper (`scripts/import-map.mjs`)

`buildShopifyModel` lee `mapping.derived_images.slots` y, **tras** poblar las fotos del CSV en `model.product.images`, hace `push` de cada slot derivado:

```js
for (const slot of derivedImageSlots) {
  images.push({
    src: slot.url_template.replaceAll('{SKU}', sku),
    position: images.length,                                  // ver §4.1
    alt: slot.alt_template ? slot.alt_template.replaceAll('{SKU}', sku) : null,
    derived: slot.id,                                         // ver §4.4
  });
}
```

### 4.1 Posición fija al final

El orden del array es el orden del carrusel en Shopify (ver §2.3 de [02-importer §11](02-importer.md#11-imágenes--caché-y-polling)). El slot derivado va al final porque se hace `push` después del bucle de fotos del CSV. El campo `position` que se asigna (`images.length`) es informativo y no se usa aguas abajo para reordenar — `buildProductSetInput` emite `files[]` en el orden literal del array, sin reordenar por `position`.

Si un SKU no tiene fotos comerciales (columnas 58-63 vacías), el slot derivado quedará en posición 0 (será la única imagen del producto). Es un caso raro pero válido (§8.3).

### 4.2 `alt` propio, no heredado

Las fotos del CSV no llevan `alt` — `model.product.images` para ellas es `{ src, position }`. Solo el slot derivado lleva `alt`. Esto preserva el comportamiento histórico de las fotos (sin `altText` en `FileSetInput`) mientras inyecta uno propio para el esquema.

### 4.3 Sin asumir extensión

El path `/png/` sirve **tanto PNG como JPEG** (ver §8.1). El `src` que se construye no lleva extensión (`https://files.ledsc4.com/png/{SKU}`, sin `.png` ni `.jpg`), y el `altText` tampoco la incluye. `image-upload.mjs` resuelve el MIME por header + sniff de magic-byte como con cualquier otra imagen.

### 4.4 Marca `derived`

El campo `img.derived = slot.id` es la pista que el writer usa para discriminar:

- En `resolveImagesForSku`: para clasificar un 404 como `expectedAbsence` solo si proviene de un slot derivado (§5.3).
- En el cómputo de `schematicStatus`: solo los slots con `derived` set actualizan el estado del SKU.

Las fotos del CSV no llevan `derived` — su 404 sigue siendo WARN como hoy.

## 5. Consumo en el writer

### 5.1 `buildProductSetInput` propaga `alt`

En `scripts/import-write.mjs`, `buildProductSetInput` añade `alt` a `FileSetInput` solo cuando el slot lo trae:

```js
const f = { id: r.fileId };
if (img.alt) f.alt = img.alt;
files.push(f);
```

Tanto en la rama id-mode (cuando hay `resolvedImages`, que es el caso en runs reales) como en la rama legacy (dry-run / tests). Las fotos del CSV no tienen `img.alt` → el campo no se añade → comportamiento intacto.

### 5.2 `schematicStatus` por SKU

`resolveImagesForSku` devuelve `{ resolved, warnings, expectedAbsences, schematicStatus }`. El nuevo campo `schematicStatus` toma uno de cuatro valores:

| Valor | Significado | Cuándo |
|---|---|---|
| `'present'` | El esquema se resolvió a un File (fresh o cache) | Slot derivado + `resolveImageToShopifyFileId` devuelve `{ ok: true, fileId }` |
| `'missing'` | El esquema no existe en el CDN (ausencia esperada) | Slot derivado + `fetch_failed` + `httpStatus === 404` |
| `'failed'` | El esquema falló por algo que no es 404 | Slot derivado + cualquier otro fallo (timeout, file_create, mime, fetch_failed no-404) |
| `null` | El SKU no tiene slot derivado (no debería ocurrir hoy) | `mapping.derived_images.slots` vacío |

El mapper añade exactamente un slot derivado por SKU (invariante de §4), así que la asignación es 1:1 sin precedencias entre múltiples slots.

### 5.3 Discriminación 404 vs otros fallos

**Detección por dato estructurado, no por string del mensaje.** `fetchBinary` en `scripts/lib/image-upload.mjs` expone `httpStatus: res.status` en el objeto de fallo:

```js
if (!res.ok) {
  return { ok: false, kind: 'fetch_failed', message: `HTTP ${res.status} ${res.statusText}`, httpStatus: res.status };
}
```

Y `resolveImagesForSku` ramifica sobre el número, no sobre regex:

```js
const isExpectedAbsence =
  img.derived &&
  r.kind === 'fetch_failed' &&
  r.httpStatus === 404;
```

Decisión: el `message` queda como string legible humano-friendly; los callers que necesitan ramificar por status leen `httpStatus`. Si en el futuro se reformatea el `message`, no se rompe la detección.

Consecuencias en cascada para un slot derivado:

- **404** → no entra en `warnings`, entra en `expectedAbsences`, `schematicStatus='missing'`. El slot pasa a `null` en `productSet.input.files[]` (skip), el producto se publica con sus fotos. **No es WARN** — es una ausencia esperada del catálogo del cliente.
- **Resto de fallos** (`fetch_timeout`, `unsupported_mime`, `staged_upload_failed`, `file_create_failed`, `file_status_failed`, o `fetch_failed` no-404) → entra en `warnings` como un fallo de imagen cualquiera, `schematicStatus='failed'`, el SKU pasa a WARN por la rama existente del gate (`ir.warnings.length > 0`).

Para fotos del CSV (sin `img.derived`): comportamiento intacto. Un 404 sigue siendo WARN como hoy.

## 6. Telemetría

### 6.1 Línea en `summary.txt`

Tras la línea de `product media (post-poll)`:

```
- Technical schematic:          present=N missing=M failed=K
```

Tres cubos disjuntos. **Población = SKUs que superan productSet** (misma población que `image pre-upload (CDN)`). En un run sano (`productSet failed=0`), `present + missing + failed` iguala el número de publicables. Si `productSet` tiene fallos, esos SKUs no contribuyen a ninguno de los tres cubos: un SKU que no llegó a crearse en Shopify no es "cobertura de catálogo".

Lectura para el cliente:

- `present` — cobertura real del catálogo. Es el número que va al correo de seguimiento.
- `missing` — SKUs sin esquema en el CDN del cliente. No es error del pipeline, es estado del feed del cliente. Si crece, conversación con el cliente.
- `failed` — SKUs cuyo esquema falló por algo no-404 (timeout, etc.). En general transitorio del CDN; si crece de forma sostenida, investigar.

Sin exit code distinto ni alerta nueva por `missing` alto: PR-IMG-3 es observabilidad, no un gate.

### 6.2 Columna en `changes.csv`

Nueva columna `schematic_status` insertada justo antes de `overall`:

| Tipo de fila | Valor de `schematic_status` |
|---|---|
| `OK` (productSet+translations+publish exitosos) | `present` / `missing` / `failed` |
| `WARN` (foto comercial falla, esquema sí presente) | `present` (o `missing`, o `failed` — el WARN viene de la foto, no del esquema en sí) |
| `FAILED` (productSet falló) | vacío |
| `HIDDEN` (SKU no publicable: missing_stock, price_zero, etc.) | vacío |
| `DRY_RUN` | vacío |

Útil para auditar SKU-a-SKU qué pasó con el esquema. El cliente puede filtrar por `schematic_status=missing` y obtener la lista exacta de SKUs sin esquema en el feed.

## 7. Procedimiento operativo — hidratación quirúrgica

### 7.1 Cuándo se usa

Dos casos típicos:

- **Primer run con caché fría** tras introducir PR-IMG-3 (o tras un purge de `image_cache`). El run carga todos los esquemas desde el CDN — N fetches secuenciales a 1 req/1.5 s + uploads a Shopify Files. Para catálogos del orden de centenares de SKUs, esto puede empujar el run por encima del `timeout-minutes` del workflow.
- **Cron truncado por timeout.** Si un cron se cancela en mitad del procesado dejando un subconjunto de SKUs sin esquema en el caché, la siguiente noche volverá a partir de cache fría parcial para esos huecos — y puede toparse con el mismo techo de tiempo.

En ambos casos, hidratar el caché en una pasada **fuera del cron** evita el problema: el siguiente cron entra con `image_cache` ya poblado para los esquemas → todos hit, sin trabajo CDN nuevo → encaja holgadamente en el `timeout-minutes` existente.

### 7.2 Qué hace exactamente

Llama a `resolveImageToShopifyFileId` solo para los slots de esquema (URL `https://files.ledsc4.com/png/{SKU}`) de los SKUs cuyo URL no esté ya en `image_cache`. Es decir:

1. Lee la lista de publicables corriendo el mapper sobre los samples locales.
2. Consulta `image_cache` para saber qué URLs de esquema ya están cacheadas.
3. Diff → lista de SKUs a hidratar.
4. Para cada uno: `resolveImageToShopifyFileId` con el mismo `cdnBucket` y `dbConnection` que usa el writer. Cero llamadas a `productSet`, cero modificaciones de productos.

**Es reentrante.** Si se relanza, los SKUs ya hidratados hacen `cache_hit` y no generan trabajo.

### 7.3 Cómo se lanza

Script ad-hoc en `tmp/` (no es código de producción; vive fuera del repo de Shopify Files). Patrón de referencia: ver el script `tmp/hydrate-schematic-cache.mjs` usado durante el cierre de PR-IMG-3 (no commiteado, generable en cualquier momento).

Esqueleto mínimo:

```js
// Conexión a Supabase (image_cache).
const dbConnection = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await dbConnection.connect();

// 1. Build model → publishables.
const { products } = await buildModel();  // usa parseSurtido/Stock/Precios + buildShopifyModel
const publishables = Array.from(products.values()).filter((m) => m.publish).map((m) => m.sku);

// 2. Diff contra image_cache.
const cached = new Set((await dbConnection.query(
  `select source_url from private.image_cache where source_url like 'https://files.ledsc4.com/png/%'`
)).rows.map((r) => r.source_url));
const missing = publishables.filter((sku) => !cached.has(`https://files.ledsc4.com/png/${sku}`));

// 3. Resolve secuencial (cdnBucket serializa igualmente).
const ctx = { endpoint: …, token: …, fetch, bucket: createTokenBucket({ capacity: 50, refillPerSec: 10 }) };
const cdnBucket = createTokenBucket({ capacity: 1, refillPerSec: 1 / 1.5 });
for (const sku of missing) {
  const r = await resolveImageToShopifyFileId({
    url: `https://files.ledsc4.com/png/${sku}`,
    ctx, cdnBucket, dbConnection, fetchImpl: fetch,
  });
  // contar ok/failed por kind…
}
```

Pre-flight recomendado antes del bucle:

- Confirmar conectividad a Supabase con un `SELECT COUNT(*)` contra `image_cache`.
- (Opcional) confirmar permisos de escritura con un `INSERT … ROLLBACK` sobre un sha256 sentinela.

### 7.4 Qué reporta

Mínimo razonable:

- SKUs a hidratar (tras diff).
- `OK` (desglose `fresh` / `cache_hit` — el cache_hit aparece cuando el script se relanza o cuando otro proceso hidrató ya esa URL).
- `failed`, desglosado por `kind` (`fetch_failed` con `httpStatus`, `fetch_timeout`, etc.). Los 404 son `missing` esperado, no fallo real del pipeline.
- Tiempo total wall-clock.

Para los `fetch_timeout`, conviene un reintento explícito (2-3 veces con espera de unos segundos) — son transitorios del CDN del cliente y reintentar suele resolverlos en el mismo turno.

### 7.5 Casos típicos de uso

- **Tras introducir PR-IMG-3 o purgar `image_cache`:** se ejecuta una vez sobre todos los publicables. Tiempo proporcional al número de esquemas × 1.5 s + tiempo de upload a Shopify Files. Para catálogos del orden actual (~450 publicables, todos los esquemas frescos), del orden de varios minutos.
- **Tras un cron truncado por timeout:** si un cron se cancela dejando N SKUs sin esquema en el caché, una hidratación quirúrgica sobre solo esos N los completa en cuestión de minutos. El siguiente cron entra con caché caliente y encaja en `timeout-minutes`.

Sin tocar `timeout-minutes` del workflow ni el catálogo del shop. Es una operación de calentamiento de caché, totalmente reversible (a lo sumo deja Files extra sin asociar en Shopify Files, espacio de coste despreciable).

## 8. Gotchas conocidos

### 8.1 El path `/png/` sirve PNG y JPEG indistintamente

A pesar del nombre del path, el CDN devuelve PNG o JPEG según el archivo origen del cliente. `image-upload.mjs` ya maneja ambos via `MIME_TO_EXT` + `sniffImageMime` (magic-byte). Ningún punto del slot derivado asume extensión `.png`: ni `src`, ni `alt`, ni filename interno.

### 8.2 Algunos JPEG sobredimensionados

En el diagnóstico inicial (PR-IMG-3 Fase 0) aparecieron casos puntuales de `/png/{SKU}` devolviendo JPEG de tamaño anómalo (>150 KB para lo que debería ser un esquema vectorial). Se trata de un defecto del conversor del cliente, no del pipeline. Fuera de scope de PR-IMG-3 — anotado para conversación con el cliente, no acción interna.

### 8.3 Slot derivado en posición 0

Si un SKU no tiene ninguna foto comercial poblada en las columnas 58-63 del CSV, el slot derivado queda como **única imagen** del producto (posición 0 del carrusel). Lo cubrirá Shopify como imagen principal. Caso raro pero válido — no bloquear, no warning. Aparece en el `csvFirstError` con `pos=0` si ese slot único además falla.

## Cambios

- **v1.0** (21-may-2026): primera publicación tras cierre de PR-IMG-3.
