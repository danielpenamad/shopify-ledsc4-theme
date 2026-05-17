# D11 · Pre-upload de imágenes a Shopify Files

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · PR-IMG-2 (mayo 2026) · vigente. Reemplaza el modelo inicial de import directo desde URL.

## Contexto

Cada producto del catálogo trae hasta 6 imágenes referenciadas como URLs absolutas en la CDN del cliente (`files.ledsc4.com`). El importer original usaba el patrón nativo de Shopify para asociar imágenes a productos:

```graphql
productSet(input: {
  files: [{ originalSource: "https://files.ledsc4.com/products/abc.jpg" }]
})
```

Shopify recibe la URL, intenta descargarla desde su infraestructura, y crea internamente un `MediaImage`. Ventaja: cero código de descarga en el importer; el writer pasa URLs y olvida.

El comportamiento real en producción fue distinto. La CDN del cliente aplica rate-limiting agresivo cuando recibe ráfagas concurrentes desde la misma IP de origen (los workers de Shopify). En el primer dry-run completo sobre 745 productos × ~5 imágenes cada uno (~3700 requests en ventana corta), la CDN devolvió 429/503 en ~50% de las peticiones. Shopify marcó esos `MediaImage` como `FAILED` y el producto quedó publicado **sin imagen**, con `mediaErrors` en el response que el importer no podía resolver — la URL estaba bien, el problema era el rate-limit del lado del cliente.

Intentos de mitigación que NO funcionaron:

- Reducir paralelismo del writer a 1 SKU/segundo — no controla cuántas requests internas hace Shopify a la CDN al expandir el `files[]`.
- Pre-calentamiento de la CDN con GET masivos — la CDN trata las requests de Shopify como diferentes a las nuestras (distinto User-Agent, IPs distintas), el cache no se comparte.
- Retry desde Shopify — `fileUpdate` con la misma URL produce los mismos 429 porque Shopify reintenta inmediatamente.

La conversación con el equipo del cliente confirmó que **no van a relajar el rate-limit** de la CDN — es la misma infraestructura que sirve a ledsc4.com público y la protección es necesaria.

## Decisión

**El importer pre-sube cada imagen a Shopify Files** antes de asociarla al producto. Shopify deja de fetchear desde la CDN del cliente; recibe binarios directamente desde el writer.

Flujo por imagen:

1. **Bucket compartido del run** serializa descargas: 1 request cada 1.5 segundos a la CDN del cliente. SLA de cortesía verificado en diagnóstico (337 HEADs sin un solo 429). Configurable vía `options.cdnRateLimit`.
2. **Fetch binario a memoria** (timeout 15s) + cálculo de `sha256` + sniff MIME (header + fallback magic-byte).
3. **Cache lookup** en tabla `private.image_cache` (`sha256` → `shopify_file_id`):
   - Hit → reusar el File existente, salir sin tocar Shopify Files.
   - Miss → `stagedUploadsCreate(resource: IMAGE)` → POST multipart al target devuelto → `fileCreate(originalSource: resourceUrl)` → polling de `MediaImage.status` hasta `READY` o `FAILED` (techo 15s).
4. **Persistir en cache**: `INSERT INTO private.image_cache ... ON CONFLICT (sha256) DO UPDATE last_used_at = now()`.
5. **Asociar al producto**: el `productSet` referencia el File pre-subido vía `FileSetInput.id`, no vía `originalSource`.

Helper: `scripts/lib/image-upload.mjs`. Cada modo de fallo (`fetch_failed`, `fetch_timeout`, `unsupported_mime`, `staged_upload_failed`, `file_create_failed`, `file_status_failed`) devuelve `{ ok: false, kind, message }`. El slot pasa a `null` en `productSet.input.files[]` para no tocar el media existente del producto.

Migración: [`supabase/migrations/20260510120000_image_cache.sql`](https://github.com/danielpenamad/shopify-ledsc4-theme/blob/main/supabase/migrations/20260510120000_image_cache.sql).

## Alternativas consideradas

**Dejar a Shopify fetchear desde la CDN del cliente** (modelo original). Descartada por rate-limit de la CDN. ~50% del catálogo quedaba sin imágenes.

**Negociar relajación del rate-limit con el cliente.** Descartada: el cliente no puede bajar la protección de su CDN sin abrir vector de abuso.

**Proxy intermedio del lado nuestro** (Cloudflare Workers o similar) que cachee imágenes y sirva a Shopify. Descartada: añade infraestructura adicional (deploy, secrets, billing, monitoreo) sin valor frente a la solución directa de pre-upload. Shopify Files actúa como ese cache, gratis y dentro del entorno ya operado.

**Pre-upload sin caché** (descargar y subir siempre, sin lookup `sha256`). Descartada: dos SKUs con la misma imagen (caso común — variantes de color del mismo modelo) duplicarían el File en Shopify, multiplicando el coste de almacenamiento y los tiempos del writer. La caché reduce los re-imports a tiempos cercanos al `productSet` puro.

## Consecuencias

- **El importer es ahora responsable de la integridad de las imágenes**. Si la CDN devuelve binario corrupto, el sniff MIME falla y el slot queda `null`. Visible en `import-YYYY-MM-DD-changes.csv` columnas `media_failed_count` y `media_first_error`.
- **Coste de storage en Shopify Files** asumido. Volumen actual: ~455 productos × hasta 6 imágenes = ~2700 Files; cualquier nuevo SKU con imagen nueva añade hasta 6 Files. No hay política de eviction — al volumen actual la tabla cabe holgada y los Files no caducan.
- **Latencia del writer aumenta**: cada miss añade ~3-8s (download + staged upload + fileCreate + polling). En run completo desde caché vacía, ~688s para 450 SKUs. Re-runs sobre caché poblada bajan a ~460s. Documentado en [02-importer](../02-importer.md) §performance.
- **El polling de `MediaImage.status`** se mantiene como defense-in-depth incluso con Files pre-subidos. Captura fallos post-asociación (p. ej. `pixel limit exceeded` sobre imágenes >20 MP) que el pre-upload no detecta. Devuelve `{ ready, failed, processing, firstError }` al `changes.csv`.
- **Caché ortogonal a SKUs**: la tabla `private.image_cache` sobrevive a la descatalogación de SKUs y reusa Files entre productos distintos. Si dos SKUs comparten la misma foto, comparten el mismo `shopify_file_id`.
- **Sin re-bajada de imágenes ya `READY`**: si en un run anterior un slot quedó `WARN` (imagen no recuperada), el siguiente cron solo reintenta el slot fallido. Las imágenes que sí quedaron `READY` se reusan desde caché vía `sha256`.
- **Modo `--dry-run`** no pega contra la CDN ni contra Shopify Files. Documentado en [02-importer](../02-importer.md) §writer.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
