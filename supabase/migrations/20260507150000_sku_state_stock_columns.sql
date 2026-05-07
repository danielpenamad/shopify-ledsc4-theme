-- Add stock-only columns to private.sku_state (Fase A — PR-Y stock_only).
--
-- Decision (option 2.a from the PR-Y spec): keep one row per SKU but track
-- two independent fingerprints — one for full runs (existing `fingerprint`
-- column, covers product/translations/publish state) and one for
-- stock-only runs (`fingerprint_stock`, covers just inventory at location).
-- Fase B will compare each independently.
--
-- runStockOnly does UPDATE-only (not insert). If a SKU has never been
-- through a full run, the row doesn't exist yet and stock-only logs a
-- warning + skips the upsert. The next full run will create the row.
-- Rationale: avoids needing to drop NOT NULL on `fingerprint` and
-- `last_published` (which would loosen invariants for the full-run path
-- that doesn't need loosening).

alter table private.sku_state
  add column fingerprint_stock text,
  add column stock_last_seen_at timestamptz;

comment on column private.sku_state.fingerprint_stock is
  'Hex SHA-256 of {sku, locationId, quantity}. Updated by runStockOnly.';
comment on column private.sku_state.stock_last_seen_at is
  'When runStockOnly last touched this row. Independent of last_seen_at (which tracks full runs).';
