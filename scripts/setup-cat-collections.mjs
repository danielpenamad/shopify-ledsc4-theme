#!/usr/bin/env node
// Crea/actualiza la jerarquía de colecciones del outlet B2B LedsC4 y las
// publica al catalog "Outlet general". Idempotente.
//
// Estructura (PR-CAT-RESTRUCTURE 2026-05, ampliada 2026-07-26):
//   - 5 padres SMART (cat-forlight, cat-architectural, cat-decorative,
//     cat-outdoor, cat-emergency). Reglas AND: tag:Coleccion:2026 +
//     catalogo == X.
//   - 45 hijos SMART (combos catalogo × tipo con >= 3 productos entre los
//     que de verdad se publican). Naming: cat-{slug(catalogo)}-{slug(tipo)}.
//     Reglas AND triple.
//
// 2026-07-26: tras validar en vivo contra el SFTP + stock + precios (dry-run
// de la importación del lote de ~422 SKUs nuevos), se detectaron 12 combos
// que ya superan el umbral de >=3 productos publicables y no tenían hijo:
// emergency-superficie-de-pared, architectural-accesorio,
// outdoor-baliza, forlight-modulo, architectural-colgante,
// decorative-pie, forlight-flexo — antes sub-umbral con 2, ver nota en
// sku-overrides.json rule B, ya no aplica —, decorative-superficie-de-techo,
// architectural-modulo, decorative-proyector,
// outdoor-empotrable-de-techo, forlight-chillout. cat-emergency ya no
// es un padre suelto: gana su primer hijo.
//
// 2026-07-27: import de los ~422 SKUs completado en producción (904
// publicables) y este script ya corrido contra la tienda real — las 50
// colecciones (5 padres + 45 hijos) están creadas/actualizadas y publicadas,
// 0 errores. Solo 3 eran genuinamente nuevas (architectural-accesorio,
// architectural-colgante, architectural-modulo); el resto de los 12 ya
// existían con la regla correcta (creadas manualmente o por un run previo).
// PADRE_EXPECTED/HIJOS se refrescaron con el productsCount real devuelto por
// Shopify en ese run — ver nota junto a PADRE_EXPECTED sobre por qué el
// conteo real es más alto que "productos publicables".
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
//
// 2026-07-27: refrescados con productsCount REAL devuelto por Shopify tras
// correr el script contra producción (import de los ~422 SKUs nuevos ya
// completado, 904 publicables). La corrección de 2026-07-26 (basada en el
// dry-run) usaba el conteo de productos *publicables* (stock>0+precio>0),
// pero la smart collection cuenta TODO producto con el tag+metafield sin
// filtrar por stock/precio/estado — incluye drafts y huérfanos históricos —
// así que salía sistemáticamente por debajo del real (ej. Architectural —
// Empotrable de techo: se esperaba 54, el real es 271). Estos 3 hijos
// (Accesorio/Colgante/Módulo de Architectural) se crearon en este mismo run
// y Shopify aún no había indexado su smart rule (productsCount=0 en el
// momento de crearlos) — se deja el conteo estimado, no el 0 transitorio.
// (Solo informativo para el WARN de tolerancia; no se usa en reglas.)
const PADRE_EXPECTED = {
  Forlight:      334,
  Architectural: 417,
  Decorative:    152,
  Outdoor:       122,
  Emergency:       9,
};

// Subcolecciones por padre: [tipo, expectedCount]. Solo los combos con
// >= 3 productos (no incluye los descartados sub-umbral). Conteos
// actualizados tras PR-CAT-RESTRUCTURE, y de nuevo 2026-07-27 con
// productsCount real de Shopify tras el run de producción (ver nota de
// PADRE_EXPECTED).
const HIJOS = {
  Forlight: [
    ['Superficie de Pared', 76], ['Empotrable de techo', 60], ['Superficie de Techo', 36],
    ['Serie de focos', 22], ['Baliza', 20], ['Sobremesa', 14],
    ['Proyector', 19], ['Ventilador', 21], ['Colgante', 14],
    ['Baño', 8], ['Empotrable de suelo', 5], ['Tira LED', 4],
    ['Pie', 4], ['Módulo', 6], ['Flexo', 4], ['Chillout', 3],
  ],
  Architectural: [
    ['Empotrable de techo', 271], ['Tira LED', 19], ['Superficie de Techo', 24],
    ['Señalización', 6], ['Bajo voltaje', 11], ['Proyector', 31],
    ['Carril', 5], ['Sistema lineal', 18], ['Accesorio', 6],
    ['Colgante', 6], ['Módulo', 3],
  ],
  Decorative: [
    ['Superficie de Pared', 52], ['Luz de lectura', 25], ['Colgante', 27],
    ['Baño', 12], ['Sobremesa', 9], ['Pie', 6],
    ['Superficie de Techo', 3], ['Proyector', 4],
  ],
  Outdoor: [
    ['Superficie de Pared', 34], ['Superficie de Techo', 12],
    ['Sistema lineal', 8], ['Empotrable de pared', 7],
    ['Empotrable de suelo', 27], ['Proyector', 10], ['Farola', 9],
    ['Baliza', 9], ['Empotrable de techo', 3],
  ],
  Emergency: [
    ['Superficie de Pared', 7],
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

  console.log('\n── 45 hijos SMART ──');
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

  console.log(`\nTotal collections processed: ${results.length} (5 padres smart + 45 hijos smart = 50 expected)`);
  process.exit(errs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
