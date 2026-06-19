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
const NEW_LOCATION = "gid://shopify/CompanyLocation/88810"; // sede de overflow creada
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

function shopifyHandler(opts: {
  email: string;
  profilesAfterRace?: Array<{ id: string; company: { id: string } }>;
  // roleAssignments que ya tiene el contacto (ensureAdminRole). Default [].
  contactRoleEdges?: Array<{ node: { id: string; role: { note: string }; companyLocation: { id: string } } }>;
  // Locations que devuelven LIMIT_REACHED al asignar rol pese a tener count<cap
  // (simula carrera de concurrencia → la reactiva debe pasar a la siguiente).
  fullLocationIds?: string[];
  // Sedes existentes de la company con su ocupación (listCompanyLocationsWithCounts).
  // Default según la company: una sede vacía (count 0).
  companyLocations?: Array<{ id: string; name: string; count: number }>;
  // Si true, companyAssignCustomerAsContact devuelve contacto null (ya existe);
  // el código debe resolver el id vía companyContactProfiles.
  assignReturnsNull?: boolean;
}) {
  const full = new Set(opts.fullLocationIds ?? []);
  return (call: RecordedCall): unknown => {
    const q = call.query ?? "";
    if (q.includes("defaultEmailAddress")) return customerData(opts.email);
    if (q.includes("companyContactProfiles") && !q.includes("metafields")) {
      // Re-lectura de perfiles / findExistingContactId.
      return { customer: { companyContactProfiles: opts.profilesAfterRace ?? [] } };
    }
    if (q.includes("companyLocationCreate")) {
      return {
        companyLocationCreate: {
          companyLocation: { id: NEW_LOCATION, name: "Empresa Test SL — sede 2" },
          userErrors: [],
        },
      };
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
          companyContact: opts.assignReturnsNull ? null : { id: "gid://shopify/CompanyContact/555" },
          userErrors: [],
        },
      };
    }
    // Lectura idempotente de roles del contacto (ensureAdminRole). Por defecto
    // el contacto aún NO tiene rol → ensureAdminRole procederá a asignarlo.
    if (q.includes("roleAssignments(first: 25)")) {
      return {
        companyContact: {
          roleAssignments: { edges: opts.contactRoleEdges ?? [] },
        },
      };
    }
    // listCompanyLocationsWithCounts: name + sedes con ocupación + config.
    if (q.includes("locations(first: 10)")) {
      const companyId = call.variables?.id as string;
      const locs = opts.companyLocations ??
        (companyId === WINNER_COMPANY
          ? [{ id: WINNER_LOCATION, name: "Winner L1", count: 0 }]
          : [{ id: OWN_LOCATION, name: "Own L1", count: 0 }]);
      return {
        company: {
          name: "Empresa Test SL",
          locations: {
            edges: locs.map((l) => ({
              node: {
                id: l.id,
                name: l.name,
                buyerExperienceConfiguration: {
                  checkoutToDraft: false,
                  editableShippingAddress: false,
                  paymentTermsTemplate: null,
                },
                // count asignaciones → edges sintéticos para que el código las cuente.
                roleAssignments: {
                  edges: Array.from({ length: l.count }, (_, i) => ({
                    node: { id: `ra-${l.id}-${i}` },
                  })),
                },
              },
            })),
          },
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
      const locId = (call.variables?.rolesToAssign as Array<{ companyLocationId: string }>)[0].companyLocationId;
      if (full.has(locId)) {
        return {
          companyContactAssignRoles: {
            roleAssignments: [],
            userErrors: [{
              field: ["rolesToAssign", "0"],
              message: "La sucursal de la empresa ha alcanzado el número máximo de 50 asignaciones de clientes.",
              code: "LIMIT_REACHED",
            }],
          },
        };
      }
      return {
        companyContactAssignRoles: {
          roleAssignments: [{ id: "gid://shopify/CompanyContactRoleAssignment/1" }],
          userErrors: [],
        },
      };
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

// Auto-reparación: el camino de unión asegura el rol SIEMPRE. Un contacto sin
// rol que vuelve a pasar por aquí termina con rol (no 500, no duplica).
Deno.test("contacto ya existente SIN rol → asigna rol (no 500, no duplica)", async () => {
  installFetchMock({
    // companyAssignCustomerAsContact devuelve null (ya es contacto); el código
    // resuelve el companyContactId vía companyContactProfiles y luego, como el
    // contacto no tiene rol (contactRoleEdges=[]), lo asigna.
    shopify: shopifyHandler({
      email: "segundo@ledsc4.com",
      assignReturnsNull: true,
      profilesAfterRace: [{ id: "gid://shopify/CompanyContact/555", company: { id: WINNER_COMPANY } }],
      contactRoleEdges: [],
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: WINNER_LOCATION }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.joined, true);
    assertEquals(json.companyContactId, "gid://shopify/CompanyContact/555");
    // Se asignó exactamente UNA vez (no duplica).
    const assignCalls = shopifyCalls().filter((c) => c.query!.includes("companyContactAssignRoles"));
    assertEquals(assignCalls.length, 1);
    assertEquals(json.assignedRoleIds.length, 1);
  } finally {
    restoreFetch();
  }
});

// Idempotencia del rol: si el contacto YA tiene el rol admin en esa location,
// ensureAdminRole hace no-op (no llama a companyContactAssignRoles).
Deno.test("contacto ya existente CON rol → no-op (no re-asigna)", async () => {
  installFetchMock({
    shopify: shopifyHandler({
      email: "segundo@ledsc4.com",
      contactRoleEdges: [{
        node: {
          id: "gid://shopify/CompanyContactRoleAssignment/99",
          role: { note: ADMIN_ROLE_NOTE },
          companyLocation: { id: WINNER_LOCATION },
        },
      }],
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: WINNER_LOCATION }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.joined, true);
    // No se intentó re-asignar el rol (evita el error de rol duplicado).
    const assignCalls = shopifyCalls().filter((c) => c.query!.includes("companyContactAssignRoles"));
    assertEquals(assignCalls.length, 0);
  } finally {
    restoreFetch();
  }
});

// Spill: cuando TODAS las sedes están al HARD_CAP (50), crea UNA sede de
// overflow y asigna ahí (200, no 409). Replica la config de la 1ª sede.
Deno.test("todas las sedes al tope (50) → crea sede de overflow y asigna ahí", async () => {
  installFetchMock({
    shopify: shopifyHandler({
      email: "segundo@ledsc4.com",
      companyLocations: [{ id: WINNER_LOCATION, name: "Madre", count: 50 }],
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: WINNER_LOCATION }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.joined, true);
    // Se creó UNA sede nueva y el rol cayó ahí; la llena (50) ni se intentó.
    const creates = shopifyCalls().filter((c) => c.query!.includes("companyLocationCreate"));
    assertEquals(creates.length, 1);
    // La sede nueva replica buyerExperienceConfiguration de la 1ª.
    const bec = (creates[0].variables!.input as { buyerExperienceConfiguration?: unknown })
      .buyerExperienceConfiguration;
    assert(bec !== undefined);
    assertEquals(json.companyLocationId, NEW_LOCATION);
    assertEquals(json.assignedRoleIds.length, 1);
  } finally {
    restoreFetch();
  }
});

// No-sprawl: si hay una sede con hueco NO crea otra; concentra rellenando la
// más llena por debajo del tope (no deja sedes casi vacías).
Deno.test("sede principal llena pero sede 2 con hueco → reutiliza (no crea)", async () => {
  const SEDE2 = "gid://shopify/CompanyLocation/7772";
  installFetchMock({
    shopify: shopifyHandler({
      email: "tercero@ledsc4.com",
      companyLocations: [
        { id: WINNER_LOCATION, name: "Madre", count: 50 }, // llena
        { id: SEDE2, name: "sede 2", count: 15 }, // con hueco
      ],
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: WINNER_LOCATION }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.companyLocationId, SEDE2);
    assert(!shopifyCalls().some((c) => c.query!.includes("companyLocationCreate")));
  } finally {
    restoreFetch();
  }
});

// Concentración: con dos sedes por debajo del soft cap, rellena la MÁS LLENA
// primero (no reparte dejando ambas a medias).
Deno.test("dos sedes bajo soft cap → elige la más llena (concentra)", async () => {
  const SEDE_A = "gid://shopify/CompanyLocation/7773";
  const SEDE_B = "gid://shopify/CompanyLocation/7774";
  installFetchMock({
    shopify: shopifyHandler({
      email: "cuarto@ledsc4.com",
      companyLocations: [
        { id: SEDE_A, name: "A", count: 10 },
        { id: SEDE_B, name: "B", count: 30 }, // más llena → preferida
      ],
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: SEDE_A }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).companyLocationId, SEDE_B);
  } finally {
    restoreFetch();
  }
});

// Carrera de concurrencia: el count decía hueco pero el assign devuelve
// LIMIT_REACHED → la reactiva pasa a la siguiente sede sin fallar.
Deno.test("carrera: assign LIMIT_REACHED pese a count<cap → cae a la siguiente", async () => {
  const SEDE_A = "gid://shopify/CompanyLocation/7775";
  const SEDE_B = "gid://shopify/CompanyLocation/7776";
  installFetchMock({
    shopify: shopifyHandler({
      email: "quinto@ledsc4.com",
      companyLocations: [
        { id: SEDE_A, name: "A", count: 40 }, // se eligen por más-llena: A primero
        { id: SEDE_B, name: "B", count: 20 },
      ],
      fullLocationIds: [SEDE_A], // A se llenó por carrera entre el count y el assign
    }),
    lookupRows: [[{ company_id: WINNER_COMPANY, company_location_id: SEDE_A }]],
    insertRows: [],
  });
  try {
    const res = await handle(makeReq({ customerId: CUSTOMER_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.companyLocationId, SEDE_B);
    assert(!shopifyCalls().some((c) => c.query!.includes("companyLocationCreate")));
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
