// Supabase Edge Function: create-company-for-customer
//
// Invocada desde Flow W1 (rama Then, auto-aprobación) y W2 (aprobación manual)
// tras tagear al customer como 'aprobado'. Crea Company B2B + Contact +
// Location y asigna la location al catálogo "Outlet general".
//
// Reemplaza el paso manual de backoffice (Opción A previa). Migración a
// Opción C (Supabase) tomada 2026-04-19 tras confirmar que Flow expone la
// acción "Send HTTP request".
//
// Idempotente: si el customer ya tiene companyContactProfiles, salta sin
// crear nada.
//
// Auth: header X-Webhook-Secret == env CREATE_COMPANY_WEBHOOK_SECRET.
//
// Input (body JSON):
//   { "customerId": "gid://shopify/Customer/123..." }
//
// Output:
//   { created: true, companyId, companyLocationId, catalogId }          (200 creado)
//   { skipped: true, reason: "already_has_company", companyId }          (200 idempotente)
//   { error: "...", ... }                                                (4xx/5xx)
//
// Secrets requeridos en Supabase (Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN                 (scopes: read/write_companies + read_publications)
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   CREATE_COMPANY_WEBHOOK_SECRET       (mismo valor en el header de Flow)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const WEBHOOK_SECRET = Deno.env.get("CREATE_COMPANY_WEBHOOK_SECRET");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}
if (!WEBHOOK_SECRET) {
  throw new Error("Missing CREATE_COMPANY_WEBHOOK_SECRET env var");
}

