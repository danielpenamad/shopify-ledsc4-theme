-- private.image_cache — sha256 → Shopify file_id cache for the image
-- pre-upload pipeline (PR-IMG-1).
--
-- Why pre-upload exists: the customer's CDN (files.ledsc4.com) rate-limits
-- Shopify's media-fetcher under bulk load, leaving ~half the catalog with
-- FAILED MediaImage nodes. Diagnosis confirmed URLs are valid (96% of
-- politely-paced HEAD requests return 200). Fix: download binary from CDN
-- ourselves at controlled rate, upload to Shopify Files, reference the
-- resulting File id in productSet.input.files[].id.
--
-- Why hash-based: dedupe by binary identity, not by SKU. Two SKUs with the
-- same image share one Shopify File. Cache survives SKU descatalogación.
--
-- Lifecycle:
--   - Written by the importer's pre-upload helper after successful
--     fileCreate + status=READY.
--   - Read on every image resolution; on hit, helper returns the cached
--     file_id without re-downloading from the CDN.
--   - last_used_at refreshed on every cache hit (informative; no eviction
--     policy yet — at 455 SKUs × 6 imgs the table stays small).
--
-- Service-role only, same pattern as private.import_runs / private.sku_state.

create table private.image_cache (
  -- Hex-encoded SHA-256 of the binary fetched from the CDN.
  sha256 text primary key,
  -- Shopify File GID (gid://shopify/MediaImage/...). Reusable across
  -- products via FileSetInput.id in productSet.
  shopify_file_id text not null,
  -- Detected from Content-Type header at fetch time, fallback to magic-byte
  -- sniff. Used to round-trip the file_id back to filename/extension when
  -- the writer needs them.
  mime_type text not null,
  byte_size bigint not null,
  -- Last CDN URL that produced this hash. Informative only — the same
  -- binary can live at multiple paths on the customer's CDN.
  source_url text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index idx_image_cache_last_used on private.image_cache (last_used_at);

revoke all on private.image_cache from anon, authenticated;

comment on table private.image_cache is
  'sha256 → Shopify file_id cache for the image pre-upload pipeline. Service-role only.';
