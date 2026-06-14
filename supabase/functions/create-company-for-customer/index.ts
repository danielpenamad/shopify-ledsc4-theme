// Supabase Edge Function: create-company-for-customer
//
// Invocada desde Flow W1 (rama Then, auto-aprobación) y W2 (aprobación manual)
// tras tagear al customer como 'aprobado'. Crea Company B2B + Contact +
// Location, o UNE el customer a la Company existente de su dominio
// corporativo SOLO si ese dominio fue sembrado A MANO en
// public.company_domains.
//
// Ya NO asigna catálogo: el catálogo "Outlet general" quedó ARCHIVED y es
// arquitectura abandonada desde Fase D (checkout nativo deshabilitado,
// pedidos vía submit-order-request, 2026-05-26). Sus pasos eran la causa
// del 500 sistemático en cada alta (auditoría 2026-06-10).
//
// Roles: SOLO "System-defined Location admin role" (decisión registrada
// project_b2b_contact_roles; el ordering-only se eliminó 2026-06-11).
//
// Modelo de dominio (INVERTIDO 2026-06-14, decisión Víctor vía Dani):
// las cadenas multi-delegación van como Companies SEPARADAS. La función
// ya NO auto-siembra dominios. company_domains pasa a ser una tabla de
// gestión MANUAL: un humano añade una fila solo cuando quiere fusionar.
//   - Dominios genéricos (GENERIC_DOMAINS) → crear company normal.
//   - Dominio corporativo con fila YA en company_domains → NO crear: unir el
//     customer a esa company ({ joined: true, via: "domain" }).
//   - Dominio corporativo SIN fila → crear company nueva, sin sembrar nada.
//     (Un segundo alias del mismo dominio no sembrado crea OTRA company.)
//
// Idempotencia + race del MISMO customer (Flow W1+W2 concurrentes, caso
// iluvi): ya NO la cubre el ON CONFLICT de la siembra (eliminada). En su
// lugar serializamos por customer con un pg_advisory_lock(hashtext(id))
// session-level sostenido durante toda la sección crítica (incluidas las
// mutaciones Shopify), y re-leemos companyContactProfiles DENTRO del lock
// antes de decidir crear. Dos invocaciones del mismo customer: la segunda
// entra al lock cuando la primera ya creó → ve profiles!=[] → skipped.
//
// Auth: header X-Webhook-Secret == env CREATE_COMPANY_WEBHOOK_SECRET.
//
// Input (body JSON):
//   { "customerId": "gid://shopify/Customer/123..." }
//
// Output (200 en todos los caminos felices):
//   { created: true, companyId, companyLocationId, ... }
//   { joined: true, companyId, via: "domain", ... }
//   { skipped: true, reason: "already_has_company", companyId }
//   { error: "...", ... }                                       (4xx/5xx)
//
// Secrets requeridos en Supabase (Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN                 (scopes: read/write_companies)
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   CREATE_COMPANY_WEBHOOK_SECRET       (mismo valor en el header de Flow)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL
//                                       (inyectadas por el runtime)

import postgres from "npm:postgres@3.4.4";

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

// --- Serialización por customer (advisory lock session-level) ------------

// Serializa invocaciones concurrentes del MISMO customer (Flow W1+W2). Un
// pg_advisory_xact_lock no sirve aquí: la sección crítica incluye mutaciones
// Shopify (HTTP), no cabe en una sola transacción. Usamos un lock session-
// level sobre una conexión dedicada y corta, sostenido durante todo `fn` y
// liberado en finally (el cierre de la conexión libera el lock igualmente).
// La clave es hashtext(customerId), igual que pediría pg_advisory_xact_lock.
async function withCustomerLock<T>(
  customerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // En test no hay DB; el lock no aporta nada y no queremos conexión real.
  if (Deno.env.get("CREATE_COMPANY_TEST_MODE")) {
    return await fn();
  }
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    throw new Error("Missing SUPABASE_DB_URL env var (needed for customer lock)");
  }
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    // hashtext(text) → int4, que se promociona a la forma de clave única
    // bigint de pg_advisory_lock. Bloquea hasta que la otra invocación suelte.
    await sql`select pg_advisory_lock(hashtext(${customerId}))`;
    return await fn();
  } finally {
    try {
      await sql`select pg_advisory_unlock(hashtext(${customerId}))`;
    } catch (_) {
      // best-effort; el sql.end() de abajo libera el lock al cerrar la sesión.
    }
    await sql.end({ timeout: 5 });
  }
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

    // 3-7. Sección crítica serializada por customer: re-leemos profiles
    // DENTRO del lock y, si seguimos sin company, creamos. Dos invocaciones
    // del mismo customer no pueden crear dos companies (caso iluvi).
    return await withCustomerLock(customerId, async () => {
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

    // 5.5 Unión por dominio SOLO si está sembrado a mano: si el dominio es
    // corporativo y tiene fila en company_domains, unir a esa company. Si NO
    // tiene fila, se crea company nueva sin sembrar nada (modelo invertido
    // 2026-06-14: las cadenas multi-delegación van separadas).
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

    // 7. Unir el customer a la company recién creada (contact + rol admin).
    // Ya NO sembramos el dominio: la unión por dominio es solo para filas
    // puestas a mano por un humano.
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
    });
  } catch (e) {
    // Log explícito: el 500 de la race de iluvi.com (2026-06-11) fue
    // invisible en function_logs porque este catch no logueaba.
    console.log(JSON.stringify({
      startedAt,
      outcome: "unhandled_error",
      error: (e as Error).message,
    }));
    return jsonResponse({ startedAt, error: (e as Error).message }, 500);
  }
}

if (!Deno.env.get("CREATE_COMPANY_TEST_MODE")) {
  Deno.serve(handle);
}
