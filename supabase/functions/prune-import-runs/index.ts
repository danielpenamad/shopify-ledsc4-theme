// Supabase Edge Function: prune-import-runs
//
// Retention job for the `ledsc4-imports` Storage bucket. Every sftp-sync
// invocation archives the SFTP CSVs (productos/stock/precios) plus the
// writer's reports (run.log, changes.csv, fingerprints.json, orphans.csv)
// under `runs/<run_id>/` — see supabase/functions/sftp-sync/index.ts and
// .github/workflows/ledsc4-import.yml. Nothing in the pipeline reads a run
// once it's done (sku_state / image_cache in Postgres carry all the
// incremental state — see CLAUDE.md "Importación nocturna"), so old run
// folders are pure accumulation. At 5 runs/day (4 stock_only + 1 full) this
// blew past the free-tier 1 GB Storage quota within ~4 months.
//
// This function deletes run folders whose `private.import_runs.started_at`
// is older than RETENTION_DAYS, using the Storage API (`storage.remove`) —
// never `DELETE FROM storage.objects` by SQL, which deletes only the catalog
// row and leaves the physical object orphaned in the bucket. It never writes
// to `private.import_runs` (that table is history, not ours to touch) and
// never deletes the single most-recent run, even if somehow older than the
// retention window (e.g. the pipeline paused for a while) — there should
// always be at least one run's raw CSVs available for manual inspection.
//
// Source of truth for "which runs exist and how old they are" is
// `private.import_runs`, not a top-level `storage.list('runs')` scan: the
// DB row is written before any file lands in Storage (see sftp-sync step 3),
// so it's authoritative and gives us `started_at` for free without needing
// to paginate over ~700+ pseudo-folders. A storage folder with no matching
// import_runs row (only possible if a row was deleted by hand — nothing in
// this codebase does that) would not be found by this job; that's an
// accepted gap, not a bug.
//
// Runs bounded per invocation (`max_runs`, default 50): the daily cron only
// ever has a handful of runs crossing the retention threshold, but the
// one-off historical backfill has ~600. Bounding keeps each invocation well
// within Edge Function time limits; the caller (cron or operator) re-invokes
// until `remaining_eligible` is 0. Eligible = older than retention AND still
// holding objects in Storage (read-only check on storage.objects), so pruned
// runs drop out of the count and the backlog converges.
//
// Payload (all optional):
//   {
//     "retention_days": 14,   // default 14 (RETENTION_DAYS)
//     "dry_run": false,       // true = compute + report, delete nothing
//     "max_runs": 50          // runs processed this invocation, 1-250
//   }
//
// Auth: verify_jwt = true (same pattern as sftp-sync / csv-grep) — only
// invocable by pg_cron (with_auth=true) or manually with anon/service key.

// @ts-nocheck — Deno + npm: compat doesn't ship full TS types here.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import postgres from 'npm:postgres@3.4.4';

const STORAGE_BUCKET = 'ledsc4-imports';
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_RUNS = 50;
const MAX_RUNS_HARD_CAP = 250;
const REMOVE_BATCH_SIZE = 100;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type StorageFile = { path: string; size: number };

