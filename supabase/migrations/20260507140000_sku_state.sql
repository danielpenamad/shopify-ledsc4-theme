-- private.sku_state — fingerprint cache for incremental imports (Fase B prep).
--
-- Each row records the last successful state we wrote to Shopify for a SKU,
-- including a deterministic hash of the desired-state payload (productSet
-- input + translations + publish target). Fase B will compare this against
-- a freshly-computed fingerprint to skip SKUs whose data hasn't changed.
--
-- Written by the writer (scripts/import-write.mjs) when invoked with a
-- dbConnection. Read by Fase B (future) to compute the diff. RLS off,
-- service-role only — same pattern as private.import_runs.

create table private.sku_state (
  -- Stable across imports (handle = sku.toLowerCase()).
  sku text primary key,
  -- Hex-encoded SHA-256 of the deterministic payload digest.
  fingerprint text not null,
  -- Soft FK to private.import_runs (not enforced — runs may be GC'd, or
  -- the writer may run from GHA without an import_runs context).
  last_run_id uuid,
  -- When this row was last written. Updated on every successful run.
  last_seen_at timestamptz not null default now(),
  -- Whether the SKU was last published to "Tienda online". Always true today
  -- (the writer only processes publishables); reserved for future unpublish.
  last_published boolean not null
);

create index idx_sku_state_last_seen on private.sku_state (last_seen_at);

revoke all on private.sku_state from anon, authenticated;

comment on table private.sku_state is
  'Fingerprint cache per SKU for incremental imports. Service-role only.';
