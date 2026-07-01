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
// Garantía del rol (auto-reparación, 2026-06-16): joinCustomerToCompany es
// idempotente y asegura el rol SIEMPRE, en cualquier camino de alta/unión. Si
// el customer ya es contacto, NO aborta: resuelve el companyContactId existente
// y continúa. ensureAdminRole lee los roleAssignments y solo asigna si falta
// (no-op si ya está). Esto repara el bug histórico: si el paso de assign-rol
// fallaba una vez, el contacto quedaba con roleAssignments=[] permanentemente
// ("no permisos para comprar"). Un reintento ahora converge a "contacto + rol".
//
// Cupo 49/location + SELECCIÓN POR OCUPACIÓN: Shopify admite 50 como techo,
// pero el slot nº 50 no puede comprar ("You can't purchase for this location"),
// así que el cupo operativo real es 49 (ver LOCATION_HARD_CAP). ensureAdminRole
// NO se clava en una location fija: lee la ocupación de todas las sedes de la
// company y coloca al
// contacto en una con hueco según política SOFT_CAP/HARD_CAP (concentra para
// no dejar sedes casi vacías y deja margen ante concurrencia). Solo cuando
// TODAS las sedes están al HARD_CAP crea UNA sede de overflow nueva
// ("<company> — sede N+1"), replicando la buyerExperienceConfiguration de la
// primera y sin catálogo propio → un contacto en sede 2/3/… compra idéntico a
// la principal (mismo Market ES/EUR). Así la company escala a cualquier nº de
// contactos sola, sin 409 ni repuntado manual de company_domains (cuya
// company_location_id pasa a ser una pista obsoleta con multi-sede).
// Modelo aplicado en la madre LedsC4 SA: primaria llena, "sede 2" como
// overflow. LocationFullError/409 queda solo como red de seguridad para el caso
// imposible (una sede recién creada que ya esté llena).
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

// Cupo operativo por company location: 49 asignaciones de cliente. Shopify
// admite 50 como techo de plataforma (CONFIRMADO empíricamente: la primaria de
// la madre devolvió LIMIT_REACHED a 50 exactos, 2026-06-16), PERO el contacto
// nº 50 se queda sin capacidad de compra efectiva ("You can't purchase for this
// location") pese a tener el rol asignado, así que el último slot es inservible
// y el límite real es 49 (2026-07-01). HARD_CAP es ese cupo operativo; SOFT_CAP
// es un umbral con margen: durante operación normal colocamos contactos en
// sedes por debajo de SOFT_CAP para dejar holgura ante concurrencia, y solo
// rellenamos la franja SOFT..HARD cuando TODAS las sedes ya superaron SOFT.
// Una sede de overflow nueva se crea SOLO cuando todas están al HARD_CAP.
const LOCATION_HARD_CAP = 49;
const LOCATION_SOFT_CAP = 45;

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

// Error tipado para el cupo operativo de la company location (49 asignaciones
// de cliente; el 50º slot de Shopify es inservible, ver LOCATION_HARD_CAP). No
// es un fallo transitorio ni un bug: la location está llena y hay que abrir otra
// (o usar otra company). Lo distinguimos del 500 genérico para que el handler
// devuelva un 409 accionable.
class LocationFullError extends Error {
  constructor(public companyLocationId: string, public detail: unknown) {
    super(`company location ${companyLocationId} llena (límite de 49 contactos): ${JSON.stringify(detail)}`);
    this.name = "LocationFullError";
  }
}

// Busca el companyContactId de un customer DENTRO de una company concreta,
// leyendo sus companyContactProfiles. Devuelve null si no es contacto de esa
// company. Sirve para converger cuando companyAssignCustomerAsContact ya no
// puede crear el contacto (porque ya existe) y no nos devuelve el id.
async function findExistingContactId(
  companyId: string,
  customerId: string,
): Promise<string | null> {
  const res = await gql<{
    customer: {
      companyContactProfiles: Array<{ id: string; company: { id: string } }>;
    } | null;
  }>(
    `
    query($id: ID!) {
      customer(id: $id) {
        companyContactProfiles { id company { id } }
      }
    }
    `,
    { id: customerId },
  );
  const profiles = res.customer?.companyContactProfiles ?? [];
  return profiles.find((p) => p.company.id === companyId)?.id ?? null;
}

