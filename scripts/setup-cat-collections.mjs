#!/usr/bin/env node
// Crea/actualiza la jerarquía de colecciones del outlet B2B LedsC4 y las
// publica al catalog "Outlet general". Idempotente.
//
// Decisiones cerradas (Paso 1):
//   - 5 padres SMART (cat-forlight, cat-architectural, cat-decorative,
//     cat-diy, cat-outdoor). Reglas AND: tag:Coleccion:2026 + catalogo == X.
//   - 38 hijos SMART (combos catalogo × tipo con >= 3 productos en Paso 1).
//     Naming: cat-{slug(catalogo)}-{slug(tipo)}. Reglas AND triple.
//   - 1 padre CUSTOM: cat-otros. Smart-collection no permite OR mixto con
//     AND-tag, así que se popula manualmente con los productos cuyo
//     metafield product.catalogo ∈ {Emergency, Ecommerce}.
//
// Robustez (obligatoria por prompt):
//   - Una colección a la vez, secuencial. Sleep 500ms entre operaciones.
//   - Idempotente: existing handle → collectionUpdate; nuevo → collectionCreate.
//   - Tras upsert: publishablePublish al catalog "Outlet general" si no
//     está ya publicada en él.
//   - productsCount vs expected: si |diff| > 2, WARN (Shopify tarda
//     segundos en indexar smart rules). Nunca aborta.
//   - Errores por colección no abortan; se acumulan y reportan al final.
//
// Usage:
//   node --env-file=shopify-ledsc4-theme.env scripts/setup-cat-collections.mjs [--dry-run]

import { requireEnv } from './_shopify.mjs';
import {
  slug,
  sleep,
  OTROS_CATALOGOS,
  CATALOG_PUBLICATION_TITLE,
  buildPadreRuleSet,
  buildHijoRuleSet,
  findCollectionByHandle,
  collectionCreate,
  collectionUpdate,
  collectionAddProducts,
  resolvePublicationIdByCatalogTitle,
  ensurePublished,
  ruleSetMatches,
  iterOutletProducts,
} from './lib/shopify-collections.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// requireEnv() es incondicional: dry-run sigue ejecutando TODAS las
// lecturas (resolver publication, findCollectionByHandle, iterOutletProducts)
// contra la tienda real. Solo se saltan las escrituras. Si la API/credencial
// está rota, el dry-run debe explotar igual que el real.
requireEnv();

// Orden de padres en stdout/log/menú downstream (lo replica setup-cat-menu).
const PADRES = ['Forlight', 'Architectural', 'Decorative', 'DIY', 'Outdoor'];

// Conteos esperados por padre: TOTAL de productos del outlet en ese catalogo,
// incluyendo huérfanos (tipos sub-umbral <3 y productos sin product.tipo).
// La regla del padre es solo AND(tag, catalogo) — no filtra por tipo — así
// que el conteo debe coincidir con el total del audit, no con la suma de
// los hijos top-level. Fuente: scripts/audit-catalogo-tipo.mjs.
// (Solo informativo para el WARN de tolerancia; no se usa en reglas.)
const PADRE_EXPECTED = {
  Forlight:      172,
  Architectural: 103,
  Decorative:     72,
  DIY:            53,
  Outdoor:        50,
};

// Subcolecciones por padre: [tipo, expectedCount]. Solo los combos con
// >= 3 productos en Paso 1 (no incluye los descartados sub-umbral).
const HIJOS = {
  Forlight: [
    ['Superficie de Pared', 50], ['Empotrable de techo', 46], ['Baliza', 12],
    ['Proyector', 11], ['Ventilador', 9], ['Serie de focos', 7],
    ['Superficie de Techo', 6], ['Baño', 5], ['Sobremesa', 5],
    ['Colgante', 4], ['Empotrable de suelo', 4], ['Tira LED', 4],
    ['Pie', 3],
  ],
  Architectural: [
    ['Empotrable de techo', 54], ['Tira LED', 15], ['Superficie de Techo', 7],
    ['Señalización', 6], ['Bajo voltaje', 6], ['Proyector', 5],
    ['Carril', 5], ['Sistema lineal', 4],
  ],
  Decorative: [
    ['Superficie de Pared', 29], ['Luz de lectura', 16], ['Colgante', 9],
    ['Baño', 6], ['Sobremesa', 4],
  ],
  DIY: [
    ['Superficie de Techo', 16], ['Serie de focos', 8], ['Colgante', 6],
    ['Superficie de Pared', 5], ['Sobremesa', 5],
  ],
  Outdoor: [
    ['Superficie de Pared', 14], ['Superficie de Techo', 7],
    ['Sistema lineal', 6], ['Empotrable de pared', 6],
    ['Empotrable de suelo', 5], ['Proyector', 4], ['Farola', 3],
  ],
};

