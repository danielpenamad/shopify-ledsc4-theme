#!/usr/bin/env node
// Idempotent setter for the shop-level B2B metafields.
//
//   b2b.email_backoffice   (single_line_text_field)      destinatario avisos backoffice
//   b2b.whitelist_emails   (list.single_line_text_field) emails auto-aprobados al registrarse
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/set-shop-b2b-metafields.mjs [--dry-run] [--overwrite-whitelist]
//
// Defaults (sobrescribibles por env):
//   B2B_EMAIL_BACKOFFICE = daniel.pena+backoffice@creacciones.es
//   B2B_WHITELIST_EMAILS = daniel.pena+whitelist@creacciones.es (comma-separated)
//
// Idempotencia:
//   - email_backoffice: si el valor actual coincide, skip; si no, sobrescribe.
//   - whitelist_emails: por defecto merge + dedupe case-insensitive con los
//     emails ya presentes. Con --overwrite-whitelist, pisa completamente.

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');
const OVERWRITE_WHITELIST = process.argv.includes('--overwrite-whitelist');
const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;

const DEFAULT_EMAIL_BACKOFFICE = 'daniel.pena+backoffice@creacciones.es';
const DEFAULT_WHITELIST = 'daniel.pena+whitelist@creacciones.es';

const EMAIL_BACKOFFICE = (process.env.B2B_EMAIL_BACKOFFICE ?? DEFAULT_EMAIL_BACKOFFICE).trim();
const WHITELIST_INPUT = [
  ...new Set(
    (process.env.B2B_WHITELIST_EMAILS ?? DEFAULT_WHITELIST)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
];

const NS = 'b2b';
const KEY_BACKOFFICE = 'email_backoffice';
const KEY_WHITELIST = 'whitelist_emails';

if (!DRY_RUN && (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN)) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  console.error('Either set them or run with --dry-run to preview.');
  process.exit(1);
}

const endpoint = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : null;

async function gql(query, variables) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function readShop() {
  const q = `query {
    shop {
      id
      backoffice: metafield(namespace: "${NS}", key: "${KEY_BACKOFFICE}") { id value type }
      whitelist:  metafield(namespace: "${NS}", key: "${KEY_WHITELIST}")  { id value type }
    }
  }`;
  const data = await gql(q, {});
  return data.shop;
}

function planOps(shop) {
  const ops = [];

  // 1. email_backoffice
  const currentBackoffice = shop.backoffice?.value ?? null;
  if (currentBackoffice === EMAIL_BACKOFFICE) {
    console.log(`[skip] ${NS}.${KEY_BACKOFFICE} already equals "${EMAIL_BACKOFFICE}"`);
  } else {
    console.log(`[set]  ${NS}.${KEY_BACKOFFICE}: "${currentBackoffice ?? '(empty)'}" -> "${EMAIL_BACKOFFICE}"`);
    ops.push({
      ownerId: shop.id,
      namespace: NS,
      key: KEY_BACKOFFICE,
      type: 'single_line_text_field',
      value: EMAIL_BACKOFFICE,
    });
  }

  // 2. whitelist_emails
  let currentWhitelist = [];
  const raw = shop.whitelist?.value ?? null;
  if (raw) {
    try {
      currentWhitelist = JSON.parse(raw).map((s) => String(s).toLowerCase());
    } catch {
      console.warn(`[warn] ${NS}.${KEY_WHITELIST} existing value is not valid JSON; treating as empty: ${raw}`);
    }
  }

  const nextWhitelist = OVERWRITE_WHITELIST
    ? [...new Set(WHITELIST_INPUT)]
    : [...new Set([...currentWhitelist, ...WHITELIST_INPUT])];

  const same =
    nextWhitelist.length === currentWhitelist.length &&
    nextWhitelist.every((e, i) => e === currentWhitelist[i]);

  if (same) {
    console.log(`[skip] ${NS}.${KEY_WHITELIST} already contains: ${JSON.stringify(currentWhitelist)}`);
  } else {
    const mode = OVERWRITE_WHITELIST ? 'overwrite' : 'merge';
    console.log(`[set]  ${NS}.${KEY_WHITELIST} (${mode}): ${JSON.stringify(currentWhitelist)} -> ${JSON.stringify(nextWhitelist)}`);
    ops.push({
      ownerId: shop.id,
      namespace: NS,
      key: KEY_WHITELIST,
      type: 'list.single_line_text_field',
      value: JSON.stringify(nextWhitelist),
    });
  }

  return ops;
}

async function apply(ops) {
  const m = `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value type }
      userErrors { field message code }
    }
  }`;
  const data = await gql(m, { metafields: ops });
  const errs = data.metafieldsSet.userErrors ?? [];
  if (errs.length) throw new Error(`metafieldsSet: ${JSON.stringify(errs)}`);
  return data.metafieldsSet.metafields;
}

async function main() {
  const target = SHOPIFY_STORE_DOMAIN ?? '(not set — dry run)';
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Setting shop B2B metafields on ${target}`);
  console.log(`  email_backoffice = ${EMAIL_BACKOFFICE}`);
  console.log(`  whitelist_emails = ${JSON.stringify(WHITELIST_INPUT)} (${OVERWRITE_WHITELIST ? 'overwrite' : 'merge'})`);

  if (DRY_RUN) {
    console.log('[dry-run] No network calls. Re-run without --dry-run to read current state and apply.');
    return;
  }

  const shop = await readShop();
  console.log(`[info] shop id: ${shop.id}`);

  const ops = planOps(shop);
  if (ops.length === 0) {
    console.log('\nNothing to change. Done.');
    return;
  }

  const result = await apply(ops);
  console.log(`\nApplied ${result.length} metafield(s):`);
  for (const m of result) {
    console.log(`  ${m.namespace}.${m.key} = ${m.value}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