// Lee el id del rol admin de sistema de una company (per-Company, mapeado por
// `note` estable, no por `name` localizable).
async function getAdminRoleId(companyId: string): Promise<string> {
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
  return adminRole.id;
}

// Configuración de experiencia de compra de una location (para replicarla
// en las sedes de overflow y que un contacto en sede 2/3/… compre idéntico).
type BuyerExperienceConfig = {
  checkoutToDraft: boolean;
  editableShippingAddress: boolean;
  paymentTermsTemplate: { id: string } | null;
};

type LocationInfo = {
  id: string;
  name: string;
  count: number; // nº de asignaciones de rol (ocupación real, ≤ HARD_CAP)
  buyerExperienceConfiguration: BuyerExperienceConfig | null;
};

// Lista las locations de una company con su OCUPACIÓN (nº de roleAssignments)
// y su buyerExperienceConfiguration. La ocupación es lo que decide, de forma
// dinámica, en qué sede colocar al contacto (no nos clavamos en una fija).
async function listCompanyLocationsWithCounts(
  companyId: string,
): Promise<{ name: string; locations: LocationInfo[] }> {
  const res = await gql<{
    company: {
      name: string;
      locations: {
        edges: Array<{
          node: {
            id: string;
            name: string;
            buyerExperienceConfiguration: BuyerExperienceConfig | null;
            roleAssignments: { edges: Array<{ node: { id: string } }> };
          };
        }>;
      };
    } | null;
  }>(
    `
    query($id: ID!) {
      company(id: $id) {
        name
        locations(first: 10) {
          edges {
            node {
              id
              name
              buyerExperienceConfiguration {
                checkoutToDraft
                editableShippingAddress
                paymentTermsTemplate { id }
              }
              roleAssignments(first: 50) { edges { node { id } } }
            }
          }
        }
      }
    }
    `,
    { id: companyId },
  );
  const locations = (res.company?.locations.edges ?? []).map((e) => ({
    id: e.node.id,
    name: e.node.name,
    count: e.node.roleAssignments.edges.length,
    buyerExperienceConfiguration: e.node.buyerExperienceConfiguration,
  }));
  return { name: res.company?.name ?? "Company", locations };
}

// Intenta asignar el rol admin al contacto sobre una location. Devuelve:
//   { ok: true, roleId }  si se asignó,
//   { ok: false }         si la location está llena (LIMIT_REACHED),
// y lanza Error en cualquier otro userError.
async function tryAssignRole(
  companyContactId: string,
  adminRoleId: string,
  companyLocationId: string,
): Promise<{ ok: boolean; roleId?: string }> {
  const res = await gql<{
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
      rolesToAssign: [{ companyContactRoleId: adminRoleId, companyLocationId }],
    },
  );
  const errs = res.companyContactAssignRoles.userErrors;
  if (errs.length) {
    if (errs.some((e) => e.code === "LIMIT_REACHED")) return { ok: false };
    throw new Error(`companyContactAssignRoles userErrors: ${JSON.stringify(errs)}`);
  }
  return { ok: true, roleId: res.companyContactAssignRoles.roleAssignments?.[0]?.id };
}