const CATALOG_TITLE = "Outlet general";
const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();

  // 1. Auth: X-Webhook-Secret header
  const providedSecret = req.headers.get("x-webhook-secret");
  if (providedSecret !== WEBHOOK_SECRET) {
    return jsonResponse({ startedAt, error: "invalid or missing X-Webhook-Secret header" }, 401);
  }

  try {
    // 2. Parse body
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const customerId = (body.customerId ?? body.customer_id) as string | undefined;
    if (!customerId || typeof customerId !== "string" || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({
        startedAt,
        error: "missing or invalid 'customerId' in body (expected gid://shopify/Customer/...)",
      }, 400);
    }

    // 3. Fetch customer + metafields + existing company profiles.
    // Admin API expone customer.metafields como Connection (edges/node),
    // distinto a Flow Run code donde es un array plano. Usamos namespace
    // arg para filtrar a "b2b" y reducir payload.
    const data = await gql<{
      customer: {
        id: string;
        firstName: string;
        lastName: string;
        defaultEmailAddress: { emailAddress: string } | null;
        companyContactProfiles: Array<{ id: string; company: { id: string; name: string } }>;
        metafields: {
          edges: Array<{ node: { namespace: string; key: string; value: string } }>;
        };
      } | null;
    }>(
      `
      query($id: ID!) {
        customer(id: $id) {
          id
          firstName
          lastName
          defaultEmailAddress { emailAddress }
          companyContactProfiles {
            id
            company { id name }
          }
          metafields(namespace: "b2b", first: 20) {
            edges { node { namespace key value } }
          }
        }
      }
      `,
      { id: customerId },
    );

    const customer = data.customer;
    if (!customer) {
      return jsonResponse({ startedAt, error: `customer not found: ${customerId}` }, 404);
    }

    // 4. Idempotencia: skip si ya tiene company
    if (customer.companyContactProfiles.length > 0) {
      const existing = customer.companyContactProfiles[0];
      return jsonResponse({
        startedAt,
        skipped: true,
        reason: "already_has_company",
        customerId,
        companyId: existing.company.id,
        companyName: existing.company.name,
      });
    }

    // 5. Validaciones — aplanar edges
    const mfList = customer.metafields.edges.map((e) => e.node);
    const empresaMf = mfList.find(
      (m) => m.namespace === "b2b" && m.key === "empresa",
    );
    const empresa = empresaMf?.value?.trim() || "";
    if (!empresa) {
      return jsonResponse({
        startedAt,
        error: "customer has no b2b.empresa metafield; cannot create company",
        customerId,
      }, 400);
    }

    const email = customer.defaultEmailAddress?.emailAddress || "";
    if (!email) {
      return jsonResponse({ startedAt, error: "customer has no default email", customerId }, 400);
    }

    // 6. companyCreate — solo Company + Location. El Contact lo creamos
    // en un paso separado con companyAssignCustomerAsContact porque el
    // companyContact de companyCreate crearía un NUEVO customer en vez de
    // linkear el existente.
    const createRes = await gql<{
      companyCreate: {
        company: {
          id: string;
          name: string;
          locations: { edges: Array<{ node: { id: string } }> };
        } | null;
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    }>(
      `
      mutation($input: CompanyCreateInput!) {
        companyCreate(input: $input) {
          company {
            id
            name
            locations(first: 1) { edges { node { id } } }
          }
          userErrors { field message code }
        }
      }
      `,
      {
        input: {
          company: { name: empresa },
          companyLocation: {
            name: empresa,
            shippingAddress: {
              address1: "Por completar al primer pedido",
              city: "Madrid",
              zip: "28001",
              countryCode: "ES",
            },
            billingSameAsShipping: true,
          },
        },
      },
    );

    const createErrs = createRes.companyCreate.userErrors;
    if (createErrs.length) {
      return jsonResponse({
        startedAt,
        error: "companyCreate userErrors",
        userErrors: createErrs,
      }, 500);
    }

    const company = createRes.companyCreate.company!;
    const companyLocationId = company.locations.edges[0]?.node.id;
    if (!companyLocationId) {
      return jsonResponse({
        startedAt,
        error: "company created but no location returned",
        companyId: company.id,
      }, 500);
    }

    // 6.5 Asignar el customer existente como contacto de la Company
    const assignRes = await gql<{
      companyAssignCustomerAsContact: {
        companyContact: { id: string } | null;
        userErrors: Array<{ field: string[]; message: string; code: string }>;
      };
    }>(
      `
      mutation($companyId: ID!, $customerId: ID!) {
        companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
          companyContact { id }
          userErrors { field message code }
        }
      }
      `,
      { companyId: company.id, customerId },
    );

    const assignErrs = assignRes.companyAssignCustomerAsContact.userErrors;
    if (assignErrs.length) {
      return jsonResponse({
        startedAt,
        error: "companyAssignCustomerAsContact userErrors — company creada pero customer NO linkeado como contact",
        userErrors: assignErrs,
        companyId: company.id,
        companyLocationId,
      }, 500);
    }

    // 7. Buscar catálogo "Outlet general"
    const catRes = await gql<{
      catalogs: { edges: Array<{ node: { id: string; title: string } }> };
    }>(
      `
      query($q: String!) {
        catalogs(first: 10, query: $q) {
          edges { node { id title } }
        }
      }
      `,
      { q: `title:${CATALOG_TITLE}` },
    );

    const catalog = catRes.catalogs.edges.find((e) => e.node.title === CATALOG_TITLE)?.node;
    if (!catalog) {
      return jsonResponse({
        startedAt,
        error: `catalog "${CATALOG_TITLE}" not found — company created but NOT linked to catalog`,
        companyId: company.id,
        companyLocationId,
      }, 500);
    }

    // 8. Asignar la CompanyLocation al catálogo
    const updRes = await gql<{
      catalogContextUpdate: {
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `
      mutation($catalogId: ID!, $contextsToAdd: CatalogContextInput!) {
        catalogContextUpdate(catalogId: $catalogId, contextsToAdd: $contextsToAdd) {
          userErrors { field message }
        }
      }
      `,
      {
        catalogId: catalog.id,
        contextsToAdd: { companyLocationIds: [companyLocationId] },
      },
    );

    const updErrs = updRes.catalogContextUpdate.userErrors;
    if (updErrs.length) {
      return jsonResponse({
        startedAt,
        error: "catalogContextUpdate userErrors — company creada pero no linkeada al catálogo",
        userErrors: updErrs,
        companyId: company.id,
        companyLocationId,
        catalogId: catalog.id,
      }, 500);
    }

    return jsonResponse({
      startedAt,
      created: true,
      customerId,
      companyId: company.id,
      companyName: company.name,
      companyLocationId,
      catalogId: catalog.id,
    });
  } catch (e) {
    return jsonResponse({ startedAt, error: (e as Error).message }, 500);
  }
});
