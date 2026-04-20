// ═════════════════════════════════════════════════════════════════════
// DEPRECATED — este snippet ya NO se usa en el workflow en producción.
// ═════════════════════════════════════════════════════════════════════
//
// Se escribió asumiendo que el Run code de Shopify Flow permitiría llamadas
// GraphQL (shopify.graphql). En Fase B descubrimos que NO:
//
//   - Flow Run code es sandbox puro (sin async, sin fetch, sin shopify.graphql).
//   - Solo se pueden hacer computaciones puras sobre el input.
//
// La creación automatizada de Company B2B se mueve a una edge function de
// Supabase:
//
//   supabase/functions/create-company-for-customer/index.ts
//
// Invocada desde W1 rama Verdadero y W2 rama Verdadero con la acción de Flow
// `Send HTTP request` con header X-Webhook-Secret. Ver:
//
//   flows/W1-walkthrough.md §6.4
//   flows/W2-walkthrough.md §3.3
//   supabase/README.md
//
// Este fichero se mantiene en el repo como referencia histórica del diseño
// original y para documentar la decisión (Opción A manual → Opción C
// Supabase) en el PR. Puede borrarse si molesta.

// ↓ código original (no ejecutado) ↓

const CATALOG_TITLE = 'Outlet general';

module.exports = async function createCompanyForCustomer({ input, shopify }) {
  const customerId = input.customer.id;
  const companyName = input.customer.metafields?.b2b?.empresa || input.record?.empresa;

  if (!companyName) {
    throw new Error('customer.metafields.b2b.empresa vacío; abortar creación de company');
  }

  // 1. ¿Ya tiene company?
  const existing = await shopify.graphql(
    `query($id: ID!) {
       customer(id: $id) {
         companyContactProfiles { id company { id name locations(first: 5) { edges { node { id } } } } }
       }
     }`,
    { id: customerId }
  );
  if (existing.customer?.companyContactProfiles?.length) {
    return { skipped: true, reason: 'already_has_company' };
  }

  // (resto del código original omitido — ver historial git si hace falta)
};