// Crea una location de overflow ("<company> — sede N") cuando todas las
// existentes están al HARD_CAP. N = nº de locations actuales + 1. Replica la
// buyerExperienceConfiguration de la sede plantilla (la primera de la company)
// y usa la MISMA shippingAddress placeholder Madrid/ES, sin catálogo propio:
// así un contacto en la sede nueva compra idéntico a la principal (mismo
// Market ES/EUR, mismas reglas de checkout).
async function createOverflowLocation(
  companyId: string,
  companyName: string,
  currentLocationCount: number,
  template: BuyerExperienceConfig | null,
): Promise<{ id: string; name: string }> {
  const name = `${companyName} — sede ${currentLocationCount + 1}`;
  const buyerExperienceConfiguration = template
    ? {
      checkoutToDraft: template.checkoutToDraft,
      editableShippingAddress: template.editableShippingAddress,
      ...(template.paymentTermsTemplate?.id
        ? { paymentTermsTemplateId: template.paymentTermsTemplate.id }
        : {}),
    }
    : undefined;
  const res = await gql<{
    companyLocationCreate: {
      companyLocation: { id: string; name: string } | null;
      userErrors: Array<{ field: string[]; message: string; code: string }>;
    };
  }>(
    `
    mutation($companyId: ID!, $input: CompanyLocationInput!) {
      companyLocationCreate(companyId: $companyId, input: $input) {
        companyLocation { id name }
        userErrors { field message code }
      }
    }
    `,
    {
      companyId,
      input: {
        name,
        shippingAddress: {
          address1: "Por completar al primer pedido",
          city: "Madrid",
          zip: "28001",
          countryCode: "ES",
        },
        billingSameAsShipping: true,
        ...(buyerExperienceConfiguration ? { buyerExperienceConfiguration } : {}),
      },
    },
  );
  const errs = res.companyLocationCreate.userErrors;
  if (errs.length) {
    throw new Error(`companyLocationCreate userErrors: ${JSON.stringify(errs)}`);
  }
  const loc = res.companyLocationCreate.companyLocation;
  if (!loc) throw new Error("companyLocationCreate no devolvió location");
  return loc;
}

// Asegura que el contacto tenga el rol admin de sistema en una sede de la
// company CON HUECO, elegida DINÁMICAMENTE por ocupación (no por una location
// fija). Idempotente y con auto-rollover:
//   1. Si ya tiene el rol admin en CUALQUIER sede → no-op (un solo rol basta
//      para comprar; evita duplicar).
//   2. Elige sede con la política de SOFT_CAP/HARD_CAP (ver más abajo) e
//      intenta asignar; si la sede se llenó por una carrera (LIMIT_REACHED),
//      prueba la siguiente.
//   3. Si TODAS están al HARD_CAP, crea UNA sede de overflow (replicando la
//      config de la primera) y asigna ahí — y solo entonces.
// Devuelve la sede realmente usada.
async function ensureAdminRole(
  companyId: string,
  companyContactId: string,
): Promise<{ assignedRoleIds: string[]; companyLocationId: string; alreadyHadRole: boolean }> {
  // 1. Idempotencia: ¿ya tiene el rol admin en alguna sede de la company?
  const current = await gql<{
    companyContact: {
      roleAssignments: {
        edges: Array<{ node: { id: string; role: { note: string }; companyLocation: { id: string } } }>;
      };
    } | null;
  }>(
    `
    query($id: ID!) {
      companyContact(id: $id) {
        roleAssignments(first: 25) {
          edges { node { id role { note } companyLocation { id } } }
        }
      }
    }
    `,
    { id: companyContactId },
  );
  const existing = (current.companyContact?.roleAssignments.edges ?? [])
    .map((e) => e.node)
    .find((n) => n.role.note === ADMIN_ROLE_NOTE);
  if (existing) {
    return {
      assignedRoleIds: [existing.id],
      companyLocationId: existing.companyLocation.id,
      alreadyHadRole: true,
    };
  }

  // 2. Resolver rol admin + ocupación de cada sede.
  const adminRoleId = await getAdminRoleId(companyId);
  const { name, locations } = await listCompanyLocationsWithCounts(companyId);

  // Política de colocación (concentrar para no dejar sedes casi vacías + margen):
  //   - candidatas = sedes con hueco real (count < HARD_CAP).
  //   - primero las que están bajo SOFT_CAP (margen), la más llena primero
  //     (rellena antes de empezar otra); luego la franja SOFT..HARD, también
  //     la más llena primero. Una sede nueva solo se crea si NO hay candidata.
  const withRoom = locations.filter((l) => l.count < LOCATION_HARD_CAP);
  const underSoft = withRoom
    .filter((l) => l.count < LOCATION_SOFT_CAP)
    .sort((a, b) => b.count - a.count);
  const inBuffer = withRoom
    .filter((l) => l.count >= LOCATION_SOFT_CAP)
    .sort((a, b) => b.count - a.count);
  const ordered = [...underSoft, ...inBuffer];

  for (const loc of ordered) {
    const res = await tryAssignRole(companyContactId, adminRoleId, loc.id);
    if (res.ok) {
      return {
        assignedRoleIds: res.roleId ? [res.roleId] : [],
        companyLocationId: loc.id,
        alreadyHadRole: false,
      };
    }
    // LIMIT_REACHED por carrera: esta sede acaba de llenarse, probar la siguiente.
  }

  // 3. Todas al HARD_CAP → crear sede de overflow (config = la de la 1ª sede).
  const template = locations[0]?.buyerExperienceConfiguration ?? null;
  const newLoc = await createOverflowLocation(companyId, name, locations.length, template);
  const res = await tryAssignRole(companyContactId, adminRoleId, newLoc.id);
  if (!res.ok) {
    // Una sede recién creada NO puede estar llena: si pasa, algo es muy raro.
    throw new LocationFullError(newLoc.id, "nueva location llena al instante (inesperado)");
  }
  return {
    assignedRoleIds: res.roleId ? [res.roleId] : [],
    companyLocationId: newLoc.id,
    alreadyHadRole: false,
  };
}

