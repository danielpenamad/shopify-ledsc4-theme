// Supabase Edge Function: submit-order-request
//
// Invocada desde el storefront B2B (page /pages/solicitud) cuando el
// customer pulsa "Confirmar y enviar solicitud". Crea un Draft Order en
// Shopify con los items del carrito, tags 'solicitud-b2b' + 'pendiente-
// revision', calcula CBM total sumando (qty x product.metafield.b2b.
// cbm_caja) y deja el draft listo para que el backoffice lo revise en
// admin → Orders → Drafts.
//
// Auth: HMAC-SHA256 del payload `<customer_id>:<timestamp>` firmado por
// Liquid server-side con `settings.order_request_hmac_secret`. El mismo
// secret se configura aquí como env var ORDER_REQUEST_HMAC_SECRET. TTL
// 10 min (margen para que el usuario complete el form tras llegar a /pages/solicitud).
//
// Re-verificaciones server-side pese al HMAC:
//   - El customer tiene tag 'aprobado' (gate de negocio).
//   - Sin duplicados en última hora (salvo force:true).
//
// Input (body JSON):
//   {
//     customerId: "gid://shopify/Customer/123",
//     timestamp: 1712345678,           // unix seconds, firmado
//     signature: "<hex hmac>",         // hmac_sha256(customerId:timestamp, SECRET)
//     note: "texto libre opcional",
//     items: [
//       { variantId: "gid://shopify/ProductVariant/456", quantity: 2 },
//       ...
//     ],
//     force: true                      // opcional, bypass de warning de duplicado
//   }
//
// Output:
//   { ok: true, draftOrderId, draftOrderName, cbmTotal }       (200 creado)
//   { warning: "recent_request", recentDraft: {...} }          (200 sin crear, pide confirmación)
//   { error: "...", ... }                                      (4xx/5xx)
//
// Secrets requeridos en Supabase (Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN                 (scopes: read_customers, write_draft_orders, read_products)
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   ORDER_REQUEST_HMAC_SECRET           (mismo valor en settings.order_request_hmac_secret del tema)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("ORDER_REQUEST_HMAC_SECRET");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}
if (!HMAC_SECRET) {
  throw new Error("Missing ORDER_REQUEST_HMAC_SECRET env var");
}

const HMAC_TTL_SECONDS = 600; // 10 min margen
const DUPLICATE_WINDOW_SECONDS = 60 * 60; // 60 min
const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// --- CORS para llamadas cross-origin desde el storefront ---
const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

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

