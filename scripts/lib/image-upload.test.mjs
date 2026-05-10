#!/usr/bin/env node
// Unit tests for scripts/lib/image-upload.mjs.
//
// Zero deps, manual asserts — same convention as scripts/import-write.test.mjs.
// All external I/O (CDN fetch, Shopify GraphQL, staged-upload POST, pg.query)
// is mocked. The CDN bucket is real (token-based, runs fast in tests).
//
// Run: node scripts/lib/image-upload.test.mjs

import { resolveImageToShopifyFileId, sniffImageMime, makeStagedFilename } from './image-upload.mjs';
import { createTokenBucket } from '../rate-limiter.mjs';
import { createHash } from 'node:crypto';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; failures.push(message); console.error(`  ✗ ${message}`); }
}

// --- helpers ------------------------------------------------------------

// JPEG magic bytes (FF D8 FF) + filler. 1 KB is plenty for tests.
function jpegBytes(seed = 0) {
  const buf = Buffer.alloc(1024);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xe0;
  // Variable filler so different seeds → different sha256.
  for (let i = 4; i < buf.length; i++) buf[i] = (seed + i) & 0xff;
  return buf;
}
function pngBytes() {
  const buf = Buffer.alloc(64);
  // 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) buf[i] = sig[i];
  return buf;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeFastBucket() {
  // Fast enough that tests don't sleep — we're testing the helper, not the rate limiter.
  return createTokenBucket({ capacity: 100, refillPerSec: 1000 });
}

// Mock pg.Client with an in-memory map keyed by sha256.
function makeMockDb(initial = []) {
  const rows = new Map();
  for (const r of initial) rows.set(r.sha256, { ...r });
  let queryLog = [];
  return {
    rows,
    queryLog,
    async query(sql, params) {
      queryLog.push({ sql, params });
      const isSelectUpdate = /update\s+private\.image_cache.*returning\s+shopify_file_id/is.test(sql);
      const isInsert = /insert\s+into\s+private\.image_cache/is.test(sql);
      if (isSelectUpdate) {
        // cacheLookup: select by sha256, update last_used_at, return id+mime.
        const sha = params[0];
        const row = rows.get(sha);
        if (!row) return { rowCount: 0, rows: [] };
        row.last_used_at = new Date();
        return { rowCount: 1, rows: [{ shopify_file_id: row.shopify_file_id, mime_type: row.mime_type }] };
      }
      if (isInsert) {
        const [sha, fileId, mime, size, source] = params;
        const existing = rows.get(sha);
        if (existing) {
          existing.last_used_at = new Date();
          return { rowCount: 1, rows: [{ inserted: false, shopify_file_id: existing.shopify_file_id }] };
        }
        rows.set(sha, { sha256: sha, shopify_file_id: fileId, mime_type: mime, byte_size: size, source_url: source });
        return { rowCount: 1, rows: [{ inserted: true, shopify_file_id: fileId }] };
      }
      throw new Error(`mock db: unhandled SQL: ${sql.slice(0, 80)}...`);
    },
  };
}

// Mock fetch covering: CDN GET (binary), Shopify GraphQL (POST endpoint),
// staged-upload POST (any other URL). The behavior is configured per call
// via the supplied dispatcher.
function makeMockFetch(handlers) {
  return async (url, init = {}) => {
    for (const h of handlers) {
      if (h.match(url, init)) return h.respond(url, init);
    }
    throw new Error(`mock fetch: no handler for ${url} ${init?.method ?? 'GET'}`);
  };
}

function makeCtx(fetchImpl) {
  return {
    endpoint: 'https://mock-shop.myshopify.com/admin/api/2025-10/graphql.json',
    token: 'mock-token',
    fetch: fetchImpl,
  };
}

// Build a Shopify GraphQL handler that dispatches by operation name.
function gqlHandler(opMap) {
  return {
    match: (url, init) =>
      typeof url === 'string' && url.includes('/admin/api/') && init?.method === 'POST',
    respond: async (_url, init) => {
      const body = JSON.parse(init.body);
      const op = (body.query.match(/(?:mutation|query)\s+(\w+)/) ?? [])[1];
      const fn = opMap[op];
      if (!fn) throw new Error(`mock gql: no handler for op ${op}`);
      const data = await fn(body.variables);
      return new Response(JSON.stringify({ data }), { status: 200 });
    },
  };
}

// CDN handler: returns a binary, with overridable status/content-type.
function cdnHandler({ status = 200, body, contentType = 'image/jpeg' }) {
  return {
    match: (url) => typeof url === 'string' && url.startsWith('https://files.ledsc4.com/'),
    respond: () => new Response(body, { status, headers: { 'content-type': contentType } }),
  };
}

// Staged-upload POST handler (any URL not /admin/api/ and not files.ledsc4.com).
function stagedUploadHandler({ status = 200 } = {}) {
  return {
    match: (url, init) =>
      typeof url === 'string' && url.includes('mock-staged.s3.') && init?.method === 'POST',
    respond: () => new Response('', { status }),
  };
}

// --- tests --------------------------------------------------------------

async function testSniffImageMime() {
  console.log('Test 1: sniffImageMime — magic bytes for JPEG / PNG / GIF / WebP');
  assert(sniffImageMime(jpegBytes()) === 'image/jpeg', 'JPEG sniffed');
  assert(sniffImageMime(pngBytes()) === 'image/png', 'PNG sniffed');
  // GIF8
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  assert(sniffImageMime(gif) === 'image/gif', 'GIF sniffed');
  // WebP: RIFF....WEBP
  const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert(sniffImageMime(webp) === 'image/webp', 'WebP sniffed');
  // Garbage
  assert(sniffImageMime(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])) === null, 'unknown sniffs to null');
  // Too short
  assert(sniffImageMime(Buffer.from([])) === null, 'empty sniffs to null');
}