const COUNT_TOLERANCE = 2;
const SLEEP_MS = 500;

function specPadre(cat) {
  return {
    kind: 'padre-smart',
    handle: `cat-${slug(cat)}`,
    title: cat,
    expected: PADRE_EXPECTED[cat] ?? null,
    ruleSet: buildPadreRuleSet(cat),
  };
}

function specHijo(cat, tipo, expected) {
  return {
    kind: 'hijo-smart',
    handle: `cat-${slug(cat)}-${slug(tipo)}`,
    title: `${cat} — ${tipo}`,
    expected,
    ruleSet: buildHijoRuleSet(cat, tipo),
  };
}

async function upsertSmart(spec) {
  const existing = await findCollectionByHandle(spec.handle);
  if (existing) {
    const sameRules = ruleSetMatches(existing.ruleSet, spec.ruleSet);
    const sameTitle = existing.title === spec.title;
    if (sameRules && sameTitle) {
      return { collection: existing, action: 'skip' };
    }
    if (DRY_RUN) return { collection: existing, action: 'update-dry' };
    const c = await collectionUpdate({ id: existing.id, title: spec.title, ruleSet: spec.ruleSet });
    return { collection: c, action: 'update' };
  }
  if (DRY_RUN) return { collection: null, action: 'create-dry' };
  const c = await collectionCreate({ handle: spec.handle, title: spec.title, ruleSet: spec.ruleSet });
  return { collection: c, action: 'create' };
}

