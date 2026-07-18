// Tests para generate-offer-pdf.
//
// Mockeamos `globalThis.fetch` para interceptar tanto las llamadas GraphQL
// a Shopify (Admin API) como el fetch de las imágenes de producto y el POST
// del staged upload, y verificar input/output sin red real. Las env vars se
// setean antes del import dinámico del módulo (que valida y throw si faltan).
//
// Ejecutar:
//   GENERATE_OFFER_PDF_TEST_MODE=1 \
//   SHOPIFY_STORE_DOMAIN=test.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_test \
//   GENERATE_OFFER_PDF_WEBHOOK_SECRET=test_secret \
//   deno test --allow-env --allow-net supabase/functions/generate-offer-pdf/

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("GENERATE_OFFER_PDF_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("GENERATE_OFFER_PDF_WEBHOOK_SECRET", "test_webhook_secret");

const mod = await import("./index.ts");
const handle: (req: Request) => Promise<Response> = mod.handle;

const SECRET = "test_webhook_secret";
const DRAFT_GID = "gid://shopify/DraftOrder/999";

// --- Fetch mocking ---------------------------------------------------------

interface Call {
  kind: "graphql" | "image" | "staged_upload" | "other";
  url: string;
  body?: unknown;
}

let calls: Call[] = [];
type Handler = (call: Call) => unknown;
let handler: Handler = () => ({});
const originalFetch = globalThis.fetch;

// Un PNG 1x1 real (mínimo válido) para simular la descarga de la miniatura.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function tinyPngBytes(): Uint8Array {
  const bin = atob(TINY_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// URL real del logo (assets/... del theme, fuera de cdn.shopify.com) — se
// mockea aparte para no depender de red real en los tests ni acoplar el
// mock al dominio exacto usado en producción.
const LOGO_URL = "https://shop.ledsc4.com/cdn/shop/files/logo-ledsc4.png";

function installFetchMock(h: Handler, opts: { logoFails?: boolean } = {}): void {
  calls = [];
  handler = h;
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/admin/api/")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const call: Call = { kind: "graphql", url, body };
      calls.push(call);
      const data = handler(call);
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === LOGO_URL) {
      calls.push({ kind: "image", url });
      if (opts.logoFails) return new Response("not found", { status: 404 });
      return new Response(tinyPngBytes() as BodyInit, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    if (url.includes("cdn.shopify.com")) {
      calls.push({ kind: "image", url });
      return new Response(tinyPngBytes() as BodyInit, { status: 200, headers: { "Content-Type": "image/png" } });
    }
    if (url.includes("staged-upload")) {
      calls.push({ kind: "staged_upload", url });
      return new Response("", { status: 200 });
    }
    calls.push({ kind: "other", url });
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function makeReq(body: unknown, secret = SECRET): Request {
  return new Request("https://example.com/generate-offer-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify(body),
  });
}

function draftOrderNode(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_GID,
    name: "D9999",
    note2: "Comentario de prueba",
    tags: ["pendiente-revision", "solicitud-b2b"],
    totalPrice: "100.00",
    customAttributes: [
      { key: "Moneda mostrada", value: "EUR" },
      { key: "Símbolo moneda", value: "€" },
    ],
    pdfUrlMetafield: null,
    customer: {
      id: "gid://shopify/Customer/1",
      tags: ["aprobado"],
      locale: "es",
      cp: { value: "28001" },
      utmSource: { value: "meta" },
      utmMedium: { value: "paid_social" },
      utmCampaign: { value: "instalador_q3" },
    },
    lineItems: {
      edges: [
        {
          node: {
            title: "Producto de prueba",
            variantTitle: "Default Title",
            sku: "SKU-1",
            quantity: 2,
            originalUnitPriceSet: { presentmentMoney: { amount: "50.00", currencyCode: "EUR" } },
            discountedTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "EUR" } },
            image: { url: "https://cdn.shopify.com/fake.png" },
          },
        },
      ],
    },
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

Deno.test("rechaza sin X-Webhook-Secret (401)", async () => {
  const res = await handle(makeReq({ draftOrderId: DRAFT_GID }, "wrong"));
  assertEquals(res.status, 401);
  restoreFetch();
});

Deno.test("rechaza draftOrderId inválido (400)", async () => {
  const res = await handle(makeReq({ draftOrderId: "not-a-gid" }));
  assertEquals(res.status, 400);
  restoreFetch();
});

Deno.test("draft no encontrado (404)", async () => {
  installFetchMock(() => ({ draftOrder: null }));
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 404);
  } finally {
    restoreFetch();
  }
});

