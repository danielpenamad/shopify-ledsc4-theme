#!/usr/bin/env node
// Idempotente: configura el main-menu del outlet B2B con la jerarquía
// cat-*. Diseñado para correr DESPUÉS de scripts/setup-cat-collections.mjs.
//
// Estructura (cerrada en Paso 1):
//   1. Forlight       → cat-forlight       (con hijos ordenados por count desc)
//   2. Architectural  → cat-architectural  ( "" )
//   3. Decorative     → cat-decorative     ( "" )
//   4. DIY            → cat-diy            ( "" )
//   5. Outdoor        → cat-outdoor        ( "" )
//   6. Otros          → cat-otros          (sin hijos)
//
// Idempotencia: compara normalizado el menú actual vs el target. Si igual,
// skip. Si distinto, menuUpdate (preserva el id; no se borra ni recrea).
// Si el menú "main-menu" no existe (store custom o eliminado), menuCreate.
//
// Hijo titles en el menú: derivados de "Padre — Tipo" → "Tipo" para evitar
// repetir el padre dentro del submenú.
//
// Usage:
//   node --env-file=shopify-ledsc4-theme.env scripts/setup-cat-menu.mjs [--dry-run]

import { gql, requireEnv } from './_shopify.mjs';
import {
  MENU_HANDLE,
  findMenu,
  menuCreate,
  menuUpdate,
  normaliseMenuItems,
} from './lib/shopify-collections.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
if (!DRY_RUN) requireEnv();

// Orden cerrado. cat-otros al final, sin hijos.
const PADRE_ORDER = [
  { title: 'Forlight',      handle: 'cat-forlight',      withChildren: true  },
  { title: 'Architectural', handle: 'cat-architectural', withChildren: true  },
  { title: 'Decorative',    handle: 'cat-decorative',    withChildren: true  },
  { title: 'DIY',           handle: 'cat-diy',           withChildren: true  },
  { title: 'Outdoor',       handle: 'cat-outdoor',       withChildren: true  },
  { title: 'Otros',         handle: 'cat-otros',         withChildren: false },
];

async function fetchAllCatCollections() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      collections(first: 100, after: $after, query: "handle:cat-*") {
        edges { cursor node { id handle title productsCount { count } } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const d = await gql(q, { after: cursor }, { requestedCost: 200 });
    for (const e of d.collections.edges) {
      // El search "handle:cat-*" puede devolver matches por prefijo
      // sustring; re-filtramos defensivamente.
      if (e.node.handle.startsWith('cat-')) out.push(e.node);
    }
    if (!d.collections.pageInfo.hasNextPage) break;
    cursor = d.collections.pageInfo.endCursor;
  }
  return out;
}

// Hijos de un padre = colecciones cuyo handle == padre.handle + "-" + algo.
function childrenOf(padreHandle, byHandle) {
  const prefix = `${padreHandle}-`;
  return [...byHandle.values()]
    .filter((c) => c.handle.startsWith(prefix))
    .sort((a, b) => (b.productsCount?.count ?? 0) - (a.productsCount?.count ?? 0));
}

// "Forlight — Superficie de Pared" → "Superficie de Pared".
function childTitle(t) {
  const idx = t.indexOf(' — ');
  return idx > 0 ? t.slice(idx + 3) : t;
}

function buildItems(byHandle) {
  const items = [];
  const missing = [];
  for (const padre of PADRE_ORDER) {
    const p = byHandle.get(padre.handle);
    if (!p) {
      missing.push(padre.handle);
      continue;
    }
    const item = { title: padre.title, type: 'COLLECTION', resourceId: p.id };
    if (padre.withChildren) {
      const hijos = childrenOf(padre.handle, byHandle);
      if (hijos.length) {
        item.items = hijos.map((h) => ({
          title: childTitle(h.title),
          type: 'COLLECTION',
          resourceId: h.id,
        }));
      }
    }
    items.push(item);
  }
  return { items, missing };
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Configuring menu "${MENU_HANDLE}"`);

  const [cols, existing] = await Promise.all([
    fetchAllCatCollections(),
    findMenu(),
  ]);
  console.log(`Found ${cols.length} cat-* collections; existing menu: ${existing ? existing.id : '(none)'}\n`);

  const byHandle = new Map(cols.map((c) => [c.handle, c]));
  const { items, missing } = buildItems(byHandle);

  if (missing.length) {
    console.warn(`[warn] missing top-level collections (skipping in menu): ${missing.join(', ')}`);
  }

  console.log('Planned menu structure:');
  for (const it of items) {
    console.log(`  • ${it.title}  [${it.resourceId}]`);
    for (const c of it.items ?? []) {
      console.log(`      ↳ ${c.title}  [${c.resourceId}]`);
    }
  }

  if (existing) {
    const target = normaliseMenuItems(items);
    const current = normaliseMenuItems(existing.items);
    if (target === current) {
      console.log(`\n[skip ✓] menu already matches target structure`);
      return;
    }
    if (DRY_RUN) {
      console.log(`\n[dry-run] menu differs — would menuUpdate(${existing.id})`);
      return;
    }
    const updated = await menuUpdate({
      id: existing.id,
      title: existing.title || 'Main menu',
      items,
    });
    console.log(`\n[ok] menu ${updated.id} updated (${items.length} top-level items)`);
  } else {
    if (DRY_RUN) {
      console.log(`\n[dry-run] no menu found — would menuCreate("${MENU_HANDLE}")`);
      return;
    }
    const created = await menuCreate({ title: 'Main menu', items });
    console.log(`\n[ok] menu created: ${created.id}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
