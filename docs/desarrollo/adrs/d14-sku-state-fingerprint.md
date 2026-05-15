# D14 · Fingerprint cache en `private.sku_state`

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ⚠️ aceptada (skip incremental pendiente de implementar)
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase I3 (mayo 2026) · vigente. La tabla `private.sku_state` está creada y se popula en cada run del writer. El **skip incremental basado en fingerprint** está pendiente de implementación (Fase B prep).

## Contexto

El writer del importer es **idempotente sobre Shopify**: `productSet`, `translationsRegister` y `publishablePublish` son no-op cuando los datos no cambian. Re-ejecutar el run completo sobre datos sin cambios no produce diferencias en el shop.

El problema es el **coste de ese no-op**:

- Run completo: ~688s en caché vacía, ~460s en re-runs sobre caché de imágenes ya poblada.
- Cada SKU consume cuota de Shopify GraphQL Admin API (`productSet` ~30 puntos + `translationsRegister` ~5 puntos × N metafields traducibles + `publishablePublish` ~3 puntos = ~50-80 puntos por SKU).
- Para 450 SKUs × ~70 puntos = ~31500 puntos por run. La cuota Admin es 1000 puntos/segundo con bucket de 2000.

El plan ([D10](d10-3-csvs-sftp.md)) contempla ejecutar el cron de stock/precios **cada 6 horas**. Pero el writer real corre desde GHA disparado por `sftp-sync` ([D12](d12-pipeline-split.md)), y aunque el cron de stock toca solo `inventory_levels` + `variants.price`, el cron diario de surtido completo re-procesa los 450 SKUs aunque la mayoría no haya cambiado.

Sin mecanismo de skip:

- ~30 min de runner GHA por cron diario, incluso si solo cambiaron 5 SKUs.
- Cuota GraphQL consumida en operaciones sin valor.
- Logs masivos en cada run para diferencias mínimas — ruido que oculta los cambios reales.

## Decisión

Implementar un **cache de fingerprint por SKU** que permita al writer saltarse productos cuyo desired-state no ha cambiado desde el run anterior.

### Modelo

Tabla `private.sku_state`:

```sql
sku             text primary key       -- handle = sku.toLowerCase()
fingerprint     text not null          -- SHA-256 hex del payload determinista
last_run_id     uuid                   -- soft FK a private.import_runs
last_seen_at    timestamptz            -- updated en cada run
last_published  boolean                -- estado publicado en el shop
```

Migración: [`20260507140000_sku_state.sql`](https://github.com/danielpenamad/shopify-ledsc4-theme/blob/main/supabase/migrations/20260507140000_sku_state.sql).

### Fingerprint

Hash SHA-256 hex del payload determinista que el mapper produciría para Shopify:

- `productInput` (title, body_html, vendor, tags, options).
- `metafieldsInput` (todos los campos del CSV mapeados a metafields).
- `imageInput` (lista de URLs ordenada, las que apliquen).
- `translationsInput` (los 5 locales × campos traducibles).
- Target de publicación (publication GID del catalog).

La función de fingerprint es **determinista** sobre la entrada: el mismo SKU con los mismos valores en los 8 CSVs produce el mismo hash en cualquier máquina, sin necesidad de consultar Shopify.

### Flujo del writer con skip activo (Fase B prep)

Por cada SKU del surtido:

1. Calcular fingerprint del desired-state desde los CSVs + mapping.
2. Consultar `private.sku_state` por `sku`.
3. Si `row.fingerprint === fresh_fingerprint`: **skip** — saltar `productSet` + `translationsRegister` + `publishablePublish`. Actualizar `last_seen_at` y `last_run_id`.
4. Si difieren o no hay row: ejecutar el path normal del writer y persistir `(sku, fingerprint, last_run_id, last_seen_at, last_published)`.

### Uso actual de la tabla (sin skip todavía)

Hoy el writer **escribe la tabla pero no lee el fingerprint para skip**:

- En cada SKU procesado, persiste `(sku, fingerprint, last_run_id, last_seen_at, last_published=true)`.
- El campo `last_published` sí se consume en la fase **I3.6 unpublish orphans** ([02-importer](../02-importer.md)): SKUs con `last_published=true` que en el run actual no aparecen entre publishables se despublican (`productUpdate(status: DRAFT)`).
- El campo `fingerprint` está poblado pero ningún path lo lee. El skip se activará en una fase B futura.

## Alternativas consideradas

**No-cache, ejecutar `productSet` always** (situación actual sin la fase B). Idempotente sobre Shopify pero costoso: 30 min de runner GHA + cuota GraphQL completa por cada cron diario. Aceptable en Fase I para validar end-to-end, no escalable a producción continua.

**Cache en memoria** (estado del run anterior pasado vía artefacto GHA). Descartada:
- Frágil (un fallo de upload del artefacto pierde la caché).
- No sobrevive a runs paralelos o re-disparos manuales.
- Una tabla en Postgres es trivial de mantener y consultar.

**Cache basada en Shopify `updatedAt`** (consultar el producto en Shopify, comparar `updatedAt` con el último run). Descartada:
- Implica un `productByHandle` por SKU antes de decidir skip — añade ~450 consultas extra al run, parte de la cuota que intentamos ahorrar.
- `updatedAt` cambia por ediciones manuales del staff en Admin, lo cual generaría skip espurios. La fuente de verdad debe ser **nuestro** estado, no el de Shopify.

**Hash de los CSVs completos** (no granular por SKU). Descartada:
- Un cambio en cualquier SKU obliga a procesar los 450. No aporta granularidad.
- Los CSVs cambian incluso cuando ningún SKU cambia (timestamps de export, orden de filas) — produciría fingerprints distintos sin cambios reales.

## Consecuencias

- **Tabla creada y poblada hoy**. El writer escribe en `sku_state` en cada run con `dbConnection` activa. Visible vía Supabase SQL Editor o `psql` con `SUPABASE_DB_URL`.
- **Skip por fingerprint pendiente**. La función `computeFingerprint(payload)` y el path de skip son trabajo de Fase B. Una vez implementados, el cron diario debería bajar a tiempos del orden de "10s × SKUs cambiados".
- **`last_published` ya consumido** por la fase I3.6 unpublish orphans. Borrar la tabla rompería ese flujo — los SKUs que salgan del surtido no se despublicarían sin la pista del estado anterior.
- **Soft FK a `import_runs`**. `last_run_id` no es FOREIGN KEY enforced — runs antiguos pueden ser garbage-collected sin romper `sku_state`. El writer en GHA también opera sin un `import_runs` context cuando es invocado con `workflow_dispatch` manual sin `run_id` (no es el caso del cron, pero existe ergonómicamente).
- **Service-role only**. RLS off, `revoke all from anon, authenticated`. Mismo patrón que `private.import_runs` y `private.image_cache`. Documentado en [11-supabase](../11-supabase.md) §schemas.
- **El fingerprint debe ser estable bajo cambios irrelevantes**. La función de hash tiene que ordenar listas, normalizar nulls, no incluir timestamps. Un cambio cosmético del mapper (ej. ordenar metafields alfabéticamente vs por orden de mapping.json) invalidaría toda la caché. Cualquier cambio futuro de la lógica de fingerprint debe acompañarse de un reset de la tabla (`TRUNCATE private.sku_state`) en la migración o en el deploy.
- **No hay política de eviction**. La tabla crece linealmente con SKUs únicos vistos a lo largo de la vida del proyecto. Volumen actual: ~450 SKUs publishables + N históricos que salieron de surtido = bajo. Si en el futuro el catálogo escala a miles, evaluar cleanup de rows con `last_seen_at` > 90 días.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
