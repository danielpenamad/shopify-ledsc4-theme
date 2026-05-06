#!/usr/bin/env node
// Idempotent metafield definition manager for the LedsC4 B2B project.
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/apply-metafield-definitions.mjs [--dry-run]
//
// Reads scripts/metafield-definitions.json and:
//   1) queries existing metafield definitions on the shop (one query per ownerType used in the JSON),
//      including capabilities.smartCollectionCondition.enabled to detect dependency locks;
//   2) classifies each entry as Create / Unchanged / Update / UpdateBlockedByDependency / DriftBlocked;
//   3) executes:
//        - metafieldDefinitionCreate (+ metafieldDefinitionPin if def.pin) for Create;
//        - metafieldDefinitionUpdate (description / access) AND metafieldDefinitionPin/Unpin
//          (pin) — separately, since the Pin state is NOT a field of the Update mutation
//          input — for Update;
//   4) UpdateBlockedByDependency: definition has capabilities.smartCollectionCondition.enabled = true
//      and the JSON wants a change. Shopify rejects Update on these with CAPABILITY_CANNOT_BE_DISABLED.
//      Reported as a warning, never applied. Operator must remove the smart collection rule (or
//      accept the current shop state) to unblock. The classifier detects this a priori from the
//      capability flag rather than letting Update fail at runtime, so dry-run reflects reality
//      and idempotency holds.
//   5) DriftBlocked (key/type changed) is reported but NEVER applied automatically.
//
// In --dry-run, no mutation is sent — only the classification is printed.
// If credentials are absent and --dry-run is set, falls back to "print only".

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'metafield-definitions.json');
const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2025-10';
const DRY_RUN = process.argv.includes('--dry-run');

const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN } = process.env;
const HAS_CREDENTIALS = Boolean(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);

if (!DRY_RUN && !HAS_CREDENTIALS) {
  console.error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars.');
  console.error('Either set them or run with --dry-run to preview.');
  process.exit(1);
}

const endpoint = SHOPIFY_STORE_DOMAIN
  ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`
  : null;

const CREATE_MUTATION = `
  mutation metafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key name ownerType }
      userErrors { field message code }
    }
  }
`;

const UPDATE_MUTATION = `
  mutation metafieldDefinitionUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id namespace key }
      userErrors { field message code }
    }
  }
`;

const PIN_MUTATION = `
  mutation metafieldDefinitionPin($id: ID!) {
    metafieldDefinitionPin(definitionId: $id) {
      pinnedDefinition { id }
      userErrors { field message code }
    }
  }
`;

const UNPIN_MUTATION = `
  mutation metafieldDefinitionUnpin($id: ID!) {
    metafieldDefinitionUnpin(definitionId: $id) {
      unpinnedDefinition { id }
      userErrors { field message code }
    }
  }
`;

const LIST_QUERY = `
  query MetafieldDefs($ownerType: MetafieldOwnerType!, $first: Int!, $after: String) {
    metafieldDefinitions(ownerType: $ownerType, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        namespace
        key
        description
        pinnedPosition
        access { storefront }
        type { name }
        capabilities { smartCollectionCondition { enabled } }
      }
    }
  }