async function testMakeStagedFilename() {
  console.log('Test 2: makeStagedFilename — sha256-prefix.ext');
  const sha = 'abcdef0123456789' + '0'.repeat(48);
  assert(makeStagedFilename(sha, 'image/jpeg') === 'abcdef0123456789.jpg', `jpg ext`);
  assert(makeStagedFilename(sha, 'image/png') === 'abcdef0123456789.png', `png ext`);
  assert(makeStagedFilename(sha, 'application/octet-stream') === 'abcdef0123456789.bin', `unknown → bin`);
}

async function testHappyPath() {
  console.log('Test 3: happy path — fetch → stage → upload → fileCreate → poll → cache');
  const buf = jpegBytes(1);
  const sha = sha256Hex(buf);
  const db = makeMockDb();
  const calls = { stagedUploads: 0, fileCreate: 0, fileNode: 0, stagedPost: 0 };
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    {
      match: (url) => url.includes('mock-staged.s3.') && false, // never match here
      respond: () => null,
    },
    gqlHandler({
      StagedUploadsCreate: () => {
        calls.stagedUploads++;
        return {
          stagedUploadsCreate: {
            stagedTargets: [{
              url: 'https://mock-staged.s3.amazonaws.com/upload',
              resourceUrl: 'https://mock-staged.s3.amazonaws.com/resource/abc',
              parameters: [{ name: 'key', value: 'k1' }, { name: 'policy', value: 'p1' }],
            }],
            userErrors: [],
          },
        };
      },
      FileCreate: () => {
        calls.fileCreate++;
        // status PROCESSING — forces a poll round.
        return {
          fileCreate: {
            files: [{ id: 'gid://shopify/MediaImage/M1', fileStatus: 'UPLOADED', status: 'PROCESSING', mediaErrors: [] }],
            userErrors: [],
          },
        };
      },
      FileNode: () => {
        calls.fileNode++;
        return { node: { id: 'gid://shopify/MediaImage/M1', status: 'READY', mediaErrors: [] } };
      },
    }),
  ]);
  // Stage POST should be detected as same path as gql but different host;
  // since FormData triggers init.body without query/operation, we route
  // to stagedUploadHandler first.
  // The mock list above has stagedUploadHandler before gqlHandler — good.

  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/SKU-1',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
    pollMs: 1, pollMaxMs: 2000,
  });

  assert(r.ok === true, `expected ok=true, got ${JSON.stringify(r)}`);
  assert(r.fileId === 'gid://shopify/MediaImage/M1', `expected fileId, got ${r.fileId}`);
  assert(r.fromCache === false, 'fromCache=false on first call');
  assert(r.sha256 === sha, 'sha256 returned');
  assert(r.mimeType === 'image/jpeg', 'mimeType=image/jpeg');
  assert(r.byteSize === buf.length, `byteSize=${buf.length}`);
  assert(calls.stagedUploads === 1, '1 stagedUploadsCreate');
  assert(calls.fileCreate === 1, '1 fileCreate');
  assert(calls.fileNode >= 1, 'polled at least once');
  assert(db.rows.has(sha), 'cache row inserted');
  assert(db.rows.get(sha).shopify_file_id === 'gid://shopify/MediaImage/M1', 'cache row has fileId');
}

