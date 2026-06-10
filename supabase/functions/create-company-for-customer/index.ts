// Supabase Edge Function: create-company-for-customer
//
// Invocada desde Flow W1 (rama Then, auto-aprobación) y W2 (aprobación manual)
// tras tagear al customer como 'aprobado'. Crea Company B2B + Contact +
// Location, o UNE el customer a la Company existente de su dominio
// corporativo (tabla public.company_domains; decisión de negocio Víctor
// 2026-06-10 para frenar la duplicación de Companies por organización).
//
// Ya NO asigna catálogo: el catálogo "Outlet general" quedó ARCHIVED y es
// arquitectura abandonada desde Fase D (checkout nativo deshabilitado,
// pedidos vía submit-order-request, 2026-05-26). Sus pasos eran la causa
// del 500 sistemático en cada alta (auditoría 2026-06-10).
//
// Roles: SOLO "System-defined Location admin role" (decisión registrada
// project_b2b_contact_roles; el ordering-only se eliminó 2026-06-11).
//
// Unificación por dominio:
//   - Dominios genéricos (GENERIC_DOMAINS) → crear company normal, sin tabla.
//   - Dominio corporativo con fila en company_domains → NO crear: unir el
//     customer a esa company ({ joined: true, via: "domain" }).
//   - Dominio corporativo sin fila → crear company + INSERT con
//     ON CONFLICT DO NOTHING. Si el insert no inserta (otra invocación
//     concurrente ganó — caso josepinas), unir el customer a la company
//     ganadora y borrar la recién creada (companyDelete).
//
// Idempotente: si el customer ya tiene companyContactProfiles, salta sin
// crear nada.
//
// Auth: header X-Webhook-Secret == env CREATE_COMPANY_WEBHOOK_SECRET.
//
// Input (body JSON):
//   { "customerId": "gid://shopify/Customer/123..." }
//
// Output (200 en todos los caminos felices):
//   { created: true, companyId, companyLocationId, ... }
//   { joined: true, companyId, via: "domain" | "domain_race", ... }
//   { skipped: true, reason: "already_has_company", companyId }
//   { error: "...", ... }                                       (4xx/5xx)
//
// Secrets requeridos en Supabase (Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN                 (scopes: read/write_companies)
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   CREATE_COMPANY_WEBHOOK_SECRET       (mismo valor en el header de Flow)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (inyectadas por el runtime)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const WEBHOOK_SECRET = Deno.env.get("CREATE_COMPANY_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}
if (!WEBHOOK_SECRET) {
  throw new Error("Missing CREATE_COMPANY_WEBHOOK_SECRET env var");
}
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

const ADMIN_ROLE_NOTE = "System-defined Location admin role";

// Dominios de email personales: nunca agrupan company. Constante en código
// a propósito (lista corta y estable; un cambio es un deploy consciente).
export const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "yahoo.es",
  "icloud.com",
  "live.com",
  "msn.com",
  "protonmail.com",
  "aol.com",
]);

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

// --- company_domains (PostgREST con service role; RLS sin policies) -----

type DomainRow = { company_id: string; company_location_id: string };

const sbHeaders = {
  apikey: SERVICE_ROLE_KEY!,
  Authorization: `Bearer ${SERVICE_ROLE_KEY!}`,
};

