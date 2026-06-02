// Pre-upload helper for the LedsC4 importer (PR-IMG-1).
//
// Resolves a single CDN image URL to a Shopify File GID by:
//   1. Acquiring a token from the caller-supplied CDN bucket (serializes
//      fetches against files.ledsc4.com at the politeness rate proven by
//      the diagnostic — 1 req per ~1.5s leaves the CDN's rate-limiter
//      untouched).
//   2. Fetching the binary into memory + computing sha256.
//   3. Checking private.image_cache for a hit (sha256 → shopify_file_id);
//      if hit, returning that id without uploading.
//   4. Otherwise: stagedUploadsCreate → POST binary to staged target →
//      fileCreate(originalSource: resourceUrl) → poll fileStatus until
//      READY/FAILED/timeout → cache the resulting MediaImage GID.
//
// Why this exists: Shopify's image fetcher hammered the customer's CDN
// (files.ledsc4.com) under bulk load and got HTTP 429s, leaving 222/455
// products with FAILED MediaImage nodes. URLs are valid (96% return 200
// when paced); the rate-limit is the failure mode. By pre-uploading from
// our pipeline we control concurrency and the CDN never sees a burst.
//
// The returned file_id is intended for FileSetInput.id (productSet.input.files[].id),
// NOT FileSetInput.originalSource. Verified against Shopify schema 2025-10.
//
// Pure-ish: takes ctx (Shopify GraphQL), cdnBucket (rate limiter),
// dbConnection (pg.Client-like, optional — disables cache when null) and
// fetchImpl as injected dependencies. Never throws — returns
// { ok: true, fileId, ... } | { ok: false, kind, message, ... }.

import { createHash } from 'node:crypto';

// File polling: post-fileCreate, the Shopify File transitions
// UPLOADED → PROCESSING → READY (or FAILED). 15s ceiling matches PR-IMG-2's
// post-productSet polling — same "if it's not ready by now, log and move on"
// posture. Tunable via opts.pollMaxMs.
const DEFAULT_POLL_MS = 1000;
const DEFAULT_POLL_MAX_MS = 15_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'LedsC4-Importer/1.0';

// MIME map for staged upload + filename extension. Anything not listed
// returns 'fetch_failed' with kind='unsupported_mime' rather than guessing.
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Magic-byte sniff for cases where the CDN omits Content-Type or sets it
// to a generic value. Returns null if no signature matches — caller falls
// back to Content-Type or fails.
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // GIF: 47 49 46 38 (GIF8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WebP: RIFF .... WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'image/webp';
  return null;
}

// Normalize a Content-Type header value to a base MIME (strip ;charset=...).
function normalizeMime(headerValue) {
  if (!headerValue) return null;
  const semi = headerValue.indexOf(';');
  const base = (semi >= 0 ? headerValue.slice(0, semi) : headerValue).trim().toLowerCase();
  return base || null;
}

// Derive a deterministic filename for the staged upload from the hash.
// The filename Shopify stores is independent of the URL/SKU — what
// matters for product-level dedupe (productSet's REPLACE mode) is the
// filename used in productSet.files[], NOT here. Keep this informative:
// the first 16 hex chars of sha256 + extension.
export function makeStagedFilename(sha256Hex, mimeType) {
  const ext = MIME_TO_EXT[mimeType] ?? 'bin';
  return `${sha256Hex.slice(0, 16)}.${ext}`;
}

// --- GraphQL queries / mutations ----------------------------------------

const STAGED_UPLOADS_CREATE = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
        ... on MediaImage {
          status
          mediaErrors { code details message }
        }
      }
      userErrors { field message code }
    }
  }
`;

const FILE_NODE_QUERY = `
  query FileNode($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        status
        mediaErrors { code details message }
      }
      ... on GenericFile {
        id
        fileStatus
      }
    }
  }
