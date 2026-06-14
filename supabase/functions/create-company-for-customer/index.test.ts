// Tests para create-company-for-customer (unificación por dominio).
//
// Mockeamos `globalThis.fetch` para interceptar tanto las llamadas GraphQL
// a Shopify como las REST a PostgREST (company_domains) y verificar
// input/output sin red. Las env vars se setean antes del import dinámico
// del módulo (que valida y throw si faltan).
//
// Ejecutar:
//   deno test --allow-env --allow-net supabase/functions/create-company-for-customer/

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// --- Setup env BEFORE importing module ---
Deno.env.set("CREATE_COMPANY_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("CREATE_COMPANY_WEBHOOK_SECRET", "whsec_test");
Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk_test");

const mod = await import("./index.ts");
const handle: (req: Request) => Promise<Response> = mod.handle;

const SECRET = "whsec_test";
const CUSTOMER_GID = "gid://shopify/Customer/123456";
const OWN_COMPANY = "gid://shopify/Company/999";
const OWN_LOCATION = "gid://shopify/CompanyLocation/9991";
const WINNER_COMPANY = "gid://shopify/Company/777";
const WINNER_LOCATION = "gid://shopify/CompanyLocation/7771";
const ADMIN_ROLE_NOTE = "System-defined Location admin role";

// --- Fetch mocking -------------------------------------------------------

interface RecordedCall {
  kind: "shopify" | "rest";
  url: string;
  method: string;
  // shopify
  query?: string;
  variables?: Record<string, unknown>;
  // rest
  body?: unknown;
}

interface MockConfig {
  // Respuesta data de Shopify por substring del query.
  shopify: (call: RecordedCall) => unknown;
  // Filas devueltas por GET company_domains.
  lookupRows: Array<{ company_id: string; company_location_id: string }>[];
  // Filas devueltas por el POST insert (vacío = conflicto).
  insertRows: unknown[][];
}

let calls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;

function installFetchMock(cfg: MockConfig): void {
  calls = [];
  let lookupIdx = 0;
  let insertIdx = 0;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/admin/api/")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const call: RecordedCall = {
        kind: "shopify",
        url,
        method: init?.method ?? "POST",
        query: body.query,
        variables: body.variables,
      };
      calls.push(call);
      return new Response(JSON.stringify({ data: cfg.shopify(call) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/company_domains")) {
      const method = init?.method ?? "GET";
      const call: RecordedCall = {
        kind: "rest",
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const rows = method === "GET"
        ? (cfg.lookupRows[lookupIdx++] ?? [])
        : (cfg.insertRows[insertIdx++] ?? []);
      return new Response(JSON.stringify(rows), {
        status: method === "GET" ? 200 : 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// --- Shopify respuestas canned -------------------------------------------

function customerData(email: string) {
  return {
    customer: {
      id: CUSTOMER_GID,
      firstName: "Test",
      lastName: "User",
      defaultEmailAddress: { emailAddress: email },
      companyContactProfiles: [],
      metafields: {
        edges: [
          { node: { namespace: "b2b", key: "empresa", value: "Empresa Test SL" } },
        ],
      },
    },
  };
}

function shopifyHandler(opts: { email: string; profilesAfterRace?: Array<{ id: string; company: { id: string } }> }) {
  return (call: RecordedCall): unknown => {
    const q = call.query ?? "";
    if (q.includes("defaultEmailAddress")) return customerData(opts.email);
    if (q.includes("companyContactProfiles") && !q.includes("metafields")) {
      // Re-lectura de perfiles en el camino de race (post-deleteCompany).
      return { customer: { companyContactProfiles: opts.profilesAfterRace ?? [] } };
    }
    if (q.includes("companyCreate")) {
      return {
        companyCreate: {
          company: {
            id: OWN_COMPANY,
            name: "Empresa Test SL",
            locations: { edges: [{ node: { id: OWN_LOCATION } }] },
          },
          userErrors: [],
        },
      };
    }
    if (q.includes("companyAssignCustomerAsContact")) {
      return {
        companyAssignCustomerAsContact: {
          companyContact: { id: "gid://shopify/CompanyContact/555" },
          userErrors: [],
        },
      };
    }
    if (q.includes("contactRoles")) {
      return {
        company: {
          contactRoles: {
            edges: [
              { node: { id: "gid://shopify/CompanyContactRole/1", name: "Location admin", note: ADMIN_ROLE_NOTE } },
              { node: { id: "gid://shopify/CompanyContactRole/2", name: "Ordering only", note: "System-defined Ordering only role" } },
            ],
          },
        },
      };
    }
    if (q.includes("companyContactAssignRoles")) {
      return {
        companyContactAssignRoles: {
          roleAssignments: [{ id: "gid://shopify/CompanyContactRoleAssignment/1" }],
          userErrors: [],
        },
      };
    }
    if (q.includes("companyDelete")) {
      return { companyDelete: { deletedCompanyId: OWN_COMPANY, userErrors: [] } };
    }
    throw new Error(`mock sin handler para query: ${q.slice(0, 80)}`);
  };
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/create-company-for-customer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": SECRET,
    },
    body: JSON.stringify(body),
  });
}

function shopifyCalls(): RecordedCall[] {
  return calls.filter((c) => c.kind === "shopify");
}
function restCalls(): RecordedCall[] {
  return calls.filter((c) => c.kind === "rest");
}

// --- Tests ---------------------------------------------------------------

Deno.test("dominio genérico → crea company y NO toca company_domains", async () => {
  installFetchMock({
    shopify: shopifyHandler({ email: "cliente@gmail.com" }),
    lookupRows: [],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.created, true);
    assertEquals(json.companyId, OWN_COMPANY);
    assertEquals(json.domain, null);
    assertEquals(restCalls().length, 0);
    assert(shopifyCalls().some((c) => c.query!.includes("companyCreate")));
    // Solo el rol admin
    const roleCall = shopifyCalls().find((c) => c.query!.includes("companyContactAssignRoles"))!;
    const roles = (roleCall.variables!.rolesToAssign as unknown[]);
    assertEquals(roles.length, 1);
  } finally {
    restoreFetch();
  }
});

Deno.test("dominio NO sembrado → crea company SIN sembrar (no INSERT)", async () => {
  installFetchMock({
    shopify: shopifyHandler({ email: "compras@empresa-nueva.es" }),
    lookupRows: [[]], // lookup: sin fila → no se une
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.created, true);
    assertEquals(json.domain, "empresa-nueva.es");
    assert(shopifyCalls().some((c) => c.query!.includes("companyCreate")));
    // Modelo invertido: NUNCA se inserta en company_domains.
    assertEquals(restCalls().filter((c) => c.method === "POST").length, 0);
    // Solo se hizo el lookup de lectura.
    const gets = restCalls().filter((c) => c.method === "GET");
    assertEquals(gets.length, 1);
  } finally {
    restoreFetch();
  }
});

Deno.test("segundo alias de dominio NO sembrado → crea OTRA company (no une)", async () => {
  // Mismo dominio que el test anterior, distinto customer: sin fila en la
  // tabla, debe crear company propia igualmente (cadenas van separadas).
  installFetchMock({
    shopify: shopifyHandler({ email: "ventas@empresa-nueva.es" }),
    lookupRows: [[]], // sigue sin fila (nadie la sembró)
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.created, true);
    assertEquals(json.companyId, OWN_COMPANY);
    assert(!shopifyCalls().some((c) => c.query!.includes("companyAssignCustomerAsContact")
      && c.variables!.companyId !== OWN_COMPANY));
    assertEquals(restCalls().filter((c) => c.method === "POST").length, 0);
  } finally {
    restoreFetch();
  }
});

Deno.test("dominio existente → une sin crear company", async () => {
  installFetchMock({
    shopify: shopifyHandler({ email: "segundo@ledsc4.com" }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: WINNER_LOCATION }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.joined, true);
    assertEquals(json.via, "domain");
    assertEquals(json.companyId, WINNER_COMPANY);
    // NO se creó company ni se insertó dominio
    assert(!shopifyCalls().some((c) => c.query!.includes("companyCreate")));
    assertEquals(restCalls().filter((c) => c.method === "POST").length, 0);
    // El contact se asignó a la company ganadora
    const assign = shopifyCalls().find((c) => c.query!.includes("companyAssignCustomerAsContact"))!;
    assertEquals(assign.variables!.companyId, WINNER_COMPANY);
  } finally {
    restoreFetch();
  }
});

// El race del MISMO customer (Flow W1+W2) ya NO se resuelve con la siembra
// (eliminada) sino con pg_advisory_lock + re-lectura de profiles dentro del
// lock. En unit test el lock se salta (TEST_MODE) y la concurrencia real no
// es observable; el comportamiento clave —la segunda invocación ve la company
// ya creada y NO crea otra— lo cubre el test de idempotencia siguiente.
Deno.test("idempotencia (cubre race mismo customer): company existente → skipped", async () => {
  installFetchMock({
    shopify: (call) => {
      if (call.query!.includes("defaultEmailAddress")) {
        const d = customerData("x@ledsc4.com");
        d.customer.companyContactProfiles = [
          { id: "cc1", company: { id: WINNER_COMPANY, name: "LedsC4 SA" } },
        ] as never;
        return d;
      }
      throw new Error("no debería llamar nada más");
    },
    lookupRows: [],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.skipped, true);
    assertEquals(restCalls().length, 0);
  } finally {
    restoreFetch();
  }
});

Deno.test("auth: sin X-Webhook-Secret → 401", async () => {
  installFetchMock({ shopify: () => ({}), lookupRows: [], insertRows: [] });
  try {
    const req = new Request("http://localhost/create-company-for-customer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: CUSTOMER_GID }),
    });
    const res = await handle(req);
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
  }
});