async function testCacheHit() {
  console.log('Test 4: cache hit — skips upload entirely');
  const buf = jpegBytes(2);
  const sha = sha256Hex(buf);
  const db = makeMockDb([{ sha256: sha, shopify_file_id: 'gid://shopify/MediaImage/CACHED', mime_type: 'image/jpeg', byte_size: buf.length }]);
  let gqlCalls = 0;
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    gqlHandler(new Proxy({}, { get: () => () => { gqlCalls++; throw new Error('should not call shopify'); } })),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/SKU-2',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
  });
  assert(r.ok === true, `ok=true`);
  assert(r.fromCache === true, `fromCache=true`);
  assert(r.fileId === 'gid://shopify/MediaImage/CACHED', `cached id returned`);
  assert(gqlCalls === 0, `no Shopify calls — got ${gqlCalls}`);
}

async function testFetchFailedHttp() {
  console.log('Test 5: CDN returns 404 — ok:false, kind=fetch_failed');
  const fetchImpl = makeMockFetch([cdnHandler({ status: 404, body: 'not found' })]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/MISSING',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
  });
  assert(r.ok === false, 'ok=false on 404');
  assert(r.kind === 'fetch_failed', `kind=fetch_failed, got ${r.kind}`);
  assert(/404/.test(r.message), `message mentions 404`);
}

async function testFetchTimeout() {
  console.log('Test 6: CDN times out — ok:false, kind=fetch_timeout');
  const fetchImpl = async (_url, init) => {
    // Honor AbortController.signal like the real fetch does.
    return new Promise((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/SLOW',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
    fetchTimeoutMs: 30, // tight for the test
  });
  assert(r.ok === false, 'ok=false on timeout');
  assert(r.kind === 'fetch_timeout', `kind=fetch_timeout, got ${r.kind}`);
}

async function testUnsupportedMime() {
  console.log('Test 7: unrecognized binary — ok:false, kind=unsupported_mime');
  // Random bytes that don't match any magic, with a generic content-type.
  const buf = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const fetchImpl = makeMockFetch([cdnHandler({ body: buf, contentType: 'application/octet-stream' })]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/WEIRD',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
  });
  assert(r.ok === false, 'ok=false on unknown MIME');
  assert(r.kind === 'unsupported_mime', `kind=unsupported_mime, got ${r.kind}`);
  assert(typeof r.sha256 === 'string' && r.sha256.length === 64, 'sha256 still computed');
}

async function testMimeFromContentTypeHeader() {
  console.log('Test 8: header content-type wins when valid (no need for sniff)');
  const buf = pngBytes();
  const db = makeMockDb();
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf, contentType: 'image/png; charset=binary' }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: (vars) => {
        assert(vars.input[0].mimeType === 'image/png', `staged mimeType=image/png passed through`);
        assert(vars.input[0].filename.endsWith('.png'), `filename has .png ext`);
        return {
          stagedUploadsCreate: {
            stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
            userErrors: [],
          },
        };
      },
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/PNG1', status: 'READY', mediaErrors: [] }], userErrors: [] },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/PNG-SKU',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
  });
  assert(r.ok === true, 'ok=true');
  assert(r.mimeType === 'image/png', 'mimeType=image/png');
}

async function testSniffFallback() {
  console.log('Test 9: header is generic, sniff finds JPEG');
  const buf = jpegBytes(3);
  const db = makeMockDb();
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf, contentType: 'application/octet-stream' }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: (vars) => {
        assert(vars.input[0].mimeType === 'image/jpeg', `mimeType from sniff`);
        return {
          stagedUploadsCreate: {
            stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
            userErrors: [],
          },
        };
      },
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/SNIFF1', status: 'READY', mediaErrors: [] }], userErrors: [] },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/SNIFF',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
  });
  assert(r.ok === true, 'ok=true via sniff');
  assert(r.mimeType === 'image/jpeg', 'mimeType=image/jpeg from sniff');
}

