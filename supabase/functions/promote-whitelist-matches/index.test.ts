// Tests para promote-whitelist-matches (rescate por dominio sembrado).
//
// Mockeamos `globalThis.fetch` para interceptar Shopify GraphQL y PostgREST
// (company_domains). Env vars antes del import dinámico.
//
// Ejecutar:
//   deno test --allow-env --allow-net supabase/functions/promote-whitelist-matches/

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("PROMOTE_WL_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("SUPABASE_URL", "http://supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "srk_test");

const mod = await import("./index.ts");
const handle: (req: Request) => Promise<Response> = mod.handle;

const CUSTOMER_GID = "gid://shopify/Customer/111";
const MADRE_COMPANY = "gid://shopify/Company/7410123079";

interface RecordedCall {
  kind: "shopify" | "rest";
  url: string;
  query?: string;
  variables?: Record<string, unknown>;
}

let calls: RecordedCall[] = [];
const originalFetch = globalThis.fetch;

interface MockConfig {
  whitelist: string[];
  candidate: { email: string; tags: string[]; hasEmpresa: boolean };
  domainRows: Array<{ company_id: string; company_location_id: string }>;
}

function installFetchMock(cfg: MockConfig): void {
  calls = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/rest/v1/company_domains")) {
      calls.push({ kind: "rest", url });
      return new Response(JSON.stringify(cfg.domainRows), { status: 200 });
    }
    if (url.includes("/admin/api/")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const q: string = body.query ?? "";
      calls.push({ kind: "shopify", url, query: q, variables: body.variables });
      let data: unknown = {};
      if (q.includes("whitelist_emails")) {
        data = { shop: { metafield: { value: JSON.stringify(cfg.whitelist) } } };
      } else if (q.includes("customers(first")) {
        data = {
          customers: {
            pageInfo: { hasNextPage: false, endCursor: "x" },
            edges: [{
              node: {
                id: CUSTOMER_GID,
                tags: cfg.candidate.tags,
                defaultEmailAddress: { emailAddress: cfg.candidate.email },
                empresa: cfg.candidate.hasEmpresa ? { value: "Empresa Form SL" } : null,
              },
            }],
          },
        };
      } else if (q.includes("company(id:")) {
        data = { company: { name: "LedsC4 SA" } };
      } else if (q.includes("metafieldsSet")) {
        data = { metafieldsSet: { userErrors: [] } };
      } else if (q.includes("customerEmailMarketingConsentUpdate")) {
        data = { customerEmailMarketingConsentUpdate: { userErrors: [] } };
      } else if (q.includes("tagsAdd")) {
        data = { tagsAdd: { userErrors: [] } };
      } else if (q.includes("customerUpdate")) {
        data = { customerUpdate: { userErrors: [] } };
      } else {
        throw new Error("mock sin handler: " + q.slice(0, 60));
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

const req = () => new Request("http://localhost/", { method: "POST" });

Deno.test("(a) whitelisted + dominio sembrado + sin b2b.empresa → escribe empresa y promueve", async () => {
  installFetchMock({
    whitelist: ["vijayvaja@ledsc4.com"],
    candidate: { email: "vijayvaja@ledsc4.com", tags: [], hasEmpresa: false },
    domainRows: [{ company_id: MADRE_COMPANY, company_location_id: "gid://shopify/CompanyLocation/8330346823" }],
  });
  try {
    const res = await handle(req());
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.promoted, 1);
    assertEquals(json.promotedViaDomain, ["vijayvaja@ledsc4.com"]);
    assertEquals(json.skippedNoEmpresa, []);
    assertEquals(json.errors, []);
    // Escribió el metafield con el nombre de la company canónica
    const mfSet = calls.find((c) => c.query?.includes("metafieldsSet"))!;
    const mf = (mfSet.variables!.metafields as Array<Record<string, string>>)[0];
    assertEquals(mf.ownerId, CUSTOMER_GID);
    assertEquals(mf.key, "empresa");
    assertEquals(mf.value, "LedsC4 SA");
    // Flip de dos pasos intacto: tagsAdd pendiente + customerUpdate aprobado
    assert(calls.some((c) => c.query?.includes("tagsAdd")));
    const upd = calls.find((c) => c.query?.includes("customerUpdate"))!;
    const tags = (upd.variables!.input as Record<string, unknown>).tags as string[];
    assert(tags.includes("aprobado"));
    assert(!tags.includes("pendiente"));
  } finally {
    restoreFetch();
  }
});

Deno.test("(b) whitelisted + dominio NO sembrado + sin b2b.empresa → skip (regresión guard)", async () => {
  installFetchMock({
    whitelist: ["compras@com-val.es"],
    candidate: { email: "compras@com-val.es", tags: [], hasEmpresa: false },
    domainRows: [], // sin fila
  });
  try {
    const res = await handle(req());
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.promoted, 0);
    assertEquals(json.promotedViaDomain, []);
    assertEquals(json.skippedNoEmpresa, ["compras@com-val.es"]);
    // Consultó la tabla pero NO tocó metafields ni tags
    assert(calls.some((c) => c.kind === "rest"));
    assert(!calls.some((c) => c.query?.includes("metafieldsSet")));
    assert(!calls.some((c) => c.query?.includes("tagsAdd")));
    assert(!calls.some((c) => c.query?.includes("customerUpdate")));
  } finally {
    restoreFetch();
  }
});

Deno.test("(c) whitelisted + con b2b.empresa → promoción normal sin tocar el metafield", async () => {
  installFetchMock({
    whitelist: ["cliente@empresa.es"],
    candidate: { email: "cliente@empresa.es", tags: ["pendiente"], hasEmpresa: true },
    domainRows: [{ company_id: "gid://shopify/Company/999", company_location_id: "gid://shopify/CompanyLocation/9991" }],
  });
  try {
    const res = await handle(req());
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.promoted, 1);
    assertEquals(json.promotedViaDomain, []);
    // Ni lookup de dominio ni metafieldsSet: la empresa existente manda
    assertEquals(calls.filter((c) => c.kind === "rest").length, 0);
    assert(!calls.some((c) => c.query?.includes("metafieldsSet")));
    // Ya tenía 'pendiente': NO hay tagsAdd, flip directo a aprobado
    assert(!calls.some((c) => c.query?.includes("tagsAdd")));
    assert(calls.some((c) => c.query?.includes("customerUpdate")));
  } finally {
    restoreFetch();
  }
});
