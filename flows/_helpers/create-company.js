// Snippet de referencia para el paso "Run code → create_company" de W1 y W2.
// Crea una Company B2B con 1 miembro, le asocia una CompanyLocation por
// defecto, y la añade al catálogo "Outlet general".
//
// Idempotente: si el customer ya tiene companyContactProfiles, sale sin
// crear nada.
//
// Adaptar al SDK de Flow Run code (2026). Asume un objeto `shopify` con
// método .graphql(query, variables) y un `input` del workflow.

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

  // 2. Crear Company + CompanyContact + CompanyLocation en una sola mutation
  const created = await shopify.graphql(
    `mutation($input: CompanyCreateInput!) {
       companyCreate(input: $input) {
         company {
           id name
           contacts(first: 1) { edges { node { id } } }
           locations(first: 1) { edges { node { id } } }
         }
         userErrors { field message code }
       }
     }`,
    {
      input: {
        company: { name: companyName },
        companyContact: {
          customerId,
          firstName: input.customer.first_name,
          lastName: input.customer.last_name,
          email: input.customer.email,
          title: 'Contacto principal',
        },
        companyLocation: {
          name: companyName,
          shippingAddress: { countryCode: 'ES' },
          billingSameAsShipping: true,
          buyerExperienceConfiguration: { editableShippingAddress: true },
        },
      },
    }
  );
  const errs = created.companyCreate?.userErrors || [];
  if (errs.length) throw new Error('companyCreate: ' + JSON.stringify(errs));
  const company = created.companyCreate.company;
  const locationId = company.locations.edges[0]?.node.id;

  // 3. Encontrar el catálogo "Outlet general"
  const cat = await shopify.graphql(
    `query($q: String!) {
       catalogs(first: 10, query: $q) {
         edges { node { id title } }
       }
     }`,
    { q: 'title:' + CATALOG_TITLE }
  );
  const catalog = cat.catalogs.edges.find(e => e.node.title === CATALOG_TITLE)?.node;
  if (!catalog) throw new Error('Catálogo "' + CATALOG_TITLE + '" no encontrado');

  // 4. Añadir la CompanyLocation al contexto del catálogo
  const upd = await shopify.graphql(
    `mutation($catalogId: ID!, $contextsToAdd: [ID!]!) {
       catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contextsToAdd) {
         userErrors { field message }
       }
     }`,
    { catalogId: catalog.id, contextsToAdd: [locationId] }
  );
  const uErrs = upd.catalogContextUpdate?.userErrors || [];
  if (uErrs.length) throw new Error('catalogContextUpdate: ' + JSON.stringify(uErrs));

  return {
    companyId: company.id,
    companyLocationId: locationId,
    catalogId: catalog.id,
  };
};
