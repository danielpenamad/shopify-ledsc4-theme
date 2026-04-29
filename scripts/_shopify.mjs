// Shared Shopify Admin GraphQL helper with cost-aware throttling.
//
// Used by setup-outlet-collections, tag-products-by-axis, setup-outlet-menu,
// audit-collection-axes. Keeps a token budget out of the call sites.
//
// Throttling: Shopify returns extensions.cost.throttleStatus. When
// currentlyAvailable drops below the next call's requested cost, we sleep
// proportionally to restoreRate before the next request. On THROTTLED /
// 429 errors, exponential backoff up to 5 retries.

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

const ENDPOINT = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : null;

let lastThrottle = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function requireEnv() {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
    process.exit(1);
  }
}

async function maybeWait(requestedCost = 50) {
  if (!lastThrottle) return;
  const { currentlyAvailable, restoreRate } = lastThrottle;
  if (currentlyAvailable >= requestedCost) return;
  const deficit = requestedCost - currentlyAvailable;
  const ms = Math.ceil((deficit / restoreRate) * 1000);
  if (ms > 0) await sleep(Math.min(ms, 4000));
}

export async function gql(query, variables = {}, { retries = 5, requestedCost = 50 } = {}) {
  await maybeWait(requestedCost);
  let attempt = 0;
  while (true) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      if (attempt++ >= retries) throw new Error('429 after retries');
      await sleep(Math.min(1000 * 2 ** attempt, 16000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${body.slice(0, 400)}`);
    }
    const json = await res.json();
    if (json.extensions?.cost?.throttleStatus) {
      lastThrottle = json.extensions.cost.throttleStatus;
    }
    if (json.errors) {
      const isThrottled = json.errors.some(
        (e) => e?.extensions?.code === 'THROTTLED' || /throttled/i.test(e?.message ?? '')
      );
      if (isThrottled && attempt++ < retries) {
        await sleep(Math.min(1000 * 2 ** attempt, 16000));
        continue;
      }
      throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }
}

export function slug(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
