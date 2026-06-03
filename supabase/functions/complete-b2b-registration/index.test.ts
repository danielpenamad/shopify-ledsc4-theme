// Tests para complete-b2b-registration.
//
// Mockeamos `globalThis.fetch` para interceptar las llamadas GraphQL a
// Shopify y verificar input/output sin red. Las env vars se setean antes
// del import dinámico del módulo (que valida y throw si faltan).
//
// Ejecutar:
//   COMPLETE_B2B_TEST_MODE=1 \
//   SHOPIFY_STORE_DOMAIN=test.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_test \
//   REGISTER_B2B_HMAC_SECRET=test_secret \
//   deno test --allow-env --allow-net supabase/functions/complete-b2b-registration/

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// --- Setup env BEFORE importing module ---
Deno.env.set("COMPLETE_B2B_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("REGISTER_B2B_HMAC_SECRET", "test_secret_unit");

const mod = await import("./index.ts");
const handle: (req: Request) => Promise<Response> = mod.handle;
const hmacSha256Hex: (msg: string, secret: string) => Promise<string> = mod.hmacSha256Hex;

const SECRET = "test_secret_unit";
const CUSTOMER_GID = "gid://shopify/Customer/123456";

// --- Fetch mocking -----------------------------------------------------

interface ShopifyCall {
  query: string;
  variables: Record<string, unknown>;
}

interface MockHandler {
  (call: ShopifyCall): unknown; // return response.data
}

let calls: ShopifyCall[] = [];
let handler: MockHandler = () => ({});
const originalFetch = globalThis.fetch;

function installFetchMock(h: MockHandler): void {
  calls = [];
  handler = h;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("/admin/api/")) {
      return originalFetch(input as RequestInfo, init);
    }
    const body = JSON.parse((init?.body as string) ?? "{}");
    const call: ShopifyCall = { query: body.query, variables: body.variables };
    calls.push(call);
    const data = handler(call);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

// --- Helpers -----------------------------------------------------------

async function signedBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = "nonce-12345678";
  const customerId = (overrides.customerId as string) ?? CUSTOMER_GID;
  const signature = await hmacSha256Hex(
    `${timestamp}:${nonce}:${customerId}`,
    SECRET,
  );
  return {
    timestamp,
    nonce,
    signature,
    customerId,
    nombre: "Juan",
    apellidos: "Pérez García",
    telefono: "+34600000000",
    empresa: "Instalaciones Luz SL",
    nif: "B12345674", // CIF válido (calculado)
    sector: "instalador",
    pais: "ES",
    volumen_estimado: "5k-25k",
    condiciones: true,
    ...overrides,
  };
}

function makeReq(body: unknown): Request {
  return new Request("http://localhost/complete-b2b-registration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// --- Tests -------------------------------------------------------------

Deno.test("rechaza firma inválida (401)", async () => {
  installFetchMock(() => ({}));
  try {
    const body = await signedBody({ signature: "0".repeat(64) });
    const res = await handle(makeReq(body));
    assertEquals(res.status, 401);
    const json = await res.json();
    assertEquals(json.code, "INVALID_SIGNATURE");
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

Deno.test("rechaza firma expirada (401)", async () => {
  installFetchMock(() => ({}));
  try {
    const timestamp = Math.floor(Date.now() / 1000) - 4000; // > 3600s
    const nonce = "nonce-12345678";
    const signature = await hmacSha256Hex(
      `${timestamp}:${nonce}:${CUSTOMER_GID}`,
      SECRET,
    );
    const body = await signedBody({ timestamp, nonce, signature });
    const res = await handle(makeReq(body));
    assertEquals(res.status, 401);
    const json = await res.json();
    assertEquals(json.code, "SIGNATURE_EXPIRED");
    assertEquals(calls.length, 0);
  } finally {
    restoreFetch();
  }
});

Deno.test("rechaza payload sin customerId (400)", async () => {
  installFetchMock(() => ({}));
  try {
    const body = await signedBody();
    delete (body as Record<string, unknown>).customerId;
    const res = await handle(makeReq(body));
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.code, "INVALID_PAYLOAD");
  } finally {
    restoreFetch();
  }
});

Deno.test("rechaza customerId con formato inválido (400)", async () => {
  installFetchMock(() => ({}));
  try {
    // Customer id no-gid → INVALID_PAYLOAD aunque la firma cuadre.
    const customerId = "123456";
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = "nonce-12345678";
    const signature = await hmacSha256Hex(
      `${timestamp}:${nonce}:${customerId}`,
      SECRET,
    );
    const res = await handle(makeReq({
      timestamp,
      nonce,
      signature,
      customerId,
      nombre: "x",
      apellidos: "y",
      empresa: "z",
      nif: "B12345674",
      sector: "instalador",
      pais: "ES",
      condiciones: true,
    }));
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.code, "INVALID_PAYLOAD");
  } finally {
    restoreFetch();
  }
});

Deno.test("rechaza campos inválidos (400, VALIDATION_ERROR)", async () => {
  installFetchMock(() => ({}));
  try {
    const body = await signedBody({
      nif: "12345678Z", // DNI inválido (letra mala)
      sector: "no_existe",
      condiciones: false,
    });
    const res = await handle(makeReq(body));
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.code, "VALIDATION_ERROR");
    assertExists(json.fieldErrors.nif);
    assertExists(json.fieldErrors.sector);
    assertExists(json.fieldErrors.condiciones);
    assertEquals(calls.length, 0); // no llega a Shopify
  } finally {
    restoreFetch();
  }
});

Deno.test("guard: customer no existe → 404", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) return { customer: null };
    throw new Error("unexpected call: " + call.query);
  });
  try {
    const body = await signedBody();
    const res = await handle(makeReq(body));
    assertEquals(res.status, 404);
    const json = await res.json();
    assertEquals(json.code, "CUSTOMER_NOT_FOUND");
    assertEquals(calls.length, 1); // solo el lookup
  } finally {
    restoreFetch();
  }
});

