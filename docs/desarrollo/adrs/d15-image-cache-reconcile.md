# D15 · Reconciliación del image_cache · feed como fuente de verdad de imágenes

!!! info "Estado del documento"
    **Versión:** 1.0 · 18-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · 18-may-2026 · vigente. Implementada en `scripts/lib/image-upload.mjs`
(`reconcileImageCache`) y enganchada en `runFullImport`
(`scripts/import-write.mjs`). Desplegada en `main` vía PR #127.

## Contexto

El pre-upload de imágenes ([D11](d11-image-pre-upload.md)) cachea en
`private.image_cache` el mapeo `sha256(binario) → shopify_file_id`. La
escritura de caché es **write-once sobre `shopify_file_id`**: el
`INSERT … ON CONFLICT (sha256) DO UPDATE last_used_at = now()` nunca
reescribe el id de File; solo refresca `last_used_at`. El `cacheLookup` en
hit devuelve el id cacheado **sin verificar que el File siga existiendo en
Shopify**.

Ese diseño asume que un `MediaImage` subido por el pipeline vive para
siempre. La asunción se rompe cuando la media cambia **fuera del
pipeline**: una intervención de media en el Admin o un re-import externo
recrea/elimina los `MediaImage`, dejando en caché GIDs muertos. Como
`productSet` es **atómico**, un solo `files[].id` inexistente en el input
hace que Shopify rechace toda la mutación (`INVALID_INPUT input.files:
Media ids […] do not exist`) — y con ella se pierde la escritura de
`variant.price` e inventario del SKU. En el incidente que motivó este ADR,
430/454 productos quedaron sin publicar por run y con precio/stock
desactualizados hasta que la caché se invalidó.

## Decisión