Deno.test("idempotencia: si ya hay pdf_url, lo devuelve sin regenerar (pero reescribe última oferta en el customer)", async () => {
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return { draftOrder: draftOrderNode({ pdfUrlMetafield: { value: "https://cdn.shopify.com/existing.pdf" } }) };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("unexpected call: " + JSON.stringify(call));
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.pdf_url, "https://cdn.shopify.com/existing.pdf");
    // El hit idempotente también debe traer total_oferta y el passthrough
    // (cp/locale/utm_*) — Flow necesita el mismo shape se regenere o no el PDF.
    assertEquals(json.total_oferta, "100,00 €");
    assertEquals(json.cp, "28001");
    assertEquals(json.locale, "es");
    assertEquals(json.utm_source, "meta");
    assertEquals(json.utm_medium, "paid_social");
    assertEquals(json.utm_campaign, "instalador_q3");
    // NO debe subir PDF ni tocar el metafield b2b.pdf_url del draft (ya
    // existe) — pero SÍ debe reescribir "última oferta" en el customer, para
    // que un reintento sobre un draft ya procesado no lo deje desfasado.
    assertEquals(calls.filter((c) => c.kind === "staged_upload").length, 0);
    const setCall = calls.find((c) => c.kind === "graphql" && (c.body as { query: string }).query.includes("SetOfferMetafields"));
    assertExists(setCall);
    const vars = (setCall!.body as { variables: { metafields: Array<Record<string, unknown>> } }).variables;
    assertEquals(vars.metafields.length, 3);
    assertEquals(vars.metafields.every((m) => m.ownerId === "gid://shopify/Customer/1"), true);
    const byKey = Object.fromEntries(vars.metafields.map((m) => [m.key, m.value]));
    assertEquals(byKey.ultima_oferta_pdf, "https://cdn.shopify.com/existing.pdf");
    assertEquals(byKey.ultima_oferta_ref, "D9999");
    assertEquals(byKey.ultima_oferta_total, "100,00 €");
  } finally {
    restoreFetch();
  }
});