Deno.test("guard: tag 'aprobado' → 200 noop sin update", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) {
      return { customer: { id: CUSTOMER_GID, tags: ["aprobado"] } };
    }
    throw new Error("unexpected call: " + call.query);
  });
  try {
    const body = await signedBody();
    const res = await handle(makeReq(body));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.ok, true);
    assertEquals(json.noop, true);
    assertEquals(calls.length, 1); // solo lookup, no update ni tagsAdd
  } finally {
    restoreFetch();
  }
});

Deno.test("guard: tag 'rechazado' → 200 noop sin update", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) {
      return { customer: { id: CUSTOMER_GID, tags: ["rechazado"] } };
    }
    throw new Error("unexpected call: " + call.query);
  });
  try {
    const body = await signedBody();
    const res = await handle(makeReq(body));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.noop, true);
    assertEquals(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

Deno.test("happy path: customerUpdate + tagsAdd 'pendiente' con input correcto", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) {
      // sin tag terminal — alta nativa incompleta
      return { customer: { id: CUSTOMER_GID, tags: [] } };
    }
    if (call.query.includes("customerUpdate")) {
      return {
        customerUpdate: {
          customer: { id: CUSTOMER_GID },
          userErrors: [],
        },
      };
    }
    if (call.query.includes("tagsAdd")) {
      return { tagsAdd: { node: { id: CUSTOMER_GID }, userErrors: [] } };
    }
    throw new Error("unexpected call: " + call.query);
  });
  try {
    const body = await signedBody();
    const res = await handle(makeReq(body));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.ok, true);
    assertEquals(json.customerId, CUSTOMER_GID);
    assertEquals(json.status, "pendiente");
    assertEquals(json.tagsAdded, true);

    // Verifica calls: lookup + update + tagsAdd
    assertEquals(calls.length, 3);

    const update = calls[1];
    assert(update.query.includes("customerUpdate"));
    const input = (update.variables as { input: Record<string, unknown> }).input;
    assertEquals(input.id, CUSTOMER_GID);
    assertEquals(input.firstName, "Juan");
    assertEquals(input.lastName, "Pérez García");
    assertEquals(input.phone, "+34600000000");
    const consent = input.emailMarketingConsent as Record<string, string>;
    assertEquals(consent.marketingState, "SUBSCRIBED");
    assertEquals(consent.marketingOptInLevel, "SINGLE_OPT_IN");

    const metafields = input.metafields as Array<Record<string, string>>;
    const byKey = Object.fromEntries(metafields.map((m) => [m.key, m]));
    assertEquals(byKey.empresa.value, "Instalaciones Luz SL");
    assertEquals(byKey.empresa.namespace, "b2b");
    assertEquals(byKey.nif.value, "B12345674");
    assertEquals(byKey.sector.value, "instalador");
    assertEquals(byKey.pais.value, "ES");
    assertEquals(byKey.volumen_estimado.value, "5k-25k");
    assert(byKey.fecha_registro.value.match(/^\d{4}-\d{2}-\d{2}$/));
    assertEquals(byKey.fecha_registro.type, "date");

    const tagsCall = calls[2];
    assert(tagsCall.query.includes("tagsAdd"));
    assertEquals((tagsCall.variables as Record<string, unknown>).id, CUSTOMER_GID);
    assertEquals(
      (tagsCall.variables as Record<string, unknown>).tags,
      ["pendiente"],
    );
  } finally {
    restoreFetch();
  }
});

Deno.test("happy path: customer con tag 'pendiente' previo permite reintento", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) {
      return { customer: { id: CUSTOMER_GID, tags: ["pendiente"] } };
    }
    if (call.query.includes("customerUpdate")) {
      return { customerUpdate: { customer: { id: CUSTOMER_GID }, userErrors: [] } };
    }
    if (call.query.includes("tagsAdd")) {
      return { tagsAdd: { node: { id: CUSTOMER_GID }, userErrors: [] } };
    }
    throw new Error("unexpected call: " + call.query);
  });
  try {
    const body = await signedBody();
    const res = await handle(makeReq(body));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.ok, true);
    assertEquals(json.status, "pendiente");
    assertEquals(calls.length, 3); // procesa normal
  } finally {
    restoreFetch();
  }
});

Deno.test("volumen_estimado omitido → metafield no se incluye", async () => {
  installFetchMock((call) => {
    if (call.query.includes("customer(id:")) {
      return { customer: { id: CUSTOMER_GID, tags: [] } };
    }
    if (call.query.includes("customerUpdate")) {
      return { customerUpdate: { customer: { id: CUSTOMER_GID }, userErrors: [] } };
    }
    if (call.query.includes("tagsAdd")) {
      return { tagsAdd: { node: { id: CUSTOMER_GID }, userErrors: [] } };
    }
    throw new Error("unexpected call");
  });
  try {
    const body = await signedBody({ volumen_estimado: "" });
    const res = await handle(makeReq(body));
    assertEquals(res.status, 200);
    const update = calls[1];
    const input = (update.variables as { input: Record<string, unknown> }).input;
    const metafields = input.metafields as Array<Record<string, string>>;
    const keys = metafields.map((m) => m.key);
    assert(!keys.includes("volumen_estimado"));
  } finally {
    restoreFetch();
  }
});