`;

// --- Internal: single-step helpers --------------------------------------

async function fetchBinary({ url, fetchImpl, timeoutMs, userAgent }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': userAgent, Accept: 'image/*,*/*;q=0.5' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // httpStatus exposed structurally (PR-IMG-3): callers must NOT parse the
      // message string to branch on the status code (e.g. 404 → expected
      // absence of a derived slot). The message stays human-readable only.
      return { ok: false, kind: 'fetch_failed', message: `HTTP ${res.status} ${res.statusText}`, httpStatus: res.status };
    }
    const headerMime = normalizeMime(res.headers.get('content-type'));
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    return { ok: true, buf, headerMime };
  } catch (err) {
    const kind = err?.name === 'AbortError' ? 'fetch_timeout' : 'fetch_failed';
    return { ok: false, kind, message: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

async function cacheLookup(dbConnection, sha256) {
  if (!dbConnection) return null;
  try {
    const r = await dbConnection.query(
      `update private.image_cache
          set last_used_at = now()
        where sha256 = $1
        returning shopify_file_id, mime_type`,
      [sha256],
    );
    if (r.rowCount === 0) return null;
    return { shopify_file_id: r.rows[0].shopify_file_id, mime_type: r.rows[0].mime_type };
  } catch {
    // DB hiccup: behave like a miss. Caller will upload and try again to
    // write the cache row; if THAT fails we just lose the cache benefit
    // for this binary.
    return null;
  }
}

// Pre-fetch lookup por URL. Si una URL ya produjo un File en Shopify la
// devolvemos sin tocar el CDN — short-circuit del cuello de botella del full
// run (1 GET / 3s × ~2700 imágenes = ~80 min solo en descargas).
//
// Asunción de URL inmutable documentada en la migración
// 20260602120000_image_cache_source_url_index.sql.
//
// Si una URL aparece con varios sha256 (rehasheo manual fuera de flujo),
// devolvemos el más recientemente usado — coincide con el comportamiento
// que tendría un GET normal sobre el CDN tras invalidación.
async function cacheLookupByUrl(dbConnection, url) {
  if (!dbConnection || !url) return null;
  try {
    const r = await dbConnection.query(
      `update private.image_cache
          set last_used_at = now()
        where sha256 = (
          select sha256
            from private.image_cache
           where source_url = $1
           order by last_used_at desc
           limit 1
        )
        returning sha256, shopify_file_id, mime_type, byte_size`,
      [url],
    );
    if (r.rowCount === 0) return null;
    return {
      sha256: r.rows[0].sha256,
      shopify_file_id: r.rows[0].shopify_file_id,
      mime_type: r.rows[0].mime_type,
      byte_size: Number(r.rows[0].byte_size),
    };
  } catch {
    return null;
  }
}

async function cacheInsert(dbConnection, row) {
  if (!dbConnection) return { ok: true, conflict: false };
  try {
    // ON CONFLICT handles the rare race where two concurrent callers
    // hashed the same binary, both missed the cache, both uploaded.
    // The first INSERT wins; the second is a no-op that returns the
    // already-cached file id so the caller can drop its duplicate File
    // (or just leave it — Shopify Files isn't quota-constrained at our
    // scale and there's no orphan-cleanup policy yet).
    const r = await dbConnection.query(
      `insert into private.image_cache (sha256, shopify_file_id, mime_type, byte_size, source_url)
       values ($1, $2, $3, $4, $5)
       on conflict (sha256) do update
         set last_used_at = now()
       returning (xmax = 0) as inserted, shopify_file_id`,
      [row.sha256, row.shopify_file_id, row.mime_type, row.byte_size, row.source_url ?? null],
    );
    const inserted = r.rows[0]?.inserted === true;
    const winnerId = r.rows[0]?.shopify_file_id;
    return { ok: true, conflict: !inserted, winnerId };
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

// --- C: batch reconcile of cached file ids against Shopify ---------------
//
// Why: image_cache is write-once (cacheInsert never rewrites shopify_file_id,
// see ON CONFLICT above). When media is replaced/deleted Shopify-side out of
// band (manual admin, external re-import), the cached MediaImage GIDs go
// dead. cacheLookup does NO existence check, so productSet keeps receiving
// dead `files[].id` and Shopify rejects the whole atomic input — taking the
// variant price/inventory down with it. This pass runs once at the start of
// each full run: it verifies every cached GID via Shopify `nodes(ids:)` and
// DELETEs rows whose GID is null / not a MediaImage / not READY, so the next
// cacheLookup misses and resolveImageToShopifyFileId re-uploads from
// source_url (feed-wins, no manual-curation preservation by design).
//
// Fail-safe contract:
//   - dbConnection null  → no-op (cache disabled), { skipped:true }.
//   - A batch GraphQL call that throws is retried once split in half; if a
//     half still throws, that half's ids are left UNVERIFIED (counted in
//     `unverified`) and never deleted — ambiguity never causes a delete.
//   - Only ids confirmed dead in a successful response are deleted. The run
//     ALWAYS proceeds; reconcile failure degrades to today's behavior.
//
// Shopify `nodes` accepts up to 250 ids/call; default batch 250 → ~4 calls
// for ~959 rows, each paced through ctx.bucket like every other GraphQL call.

const RECONCILE_NODES_QUERY = `
  query ReconcileImageCache($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on MediaImage { id status }
    }
  }
