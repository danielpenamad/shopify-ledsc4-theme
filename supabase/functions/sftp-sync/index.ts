// Supabase Edge Function: sftp-sync (Fase I4.1 + PR-A2 chain)
//
// Job 1 of the I4 import pipeline. Downloads CSVs from the LedsC4 SFTP into
// Supabase Storage, tracks the run in private.import_runs, and (PR-A2)
// triggers Job 2 (`ledsc4-import.yml` GitHub Actions workflow) via
// `repository_dispatch` once the row reaches status='downloaded'.
//
// DB access pattern:
//   - import_runs lives in the `private` schema, NOT exposed via PostgREST.
//     The supabase-js client is bound to PostgREST and can't reach `private`
//     without listing it as an exposed schema (which would defeat the
//     hide-from-anon goal).
//   - So for import_runs we connect directly to Postgres via `npm:postgres`
//     (same path pg_cron uses internally — no PostgREST involvement).
//     `SUPABASE_DB_URL` is auto-injected by the Edge Runtime with creds
//     equivalent to a postgres-role connection.
//   - For Storage we still use supabase-js (the Storage API path is fine,
//     it's not gated by db-schemas).
//
// Workflow per invocation:
//   1. Parse payload { kind: "full" | "stock_only" }, default "full".
//   2. Insert import_runs row, status="started", storage_prefix=runs/<id>/.
//   3. Connect SFTP with byte-by-byte hostVerifier (validated by sftp-probe).
//   4. List the 3 subdirs (productos/stock/precios) or just stock per `kind`.
//   5. For each .csv: download to in-memory Buffer → upload to Storage.
//      Reject zero-byte files; one failure aborts the entire run.
//      (We buffer in memory rather than writing to /tmp because the
//      Edge Runtime blocklists Deno.lstatSync that ssh2-sftp-client's
//      fastGet depends on. Files are 3-7 MB so memory pressure is fine.)
//   6. Update import_runs row: status="downloaded", downloaded_at, files=[...].
//   7. POST a `repository_dispatch` (event_type=ledsc4-import,
//      client_payload={run_id}) to GitHub. Best-effort: failure here is
//      logged + reported in the response but does NOT mark the row failed
//      — the download is committed, and `workflow_dispatch` (PR-A1) is
//      the manual fallback for the same run_id.
//   8. Return JSON with run_id + counts + elapsed + dispatch_status.
//
// Auth: verify_jwt = true. Service role key not required from caller; we use
// the in-runtime SUPABASE_SERVICE_ROLE_KEY for DB + Storage writes.

// @ts-nocheck — Deno + npm: compat doesn't ship full TS types here.
import SftpClient from 'npm:ssh2-sftp-client@10.0.3';
import { Buffer } from 'node:buffer';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import postgres from 'npm:postgres@3.4.4';

const REQUIRED_SECRETS = [
  'LEDSC4_SFTP_HOST',
  'LEDSC4_SFTP_PORT',
  'LEDSC4_SFTP_USER',
  'LEDSC4_SFTP_PASSWORD',
  'LEDSC4_SFTP_BASE_PATH',
  'LEDSC4_SFTP_HOST_KEY',
] as const;

const CONNECT_TIMEOUT_MS = 10_000;
// ssh2-sftp-client doesn't expose a per-fastGet timeout natively; we wrap each
// download in a Promise.race against a manual deadline.
const DOWNLOAD_TIMEOUT_MS = 30_000;

const STORAGE_BUCKET = 'ledsc4-imports';

// PR-A2: GitHub repository_dispatch target. Hardcoded — if Phase 2 needs
// multi-environment (sandbox vs client org), parametrize then. The token
// is fine-grained PAT scoped to this exact repo (see docs/secrets.md §1
// `GITHUB_DISPATCH_TOKEN`).
const GITHUB_DISPATCHES_URL =
  'https://api.github.com/repos/danielpenamad/shopify-ledsc4-theme/dispatches';
const GITHUB_DISPATCH_EVENT_TYPE = 'ledsc4-import';
const DISPATCH_TIMEOUT_MS = 10_000;

