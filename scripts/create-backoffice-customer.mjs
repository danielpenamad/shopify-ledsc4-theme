#!/usr/bin/env node
// Crea (o actualiza) el customer especial con tag 'backoffice' que abre la
// página /pages/admin-backoffice. Idempotente:
//   - Si el email no existe → crea customer con el tag.
//   - Si existe sin tag    → añade el tag (no toca otros tags).
//   - Si existe con tag    → no-op.
//
// El email es PARAMETRIZABLE por env var BACKOFFICE_CUSTOMER_EMAIL
// (default: daniel.pena+backoffice@creacciones.es). Antes de la entrega al
// cliente, basta con cambiar el env var y re-ejecutar el script:
//   BACKOFFICE_CUSTOMER_EMAIL=staff@cliente.com node scripts/create-backoffice-customer.mjs --apply
// (y luego desactivar/borrar el customer viejo manualmente desde Admin).
//
// Uso:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/create-backoffice-customer.mjs              # dry-run (default)
//   ... --apply                                              # ejecuta
//
// Tras crear el customer, hay que ponerle password manualmente en Admin
// (Customers → buscar email → Send account invite). El sistema "new
// customer accounts" gestiona la auth en customer-side.

import { gql, requireEnv } from './_shopify.mjs';

const DEFAULT_EMAIL = 'daniel.pena+backoffice@creacciones.es';
const EMAIL = process.env.BACKOFFICE_CUSTOMER_EMAIL || DEFAULT_EMAIL;
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;

if (!DRY_RUN) requireEnv();

async function findCustomerByEmail(email) {
  const data = await gql(
    `
    query($q: String!) {
      customers(first: 5, query: $q) {
        edges { node { id email tags } }
      }
    }
    `,
    { q: `email:${email}` },
  );
  const edge = data.customers.edges.find((e) => (e.node.email || '').toLowerCase() === email.toLowerCase());
  return edge?.node ?? null;
}

async function createCustomer(email) {
  const data = await gql(
    `
    mutation($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email tags }
        userErrors { field message }
      }
    }
    `,
    { input: { email, tags: ['backoffice'], firstName: 'Backoffice', lastName: 'LedsC4' } },
  );
  const errs = data.customerCreate.userErrors;
  if (errs?.length) throw new Error(`customerCreate userErrors: ${JSON.stringify(errs)}`);
  return data.customerCreate.customer;
}

async function addBackofficeTag(customerId) {
  const data = await gql(
    `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }
    `,
    { id: customerId, tags: ['backoffice'] },
  );
  const errs = data.tagsAdd.userErrors;
  if (errs?.length) throw new Error(`tagsAdd userErrors: ${JSON.stringify(errs)}`);
}

async function main() {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Backoffice customer email: ${EMAIL}`);
  if (DRY_RUN) {
    console.log('[dry-run] Re-ejecuta con --apply para crear/actualizar.');
  }

  if (DRY_RUN) {
    console.log('[dry-run] Pasos que ejecutaría:');
    console.log(`[dry-run]   1. Buscar customer por email "${EMAIL}".`);
    console.log('[dry-run]   2. Si no existe → customerCreate con tag "backoffice".');
    console.log('[dry-run]   3. Si existe sin tag → tagsAdd "backoffice".');
    console.log('[dry-run]   4. Si existe con tag → no-op.');
    console.log('[dry-run] Tras --apply, asignar password en Admin (Customers → Send account invite).');
    return;
  }

  const existing = await findCustomerByEmail(EMAIL);
  if (existing) {
    if (existing.tags?.includes('backoffice')) {
      console.log(`[skip] customer ${EMAIL} ya tiene tag 'backoffice' (id ${existing.id}).`);
      return;
    }
    console.log(`[update] customer ${EMAIL} existe (id ${existing.id}) — añadiendo tag 'backoffice'.`);
    await addBackofficeTag(existing.id);
    console.log('[ok] tag añadido.');
    return;
  }

  console.log(`[create] customer ${EMAIL} no existe — creando con tag 'backoffice'.`);
  const created = await createCustomer(EMAIL);
  console.log(`[ok] creado: ${created.id}`);
  console.log('Siguiente paso: en Admin → Customers → buscar email → Send account invite (para que ponga password).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