async function processSmart(spec, publicationId, results) {
  const start = Date.now();
  try {
    const { collection, action } = await upsertSmart(spec);
    let publishAction = 'dry';
    if (collection && !DRY_RUN) {
      const wasNewlyPublished = await ensurePublished(collection.id, publicationId);
      publishAction = wasNewlyPublished ? 'published' : 'already-published';
    }
    const got = collection?.productsCount?.count ?? null;
    const diff = got !== null && spec.expected !== null ? got - spec.expected : null;
    const warn = diff !== null && Math.abs(diff) > COUNT_TOLERANCE;
    const ms = Date.now() - start;
    const tag = warn ? 'WARN' : 'OK';
    const gotS = got !== null ? `${got}` : '?';
    console.log(`[${tag}] ${spec.handle.padEnd(40)} got=${gotS.padStart(3)} expected=${String(spec.expected).padStart(3)} action=${action}+${publishAction} (${ms}ms)`);
    results.push({
      handle: spec.handle, kind: spec.kind, title: spec.title,
      expected: spec.expected, got, action, publishAction, ms,
      warn, error: null,
    });
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[ERR ] ${spec.handle.padEnd(40)} ${err.message}`);
    results.push({
      handle: spec.handle, kind: spec.kind, title: spec.title,
      expected: spec.expected, got: null, action: null, publishAction: null, ms,
      warn: false, error: err.message,
    });
  }
  await sleep(SLEEP_MS);
}

async function processOtros(publicationId, results) {
  const handle = 'cat-otros';
  const title = 'Otros';
  const start = Date.now();
  try {
    // Resolver productos cuyos catalogo ∈ {Emergency, Ecommerce} desde
    // el universo del outlet (tag:Coleccion:2026).
    const all = await iterOutletProducts();
    const otros = all.filter((p) => p.catalogo && OTROS_CATALOGOS.has(p.catalogo));
    const productIds = otros.map((p) => p.id);
    const expected = productIds.length;
    console.log(`       cat-otros target product count = ${expected} (${otros.map((p) => p.handle).join(', ')})`);

    let collection = await findCollectionByHandle(handle);
    let action;
    if (collection) {
      if (collection.ruleSet && (collection.ruleSet.rules?.length ?? 0) > 0) {
        throw new Error(`existing "${handle}" is SMART; cat-otros debe ser CUSTOM — limpieza manual requerida`);
      }
      action = 'exists';
    } else {
      if (DRY_RUN) {
        console.log(`[DRY ] ${handle.padEnd(40)} would create CUSTOM + add ${expected} products`);
        results.push({
          handle, kind: 'padre-custom', title,
          expected, got: null, action: 'create-dry', publishAction: 'dry',
          ms: Date.now() - start, warn: false, error: null,
        });
        return;
      }
      collection = await collectionCreate({ handle, title });
      action = 'create';
    }

    if (!DRY_RUN && productIds.length) {
      await collectionAddProducts(collection.id, productIds);
    }
    const publishAction = DRY_RUN
      ? 'dry'
      : (await ensurePublished(collection.id, publicationId)) ? 'published' : 'already-published';

    // Re-leer count tras add+publish.
    const after = !DRY_RUN ? await findCollectionByHandle(handle) : null;
    const got = after?.productsCount?.count ?? null;
    const warn = got !== null && Math.abs(got - expected) > COUNT_TOLERANCE;
    const ms = Date.now() - start;
    const tag = warn ? 'WARN' : 'OK';
    console.log(`[${tag}] ${handle.padEnd(40)} got=${(got ?? '?').toString().padStart(3)} expected=${String(expected).padStart(3)} action=${action}+${publishAction} (${ms}ms)`);
    results.push({
      handle, kind: 'padre-custom', title,
      expected, got, action, publishAction, ms,
      warn, error: null,
    });
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[ERR ] ${handle.padEnd(40)} ${err.message}`);
    results.push({
      handle, kind: 'padre-custom', title,
      expected: null, got: null, action: null, publishAction: null, ms,
      warn: false, error: err.message,
    });
  }
  await sleep(SLEEP_MS);
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Building cat-* outlet collections (target catalog: "${CATALOG_PUBLICATION_TITLE}")`);

  // dry-run ejercita TODAS las lecturas (resolver publication incluido) —
  // si esto falla en dry-run, falla igual de pronto que en real. El guard
  // anterior `DRY_RUN ? GID/DRY : await ...` ocultaba el fallo de
  // resolvePublicationIdByCatalogTitle y rompía silencioso en producción.
  const publicationId = await resolvePublicationIdByCatalogTitle(CATALOG_PUBLICATION_TITLE);
  console.log(`Publication GID: ${publicationId}\n`);

  const results = [];

  console.log('── 5 padres SMART ──');
  for (const cat of PADRES) {
    await processSmart(specPadre(cat), publicationId, results);
  }

  console.log('\n── 38 hijos SMART ──');
  for (const cat of PADRES) {
    for (const [tipo, expected] of HIJOS[cat]) {
      await processSmart(specHijo(cat, tipo, expected), publicationId, results);
    }
  }

  console.log('\n── 1 custom otros ──');
  await processOtros(publicationId, results);

  // Resumen final
  console.log('\n── Summary ──');
  const oks = results.filter((r) => !r.error && !r.warn);
  const warns = results.filter((r) => r.warn);
  const errs = results.filter((r) => r.error);
  console.log(`OK:   ${oks.length}`);
  console.log(`WARN: ${warns.length}`);
  console.log(`ERR:  ${errs.length}`);

  if (warns.length) {
    console.log('\nWarnings (|productsCount - expected| > 2):');
    for (const r of warns) {
      console.log(`  ${r.handle.padEnd(40)} got=${r.got}  expected=${r.expected}`);
    }
  }
  if (errs.length) {
    console.log('\nFailures:');
    for (const r of errs) {
      console.log(`  ${r.handle.padEnd(40)} ${r.error}`);
    }
  }

  console.log(`\nTotal collections processed: ${results.length} (5 padres + 38 hijos + 1 otros = 44 expected)`);
  process.exit(errs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
