// Reusable helpers para gestionar smart/custom collections y publicaciones
// del outlet B2B de LedsC4. Construido sobre el cliente GraphQL Admin de
// scripts/_shopify.mjs (cost-aware throttling + retry incluido ahí).
//
// Diseño:
//   - Idempotencia: findCollectionByHandle + upsert.
//   - Reglas de smart collection se construyen con buildPadreRuleSet /
//     buildHijoRuleSet (eje 1: metafield product.catalogo; eje 2: metafield
//     product.tipo).
//   - Publicación: dos destinos distintos, dos resolvers distintos.
//       · Collections → Online Store publication. Resolver:
//         resolveOnlineStorePublicationId() (capability-based, no usa nombre
//         porque el admin localiza el name — este shop lo tiene como
//         "Tienda online").
//       · Productos al catalog B2B → CompanyLocationCatalog publication.
//         Resolver: resolvePublicationIdByCatalogTitle(CATALOG_PUBLICATION_TITLE).
//     B2B catalog publications NO aceptan collections — Shopify devuelve
//     "Cannot publish a collection to a publication that does not belong to
//     a channel catalog".
//
// Consumidores actuales: scripts/setup-cat-collections.mjs,
// scripts/setup-cat-menu.mjs. publish-catalog-products.mjs es autocontenido
// pero comparte semántica con CATALOG_PUBLICATION_TITLE.

import { gql } from '../_shopify.mjs';

// ─── Constantes del dominio ────────────────────────────────────────────────

export const COLLECTION_TAG = 'Coleccion:2026';
export const MIN_SUBNIVEL = 3;

// Título del B2B catalog donde publicamos PRODUCTOS (no colecciones).
// Lo gobierna scripts/setup-b2b-catalog.mjs. Usado por
// resolvePublicationIdByCatalogTitle.
export const CATALOG_PUBLICATION_TITLE = 'Outlet general';

// Metafield definitions IDs (resueltos en Paso 1 — auditoría).
export const META_DEF_CATALOGO_GID = 'gid://shopify/MetafieldDefinition/379919106375';
export const META_DEF_TIPO_GID     = 'gid://shopify/MetafieldDefinition/382763630919';

// Catálogos que caen al bucket "Otros" (smart-collection no permite OR
// mixto con AND-tag, así que cat-otros se crea como CUSTOM y se popula
// añadiendo productos manualmente).
export const OTROS_CATALOGOS = new Set(['Emergency', 'Ecommerce']);