async function testStagedUploadUserError() {
  console.log('Test 10: stagedUploadsCreate userErrors → kind=staged_upload_failed');
  const buf = jpegBytes(4);
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: { stagedTargets: [], userErrors: [{ field: ['input'], message: 'invalid mime' }] },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/STG-FAIL',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
  });
  assert(r.ok === false, 'ok=false');
  assert(r.kind === 'staged_upload_failed', `kind=staged_upload_failed, got ${r.kind}`);
  assert(/invalid mime/.test(r.message), 'message preserved');
}

async function testStagedPostHttpError() {
  console.log('Test 11: staged POST returns 5xx → kind=staged_upload_failed');
  const buf = jpegBytes(5);
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler({ status: 503 }),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/POST-FAIL',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
  });
  assert(r.ok === false, 'ok=false on 503');
  assert(r.kind === 'staged_upload_failed', `kind=staged_upload_failed`);
  assert(/503/.test(r.message), 'message mentions 503');
}

async function testFileCreateUserError() {
  console.log('Test 12: fileCreate userErrors → kind=file_create_failed');
  const buf = jpegBytes(6);
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [], userErrors: [{ field: ['files'], message: 'too large', code: 'INVALID' }] },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/FC-FAIL',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
  });
  assert(r.ok === false, 'ok=false');
  assert(r.kind === 'file_create_failed', `kind=file_create_failed`);
  assert(/too large/.test(r.message), 'message preserved');
}

async function testFilePollFailed() {
  console.log('Test 13: file ends in FAILED with mediaErrors → kind=file_status_failed (not cached)');
  const buf = jpegBytes(7);
  const sha = sha256Hex(buf);
  const db = makeMockDb();
  let nodeCalls = 0;
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/POLL1', status: 'PROCESSING', mediaErrors: [] }], userErrors: [] },
      }),
      FileNode: () => {
        nodeCalls++;
        // After 1st poll, return FAILED with mediaError.
        return { node: { id: 'gid://shopify/MediaImage/POLL1', status: 'FAILED', mediaErrors: [{ code: 'INVALID', details: 'pixel limit exceeded', message: 'pixels' }] } };
      },
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/POLL-FAIL',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
    pollMs: 1, pollMaxMs: 200,
  });
  assert(r.ok === false, 'ok=false');
  assert(r.kind === 'file_status_failed', `kind=file_status_failed`);
  assert(/pixel limit/.test(r.message), 'message has the failure detail');
  assert(!db.rows.has(sha), 'FAILED file is NOT cached');
}

async function testFilePollTimeout() {
  console.log('Test 14: file stuck in PROCESSING beyond pollMaxMs → kind=file_status_failed (timeout)');
  const buf = jpegBytes(8);
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/STUCK', status: 'PROCESSING', mediaErrors: [] }], userErrors: [] },
      }),
      FileNode: () => ({ node: { id: 'gid://shopify/MediaImage/STUCK', status: 'PROCESSING', mediaErrors: [] } }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/STUCK',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    fetchImpl,
    pollMs: 5, pollMaxMs: 30,
  });
  assert(r.ok === false, 'ok=false on timeout');
  assert(r.kind === 'file_status_failed', `kind=file_status_failed`);
  assert(/timeout/.test(r.message), 'message mentions timeout');
}

async function testCacheRaceConflict() {
  console.log('Test 15: cache INSERT hits ON CONFLICT — caller gets the canonical id');
  const buf = jpegBytes(9);
  const sha = sha256Hex(buf);
  // Pre-seed: a "winner" already cached the same hash with id WIN.
  const db = makeMockDb([{ sha256: sha, shopify_file_id: 'gid://shopify/MediaImage/WIN', mime_type: 'image/jpeg', byte_size: buf.length }]);
  // We deliberately bypass the lookup hit by patching the lookup to return null
  // (simulating the race: lookup ran BEFORE the winner committed). We can do
  // this by clearing rows after lookup — easier: temporarily monkey-patch
  // the db.query for the lookup-step.
  const realQuery = db.query.bind(db);
  let lookupServed = false;
  db.query = async (sql, params) => {
    if (!lookupServed && /update\s+private\.image_cache.*returning\s+shopify_file_id/is.test(sql)) {
      lookupServed = true;
      return { rowCount: 0, rows: [] }; // pretend miss
    }
    return realQuery(sql, params);
  };

  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/LOSE', status: 'READY', mediaErrors: [] }], userErrors: [] },
      }),
    }),
  ]);
  const r = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/RACE',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: db,
    fetchImpl,
  });
  assert(r.ok === true, 'ok=true');
  assert(r.fromCache === false, 'fromCache=false (we DID upload)');
  assert(r.fileId === 'gid://shopify/MediaImage/WIN', `expected canonical WIN, got ${r.fileId}`);
}

