-- Add counts + report_storage_prefix to private.import_runs (Fase A — PR-A1).
--
-- Context: GitHub Actions workflow `ledsc4-import.yml` runs the writer
-- (runFullImport / runStockOnly) end-to-end against a row already left in
-- 'downloaded' state by sftp-sync. On close, the workflow persists the
-- writer's counts object and the Storage prefix where reports were uploaded.
--
-- counts:
--   jsonb mirroring the shape returned by runFullImport / runStockOnly
--   (see scripts/import-write.mjs). Different shape per kind, so the column
--   is loosely typed. NULL while the run is started/downloaded/processing.
--
-- report_storage_prefix:
--   text path inside the ledsc4-imports bucket where reports/* were uploaded
--   (e.g. 'runs/<uuid>/reports/'). Persisted so consumers (Fase B Edge
--   Function, debugging tools, dashboards) don't have to reconstruct the
--   convention. NULL until the workflow finishes uploading.
--
-- Both columns are additive and nullable — existing rows stay valid.
-- `add column if not exists` keeps the migration idempotent against
-- environments that may have run a partial earlier draft.

alter table private.import_runs
  add column if not exists counts jsonb,
  add column if not exists report_storage_prefix text;

comment on column private.import_runs.counts is
  'Writer counts object (full or stock_only shape). Set on workflow close. Null while in-flight.';
comment on column private.import_runs.report_storage_prefix is
  'Path inside ledsc4-imports bucket where the workflow uploaded reports/ (e.g. runs/<uuid>/reports/). Null until upload step completes.';
