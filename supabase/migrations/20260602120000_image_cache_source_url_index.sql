-- Índice en private.image_cache.source_url para lookup pre-fetch.
--
-- Problema: image-upload.mjs siempre hacía GET completo del CDN para hashear
-- el binario antes de consultar la cache por sha256. En catálogos grandes
-- (LedsC4: 445 productos × ~6 imgs cada uno) con rate-limit del CDN a 1/3s,
-- esto añade ~80 min al full run aunque el 100% de las imágenes estén ya
-- cacheadas. Es justo el cuello que mata al writer en GHA (timeout 60min).
--
-- Solución: añadir lookup por source_url ANTES del fetch. Si la URL exacta
-- ya produjo un Shopify File, devolvemos ese GID sin tocar el CDN.
--
-- Asunción: las URLs del CDN son inmutables (una URL siempre devuelve el
-- mismo binario). El proveedor renombra el path cuando la imagen cambia.
-- Esta asunción ya estaba implícita en reconcileImageCache, que solo verifica
-- la existencia del File en Shopify, no que el binario del CDN coincida.
-- Si en el futuro detectamos URLs que mutan en sitio, habrá que añadir
-- verificación HEAD (ETag/Last-Modified) condicional.
--
-- Índice no-UNIQUE porque distintos sha256 (imagen rehasheada tras un cambio
-- manual fuera del flujo normal) pueden compartir source_url. El lookup
-- desempata por last_used_at desc para devolver el más reciente.

create index if not exists idx_image_cache_source_url
  on private.image_cache (source_url)
  where source_url is not null;

comment on column private.image_cache.source_url is
  'CDN URL que produjo este hash. Usado como clave de lookup pre-fetch '
  '(short-circuit del GET al CDN) bajo la asunción de URLs inmutables.';