// Asigna el customer como contact de una company y le GARANTIZA el rol admin
// sobre una sede CON HUECO (elegida dinámicamente por ocupación, no fija).
// Idempotente y auto-reparador:
//   - Si el customer YA es contacto (assign no devuelve id o da userError),
//     resolvemos el companyContactId existente y continuamos en vez de abortar.
//   - El rol se asegura SIEMPRE vía ensureAdminRole, con auto-rollover de sede.
//     Devuelve la sede realmente usada.
async function joinCustomerToCompany(
  companyId: string,
  customerId: string,
): Promise<{ companyContactId: string; assignedRoleIds: string[]; companyLocationId: string }> {
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

  // Resolver el companyContactId con tolerancia a "ya es contacto": el assign
  // puede devolver el id del contacto existente, null, o un userError. En los
  // dos últimos casos lo buscamos por companyContactProfiles antes de rendirnos.
  let companyContactId = assignRes.companyAssignCustomerAsContact.companyContact?.id ?? null;
  const assignErrs = assignRes.companyAssignCustomerAsContact.userErrors;
  if (!companyContactId) {
    companyContactId = await findExistingContactId(companyId, customerId);
  }
  if (!companyContactId) {
    // Ni se creó ni existe: sí es un fallo real. Propagar el userError si lo hubo.
    if (assignErrs.length) {
      throw new Error(`companyAssignCustomerAsContact userErrors: ${JSON.stringify(assignErrs)}`);
    }
    throw new Error("companyAssignCustomerAsContact no devolvió companyContact.id");
  }

  const ensured = await ensureAdminRole(companyId, companyContactId);
  return {
    companyContactId,
    assignedRoleIds: ensured.assignedRoleIds,
    companyLocationId: ensured.companyLocationId,
  };
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
        const joined = await joinCustomerToCompany(existingRow.company_id, customerId);
        return jsonResponse({
          startedAt,
          joined: true,
          via: "domain",
          customerId,
          domain,
          companyId: existingRow.company_id,
          // Sede REALMENTE usada, elegida por ocupación (NO la company_location_id
          // de company_domains, que con multi-sede es solo una pista obsoleta).
          companyLocationId: joined.companyLocationId,
          hintLocationId: existingRow.company_location_id,
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
    // ensureAdminRole redescubre la location recién creada y asigna ahí.
    const joined = await joinCustomerToCompany(company.id, customerId);

    return jsonResponse({
      startedAt,
      created: true,
      customerId,
      domain: isCorporateDomain ? domain : null,
      companyId: company.id,
      companyName: company.name,
      companyLocationId: joined.companyLocationId,
      companyContactId: joined.companyContactId,
      assignedRoleIds: joined.assignedRoleIds,
    });
    });
  } catch (e) {
    // Location llena (cupo operativo 49): no es un 500: la company necesita
    // otra location (o el contacto otra company). 409 accionable + log claro.
    if (e instanceof LocationFullError) {
      console.log(JSON.stringify({
        startedAt,
        outcome: "location_full",
        companyLocationId: e.companyLocationId,
        detail: e.detail,
      }));
      return jsonResponse({
        startedAt,
        error: "company_location_full",
        reason: "la company location alcanzó el límite de 49 contactos; crea otra location o asigna a otra company",
        companyLocationId: e.companyLocationId,
      }, 409);
    }
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