**0 · Lookup pre-fetch por `source_url`** (añadido 02-jun-2026 en [PR #147](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/147)).
Antes del GET al CDN, `resolveImageToShopifyFileId` consulta `private.image_cache` por `source_url`. Hit → devuelve el `shopify_file_id` y `sha256` cacheados sin tocar el CDN. Miss → flujo histórico (fetch → hash → cache lookup por sha256 → upload).

Motivación: el cache por sha256 existente exige descargar el binario en cada slot (~2.700 GETs paginados a 1/3s en un full = ~80 min). En régimen estacionario (catálogo estable, URLs invariantes) el 99,9 % de los slots ya tienen entrada en `image_cache` con su `source_url`, así que ese GET es trabajo perdido. El short-circuit por URL reduce el writer de ~80 min a ~17 min, eliminando la causa raíz del incidente de 12 noches consecutivas con timeout 60 min ([02b §Timeout](../02b-importer-deploy.md#timeout-y-permisos)).

Asunción: **las URLs del CDN del proveedor son inmutables**. Cuando la imagen cambia, LedsC4 renombra el path (consistente con su comportamiento histórico observado). Si en el futuro detectamos URLs que mutan en sitio sin renombrar, el lookup por URL devolvería un GID obsoleto y habría que añadir verificación HEAD condicional (ETag/Last-Modified). La asunción ya estaba implícita en el resto del cache — `reconcileImageCache` (decisión §1 abajo) solo verifica que el File de Shopify exista, no que el binario del CDN coincida con el binario que produjo el sha256 original.

Migration del índice: [`supabase/migrations/20260602120000_image_cache_source_url_index.sql`](../../../supabase/migrations/20260602120000_image_cache_source_url_index.sql) (índice parcial `WHERE source_url IS NOT NULL`).

---

**1 · Reconciliación en lote al inicio de cada run full.**
`reconcileImageCache({ ctx, dbConnection, onProgress, batchSize=250 })` se
ejecuta en `runFullImport` tras `fetchShopContext` y antes del worker pool,
solo con `applyMode` + `dbConnection` (sin caché no aplica):

1. Snapshot `select shopify_file_id, min(source_url) … group by
   shopify_file_id` de `private.image_cache`.
2. Verificación por lotes de 250 ids vía `nodes(ids:)` (query
   `RECONCILE_NODES_QUERY`), paginada a través de `ctx.bucket` como
   cualquier otra llamada GraphQL.
3. Un id es **muerto** si el nodo es `null`, no es `MediaImage`, o su
   `status` no es `READY`.
4. `delete from private.image_cache where shopify_file_id = any($1)` de los
   muertos. La fila borrada → siguiente `cacheLookup` miss →
   `resolveImageToShopifyFileId` resube desde `source_url` y reescribe un
   GID fresco.

**2 · El feed es la fuente de verdad también para imágenes.** Igual que
precio y stock, las imágenes las gobierna el feed/CSV. El writer reasienta
en cada run los `files[]` del feed vía `productSet` (sobreescritura
incondicional, sin diff). Una imagen curada manualmente en el Admin será
revertida en el siguiente run. `reconcileImageCache` no preserva ni detecta
curación manual: garantiza que los File ids del feed sigan siendo válidos,
no que coincidan con ediciones manuales.

### Contrato fail-safe

- `dbConnection` null → no-op, `{ skipped:true }`.
- Llamada de lote que lanza → reintento partido en mitades; mitad que
  vuelve a lanzar → sus ids quedan `unverified` y **nunca se borran**
  (la ambigüedad jamás provoca un DELETE).
- Error del snapshot SELECT o del DELETE → se reporta y **el run continúa**
  (degrada al comportamiento previo a este ADR).
- Solo se borran ids confirmados muertos en una respuesta exitosa.

### Observabilidad

Línea en `summary.txt`:
`image_cache reconcile: checked=N dead=N invalidated=N unverified=N`, y
`cache-reconcile.csv` (`shopify_file_id, source_url`) en el `reportDir` del
run, subido a Storage con el resto de reportes.

## Alternativas consideradas

**TTL / expiración por antigüedad en `image_cache`.** Descartada: la
muerte de un GID no correlaciona con el tiempo — depende de intervenciones
externas impredecibles. Un TTL borraría caché sana y re-subiría de más sin
cerrar la ventana de GIDs muertos recientes.

**Verificar el GID dentro de `cacheLookup`** (un `node()` por imagen en
hit). Descartada: añade ~2700 consultas Shopify por run (una por slot),
justo la cuota que el caché existe para ahorrar. El lote al inicio cuesta
~4 consultas.

**Invalidación reactiva** (capturar el `userError` de `productSet` y
purgar el id culpable). Descartada: `productSet` es atómico — el error no
identifica de forma fiable qué id falló sin parsear el mensaje, y el SKU ya
falló ese run. La verificación previa evita el fallo en vez de reaccionar.

**Soft-delete (`invalidated_at`) en vez de DELETE.** Descartada: la fila no
porta dato irrecuperable (`source_url` también vive en el modelo del run);
el DELETE deja el caché en el estado exacto que el miss-path espera, sin
cambio de schema.

## Consecuencias

- **Auto-reparación por run.** Cada run full detecta y corrige GIDs muertos
  por cambios de media externos al pipeline, sin intervención manual.
- **Coste API acotado.** ~4 consultas `nodes(ids:)` por run (250 ids/lote
  sobre ~959 filas), dentro del bucket Shopify compartido. Despreciable
  frente a las ~30 min del run.
- **SKUs con `source_url` caída** (404/timeout en la resubida tras
  invalidar) **se publican igual con precio y stock**: el slot se omite en
  `productSet.input.files[]` y el input válido no se rechaza. Su imagen
  ausente es **deuda de datos del cliente**, visible en `failed_slots` y
  `cache-reconcile.csv`; no es un fallo del pipeline ni se enmascara.
- **Convergencia limpia y reanudable.** El caché se escribe fila a fila
  solo tras un upload+`READY` exitoso (`ON CONFLICT` idempotente). Un corte
  por timeout a mitad de resubida no deja filas envenenadas; el siguiente
  run completa las pendientes.
- **El feed-wins es ahora explícito para imágenes.** No se debe añadir
  lógica que preserve o haga merge con curación manual de media en Shopify.
  Cualquier excepción a "el feed manda" rompería la garantía de
  convergencia.
- **`reconcileImageCache` no sustituye al pre-upload ni al polling
  post-`productSet`** ([D11](d11-image-pre-upload.md)): es la capa que
  mantiene válidos los ids que esos mecanismos producen y consumen.

## Cambios

- **v1.1** (03-jun-2026): añadida la decisión §0 (lookup pre-fetch por `source_url`) tras [PR #147](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/147). Mantiene el resto de la decisión inalterado — la reconciliación por GIDs sigue siendo el mecanismo de salud del cache; el lookup por URL solo cambia el orden de los caminos de hit.
- **v1.0** (18-may-2026): primera publicación. Decisión implementada y
  desplegada en `main` (PR #127).
