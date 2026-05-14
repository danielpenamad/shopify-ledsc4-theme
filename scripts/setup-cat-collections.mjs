#!/usr/bin/env node
// Crea/actualiza la jerarquía de colecciones del outlet B2B LedsC4 y las
// publica al catalog "Outlet general". Idempotente.
//
// Estructura (PR-CAT-RESTRUCTURE 2026-05):
//   - 5 padres SMART (cat-forlight, cat-architectural, cat-decorative,
//     cat-outdoor, cat-emergency). Reglas AND: tag:Coleccion:2026 +
//     catalogo == X.
//   - 33 hijos SMART (combos catalogo × tipo con >= 3 productos en el
//     audit). Naming: cat-{slug(catalogo)}-{slug(tipo)}. Reglas AND triple.
//     cat-emergency es padre suelto sin hijos (3 productos, sub-umbral).
//
// Estructura previa (pre-2026-05, retirada): incluía cat-diy (con 5 hijos
// smart) y cat-otros (custom, popularizada con productos catalogo ∈
// {Emergency, Ecommerce}). Sustituidos por cat-emergency tras la
// reasignación de catalogo/tipo vía scripts/sku-overrides.json (los 53
// productos cat-diy se distribuyeron en cat-forlight/cat-outdoor; los 5
// cat-otros pasaron a cat-emergency / cat-forlight-sobremesa).
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
  buildPadreRuleSet,
  buildHijoRuleSet,
  findCollectionByHandle,
  collectionCreate,
  collectionUpdate,
  resolveOnlineStorePublicationId,
  ensurePublished,
  ruleSetMatches,
} from './lib/shopify-collections.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
// requireEnv() es incondicional: dry-run sigue ejecutando TODAS las
// lecturas (resolver publication, findCollectionByHandle) contra la tienda
// real. Solo se saltan las escrituras. Si la API/credencial está rota, el
// dry-run debe explotar igual que el real.
requireEnv();

// Orden de padres en stdout/log/menú downstream (lo replica setup-cat-menu).
// cat-emergency al final (líneas residuales por orden comercial).
const PADRES = ['Forlight', 'Architectural', 'Decorative', 'Outdoor', 'Emergency'];

// Conteos esperados por padre: TOTAL de productos del outlet en ese catalogo,
// incluyendo huérfanos (tipos sub-umbral <3 y productos sin product.tipo).
// La regla del padre es solo AND(tag, catalogo) — no filtra por tipo — así
// que el conteo debe coincidir con el total del audit, no con la suma de
// los hijos top-level. Conteos actualizados tras PR-CAT-RESTRUCTURE (los
// 50 SKUs Bucket A + 4 Bucket B se reasignaron a Forlight; el SKU Bucket
// C a Outdoor; los 3 Emergency forman cat-emergency).
// (Solo informativo para el WARN de tolerancia; no se usa en reglas.)
const PADRE_EXPECTED = {
  Forlight:      226,
  Architectural: 103,
  Decorative:     72,
  Outdoor:        51,
  Emergency:       3,
};

// Subcolecciones por padre: [tipo, expectedCount]. Solo los combos con
// >= 3 productos (no incluye los descartados sub-umbral). Conteos
// actualizados tras PR-CAT-RESTRUCTURE (Forlight gana sobremesa+9,
// superficie-de-pared+5, superficie-de-techo+16, serie-de-focos+8,
// colgante+6, ventilador+3, baliza+2, proyector+2, bano+1, pie+1; Outdoor
// gana farola+1). Emergency no tiene hijos (3 productos, sub-umbral de 3).
const HIJOS = {
  Forlight: [
    ['Superficie de Pared', 55], ['Empotrable de techo', 46], ['Superficie de Techo', 22],
    ['Serie de focos', 15], ['Baliza', 14], ['Sobremesa', 14],
    ['Proyector', 13], ['Ventilador', 12], ['Colgante', 10],
    ['Baño', 6], ['Empotrable de suelo', 4], ['Tira LED', 4],
    ['Pie', 4],
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
  Outdoor: [
    ['Superficie de Pared', 14], ['Superficie de Techo', 7],
    ['Sistema lineal', 6], ['Empotrable de pared', 6],
    ['Empotrable de suelo', 5], ['Proyector', 4], ['Farola', 4],
  ],
  Emergency: [],
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

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Building cat-* outlet collections (publishing to Online Store)`);

  // Las collections viven en el Online Store publication (no en el catalog
  // B2B — ese solo acepta productos). Resolver capability-based, ver
  // resolveOnlineStorePublicationId en lib/shopify-collections.mjs.
  //
  // dry-run ejercita TODAS las lecturas (resolver publication incluido) —
  // si esto falla en dry-run, falla igual de pronto que en real.
  const publicationId = await resolveOnlineStorePublicationId();
  console.log(`Online Store publication GID: ${publicationId}\n`);

  const results = [];

  console.log('── 5 padres SMART ──');
  for (const cat of PADRES) {
    await processSmart(specPadre(cat), publicationId, results);
  }

  console.log('\n── 33 hijos SMART ──');
  for (const cat of PADRES) {
    for (const [tipo, expected] of HIJOS[cat]) {
      await processSmart(specHijo(cat, tipo, expected), publicationId, results);
    }
  }

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

  console.log(`\nTotal collections processed: ${results.length} (5 padres smart + 33 hijos smart = 38 expected)`);
  process.exit(errs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