async function testWorksWithoutDb() {
  console.log('Test 16: dbConnection=null disables cache; otherwise upload still succeeds');
  const buf = jpegBytes(10);
  const fetchImpl = makeMockFetch([
    cdnHandler({ body: buf }),
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/NODB', status: 'READY', mediaErrors: [] }], userErrors: [] },
      }),
    }),
  ]);
  const r1 = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/NODB',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: null,
    fetchImpl,
  });
  const r2 = await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/NODB',
    ctx: makeCtx(fetchImpl),
    cdnBucket: makeFastBucket(),
    dbConnection: null,
    fetchImpl,
  });
  assert(r1.ok && r2.ok, 'both ok');
  assert(r1.fromCache === false && r2.fromCache === false, 'both fromCache=false (no db)');
}

async function testCdnBucketIsAcquiredBeforeFetch() {
  console.log('Test 17: cdnBucket.acquire() is called before the CDN fetch');
  const buf = jpegBytes(11);
  let acquireOrder = [];
  const fakeBucket = {
    acquire: async (n = 1) => { acquireOrder.push(`acquire(${n})`); },
  };
  const fetchImpl = makeMockFetch([
    {
      match: (url) => url.startsWith('https://files.ledsc4.com/'),
      respond: () => { acquireOrder.push('cdn-fetch'); return new Response(buf, { status: 200, headers: { 'content-type': 'image/jpeg' } }); },
    },
    stagedUploadHandler(),
    gqlHandler({
      StagedUploadsCreate: () => ({
        stagedUploadsCreate: {
          stagedTargets: [{ url: 'https://mock-staged.s3.amazonaws.com/u', resourceUrl: 'https://mock-staged.s3.amazonaws.com/r', parameters: [] }],
          userErrors: [],
        },
      }),
      FileCreate: () => ({
        fileCreate: { files: [{ id: 'gid://shopify/MediaImage/B1', status: 'READY', mediaErrors: [] }], userErrors: [] },
      }),
    }),
  ]);
  await resolveImageToShopifyFileId({
    url: 'https://files.ledsc4.com/main-photo/BUCKET',
    ctx: makeCtx(fetchImpl),
    cdnBucket: fakeBucket,
    fetchImpl,
  });
  assert(acquireOrder[0] === 'acquire(1)' && acquireOrder[1] === 'cdn-fetch', `order: ${acquireOrder.join(' → ')}`);
}

async function testValidatesArgs() {
  console.log('Test 18: missing required args → ok:false (does not throw)');
  const r1 = await resolveImageToShopifyFileId({});
  assert(r1.ok === false && /url/.test(r1.message), 'missing url');
  const r2 = await resolveImageToShopifyFileId({ url: 'https://x' });
  assert(r2.ok === false && /ctx/.test(r2.message), 'missing ctx');
  const r3 = await resolveImageToShopifyFileId({ url: 'https://x', ctx: {} });
  assert(r3.ok === false && /cdnBucket/.test(r3.message), 'missing cdnBucket');
}

// --- runner -------------------------------------------------------------

const tests = [
  testSniffImageMime,
  testMakeStagedFilename,
  testHappyPath,
  testCacheHit,
  testFetchFailedHttp,
  testFetchTimeout,
  testUnsupportedMime,
  testMimeFromContentTypeHeader,
  testSniffFallback,
  testStagedUploadUserError,
  testStagedPostHttpError,
  testFileCreateUserError,
  testFilePollFailed,
  testFilePollTimeout,
  testCacheRaceConflict,
  testWorksWithoutDb,
  testCdnBucketIsAcquiredBeforeFetch,
  testValidatesArgs,
];

(async () => {
  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      failed++;
      failures.push(`${t.name} threw: ${err.message}`);
      console.error(`  ✗ ${t.name} threw: ${err.message}`);
      console.error(err.stack);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
})();