async function lookupDomain(domain: string): Promise<DomainRow | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/company_domains?domain=eq.${encodeURIComponent(domain)}&select=company_id,company_location_id`,
    { headers: sbHeaders },
  );
  if (!res.ok) {
    throw new Error(`company_domains lookup HTTP ${res.status}: ${await res.text()}`);
  }
  const rows = (await res.json()) as DomainRow[];
  return rows[0] ?? null;
}

// true = esta invocación registró el dominio; false = conflicto (otra ganó).
async function insertDomain(
  domain: string,
  companyId: string,
  companyLocationId: string,
): Promise<boolean> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/company_domains?on_conflict=domain`,
    {
      method: "POST",
      headers: {
        ...sbHeaders,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify({
        domain,
        company_id: companyId,
        company_location_id: companyLocationId,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`company_domains insert HTTP ${res.status}: ${await res.text()}`);
  }
  const rows = (await res.json()) as unknown[];
  return rows.length > 0;
}

// --- Shopify helpers -----------------------------------------------------

// Asigna el customer como contact de una company y le da el rol admin
// sobre la location indicada. Lanza Error con detalle si algo falla.
async function joinCustomerToCompany(
  companyId: string,
  companyLocationId: string,
  customerId: string,
): Promise<{ companyContactId: string; assignedRoleIds: string[] }> {
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
    { companyId, customerId },
  );
  const assignErrs = assignRes.companyAssignCustomerAsContact.userErrors;
  if (assignErrs.length) {
    throw new Error(`companyAssignCustomerAsContact userErrors: ${JSON.stringify(assignErrs)}`);
  }
  const companyContactId = assignRes.companyAssignCustomerAsContact.companyContact?.id;
  if (!companyContactId) {
    throw new Error("companyAssignCustomerAsContact no devolvió companyContact.id");
  }

  // Los CompanyContactRole son per-Company (IDs distintos por company); se
  // leen de la company destino y se mapean por `note` de sistema (estable),
  // no por `name` (localizable/editable).
  const rolesRes = await gql<{
    company: {
      contactRoles: { edges: Array<{ node: { id: string; name: string; note: string } }> };
    } | null;
  }>(
    `
    query($id: ID!) {
      company(id: $id) {
        contactRoles(first: 10) { edges { node { id name note } } }
      }
    }
    `,
    { id: companyId },
  );
  const roleNodes = rolesRes.company?.contactRoles.edges.map((e) => e.node) ?? [];
  const adminRole = roleNodes.find((r) => r.note === ADMIN_ROLE_NOTE);
  if (!adminRole) {
    throw new Error(
      `rol admin de sistema no encontrado en company ${companyId}; roles: ${JSON.stringify(roleNodes)}`,
    );
  }

  const roleAssignRes = await gql<{
    companyContactAssignRoles: {
      roleAssignments: Array<{ id: string }> | null;
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  }>(
    `
    mutation($companyContactId: ID!, $rolesToAssign: [CompanyContactRoleAssign!]!) {
      companyContactAssignRoles(companyContactId: $companyContactId, rolesToAssign: $rolesToAssign) {
        roleAssignments { id }
        userErrors { field message code }
      }
    }
    `,
    {
      companyContactId,
      rolesToAssign: [{ companyContactRoleId: adminRole.id, companyLocationId }],
    },
  );
  const roleErrs = roleAssignRes.companyContactAssignRoles.userErrors;
  if (roleErrs.length) {
    throw new Error(`companyContactAssignRoles userErrors: ${JSON.stringify(roleErrs)}`);
  }
  const assignedRoleIds =
    (roleAssignRes.companyContactAssignRoles.roleAssignments ?? []).map((a) => a.id);
  return { companyContactId, assignedRoleIds };
}

async function deleteCompany(companyId: string): Promise<void> {
  const res = await gql<{
    companyDelete: {
      deletedCompanyId: string | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(
    `
    mutation($id: ID!) {
      companyDelete(id: $id) {
        deletedCompanyId
        userErrors { field message }
      }
    }
    `,
    { id: companyId },
  );
  const errs = res.companyDelete.userErrors;
  if (errs.length) {
    throw new Error(`companyDelete userErrors: ${JSON.stringify(errs)}`);
  }
}

// --- Handler -------------------------------------------------------------

export async function handle(req: Request): Promise<Response> {
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

    // 5.5 Unificación por dominio: si el dominio es corporativo y ya tiene
    // company registrada, unir en silencio (decisión Víctor 2026-06-10).
    const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
    const isCorporateDomain = domain.length > 0 && !GENERIC_DOMAINS.has(domain);

    if (isCorporateDomain) {
      const existingRow = await lookupDomain(domain);
      if (existingRow) {
        const joined = await joinCustomerToCompany(
          existingRow.company_id,
          existingRow.company_location_id,
          customerId,
        );
        return jsonResponse({
          startedAt,
          joined: true,
          via: "domain",
          customerId,
          domain,
          companyId: existingRow.company_id,
          companyLocationId: existingRow.company_location_id,
          companyContactId: joined.companyContactId,
          assignedRoleIds: joined.assignedRoleIds,
        });
      }
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

    // 6.5 Registrar el dominio ANTES de unir el contact: el PK sobre domain
    // es el árbitro de la race. Si el insert conflicta, otra invocación
    // concurrente ganó (caso josepinas): unimos el customer a SU company y
    // borramos la nuestra para no dejar duplicado.
    if (isCorporateDomain) {
      const won = await insertDomain(domain, company.id, companyLocationId);
      if (!won) {
        const winner = await lookupDomain(domain);
        if (!winner) {
          // Conflicto pero la fila no aparece: estado inesperado; seguimos
          // con nuestra company antes que dejar al cliente sin acceso.
          console.log(JSON.stringify({
            startedAt,
            outcome: "domain_conflict_but_no_row",
            domain,
            companyId: company.id,
          }));
        } else if (winner.company_id !== company.id) {
          const joined = await joinCustomerToCompany(
            winner.company_id,
            winner.company_location_id,
            customerId,
          );
          await deleteCompany(company.id);
          return jsonResponse({
            startedAt,
            joined: true,
            via: "domain_race",
            customerId,
            domain,
            companyId: winner.company_id,
            companyLocationId: winner.company_location_id,
            companyContactId: joined.companyContactId,
            assignedRoleIds: joined.assignedRoleIds,
            deletedCompanyId: company.id,
          });
        }
      }
    }

    // 7. Unir el customer a la company recién creada (contact + rol admin)
    const joined = await joinCustomerToCompany(company.id, companyLocationId, customerId);

    return jsonResponse({
      startedAt,
      created: true,
      customerId,
      domain: isCorporateDomain ? domain : null,
      companyId: company.id,
      companyName: company.name,
      companyLocationId,
      companyContactId: joined.companyContactId,
      assignedRoleIds: joined.assignedRoleIds,
    });
  } catch (e) {
    return jsonResponse({ startedAt, error: (e as Error).message }, 500);
  }
}

if (!Deno.env.get("CREATE_COMPANY_TEST_MODE")) {
  Deno.serve(handle);
}