// Subdirectories on the SFTP that we mirror into Storage. Order matters
// only for log readability.
const SUBDIRS_BY_KIND: Record<'full' | 'stock_only', readonly string[]> = {
  full: ['productos', 'stock', 'precios'],
  stock_only: ['stock'],
};

type FileRecord = {
  name: string;
  path_in_storage: string;
  size_bytes: number;
  sftp_mtime: number;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Parse "host <type> <base64>" → Buffer of the wire-format public key.
function parseKnownHostsLine(line: string): Buffer {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(
      `LEDSC4_SFTP_HOST_KEY does not look like a known_hosts line ` +
        `(expected "host type base64", got ${parts.length} fields)`,
    );
  }
  const key = Buffer.from(parts[2], 'base64');
  if (key.length === 0) throw new Error('LEDSC4_SFTP_HOST_KEY base64 blob is empty');
  return key;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// PR-A2: best-effort POST to GitHub's repository_dispatch endpoint. Returns
// `{ ok: true }` only on HTTP 204 (the documented success status); anything
// else (4xx/5xx, timeout, network error) is reported as `{ ok: false, error }`
// for the caller to log. Does not throw.
async function triggerWorkflow(
  runId: string,
  token: string,
): Promise<{ ok: boolean; error: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(GITHUB_DISPATCHES_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ledsc4-sftp-sync',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: GITHUB_DISPATCH_EVENT_TYPE,
        client_payload: { run_id: runId },
      }),
    });
    if (res.status === 204) return { ok: true, error: null };
    const body = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();

  // Lazy-init: build the result object incrementally so we always return
  // something consistent even if we bail mid-flow.
  const result: Record<string, unknown> = {
    status: 'error',
    run_id: null as string | null,
    kind: null as string | null,
    files_count: 0,
    elapsed_ms: 0,
    error_stage: null as string | null,
    error_message: null as string | null,
    // PR-A2: dispatch outcome. null until the dispatch step runs; 'ok' on
    // HTTP 204 from GitHub; 'failed' otherwise (with reason in dispatch_error).
    dispatch_status: null as string | null,
    dispatch_error: null as string | null,
  };

  // 1. Parse payload.
  let kind: 'full' | 'stock_only' = 'full';
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === 'object' && 'kind' in body) {
      const k = (body as Record<string, unknown>).kind;
      if (k === 'full' || k === 'stock_only') kind = k;
      else if (k != null) {
        result.error_stage = 'invalid_payload';
        result.error_message = `kind must be 'full' or 'stock_only', got ${JSON.stringify(k)}`;
        result.elapsed_ms = Date.now() - t0;
        return jsonResponse(result, 400);
      }
    }
  } catch (_e) {
    // Empty body is fine — defaults apply.
  }
  result.kind = kind;

  // 2. Load secrets. Names only on missing; never values.
  const missing: string[] = [];
  const secrets: Record<string, string> = {};
  for (const name of REQUIRED_SECRETS) {
    const v = Deno.env.get(name);
    if (!v) missing.push(name);
    else secrets[name] = v;
  }
  if (missing.length > 0) {
    result.error_stage = 'secret_load';
    result.error_message = `Missing secrets: ${missing.join(', ')}`;
    result.elapsed_ms = Date.now() - t0;
    return jsonResponse(result, 500);
  }

  // PR-A2: GITHUB_DISPATCH_TOKEN is a hard config requirement at startup —
  // missing it means the chain to Job 2 is broken and we'd silently leave
  // every run in 'downloaded'. Fail loud BEFORE any side effects (DB insert,
  // SFTP connect, Storage upload). Cron jobs without this secret should
  // never partially execute.
  const GITHUB_DISPATCH_TOKEN = Deno.env.get('GITHUB_DISPATCH_TOKEN');
  if (!GITHUB_DISPATCH_TOKEN) {
    result.error_stage = 'secret_load';
    result.error_message = 'GITHUB_DISPATCH_TOKEN not configured';
    result.elapsed_ms = Date.now() - t0;
    return jsonResponse(result, 500);
  }

  // Supabase admin client — used for STORAGE only (Storage API isn't gated
  // by db-schemas). DB writes to private.import_runs go via direct postgres
  // connection below.
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const DB_URL = Deno.env.get('SUPABASE_DB_URL');
  if (!SUPABASE_URL || !SERVICE_ROLE || !DB_URL) {
    result.error_stage = 'secret_load';
    const missingEnv: string[] = [];
    if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
    if (!SERVICE_ROLE) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!DB_URL) missingEnv.push('SUPABASE_DB_URL');
    result.error_message = `Missing auto-injected env vars: ${missingEnv.join(', ')}`;
    result.elapsed_ms = Date.now() - t0;
    return jsonResponse(result, 500);
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Postgres direct client. Single short-lived connection; we close it in
  // finally. The Edge Runtime's pooler serializes well for this.
  const sql = postgres(DB_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });

  // 3. Insert import_runs row, status='started'.
  let runId: string;
  try {
    const rows = await sql<{ id: string }[]>`
      insert into private.import_runs (kind, status)
      values (${kind}, 'started')
      returning id
    `;
    if (!rows[0]?.id) throw new Error('insert returned no row');
    runId = rows[0].id;
  } catch (err) {
    result.error_stage = 'db_insert';
    result.error_message = (err as Error).message;
    result.elapsed_ms = Date.now() - t0;
    try { await sql.end(); } catch (_e) { /* ignore */ }
    return jsonResponse(result, 500);
  }
  const storagePrefix = `runs/${runId}/`;
  result.run_id = runId;

  // Patch the row with its storage_prefix immediately so it's visible even
  // if subsequent steps fail.
  await sql`
    update private.import_runs
    set storage_prefix = ${storagePrefix}
    where id = ${runId}
  `;

  // Helper to mark a run as failed and return 502.
  const failRun = async (stage: string, message: string, extraFiles?: FileRecord[]) => {
    result.error_stage = stage;
    result.error_message = message;
    result.elapsed_ms = Date.now() - t0;
    if (extraFiles) result.files_count = extraFiles.length;
    try {
      await sql`
        update private.import_runs
        set status = 'failed',
            failed_at = now(),
            error_stage = ${stage},
            error_message = ${message},
            files = ${extraFiles ? sql.json(extraFiles as any) : null}
        where id = ${runId}
      `;
    } catch (_e) { /* db unreachable; surface only via response */ }
    return jsonResponse(result, 502);
  };

  // 4. Parse host key.
  let expectedHostKey: Buffer;
  try {
    expectedHostKey = parseKnownHostsLine(secrets.LEDSC4_SFTP_HOST_KEY);
  } catch (err) {
    return await failRun('host_key', `Failed to parse LEDSC4_SFTP_HOST_KEY: ${(err as Error).message}`);
  }

  // 5. Connect SFTP + download + upload loop.
  const sftp = new SftpClient(`sftp-sync-${runId}`);
  const downloaded: FileRecord[] = [];
  const nonCsvFlags: string[] = [];

  // Note: Supabase Edge Runtime blocklists Deno.lstatSync and several other
  // sync fs APIs that ssh2-sftp-client's `fastGet` depends on. We use
  // `get(remotePath)` instead, which returns the file contents as a Buffer
  // in memory. For our 3-7 MB CSVs this is fine; if files grow past
  // ~50 MB we should switch to a streaming approach.

  try {
    let hostKeyMatched = false;
    try {
      await sftp.connect({
        host: secrets.LEDSC4_SFTP_HOST,
        port: Number(secrets.LEDSC4_SFTP_PORT),
        username: secrets.LEDSC4_SFTP_USER,
        password: secrets.LEDSC4_SFTP_PASSWORD,
        readyTimeout: CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => {
          const match = key.length === expectedHostKey.length && key.equals(expectedHostKey);
          hostKeyMatched = match;
          return match;
        },
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const stage = !hostKeyMatched && /host\s*key|verification/i.test(msg)
        ? 'host_key'
        : /auth|password|permission/i.test(msg)
        ? 'auth'
        : 'sftp_connect';
      return await failRun(stage, msg);
    }

    // 6. List + filter per subdir.
    const basePath = secrets.LEDSC4_SFTP_BASE_PATH.replace(/\/+$/, '');
    for (const subdir of SUBDIRS_BY_KIND[kind]) {
      let entries;
      try {
        entries = await sftp.list(`${basePath}/${subdir}`);
      } catch (err) {
        return await failRun('sftp_list', `list(${subdir}): ${(err as Error).message}`, downloaded);
      }
      for (const e of entries) {
        if (e.type === 'd') {
          // Unexpected subdirectory — flag but skip (don't recurse).
          nonCsvFlags.push(`${subdir}/${e.name} (subdirectory, skipped)`);
          continue;
        }
        if (!e.name.toLowerCase().endsWith('.csv')) {
          nonCsvFlags.push(`${subdir}/${e.name} (non-csv, skipped)`);
          continue;
        }

        // 7. Download → upload loop. Buffer in memory (no /tmp).
        const remotePath = `${basePath}/${subdir}/${e.name}`;
        let fileBuf: Buffer;
        try {
          // sftp.get(remotePath) returns a Buffer when no destination given.
          fileBuf = await withTimeout(
            sftp.get(remotePath) as Promise<Buffer>,
            DOWNLOAD_TIMEOUT_MS,
            `download ${subdir}/${e.name}`,
          );
        } catch (err) {
          return await failRun('sftp_download', `${subdir}/${e.name}: ${(err as Error).message}`, downloaded);
        }

        // Validate non-empty.
        if (!fileBuf || fileBuf.length <= 0) {
          return await failRun(
            'sftp_download',
            `${subdir}/${e.name}: zero-byte file (likely corrupt or partial transfer)`,
            downloaded,
          );
        }

        // Upload to Storage.
        const storagePath = `${storagePrefix}${subdir}/${e.name}`;
        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, fileBuf, {
            contentType: 'text/csv',
            upsert: false, // each run has a unique prefix; collisions = bug
          });
        if (upErr) {
          return await failRun('storage_upload', `${storagePath}: ${upErr.message}`, downloaded);
        }

        downloaded.push({
          name: e.name,
          path_in_storage: storagePath,
          size_bytes: fileBuf.length,
          sftp_mtime: e.modifyTime, // ms epoch from ssh2
        });
      }
    }

    // 8. Mark run as downloaded.
    const flagsNote = nonCsvFlags.length > 0
      ? `flagged_unexpected_entries: ${nonCsvFlags.join('; ')}`
      : null;
    try {
      await sql`
        update private.import_runs
        set status = 'downloaded',
            downloaded_at = now(),
            files = ${sql.json(downloaded as any)},
            error_message = ${flagsNote}
        where id = ${runId}
      `;
    } catch (err) {
      return await failRun('db_update', (err as Error).message, downloaded);
    }

    // 9. PR-A2: trigger Job 2 via GitHub repository_dispatch. Best-effort —
    // a failure here does NOT roll back the row (the download is genuinely
    // done) and does NOT mark it failed (manual workflow_dispatch with the
    // same run_id is the documented fallback). Caller sees dispatch_status
    // in the response and Supabase Logs has the full error via console.error.
    const dispatch = await triggerWorkflow(runId, GITHUB_DISPATCH_TOKEN);
    result.dispatch_status = dispatch.ok ? 'ok' : 'failed';
    result.dispatch_error = dispatch.error;
    if (!dispatch.ok) {
      console.error(`[dispatch] failed for run_id=${runId}: ${dispatch.error}`);
    }

    result.status = 'ok';
    result.files_count = downloaded.length;
    if (flagsNote) result.error_message = flagsNote; // informational, not a failure
  } finally {
    // Always close SFTP and Postgres. No /tmp cleanup — we buffer in memory.
    try { await sftp.end(); } catch (_e) { /* ignore */ }
    try { await sql.end(); } catch (_e) { /* ignore */ }
    result.elapsed_ms = Date.now() - t0;
  }

  return jsonResponse(result, 200);
});