`;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Verify one batch of ids. Returns { ok:true, dead:string[] } when the call
// succeeded, or { ok:false } when it threw (caller decides retry/skip).
async function verifyBatch(ctx, ids) {
  let data;
  try {
    data = await gqlCall(ctx, RECONCILE_NODES_QUERY, { ids });
  } catch {
    return { ok: false };
  }
  const nodes = data?.nodes ?? [];
  const dead = [];
  for (let i = 0; i < ids.length; i++) {
    const n = nodes[i];
    // Dead = absent node, wrong type, or a MediaImage not in READY state
    // (a FAILED/PROCESSING MediaImage in productSet.files errors too).
    if (!n || n.__typename !== 'MediaImage' || n.status !== 'READY') {
      dead.push(ids[i]);
    }
  }
  return { ok: true, dead };
}

/**
 * Batch-verify cached shopify_file_id GIDs and invalidate (DELETE) the dead
 * ones so they're re-uploaded on miss. Read-mostly + a single scoped DELETE.
 *
 * @param {object}   args
 * @param {object}   args.ctx           Shopify GraphQL ctx { endpoint, token, fetch, bucket? }.
 * @param {object}   args.dbConnection  pg.Client-like (.query). Null → no-op.
 * @param {(s:string)=>void} [args.onProgress]
 * @param {number}   [args.batchSize=250]
 * @returns {Promise<{ checked:number, dead:number, invalidated:number,
 *                      unverified:number, skipped:boolean, error:string|null,
 *                      deadRows:Array<{shopify_file_id:string,source_url:string|null}> }>}
 * Never throws.
 */
export async function reconcileImageCache({ ctx, dbConnection, onProgress = () => {}, batchSize = 250 }) {
  const result = {
    checked: 0, dead: 0, invalidated: 0, unverified: 0,
    skipped: false, error: null, deadRows: [],
  };
  if (!dbConnection) {
    result.skipped = true;
    return result;
  }

  // Snapshot id → source_url (for the report; one row per GID is enough).
  let rows;
  try {
    const r = await dbConnection.query(
      `select shopify_file_id, min(source_url) as source_url
         from private.image_cache
        where shopify_file_id is not null
        group by shopify_file_id`,
    );
    rows = r.rows ?? [];
  } catch (err) {
    result.error = `cache snapshot failed: ${String(err?.message ?? err)}`;
    onProgress(`[warn] image_cache reconcile skipped: ${result.error}`);
    return result;
  }

  result.checked = rows.length;
  if (rows.length === 0) return result;

  const urlById = new Map(rows.map((x) => [x.shopify_file_id, x.source_url ?? null]));
  const allIds = rows.map((x) => x.shopify_file_id);
  const deadIds = [];

  for (const batch of chunk(allIds, batchSize)) {
    let res = await verifyBatch(ctx, batch);
    if (!res.ok) {
      // Retry once, split in half, to dodge a transient/over-cost call.
      const halves = chunk(batch, Math.max(1, Math.ceil(batch.length / 2)));
      for (const half of halves) {
        const r2 = await verifyBatch(ctx, half);
        if (r2.ok) deadIds.push(...r2.dead);
        else result.unverified += half.length; // ambiguous → never delete
      }
      continue;
    }
    deadIds.push(...res.dead);
  }

  result.dead = deadIds.length;
  result.deadRows = deadIds.map((id) => ({ shopify_file_id: id, source_url: urlById.get(id) ?? null }));

  if (deadIds.length > 0) {
    try {
      const del = await dbConnection.query(
        `delete from private.image_cache where shopify_file_id = any($1::text[])`,
        [deadIds],
      );
      result.invalidated = del.rowCount ?? 0;
    } catch (err) {
      result.error = `delete failed: ${String(err?.message ?? err)}`;
      onProgress(`[warn] image_cache reconcile: dead GIDs found but DELETE failed: ${result.error}`);
      return result;
    }
  }

  onProgress(
    `image_cache reconcile: checked=${result.checked} dead=${result.dead} ` +
    `invalidated=${result.invalidated} unverified=${result.unverified}`,
  );
  return result;
}

async function gqlCall(ctx, query, variables) {
  if (ctx.bucket) await ctx.bucket.acquire(1);
  const res = await ctx.fetch(ctx.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ctx.token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function stagedUpload({ ctx, buf, mimeType, sha256, fetchImpl }) {
  const filename = makeStagedFilename(sha256, mimeType);
  const data = await gqlCall(ctx, STAGED_UPLOADS_CREATE, {
    input: [{ resource: 'IMAGE', filename, mimeType, httpMethod: 'POST' }],
  });
  const errs = data.stagedUploadsCreate.userErrors;
  if (errs.length > 0) {
    return { ok: false, kind: 'staged_upload_failed', message: errs.map((e) => e.message).join('; ') };
  }
  const target = data.stagedUploadsCreate.stagedTargets?.[0];
  if (!target) return { ok: false, kind: 'staged_upload_failed', message: 'no stagedTargets returned' };

  // POST binary as multipart/form-data. The order matters: Shopify's S3
  // backend wants the parameters first, then the file last (it streams
  // and stops reading once it has the file). FormData in Node 18+ does
  // the right thing — no manual boundary needed.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  // Convert Buffer → Blob for FormData. Node 18+ exposes Blob globally.
  form.append('file', new Blob([buf], { type: mimeType }), filename);

  const upRes = await fetchImpl(target.url, { method: 'POST', body: form });
  if (!upRes.ok) {
    const body = await upRes.text().catch(() => '');
    return { ok: false, kind: 'staged_upload_failed', message: `staged POST ${upRes.status}: ${body.slice(0, 200)}` };
  }
  return { ok: true, resourceUrl: target.resourceUrl, filename };
}

async function fileCreate({ ctx, resourceUrl, filename }) {
  const data = await gqlCall(ctx, FILE_CREATE, {
    files: [{
      originalSource: resourceUrl,
      contentType: 'IMAGE',
      filename,
    }],
  });
  const errs = data.fileCreate.userErrors;
  if (errs.length > 0) {
    return { ok: false, kind: 'file_create_failed', message: errs.map((e) => `[${e.code ?? ''}] ${e.message}`).join('; ') };
  }
  const file = data.fileCreate.files?.[0];
  if (!file?.id) return { ok: false, kind: 'file_create_failed', message: 'no file returned' };
  return {
    ok: true,
    fileId: file.id,
    initialStatus: file.status ?? file.fileStatus ?? null,
    initialErrors: file.mediaErrors ?? [],
  };
}

async function pollFileStatus({ ctx, fileId, pollMs, pollMaxMs }) {
  const deadline = Date.now() + pollMaxMs;
  let lastErrors = [];
  while (Date.now() < deadline) {
    const data = await gqlCall(ctx, FILE_NODE_QUERY, { id: fileId });
    const node = data.node;
    if (!node) return { ok: false, kind: 'file_status_failed', message: 'node not found' };
    const status = node.status ?? node.fileStatus ?? null;
    if (status === 'READY') return { ok: true };
    if (status === 'FAILED') {
      lastErrors = node.mediaErrors ?? [];
      const msg = lastErrors[0]?.details ?? lastErrors[0]?.message ?? 'unknown';
      return { ok: false, kind: 'file_status_failed', message: msg };
    }
    // PROCESSING / UPLOADED → wait and retry
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, kind: 'file_status_failed', message: `timeout after ${pollMaxMs}ms (still PROCESSING)` };
}

// --- Public entrypoint --------------------------------------------------

/**
 * Resolve a CDN image URL to a Shopify File GID.
 *
 * @param {object} args
 * @param {string} args.url                          CDN URL to resolve.
 * @param {object} args.ctx                          Shopify GraphQL ctx
 *                                                   { endpoint, token, fetch, bucket? } —
 *                                                   shared with import-write.mjs.
 * @param {object} args.cdnBucket                    Token bucket gating fetches against
 *                                                   files.ledsc4.com. Caller must size it
 *                                                   to the politeness SLA (default in writer:
 *                                                   capacity=1, refillPerSec=1/1.5).
 * @param {object} [args.dbConnection]               pg.Client-like (.query()). Null disables cache.
 * @param {typeof fetch} [args.fetchImpl]            Override fetch (tests).
 * @param {number} [args.fetchTimeoutMs]             CDN fetch timeout.
 * @param {number} [args.pollMs]                     File-status poll interval.
 * @param {number} [args.pollMaxMs]                  File-status poll ceiling.
 * @param {string} [args.userAgent]                  CDN fetch User-Agent.
 *
 * @returns {Promise<
 *   { ok: true,  fileId: string, fromCache: boolean | 'url', sha256: string, mimeType: string, byteSize: number }
 * | { ok: false, kind: 'fetch_failed' | 'fetch_timeout' | 'unsupported_mime'
 *               | 'staged_upload_failed' | 'file_create_failed' | 'file_status_failed',
 *     message: string,
 *     httpStatus?: number,
 *     sha256?: string }
 * >}
 *
 * Never throws.
 */
export async function resolveImageToShopifyFileId({
  url,
  ctx,
  cdnBucket,
  dbConnection = null,
  fetchImpl = globalThis.fetch,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  pollMaxMs = DEFAULT_POLL_MAX_MS,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (!url) return { ok: false, kind: 'fetch_failed', message: 'url is required' };
  if (!ctx) return { ok: false, kind: 'fetch_failed', message: 'ctx is required' };
  if (!cdnBucket) return { ok: false, kind: 'fetch_failed', message: 'cdnBucket is required' };

  // 0. Short-circuit por URL. Si esta URL ya produjo un File, devolvemos su
  //    GID sin tocar el CDN — evita ~80min de GETs paced en el full run.
  //    Hit aquí salta steps 1-7 enteros. fromCache='url' permite a callers
  //    distinguirlo del hit clásico por sha256 (fromCache=true / 'sha256').
  const urlHit = await cacheLookupByUrl(dbConnection, url);
  if (urlHit) {
    return {
      ok: true,
      fileId: urlHit.shopify_file_id,
      fromCache: 'url',
      sha256: urlHit.sha256,
      mimeType: urlHit.mime_type,
      byteSize: urlHit.byte_size,
    };
  }

  // 1. Politely-paced CDN fetch.
  await cdnBucket.acquire(1);
  const fetched = await fetchBinary({ url, fetchImpl, timeoutMs: fetchTimeoutMs, userAgent });
  if (!fetched.ok) return fetched;

  // 2. Hash + MIME resolution.
  const sha256 = createHash('sha256').update(fetched.buf).digest('hex');
  const mimeType = MIME_TO_EXT[fetched.headerMime] ? fetched.headerMime : sniffImageMime(fetched.buf);
  if (!mimeType || !MIME_TO_EXT[mimeType]) {
    return {
      ok: false,
      kind: 'unsupported_mime',
      message: `cannot determine image MIME (header=${fetched.headerMime ?? 'none'}, sniff failed)`,
      sha256,
    };
  }

  // 3. Cache lookup.
  const hit = await cacheLookup(dbConnection, sha256);
  if (hit) {
    return {
      ok: true,
      fileId: hit.shopify_file_id,
      fromCache: true,
      sha256,
      mimeType: hit.mime_type,
      byteSize: fetched.buf.length,
    };
  }

  // 4. Staged upload.
  let staged;
  try {
    staged = await stagedUpload({ ctx, buf: fetched.buf, mimeType, sha256, fetchImpl });
  } catch (err) {
    return { ok: false, kind: 'staged_upload_failed', message: String(err?.message ?? err), sha256 };
  }
  if (!staged.ok) return { ...staged, sha256 };

  // 5. fileCreate.
  let created;
  try {
    created = await fileCreate({ ctx, resourceUrl: staged.resourceUrl, filename: staged.filename });
  } catch (err) {
    return { ok: false, kind: 'file_create_failed', message: String(err?.message ?? err), sha256 };
  }
  if (!created.ok) return { ...created, sha256 };

  // 6. Poll until READY/FAILED. Skip if already terminal from initial response.
  if (created.initialStatus !== 'READY') {
    if (created.initialStatus === 'FAILED') {
      const msg = created.initialErrors[0]?.details ?? created.initialErrors[0]?.message ?? 'unknown';
      return { ok: false, kind: 'file_status_failed', message: msg, sha256 };
    }
    let polled;
    try {
      polled = await pollFileStatus({ ctx, fileId: created.fileId, pollMs, pollMaxMs });
    } catch (err) {
      return { ok: false, kind: 'file_status_failed', message: String(err?.message ?? err), sha256 };
    }
    if (!polled.ok) return { ...polled, sha256 };
  }

  // 7. Cache write. Do not fail the whole resolve on cache write error —
  // the upload already succeeded; we just lose dedupe for this binary.
  const cached = await cacheInsert(dbConnection, {
    sha256,
    shopify_file_id: created.fileId,
    mime_type: mimeType,
    byte_size: fetched.buf.length,
    source_url: url,
  });
  // If a concurrent caller won the race, prefer the canonical id from the
  // cache (the one the writer will see on subsequent runs) and discard
  // ours — caller could prune the duplicate, but at LedsC4 scale we don't.
  const finalFileId = cached.ok && cached.conflict && cached.winnerId ? cached.winnerId : created.fileId;

  return {
    ok: true,
    fileId: finalFileId,
    fromCache: false,
    sha256,
    mimeType,
    byteSize: fetched.buf.length,
  };
}