Deno.test("happy path: genera PDF, sube a Files, escribe metafield", async () => {
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return { draftOrder: draftOrderNode() };
    }
    if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
      return {
        stagedUploadsCreate: {
          stagedTargets: [{
            url: "https://staged-upload.example.com/upload",
            resourceUrl: "https://staged-upload.example.com/resource/abc",
            parameters: [{ name: "key", value: "abc" }],
          }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("FileCreate")) {
      return {
        fileCreate: {
          files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta-D9999.pdf" }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [{ id: "1", namespace: "b2b", key: "pdf_url", value: "https://cdn.shopify.com/files/oferta-D9999.pdf" }], userErrors: [] } };
    }
    throw new Error("unexpected call: " + JSON.stringify(call));
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.pdf_url, "https://cdn.shopify.com/files/oferta-D9999.pdf");
    // Sin markup (customer no instalador): total_oferta = totalPrice tal cual, en EUR.
    assertEquals(json.total_oferta, "100,00 €");
    // Passthrough para Flow: cp/locale/utm_* del customer (metafields b2b.*).
    assertEquals(json.cp, "28001");
    assertEquals(json.locale, "es");
    assertEquals(json.utm_source, "meta");
    assertEquals(json.utm_medium, "paid_social");
    assertEquals(json.utm_campaign, "instalador_q3");

    const uploadCall = calls.find((c) => c.kind === "staged_upload");
    assertExists(uploadCall);

    const setCall = calls.find(
      (c) => c.kind === "graphql" && (c.body as { query: string }).query.includes("SetOfferMetafields"),
    );
    assertExists(setCall);
    const vars = (setCall!.body as { variables: { metafields: Array<Record<string, unknown>> } }).variables;
    // 1 metafield en el DRAFT (b2b.pdf_url, sin cambios) + 3 en el CUSTOMER
    // ("última oferta") — mismo lote de metafieldsSet.
    assertEquals(vars.metafields.length, 4);
    assertEquals(vars.metafields[0].namespace, "b2b");
    assertEquals(vars.metafields[0].key, "pdf_url");
    assertEquals(vars.metafields[0].type, "url");
    assertEquals(vars.metafields[0].value, "https://cdn.shopify.com/files/oferta-D9999.pdf");
    assertEquals(vars.metafields[0].ownerId, DRAFT_GID);

    const customerEntries = vars.metafields.slice(1);
    assertEquals(customerEntries.every((m) => m.ownerId === "gid://shopify/Customer/1"), true);
    assertEquals(customerEntries.every((m) => m.namespace === "b2b"), true);
    assertEquals(customerEntries.every((m) => m.type === "single_line_text_field"), true);
    const byKey = Object.fromEntries(customerEntries.map((m) => [m.key, m.value]));
    assertEquals(byKey.ultima_oferta_pdf, "https://cdn.shopify.com/files/oferta-D9999.pdf");
    assertEquals(byKey.ultima_oferta_ref, "D9999");
    assertEquals(byKey.ultima_oferta_total, "100,00 €");
  } finally {
    restoreFetch();
  }
});

Deno.test("logo: si la descarga del PNG falla, el PDF se genera igual (fallback a wordmark de texto, nunca falla)", async () => {
  installFetchMock(
    (call) => {
      const query = (call.body as { query: string } | undefined)?.query ?? "";
      if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
        return { draftOrder: draftOrderNode() };
      }
      if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
        return {
          stagedUploadsCreate: {
            stagedTargets: [{ url: "https://staged-upload.example.com/upload", resourceUrl: "https://staged-upload.example.com/resource/abc", parameters: [] }],
            userErrors: [],
          },
        };
      }
      if (call.kind === "graphql" && query.includes("FileCreate")) {
        return { fileCreate: { files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta.pdf" }], userErrors: [] } };
      }
      if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
        return { metafieldsSet: { metafields: [], userErrors: [] } };
      }
      throw new Error("unexpected call");
    },
    { logoFails: true },
  );
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertExists(json.pdf_url);
    // Se intentó descargar el logo (404) pero no propagó el error.
    const logoCall = calls.find((c) => c.kind === "image" && c.url === LOGO_URL);
    assertExists(logoCall);
  } finally {
    restoreFetch();
  }
});