`;

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

// Returns Map keyed by `${ownerType}:${namespace}.${key}` → { id, description, pinned, storefrontAccess, typeName }.
async function fetchExistingDefinitions(ownerTypes) {
  const out = new Map();
  for (const ownerType of ownerTypes) {
    let after = null;
    while (true) {
      const data = await gql(LIST_QUERY, { ownerType, first: 250, after });
      const conn = data.metafieldDefinitions;
      for (const n of conn.nodes) {
        const k = `${ownerType}:${n.namespace}.${n.key}`;
        out.set(k, {
          id: n.id,
          description: n.description ?? '',
          pinned: n.pinnedPosition != null,
          storefrontAccess: n.access?.storefront ?? 'NONE',
          typeName: n.type?.name ?? null,
          smartCollectionConditionEnabled: n.capabilities?.smartCollectionCondition?.enabled === true,
        });
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  return out;
}

function diffDefinition(def, existing) {
  const wantPinned = def.pin === true;
  const descChanged = (def.description ?? '') !== (existing.description ?? '');
  const pinChanged = wantPinned !== existing.pinned;
  // For definitions without explicit access in JSON, treat as "leave as is" (no diff).
  // Default for Shopify metafield definitions is access.storefront=NONE.
  const wantAccess = def.access?.storefront ?? null;
  const accessChanged = wantAccess !== null && wantAccess !== existing.storefrontAccess;
  return { descChanged, pinChanged, accessChanged, wantPinned, wantAccess };
}

function classifyDefinition(def, existing) {
  if (!existing) return { status: 'create' };

  // Drift on type is unrecoverable via metafieldDefinitionUpdate.
  if (existing.typeName && existing.typeName !== def.type) {
    return {
      status: 'drift-blocked',
      reason: `type changed: shop has "${existing.typeName}", JSON has "${def.type}". Requires manual drop+recreate.`,
    };
  }

  const d = diffDefinition(def, existing);
  if (!d.descChanged && !d.pinChanged && !d.accessChanged) return { status: 'unchanged' };

  const diffs = [];
  if (d.descChanged) diffs.push(`description: "${existing.description}" → "${def.description}"`);
  if (d.pinChanged) diffs.push(`pin: ${existing.pinned} → ${d.wantPinned}`);
  if (d.accessChanged) diffs.push(`access.storefront: ${existing.storefrontAccess} → ${d.wantAccess}`);

  // Shopify locks ALL fields of a metafield definition while
  // capabilities.smartCollectionCondition.enabled = true AND there are smart
  // collections actually using it as a rule. The Update mutation rejects with
  // CAPABILITY_CANNOT_BE_DISABLED. We can't tell from the API whether there
  // are smart collections currently using it without scanning all collections,
  // but the capability flag is a sufficient signal in practice (it gets
  // enabled when the first smart collection adopts the metafield as a rule).
  // False positive risk: capability stays enabled after the last smart
  // collection is removed; in that case the operator must disable it manually
  // or accept that this script will not auto-update.
  if (existing.smartCollectionConditionEnabled) {
    return { status: 'update-blocked-by-dependency', diffs, diff: d, blockedBy: 'smart_collection_condition' };
  }

  return { status: 'update', diffs, diff: d };
}

async function createDefinition(def) {
  const input = {
    ownerType: def.ownerType,
    namespace: def.namespace,
    key: def.key,
    name: def.name,
    description: def.description,
    type: def.type,
    access: def.access,
  };
  const data = await gql(CREATE_MUTATION, { definition: input });
  const errors = data.metafieldDefinitionCreate.userErrors ?? [];
  const taken = errors.find((e) => e.code === 'TAKEN');
  if (taken) {
    // Race: another operator created it between our fetch and now. Treat as unchanged.
    console.log(`[skip] race-existed: ${def.namespace}.${def.key}`);
    return { status: 'race-existed' };
  }
  if (errors.length > 0) {
    console.error(`[error] create ${def.namespace}.${def.key}:`, errors);
    return { status: 'error', errors };
  }
  const created = data.metafieldDefinitionCreate.createdDefinition;
  console.log(`[ok] created: ${def.namespace}.${def.key} (${created.id})`);

  if (def.pin && created?.id) {
    const r = await pinDefinition(created.id, def);
    if (r.status === 'error') return r;
  }
  return { status: 'created', id: created?.id };
}

async function pinDefinition(id, def) {
  const pinData = await gql(PIN_MUTATION, { id });
  const pinErrors = pinData.metafieldDefinitionPin.userErrors ?? [];
  const benignCodes = new Set(['TAKEN', 'PINNED_LIMIT_REACHED']);
  const nonBenign = pinErrors.filter((e) => !benignCodes.has(e.code));
  if (nonBenign.length > 0) {
    console.error(`[error] pin ${def.namespace}.${def.key}:`, nonBenign);
    return { status: 'error', errors: nonBenign };
  }
  return { status: 'ok' };
}

async function unpinDefinition(id, def) {
  const unpinData = await gql(UNPIN_MUTATION, { id });
  const unpinErrors = unpinData.metafieldDefinitionUnpin.userErrors ?? [];
  const benignCodes = new Set(['NOT_PINNED']);
  const nonBenign = unpinErrors.filter((e) => !benignCodes.has(e.code));
  if (nonBenign.length > 0) {
    console.error(`[error] unpin ${def.namespace}.${def.key}:`, nonBenign);
    return { status: 'error', errors: nonBenign };
  }
  return { status: 'ok' };
}

// Update path:
//   - If description and/or access changed → metafieldDefinitionUpdate (one call).
//   - If pin changed → metafieldDefinitionPin or metafieldDefinitionUnpin (separate call).
//     metafieldDefinitionUpdate input does NOT accept pin in the LedsC4-validated API
//     version (2025-10) — the pin state is managed by Pin/Unpin mutations, not Update.
async function applyUpdate(def, existing, diff) {
  const updates = [];

  if (diff.descChanged || diff.accessChanged) {
    const input = {
      ownerType: def.ownerType,
      namespace: def.namespace,
      key: def.key,
    };
    if (diff.descChanged) input.description = def.description;
    if (diff.accessChanged) input.access = { storefront: diff.wantAccess };

    const data = await gql(UPDATE_MUTATION, { definition: input });
    const errors = data.metafieldDefinitionUpdate.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`[error] update ${def.namespace}.${def.key}:`, errors);
      return { status: 'error', errors };
    }
    const fields = [diff.descChanged && 'description', diff.accessChanged && 'access.storefront'].filter(Boolean).join('+');
    console.log(`[ok] updated ${def.namespace}.${def.key} (${fields})`);
    updates.push(fields);
  }

  if (diff.pinChanged) {
    const r = diff.wantPinned ? await pinDefinition(existing.id, def) : await unpinDefinition(existing.id, def);
    if (r.status === 'error') return r;
    console.log(`[ok] ${diff.wantPinned ? 'pinned' : 'unpinned'} ${def.namespace}.${def.key}`);
    updates.push(diff.wantPinned ? 'pin=true' : 'pin=false');
  }

  return { status: 'updated', updates };
}

function shortAccess(def) {
  return def.access?.storefront ?? '(default)';
}

async function main() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const definitions = JSON.parse(raw);

  const target = SHOPIFY_STORE_DOMAIN ?? '(not set — legacy dry run)';
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Applying ${definitions.length} metafield definitions to ${target}`);

  // Legacy fallback: --dry-run without credentials prints each entry without classifying.
  if (DRY_RUN && !HAS_CREDENTIALS) {
    console.log('(no credentials → legacy mode: printing entries without classification)');
    for (const def of definitions) {
      console.log(`[dry-run] would consider ${def.ownerType} ${def.namespace}.${def.key} (${def.type}) pin=${!!def.pin} access.storefront=${shortAccess(def)}`);
    }
    console.log('\nSummary: classification skipped (no credentials).');
    return;
  }

  const ownerTypes = [...new Set(definitions.map((d) => d.ownerType))];
  console.log(`Querying existing definitions for ownerTypes: ${ownerTypes.join(', ')}…`);
  const existing = await fetchExistingDefinitions(ownerTypes);
  console.log(`Found ${existing.size} existing definitions across queried owner types.\n`);

  const buckets = { create: [], unchanged: [], update: [], updateBlocked: [], driftBlocked: [] };
  for (const def of definitions) {
    const k = `${def.ownerType}:${def.namespace}.${def.key}`;
    const cls = classifyDefinition(def, existing.get(k));
    if (cls.status === 'create') {
      buckets.create.push(def);
      console.log(`[plan] CREATE        ${k} (${def.type}) pin=${!!def.pin} access.storefront=${shortAccess(def)}`);
    } else if (cls.status === 'unchanged') {
      buckets.unchanged.push(def);
      console.log(`[plan] UNCHANGED     ${k}`);
    } else if (cls.status === 'update') {
      buckets.update.push({ def, existing: existing.get(k), diff: cls.diff, diffs: cls.diffs });
      console.log(`[plan] UPDATE        ${k}: ${cls.diffs.join('; ')}`);
    } else if (cls.status === 'update-blocked-by-dependency') {
      buckets.updateBlocked.push({ def, diffs: cls.diffs, blockedBy: cls.blockedBy });
      console.log(`[plan] BLOCKED       ${k}: ${cls.diffs.join('; ')} — locked by ${cls.blockedBy}`);
    } else if (cls.status === 'drift-blocked') {
      buckets.driftBlocked.push({ def, reason: cls.reason });
      console.log(`[plan] DRIFT         ${k}: ${cls.reason}`);
    }
  }

  if (DRY_RUN) {
    console.log(
      `\nSummary (dry-run): Created: ${buckets.create.length}, Updated: ${buckets.update.length}, Unchanged: ${buckets.unchanged.length}, UpdateBlockedByDependency: ${buckets.updateBlocked.length}, DriftBlocked: ${buckets.driftBlocked.length}, Failed: 0`
    );
    if (buckets.updateBlocked.length > 0) {
      console.log('\nUpdateBlockedByDependency detail (a smart collection rule depends on the metafield; clear the dependency or accept current state):');
      for (const item of buckets.updateBlocked) {
        console.log(`  - ${item.def.ownerType}:${item.def.namespace}.${item.def.key} (locked by ${item.blockedBy})`);
        for (const d of item.diffs) console.log(`      pending: ${d}`);
      }
    }
    if (buckets.driftBlocked.length > 0) {
      console.log('\nDriftBlocked detail (manual drop+recreate required):');
      for (const item of buckets.driftBlocked) {
        console.log(`  - ${item.def.ownerType}:${item.def.namespace}.${item.def.key}: ${item.reason}`);
      }
    }
    return;
  }

  // Real run: execute Create + Update. DriftBlocked is reported but not applied.
  console.log(`\nExecuting ${buckets.create.length} create(s) and ${buckets.update.length} update(s)…\n`);
  let created = 0;
  let updated = 0;
  let raceExisted = 0;
  let failed = 0;

  for (const def of buckets.create) {
    try {
      const r = await createDefinition(def);
      if (r.status === 'created') created++;
      else if (r.status === 'race-existed') raceExisted++;
      else if (r.status === 'error') failed++;
    } catch (err) {
      console.error(`[error] create ${def.namespace}.${def.key}:`, err.message);
      failed++;
    }
  }

  for (const item of buckets.update) {
    try {
      const r = await applyUpdate(item.def, item.existing, item.diff);
      if (r.status === 'updated') updated++;
      else if (r.status === 'error') failed++;
    } catch (err) {
      console.error(`[error] update ${item.def.namespace}.${item.def.key}:`, err.message);
      failed++;
    }
  }

  console.log(
    `\nSummary: Created: ${created}, Updated: ${updated}, Unchanged: ${buckets.unchanged.length + raceExisted}, UpdateBlockedByDependency: ${buckets.updateBlocked.length}, DriftBlocked: ${buckets.driftBlocked.length}, Failed: ${failed}`
  );

  if (buckets.updateBlocked.length > 0) {
    console.warn('\n⚠ UpdateBlockedByDependency entries: a smart collection rule depends on the metafield definition.');
    console.warn('  These entries are reported but NOT applied. To unblock, either remove the smart collection rule');
    console.warn('  that uses the metafield as a condition, or accept the current shop state (the JSON definition');
    console.warn('  describes the desired end-state but cannot be enforced while the dependency exists).');
    for (const item of buckets.updateBlocked) {
      console.warn(`  - ${item.def.ownerType}:${item.def.namespace}.${item.def.key} (locked by ${item.blockedBy})`);
      for (const d of item.diffs) console.warn(`      pending: ${d}`);
    }
  }
  if (buckets.driftBlocked.length > 0) {
    console.error('\n✗ DriftBlocked entries cannot be fixed via Update (key/type changed).');
    console.error('  Manual drop + recreate required:');
    for (const item of buckets.driftBlocked) {
      console.error(`  - ${item.def.ownerType}:${item.def.namespace}.${item.def.key}: ${item.reason}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
