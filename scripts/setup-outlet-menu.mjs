#!/usr/bin/env node
// Idempotent main-menu configurator for the LedsC4 B2B outlet.
//
// Builds the menu dynamically from the outlet smart collections that
// already exist (handle prefix "outlet-"). Padres are sorted by
// productsCount desc, hijos discovered via handle prefix
// "outlet-<padre>-".
//
// Menu structure:
//   - Home (FRONTPAGE)
//   - Catálogo completo → coleccion-2026
//   - <Padre 1> → outlet-<padre> ↳ <hijos>
//   - <Padre 2> → outlet-<padre> ↳ <hijos>
//   - ...
//   - Otros (no children)
//
// Idempotency: compares normalized current vs target structure. If equal,
// skip. Otherwise menuUpdate (preserves the menu id, no menuCreate needed
// since "main-menu" exists by default in every store).
//
// Usage:
//   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... \
//   node scripts/setup-outlet-menu.mjs [--dry-run]

import { gql, requireEnv } from './_shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
if (!DRY_RUN) requireEnv();

const MENU_HANDLE = 'main-menu';
const COLECCION_HANDLE = 'coleccion-2026';
const PADRE_PREFIX = 'outlet-';

// Order of padres in the menu — by descending product count typically.
// Hardcoded to keep deterministic ordering even when small fluctuations
// in the store would re-rank them.
const PADRES_ORDER = ['Forlight', 'Architectural', 'Decorative', 'Outdoor', 'DIY', 'Otros'];

async function listOutletCollections() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      collections(first: 100, after: $after, query: "handle:${PADRE_PREFIX}*") {
        edges { cursor node { id handle title productsCount { count } } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const d = await gql(q, { after: cursor }, { requestedCost: 200 });
    for (const e of d.collections.edges) {
      if (e.node.handle.startsWith(PADRE_PREFIX)) out.push(e.node);
    }
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
  return out;
}

async function getColeccionPadre() {
  const q = `query($h: String!) { collectionByHandle(handle: $h) { id title } }`;
  const d = await gql(q, { h: COLECCION_HANDLE }, { requestedCost: 5 });
  if (!d.collectionByHandle) throw new Error(`Collection ${COLECCION_HANDLE} not found`);
  return d.collectionByHandle;
}

async function findMainMenu() {
  const q = `query {
    menus(first: 50, query: "handle:${MENU_HANDLE}") {
      edges { node { id handle title items { id title type url resourceId items { id title type url resourceId } } } }
    }
  }`;
  const d = await gql(q, {}, { requestedCost: 30 });
  return d.menus.edges.find((e) => e.node.handle === MENU_HANDLE)?.node ?? null;
}

function normaliseTitle(t) {
  // Hijos titles come as "Padre — productType". For the menu we want just
  // the productType part for visual clarity (the parent context is given
  // by the menu hierarchy).
  const idx = t.indexOf(' — ');
  return idx > 0 ? t.slice(idx + 3) : t;
}

function buildItems(coleccion, padresAndHijos) {
  // Outlet B2B menu: only the catalog hierarchy. No Home, no Contact, no
  // preserved tail — the storefront logo handles "go home" and Contact
  // can be re-added manually if marketing wants it.
  const items = [
    { title: 'Todos', type: 'COLLECTION', resourceId: coleccion.id },
  ];
  for (const padreTitle of PADRES_ORDER) {
    const entry = padresAndHijos.get(padreTitle);
    if (!entry) continue;
    const item = { title: padreTitle, type: 'COLLECTION', resourceId: entry.padre.id };
    if (entry.hijos.length > 0) {
      const sorted = [...entry.hijos].sort((a, b) => (b.productsCount?.count ?? 0) - (a.productsCount?.count ?? 0));
      item.items = sorted.map((h) => ({
        title: normaliseTitle(h.title),
        type: 'COLLECTION',
        resourceId: h.id,
      }));
    }
    items.push(item);
  }
  return items;
}

function normalize(items) {
  // Compare on (title, type, resourceId) only. Shopify auto-derives url from
  // resourceId for typed items, so including url would cause false negatives
  // when our input had only resourceId.
  return JSON.stringify(
    (items ?? []).map((it) => ({
      title: it.title,
      type: it.type,
      resourceId: it.resourceId ?? null,
      items: (it.items ?? []).map((c) => ({
        title: c.title,
        type: c.type,
        resourceId: c.resourceId ?? null,
      })),
    }))
  );
}

async function menuUpdate(id, title, items) {
  const m = `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu { id handle items { id title type } }
      userErrors { field message code }
    }
  }`;
  const d = await gql(m, { id, title, handle: MENU_HANDLE, items }, { requestedCost: 80 });
  const errs = d.menuUpdate.userErrors ?? [];
  if (errs.length) throw new Error(`menuUpdate: ${JSON.stringify(errs)}`);
  return d.menuUpdate.menu;
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Configuring ${MENU_HANDLE}`);
  const [coleccion, outletCols, existing] = await Promise.all([
    getColeccionPadre(),
    listOutletCollections(),
    findMainMenu(),
  ]);

  // Group collections into padres and hijos by handle
  const padresByHandle = new Map();
  const hijosByPadreHandle = new Map();
  for (const c of outletCols) {
    const rest = c.handle.slice(PADRE_PREFIX.length);
    const dashIdx = rest.indexOf('-');
    if (dashIdx === -1) {
      padresByHandle.set(c.handle, c);
    } else {
      const padreHandle = `${PADRE_PREFIX}${rest.slice(0, dashIdx)}`;
      if (!hijosByPadreHandle.has(padreHandle)) hijosByPadreHandle.set(padreHandle, []);
      hijosByPadreHandle.get(padreHandle).push(c);
    }
  }

  // Map padre title -> { padre, hijos[] }
  const padresAndHijos = new Map();
  for (const [, padre] of padresByHandle) {
    padresAndHijos.set(padre.title, {
      padre,
      hijos: hijosByPadreHandle.get(padre.handle) ?? [],
    });
  }

  const items = buildItems(coleccion, padresAndHijos);

  console.log('\nPlanned menu structure:');
  for (const it of items) {
    const where = it.resourceId ?? it.url ?? `(${it.type})`;
    console.log(`  • ${it.title}  [${where}]`);
    for (const c of it.items ?? []) {
      console.log(`      ↳ ${c.title}  [${c.resourceId}]`);
    }
  }

  if (!existing) throw new Error(`Menu ${MENU_HANDLE} not found — would need menuCreate, blocked.`);

  const target = normalize(items);
  const current = normalize(existing.items);
  if (target === current) {
    console.log(`\n[skip ✓] menu already matches target structure`);
    return;
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] menu structure differs — would call menuUpdate(${existing.id})`);
    return;
  }

  await menuUpdate(existing.id, existing.title || 'Main menu', items);
  console.log(`\n[ok] menu ${existing.id} updated (${items.length} top-level items)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