Deno.test("markup instalador: ×1.15 solo si el customer tiene tag instalador, con el MISMO redondeo que el frontend", async () => {
  // Caso de empate deliberado: 9.90 × 1.15 = 11.385 (justo en el límite del
  // 3er decimal). El frontend (ledsc4-currency-display.js) usa
  // `toLocaleString('es-ES', {minimumFractionDigits:2,maximumFractionDigits:2})`,
  // que redondea 11.385 -> "11,39" (verificado empíricamente en Deno/V8,
  // mismo motor que el navegador). Si esta función usara una fórmula
  // distinta (p.ej. Intl.NumberFormat style:'currency', o un toFixed con
  // otro criterio de redondeo) este test detectaría la divergencia.
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return {
        draftOrder: draftOrderNode({
          totalPrice: "9.90",
          customAttributes: [
            { key: "Moneda mostrada", value: "EUR" },
            { key: "Símbolo moneda", value: "€" },
          ],
          customer: { id: "gid://shopify/Customer/1", tags: ["aprobado", "instalador"] },
          lineItems: {
            edges: [{
              node: {
                title: "Producto de prueba",
                variantTitle: "Default Title",
                sku: "SKU-1",
                quantity: 1,
                originalUnitPriceSet: { presentmentMoney: { amount: "9.90", currencyCode: "EUR" } },
                discountedTotalSet: { presentmentMoney: { amount: "9.90", currencyCode: "EUR" } },
                image: null,
              },
            }],
          },
        }),
      };
    }
    if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
      return {
        stagedUploadsCreate: {
          stagedTargets: [{ url: "https://staged-upload.example.com/upload", resourceUrl: "https://staged-upload.example.com/resource/abc", parameters: [] }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("FileCreate")) {
      return { fileCreate: { files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta.pdf" }], userErrors: [] } };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("unexpected call");
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    // 9.90 × 1.15 = 11.385 -> redondeo "half away from zero" a 2 decimales -> 11,39 €
    assertEquals(json.total_oferta, "11,39 €");
  } finally {
    restoreFetch();
  }
});

Deno.test("total_oferta ignora el símbolo cosmético de customAttributes (siempre €, nunca $/£)", async () => {
  // El cliente pudo tener seleccionado USD/GBP como display cosmético al
  // enviar la solicitud (customAttributes "Moneda mostrada"/"Símbolo
  // moneda" grabados por submit-order-request) — pero el draft y la
  // oferta son EUR real, sin conversión de tasa. total_oferta NUNCA debe
  // reflejar ese símbolo cosmético (decisión Dani 2026-07-17: sería
  // engañoso poner $/£ sobre un importe sin convertir).
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return {
        draftOrder: draftOrderNode({
          customAttributes: [
            { key: "Moneda mostrada", value: "USD" },
            { key: "Símbolo moneda", value: "$" },
          ],
        }),
      };
    }
    if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
      return {
        stagedUploadsCreate: {
          stagedTargets: [{ url: "https://staged-upload.example.com/upload", resourceUrl: "https://staged-upload.example.com/resource/abc", parameters: [] }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("FileCreate")) {
      return { fileCreate: { files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta.pdf" }], userErrors: [] } };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("unexpected call");
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.total_oferta, "100,00 €");
  } finally {
    restoreFetch();
  }
});

Deno.test("sin tag instalador: total_oferta NO lleva markup (mismo valor que el draft)", async () => {
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return {
        draftOrder: draftOrderNode({
          totalPrice: "9.90",
          customer: { id: "gid://shopify/Customer/1", tags: ["aprobado"] }, // sin 'instalador'
        }),
      };
    }
    if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
      return {
        stagedUploadsCreate: {
          stagedTargets: [{ url: "https://staged-upload.example.com/upload", resourceUrl: "https://staged-upload.example.com/resource/abc", parameters: [] }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("FileCreate")) {
      return { fileCreate: { files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta.pdf" }], userErrors: [] } };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("unexpected call");
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.total_oferta, "9,90 €");
    // Este customer no trae locale/cp/utm_* (metafields inexistentes) —
    // deben venir como "" y NUNCA como null/undefined.
    assertEquals(json.cp, "");
    assertEquals(json.locale, "");
    assertEquals(json.utm_source, "");
    assertEquals(json.utm_medium, "");
    assertEquals(json.utm_campaign, "");
  } finally {
    restoreFetch();
  }
});

Deno.test("draft sin customer asociado: no falla, salta la escritura de 'última oferta'", async () => {
  installFetchMock((call) => {
    const query = (call.body as { query: string } | undefined)?.query ?? "";
    if (call.kind === "graphql" && query.includes("GenerateOfferPdf")) {
      return { draftOrder: draftOrderNode({ customer: null }) };
    }
    if (call.kind === "graphql" && query.includes("StagedUploadsCreate")) {
      return {
        stagedUploadsCreate: {
          stagedTargets: [{ url: "https://staged-upload.example.com/upload", resourceUrl: "https://staged-upload.example.com/resource/abc", parameters: [] }],
          userErrors: [],
        },
      };
    }
    if (call.kind === "graphql" && query.includes("FileCreate")) {
      return { fileCreate: { files: [{ id: "gid://shopify/GenericFile/1", fileStatus: "READY", url: "https://cdn.shopify.com/files/oferta.pdf" }], userErrors: [] } };
    }
    if (call.kind === "graphql" && query.includes("SetOfferMetafields")) {
      return { metafieldsSet: { metafields: [], userErrors: [] } };
    }
    throw new Error("unexpected call");
  });
  try {
    const res = await handle(makeReq({ draftOrderId: DRAFT_GID }));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.cp, "");
    assertEquals(json.locale, "");
    // El metafieldsSet SÍ se llama (sigue escribiendo b2b.pdf_url en el
    // draft) pero solo con esa entrada — sin customer no hay a quién
    // escribirle "última oferta".
    const setCall = calls.find((c) => c.kind === "graphql" && (c.body as { query: string }).query.includes("SetOfferMetafields"));
    assertExists(setCall);
    const vars = (setCall!.body as { variables: { metafields: Array<Record<string, unknown>> } }).variables;
    assertEquals(vars.metafields.length, 1);
    assertEquals(vars.metafields[0].key, "pdf_url");
  } finally {
    restoreFetch();
  }
});