// Recursively lists every real file under `folderPath` (no trailing slash).
// Storage `.list()` only returns one level; pseudo-folders come back with
// `id: null`, so we recurse into those. Runs are flat (runs/<id>/<subdir>/
// <file>.csv) so this only ever goes two levels deep in practice, but the
// recursion doesn't assume that shape.
async function listFilesRecursive(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  folderPath: string,
): Promise<StorageFile[]> {
  const { data, error } = await supabase.storage.from(bucket).list(folderPath, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw new Error(`list(${folderPath}) failed: ${error.message}`);

  const files: StorageFile[] = [];
  const subfolders: string[] = [];
  for (const entry of data ?? []) {
    const childPath = folderPath ? `${folderPath}/${entry.name}` : entry.name;
    if (entry.id === null) {
      subfolders.push(childPath);
    } else {
      files.push({ path: childPath, size: Number(entry.metadata?.size ?? 0) });
    }
  }
  // Sequential, not Promise.all: keeps concurrent Storage API calls bounded
  // (a run only has 4 subdirs, so this is cheap either way).
  for (const sub of subfolders) {
    files.push(...(await listFilesRecursive(supabase, bucket, sub)));
  }
  return files;
}

async function removeInBatches(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  paths: string[],
): Promise<{ removed: number; errors: string[] }> {
  let removed = 0;
  const errors: string[] = [];
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { data, error } = await supabase.storage.from(bucket).remove(batch);
    if (error) {
      errors.push(`batch [${i}-${i + batch.length}): ${error.message}`);
      continue;
    }
    removed += data?.length ?? batch.length;
  }
  return { removed, errors };
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();

  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    // Empty body is fine — defaults apply (matches sftp-sync/update-fx-rates
    // cron invocations, which POST no body).
  }

  const dryRun = payload.dry_run === true;

  let retentionDays = Number.isFinite(payload.retention_days)
    ? Number(payload.retention_days)
    : DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) retentionDays = DEFAULT_RETENTION_DAYS;

  let maxRuns = Number.isFinite(payload.max_runs) ? Number(payload.max_runs) : DEFAULT_MAX_RUNS;
  if (!Number.isInteger(maxRuns) || maxRuns < 1) maxRuns = DEFAULT_MAX_RUNS;
  if (maxRuns > MAX_RUNS_HARD_CAP) maxRuns = MAX_RUNS_HARD_CAP;

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const DB_URL = Deno.env.get('SUPABASE_DB_URL');
  if (!SUPABASE_URL || !SERVICE_ROLE || !DB_URL) {
    const missingEnv: string[] = [];
    if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
    if (!SERVICE_ROLE) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!DB_URL) missingEnv.push('SUPABASE_DB_URL');
    return jsonResponse(
      { status: 'error', error_stage: 'secret_load', error_message: `Missing auto-injected env vars: ${missingEnv.join(', ')}` },
      500,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });

  try {
    // `private.import_runs` is the source of truth for which runs exist and
    // their age (see module doc comment). The most-recent run is excluded
    // from both queries below — it is never eligible, regardless of age.
    // Only runs that still hold objects: without the `exists`, already-pruned
    // runs (import_runs rows are never deleted) would keep filling the first
    // `max_runs` slots and newer eligible runs would never be reached.
    const eligibleRows = await sql`
      select r.id, r.started_at, r.storage_prefix
      from private.import_runs r
      where r.started_at < now() - make_interval(days => ${retentionDays})
        and r.id <> (select id from private.import_runs order by started_at desc limit 1)
        and exists (
          select 1 from storage.objects o
          where o.bucket_id = ${STORAGE_BUCKET} and starts_with(o.name, r.storage_prefix)
        )
      order by r.started_at asc
      limit ${maxRuns}
    `;

    const [{ count: eligibleTotal }] = await sql`
      select count(*)::int as count
      from private.import_runs r
      where r.started_at < now() - make_interval(days => ${retentionDays})
        and r.id <> (select id from private.import_runs order by started_at desc limit 1)
        and exists (
          select 1 from storage.objects o
          where o.bucket_id = ${STORAGE_BUCKET} and starts_with(o.name, r.storage_prefix)
        )
    `;

    const protectedRow = await sql`
      select id, started_at from private.import_runs order by started_at desc limit 1
    `;

    const runResults: Record<string, unknown>[] = [];
    let filesDeletedTotal = 0;
    let bytesFreedTotal = 0;
    const runErrors: string[] = [];

    for (const run of eligibleRows) {
      if (!run.storage_prefix) {
        runErrors.push(`run ${run.id}: storage_prefix is null, skipped`);
        continue;
      }
      const folderPath = String(run.storage_prefix).replace(/\/+$/, '');
      let files: StorageFile[];
      try {
        files = await listFilesRecursive(supabase, STORAGE_BUCKET, folderPath);
      } catch (err) {
        runErrors.push(`run ${run.id}: ${(err as Error).message}`);
        continue;
      }

      const bytes = files.reduce((sum, f) => sum + f.size, 0);
      let removed = 0;
      if (!dryRun && files.length > 0) {
        const { removed: r, errors } = await removeInBatches(
          supabase,
          STORAGE_BUCKET,
          files.map((f) => f.path),
        );
        removed = r;
        if (errors.length > 0) runErrors.push(...errors.map((e) => `run ${run.id}: ${e}`));
      } else {
        removed = files.length; // dry_run: report what would be removed
      }

      filesDeletedTotal += removed;
      bytesFreedTotal += bytes;
      runResults.push({
        run_id: run.id,
        started_at: run.started_at,
        files: files.length,
        removed,
        mb: Math.round((bytes / 1024 / 1024) * 100) / 100,
      });
    }

    const mbFreedTotal = Math.round((bytesFreedTotal / 1024 / 1024) * 100) / 100;
    const summary = {
      status: 'ok',
      dry_run: dryRun,
      retention_days: retentionDays,
      protected_run_id: protectedRow[0]?.id ?? null,
      protected_run_started_at: protectedRow[0]?.started_at ?? null,
      eligible_total: eligibleTotal,
      runs_processed: runResults.length,
      remaining_eligible: dryRun ? eligibleTotal : Math.max(0, eligibleTotal - runResults.length),
      files_deleted: filesDeletedTotal,
      mb_freed: mbFreedTotal,
      run_errors: runErrors,
      runs: runResults,
      elapsed_ms: Date.now() - t0,
    };

    console.log(
      `[prune-import-runs] dry_run=${dryRun} retention_days=${retentionDays} ` +
        `runs_processed=${runResults.length}/${eligibleTotal} files_deleted=${filesDeletedTotal} ` +
        `mb_freed=${mbFreedTotal} remaining_eligible=${summary.remaining_eligible}` +
        (runErrors.length > 0 ? ` errors=${runErrors.length}` : ''),
    );

    return jsonResponse(summary, 200);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[prune-import-runs] fatal: ${message}`);
    return jsonResponse({ status: 'error', error_message: message, elapsed_ms: Date.now() - t0 }, 500);
  } finally {
    try {
      await sql.end();
    } catch (_e) {
      /* ignore */
    }
  }
});
