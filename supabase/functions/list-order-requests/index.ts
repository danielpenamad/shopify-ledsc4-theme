// Supabase Edge Function: list-order-requests
//
// Devuelve el historial de draft orders con tag 'solicitud-b2b' del
// customer logeado. Usado por /pages/mis-solicitudes y /pages/
// solicitud-detalle en el storefront.
//
// Auth: mismo esquema HMAC que submit-order-request. El Liquid firma
// `<customerId>:<timestamp>` con ORDER_REQUEST_HMAC_SECRET y pasa via
// query string (GET) o body (POST).
//
// Endpoints:
//   GET/POST /?customerId=&timestamp=&signature=&ref=DXXXX
//     - Sin ref: lista todas las solicitudes (resumen).
//     - Con ref: devuelve el detalle de esa solicitud concreta.
//
// Secrets requeridos:
//   SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, ORDER_REQUEST_HMAC_SECRET

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("ORDER_REQUEST_HMAC_SECRET");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN || !HMAC_SECRET) {
  throw new Error("Missing required env vars");
}

const HMAC_TTL_SECONDS = 600;
const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function gql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN! },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function mapStatus(tags: string[]): string {
  if (tags.includes("cancelada")) return "cancelada";
  if (tags.includes("confirmada")) return "confirmada";
  if (tags.includes("en-tramite")) return "en-tramite";
  if (tags.includes("pendiente-revision")) return "pendiente-revision";
  return "pendiente-revision"; // default safe
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    // Params: GET via URL, POST via body
    let customerId: string | undefined;
    let timestamp: number;
    let signature: string | undefined;
    let ref: string | undefined;

    if (req.method === "GET") {
      const url = new URL(req.url);
      customerId = url.searchParams.get("customerId") ?? undefined;
      timestamp = Number(url.searchParams.get("timestamp"));
      signature = (url.searchParams.get("signature") ?? "").toLowerCase();
      ref = url.searchParams.get("ref") ?? undefined;
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({} as Record<string, unknown>));
      customerId = body.customerId as string | undefined;
      timestamp = Number(body.timestamp);
      signature = (body.signature as string | undefined)?.toLowerCase();
      ref = body.ref as string | undefined;
    } else {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    if (!customerId || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ error: "invalid_customerId" }, 400);
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0) return jsonResponse({ error: "invalid_timestamp" }, 400);
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return jsonResponse({ error: "invalid_signature_format" }, 400);

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > HMAC_TTL_SECONDS) {
      return jsonResponse({ error: "signature_expired" }, 401);
    }
    const expectedSig = await hmacSha256Hex(`${customerId}:${timestamp}`, HMAC_SECRET!);
    if (!constantTimeEq(expectedSig, signature)) return jsonResponse({ error: "invalid_signature" }, 401);

    const custNumericId = customerId.split("/").pop();

    // --- Detalle (ref) ---
    if (ref) {
      // Query por name (e.g. D1042) filtrado por customer
      const data = await gql<{
        draftOrders: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              createdAt: string;
              tags: string[];
              note2: string | null;
              totalPrice: string;
              subtotalPrice: string;
              customAttributes: Array<{ key: string; value: string }>;
              lineItems: {
                edges: Array<{
                  node: {
                    title: string;
                    variantTitle: string | null;
                    quantity: number;
                    sku: string | null;
                    originalUnitPriceSet: { presentmentMoney: { amount: string; currencyCode: string } };
                    discountedTotalSet: { presentmentMoney: { amount: string; currencyCode: string } };
                  };
                }>;
              };
            };
          }>;
        };
      }>(
        `
        query($q: String!) {
          draftOrders(first: 1, query: $q) {
            edges {
              node {
                id name createdAt tags note2 totalPrice subtotalPrice
                customAttributes { key value }
                lineItems(first: 100) {
                  edges { node {
                    title variantTitle quantity sku
                    originalUnitPriceSet { presentmentMoney { amount currencyCode } }
                    discountedTotalSet { presentmentMoney { amount currencyCode } }
                  } }
                }
              }
            }
          }
        }
        `,
        { q: `name:${ref} AND customer_id:${custNumericId} AND tag:solicitud-b2b` },
      );
      const node = data.draftOrders.edges[0]?.node;
      if (!node) return jsonResponse({ error: "not_found" }, 404);

      return jsonResponse({
        id: node.id,
        name: node.name,
        createdAt: node.createdAt,
        status: mapStatus(node.tags),
        note: node.note2,
        totalPrice: node.totalPrice,
        subtotalPrice: node.subtotalPrice,
        customAttributes: node.customAttributes,
        lineItems: node.lineItems.edges.map((e) => ({
          title: e.node.title,
          variantTitle: e.node.variantTitle,
          quantity: e.node.quantity,
          sku: e.node.sku,
          unitPrice: e.node.originalUnitPriceSet.presentmentMoney,
          totalPrice: e.node.discountedTotalSet.presentmentMoney,
        })),
      });
    }

    // --- Lista (resumen) ---
    const data = await gql<{
      draftOrders: {
        edges: Array<{
          node: {
            id: string;
            name: string;
            createdAt: string;
            tags: string[];
            totalPrice: string;
            lineItems: { edges: Array<{ node: { quantity: number } }> };
          };
        }>;
      };
    }>(
      `
      query($q: String!) {
        draftOrders(first: 50, query: $q, sortKey: ID, reverse: true) {
          edges {
            node {
              id name createdAt tags totalPrice
              lineItems(first: 100) { edges { node { quantity } } }
            }
          }
        }
      }
      `,
      { q: `customer_id:${custNumericId} AND tag:solicitud-b2b` },
    );

    const items = data.draftOrders.edges.map((e) => {
      const n = e.node;
      const totalItems = n.lineItems.edges.reduce((sum, li) => sum + li.node.quantity, 0);
      return {
        id: n.id,
        name: n.name,
        createdAt: n.createdAt,
        status: mapStatus(n.tags),
        totalItems,
        totalPrice: n.totalPrice,
      };
    });

    return jsonResponse({ items });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