// ---- HMAC ----
async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- Serve ----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const startedAt = new Date().toISOString();

  try {
    // --- 1. Parse + validate input ---
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const customerId = body.customerId as string | undefined;
    const timestamp = Number(body.timestamp);
    const signature = (body.signature as string | undefined)?.toLowerCase();
    const note = (body.note as string | undefined)?.slice(0, 1000) ?? "";
    const force = body.force === true;
    const items = (body.items as Array<{ variantId: string; quantity: number }> | undefined) ?? [];

    if (!customerId || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ startedAt, error: "invalid_customerId" }, 400);
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return jsonResponse({ startedAt, error: "invalid_timestamp" }, 400);
    }
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return jsonResponse({ startedAt, error: "invalid_signature_format" }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ startedAt, error: "empty_cart" }, 400);
    }
    for (const it of items) {
      if (!it.variantId?.startsWith("gid://shopify/ProductVariant/") || !Number.isFinite(it.quantity) || it.quantity <= 0) {
        return jsonResponse({ startedAt, error: "invalid_line_item", item: it }, 400);
      }
    }

    // --- 2. HMAC verify ---
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > HMAC_TTL_SECONDS) {
      return jsonResponse({
        startedAt,
        error: "signature_expired",
        message: "Refresca la página antes de enviar la solicitud.",
      }, 401);
    }
    const expectedSig = await hmacSha256Hex(`${customerId}:${timestamp}`, HMAC_SECRET!);
    if (!constantTimeEq(expectedSig, signature)) {
      return jsonResponse({ startedAt, error: "invalid_signature" }, 401);
    }

    // --- 3. Fetch customer, verify tag 'aprobado' ---
    const custData = await gql<{
      customer: {
        id: string;
        tags: string[];
        firstName: string;
        lastName: string;
        defaultEmailAddress: { emailAddress: string } | null;
      } | null;
    }>(
      `
      query($id: ID!) {
        customer(id: $id) {
          id tags firstName lastName
          defaultEmailAddress { emailAddress }
        }
      }
      `,
      { id: customerId },
    );
    const customer = custData.customer;
    if (!customer) {
      return jsonResponse({ startedAt, error: "customer_not_found" }, 404);
    }
    if (!customer.tags.includes("aprobado")) {
      return jsonResponse({ startedAt, error: "customer_not_approved" }, 403);
    }

    // --- 4. Duplicate check: any draft with tag pendiente-revision en últ 60min ---
    if (!force) {
      const cutoffIso = new Date(Date.now() - DUPLICATE_WINDOW_SECONDS * 1000).toISOString();
      // Query draftOrders filter: customer id + tag + created_at range
      // Draft orders API usa `query` DSL similar a orders.
      const custNumericId = customerId.split("/").pop();
      const dupData = await gql<{
        draftOrders: {
          edges: Array<{
            node: { id: string; name: string; createdAt: string; tags: string[] };
          }>;
        };
      }>(
        `
        query($q: String!) {
          draftOrders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges {
              node { id name createdAt tags }
            }
          }
        }
        `,
        { q: `customer_id:${custNumericId} AND tag:pendiente-revision AND created_at:>'${cutoffIso}'` },
      );
      const recent = dupData.draftOrders.edges[0]?.node;
      if (recent) {
        return jsonResponse({
          startedAt,
          warning: "recent_request",
          message: "Tienes una solicitud muy reciente. ¿Seguro que quieres enviar otra?",
          recentDraft: {
            id: recent.id,
            name: recent.name,
            createdAt: recent.createdAt,
          },
        }, 200);
      }
    }

    // --- 5. Fetch product variants + their product.metafield b2b.cbm_caja ---
    const variantIds = items.map((it) => it.variantId);
    const varData = await gql<{
      nodes: Array<
        | {
          id: string;
          product: {
            id: string;
            cbmCaja: { value: string } | null;
          };
        }
        | null
      >;
    }>(
      `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            product {
              id
              cbmCaja: metafield(namespace: "b2b", key: "cbm_caja") { value }
            }
          }
        }
      }
      `,
      { ids: variantIds },
    );

    let cbmTotal = 0;
    const cbmByVariant = new Map<string, number>();
    for (const node of varData.nodes) {
      if (!node) continue;
      const cbmValStr = node.product.cbmCaja?.value ?? "0";
      const cbmUnit = Number.parseFloat(cbmValStr);
      cbmByVariant.set(node.id, Number.isFinite(cbmUnit) ? cbmUnit : 0);
    }
    for (const it of items) {
      const cbmUnit = cbmByVariant.get(it.variantId) ?? 0;
      cbmTotal += cbmUnit * it.quantity;
    }
    cbmTotal = Math.round(cbmTotal * 1000) / 1000; // 3 decimales

    // --- 6. Create draft order ---
    const createData = await gql<{
      draftOrderCreate: {
        draftOrder: { id: string; name: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `
      mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id name }
          userErrors { field message }
        }
      }
      `,
      {
        input: {
          purchasingEntity: { customerId },
          lineItems: items.map((it) => ({ variantId: it.variantId, quantity: it.quantity })),
          note: note || null,
          tags: ["solicitud-b2b", "pendiente-revision"],
          customAttributes: [
            { key: "fuente", value: "solicitud-b2b-frontend" },
            { key: "cbm_total", value: cbmTotal.toString() },
            { key: "fecha_solicitud", value: new Date().toISOString() },
          ],
        },
      },
    );

    const errs = createData.draftOrderCreate.userErrors;
    if (errs.length) {
      return jsonResponse({ startedAt, error: "draftOrderCreate_userErrors", userErrors: errs }, 500);
    }

    const draft = createData.draftOrderCreate.draftOrder!;
    return jsonResponse({
      startedAt,
      ok: true,
      draftOrderId: draft.id,
      draftOrderName: draft.name,
      cbmTotal,
    });
  } catch (e) {
    return jsonResponse({ startedAt, error: (e as Error).message }, 500);
  }
});