// ─── Utilidades ────────────────────────────────────────────────────────────

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// NFD-strip acentos + lowercase + colapsar separadores a "-".
// "Empotrable de Suelo" → "empotrable-de-suelo"
// "Señalización" → "senalizacion"
// "Tira LED" → "tira-led"
export function slug(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Smart-collection rule builders ───────────────────────────────────────

export function buildPadreRuleSet(catalogo) {
  return {
    appliedDisjunctively: false,
    rules: [
      { column: 'TAG', relation: 'EQUALS', condition: COLLECTION_TAG },
      {
        column: 'PRODUCT_METAFIELD_DEFINITION',
        relation: 'EQUALS',
        condition: catalogo,
        conditionObjectId: META_DEF_CATALOGO_GID,
      },
    ],
  };
}

export function buildHijoRuleSet(catalogo, tipo) {
  return {
    appliedDisjunctively: false,
    rules: [
      { column: 'TAG', relation: 'EQUALS', condition: COLLECTION_TAG },
      {
        column: 'PRODUCT_METAFIELD_DEFINITION',
        relation: 'EQUALS',
        condition: catalogo,
        conditionObjectId: META_DEF_CATALOGO_GID,
      },
      {
        column: 'PRODUCT_METAFIELD_DEFINITION',
        relation: 'EQUALS',
        condition: tipo,
        conditionObjectId: META_DEF_TIPO_GID,
      },
    ],
  };
}

// Compara ruleSets sin importar el orden de las reglas. conditionObjectId
// no se devuelve en la query (solo column/relation/condition), así que la
// comparación es estructural por esos 3 campos.
export function ruleSetMatches(existing, expected) {
  if (!existing) return false;
  if (existing.appliedDisjunctively !== expected.appliedDisjunctively) return false;
  if ((existing.rules?.length ?? 0) !== expected.rules.length) return false;
  const norm = (r) => `${r.column}|${r.relation}|${r.condition}`;
  const a = new Set(existing.rules.map(norm));
  const b = new Set(expected.rules.map(norm));
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ─── CRUD collections ──────────────────────────────────────────────────────

export async function findCollectionByHandle(handle) {
  const q = `query($h: String!) {
    collectionByHandle(handle: $h) {
      id title handle
      productsCount { count }
      ruleSet { appliedDisjunctively rules { column relation condition } }
    }
  }`;
  const d = await gql(q, { h: handle }, { requestedCost: 20 });
  return d.collectionByHandle;
}

export async function collectionCreate({ handle, title, ruleSet }) {
  const m = `mutation($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id handle title
        productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }`;
  const input = { title, handle };
  if (ruleSet) input.ruleSet = ruleSet;
  const d = await gql(m, { input }, { requestedCost: 50 });
  const errs = d.collectionCreate.userErrors ?? [];
  if (errs.length) throw new Error(`collectionCreate ${handle}: ${JSON.stringify(errs)}`);
  return d.collectionCreate.collection;
}

export async function collectionUpdate({ id, title, ruleSet }) {
  const m = `mutation($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id handle title
        productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
      userErrors { field message }
    }
  }`;
  const input = { id };
  if (title !== undefined) input.title = title;
  if (ruleSet !== undefined) input.ruleSet = ruleSet;
  const d = await gql(m, { input }, { requestedCost: 50 });
  const errs = d.collectionUpdate.userErrors ?? [];
  if (errs.length) throw new Error(`collectionUpdate ${id}: ${JSON.stringify(errs)}`);
  return d.collectionUpdate.collection;
}

export async function collectionAddProducts(collectionId, productIds) {
  if (!productIds.length) return null;
  const m = `mutation($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id productsCount { count } }
      userErrors { field message }
    }
  }`;
  const d = await gql(
    m,
    { id: collectionId, productIds },
    { requestedCost: 50 }
  );
  const errs = d.collectionAddProducts.userErrors ?? [];
  if (errs.length) throw new Error(`collectionAddProducts: ${JSON.stringify(errs)}`);
  return d.collectionAddProducts.collection;
}

// ─── Publicaciones (dos destinos: Online Store vs B2B catalog) ────────────

/**
 * Resuelve el publication GID del Online Store, destino de las collections.
 *
 * IMPORTANTE: las collections SOLO se pueden publicar a sales channel
 * publications (las que no tienen `catalog`). Publicarlas a un B2B
 * CompanyLocationCatalog devuelve:
 *   "Cannot publish a collection to a publication that does not belong to
 *    a channel catalog."
 *
 * NO filtramos por `name === "Online Store"` porque el admin localiza el
 * name según el idioma del staff. En este shop (LedsC4 B2B) el name viene
 * como "Tienda online", en otros como "Online Store". Filtrar por nombre es
 * frágil entre tiendas.
 *
 * Ruta capability-based (resistente a locale):
 *   1. publications → iterar los nativos (Online Store, Point of Sale, Shop).
 *   2. `catalog === null` descarta cualquier publication asociada a un
 *      catalog B2B/Market/App (esas tienen un catalog no nulo).
 *   3. `supportsFuturePublishing === true` es exclusivo del Online Store
 *      entre las tres publications nativas (POS y Shop devuelven false).
 *      Combinado con (2), identifica unívocamente el Online Store.
 *
 * Devuelve el GID. Lanza si no encuentra el Online Store (caso de tienda mal
 * configurada), listando lo que vio para diagnóstico.
 */
export async function resolveOnlineStorePublicationId() {
  const seen = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      publications(first: 100, after: $after) {
        edges {
          cursor
          node {
            id name
            supportsFuturePublishing
            catalog { id }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const d = await gql(q, { after: cursor }, { requestedCost: 50 });
    for (const e of d.publications.edges) {
      const n = e.node;
      const hasCatalog = n.catalog != null;
      seen.push({
        id: n.id, name: n.name,
        supportsFuturePublishing: n.supportsFuturePublishing,
        hasCatalog,
      });
      if (!hasCatalog && n.supportsFuturePublishing === true) return n.id;
    }
    if (!d.publications.pageInfo.hasNextPage) break;
    cursor = d.publications.pageInfo.endCursor;
  }
  throw new Error(
    `No Online Store publication found (looked for catalog=null AND ` +
    `supportsFuturePublishing=true). Seen: ${JSON.stringify(seen)}.`
  );
}

/**
 * Resuelve el publication GID de un B2B catalog por su título.
 *
 * Para PRODUCTOS al catalog B2B (lo que hace scripts/publish-catalog-products.mjs
 * con "Outlet general"). NO para colecciones — esas van al Online Store; ver
 * resolveOnlineStorePublicationId.
 *
 * IMPORTANTE: la conexión raíz `publications` no incluye los B2B catalogs;
 * solo enumera sales channels. Hay que entrar por la conexión `catalogs`
 * y extraer publication.id del fragmento CompanyLocationCatalog (otros
 * catalog kinds no tienen ese campo).
 *
 * Mismo patrón que usan scripts/publish-catalog-products.mjs y
 * supabase/functions/create-company-for-customer/index.ts.
 */
export async function resolvePublicationIdByCatalogTitle(title) {
  const q = `query($q: String!) {
    catalogs(first: 50, query: $q) {
      edges {
        node {
          id title
          ... on CompanyLocationCatalog { publication { id } }
        }
      }
    }
  }`;
  const d = await gql(q, { q: `title:${title}` }, { requestedCost: 30 });
  const edges = d.catalogs?.edges ?? [];
  const node = edges.find((e) => e.node.title === title)?.node;
  if (!node) {
    const seen = edges.map((e) => e.node.title);
    throw new Error(
      `No B2B catalog matches title "${title}". Seen titles: ${JSON.stringify(seen)}. ` +
      `If the catalog exists under a different name, fix CATALOG_PUBLICATION_TITLE in this lib. ` +
      `If it doesn't exist yet, run scripts/setup-b2b-catalog.mjs first.`
    );
  }
  if (!node.publication?.id) {
    throw new Error(
      `B2B catalog "${title}" (${node.id}) exists but has no publication. ` +
      `Run scripts/setup-b2b-catalog.mjs to ensure the publication.`
    );
  }
  return node.publication.id;
}

export async function isPublishedOn(collectionId, publicationId) {
  const q = `query($id: ID!, $pub: ID!) {
    collection(id: $id) { publishedOnPublication(publicationId: $pub) }
  }`;
  const d = await gql(q, { id: collectionId, pub: publicationId }, { requestedCost: 10 });
  return d.collection?.publishedOnPublication === true;
}

export async function publishablePublish(collectionId, publicationId) {
  const m = `mutation($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }`;
  const d = await gql(
    m,
    { id: collectionId, input: [{ publicationId }] },
    { requestedCost: 30 }
  );
  const errs = d.publishablePublish.userErrors ?? [];
  if (errs.length) throw new Error(`publishablePublish ${collectionId}: ${JSON.stringify(errs)}`);
}

// Devuelve true si hubo que publicar; false si ya estaba publicada.
export async function ensurePublished(collectionId, publicationId) {
  if (await isPublishedOn(collectionId, publicationId)) return false;
  await publishablePublish(collectionId, publicationId);
  return true;
}

// ─── Producto iteration (para cat-otros y verificación) ────────────────────

// Pagina TODOS los productos con el tag del outlet, devolviendo
// { id, handle, title, catalogo, tipo } (los metafields como strings o null).
// Cost: ~200 por página, 100 productos/página. Para 455 productos = ~5 páginas.
export async function iterOutletProducts() {
  const out = [];
  let cursor = null;
  while (true) {
    const q = `query($after: String) {
      products(first: 100, after: $after, query: "tag:${COLLECTION_TAG}") {
        edges {
          cursor
          node {
            id handle title
            catalogo: metafield(namespace: "product", key: "catalogo") { value }
            tipo:     metafield(namespace: "product", key: "tipo")     { value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const d = await gql(q, { after: cursor }, { requestedCost: 200 });
    for (const e of d.products.edges) {
      out.push({
        id: e.node.id,
        handle: e.node.handle,
        title: e.node.title,
        catalogo: e.node.catalogo?.value ?? null,
        tipo:     e.node.tipo?.value     ?? null,
      });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    cursor = d.products.pageInfo.endCursor;
  }
  return out;
}

// ─── Menu (main-menu) ──────────────────────────────────────────────────────

export const MENU_HANDLE = 'main-menu';

export async function findMenu(handle = MENU_HANDLE) {
  const q = `query {
    menus(first: 50, query: "handle:${handle}") {
      edges {
        node {
          id handle title
          items {
            id title type url resourceId
            items { id title type url resourceId }
          }
        }
      }
    }
  }`;
  const d = await gql(q, {}, { requestedCost: 30 });
  return d.menus.edges.find((e) => e.node.handle === handle)?.node ?? null;
}

// Normaliza items para comparación estructural (sin id, sin url derivada).
export function normaliseMenuItems(items) {
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

export async function menuCreate({ handle = MENU_HANDLE, title, items }) {
  const m = `mutation($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id handle title }
      userErrors { field message }
    }
  }`;
  const d = await gql(m, { title, handle, items }, { requestedCost: 80 });
  const errs = d.menuCreate.userErrors ?? [];
  if (errs.length) throw new Error(`menuCreate: ${JSON.stringify(errs)}`);
  return d.menuCreate.menu;
}

export async function menuUpdate({ id, handle = MENU_HANDLE, title, items }) {
  const m = `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu { id handle title }
      userErrors { field message }
    }
  }`;
  const d = await gql(m, { id, title, handle, items }, { requestedCost: 80 });
  const errs = d.menuUpdate.userErrors ?? [];
  if (errs.length) throw new Error(`menuUpdate: ${JSON.stringify(errs)}`);
  return d.menuUpdate.menu;
}
