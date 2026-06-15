// Supabase Edge Function: list-pending-customers
//
// Devuelve a la página /pages/admin-backoffice toda la información que
// necesita en una sola llamada:
//   - Lista de customers con tag 'pendiente' (hasta 250, los más recientes
//     primero).
//   - Counts agregados de pendiente / aprobado / rechazado vía
//     `customers(first: 250, query: "tag:X")` y .length.
//   - Whitelist actual (emails y fecha de última actualización).
//
// ⚠ NOTA — counts: `customersCount(query:)` en API 2025-10 ignora el
// argumento `query` y devuelve siempre el total del shop (verificado
// 2026-05-05 contra ledsc4-b2b-outlet.myshopify.com). Bypass aplicado
// con `customers(first: 250, query: "tag:X")` y `.length`. Truncated
// flag por count si hasNextPage. Documentado en docs/pendientes.md.
//
// 🔒 SECURITY: el caller (approver) DEBE tener tag 'backoffice'. La
// verificación se hace server-side aquí — el `{% if customer.tags contains
// 'backoffice' %}` del page template es solo UX. NUNCA borrar la llamada
// a `assertBackofficeTag` de abajo: sin ella, cualquiera con la URL podría
// listar todos los pendientes con sus datos personales.
//
// Auth: HMAC-SHA256 firmado en Liquid con settings.backoffice_hmac_secret.
// Mismo patrón que submit-order-request (TTL 600s).
//
// Input (POST body JSON):
//   {
//     customerId: "gid://shopify/Customer/<approver_id>",
//     timestamp: <unix_seconds>,
//     signature: "<hex hmac>",
//     dryRun?: false       // sin efecto en este endpoint (solo lectura)
//   }
//
// Output:
//   {
//     ok: true,
//     pending: [
//       { id, email, empresa, nif, sector, fechaRegistro }
//     ],
//     pendingTruncated: boolean,                 // true si había >250
//     aprobadoTruncated: boolean,                // true si había >250
//     rechazadoTruncated: boolean,               // true si había >250
//     counts: { pendiente, aprobado, rechazado, whitelist },
//     whitelist: { emails: string[], lastUpdate: ISO|null }
//   }
//
// Errores:
//   400 INVALID_INPUT
//   401 INVALID_SIGNATURE | SIGNATURE_EXPIRED
//   403 NOT_BACKOFFICE
//   500 SHOPIFY_ERROR
//
// Secrets requeridos en Supabase:
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN
//   SHOPIFY_API_VERSION       (opcional, default 2025-10)
//   BACKOFFICE_HMAC_SECRET    (mismo valor que settings.backoffice_hmac_secret)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("BACKOFFICE_HMAC_SECRET");
// Rotación sin downtime: durante la transición se acepta también una firma
// válida contra el secret SALIENTE. Se retira al cerrar la rotación.
const HMAC_SECRET_PREV = Deno.env.get("BACKOFFICE_HMAC_SECRET_PREV");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN || !HMAC_SECRET) {
  throw new Error(
    "Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, BACKOFFICE_HMAC_SECRET",
  );
}

const HMAC_TTL_SECONDS = 600;
const PENDING_HARD_CAP = 250;
const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

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

function logJson(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, fn: "list-pending-customers", ...fields }));
}

async function gql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

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
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(customerId: string, timestamp: number, signature: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(nowSec - timestamp) > HMAC_TTL_SECONDS) {
    return { ok: false, code: "SIGNATURE_EXPIRED" };
  }
  const payload = `${customerId}:${timestamp}`;
  let valid = constantTimeEq(await hmacSha256Hex(payload, HMAC_SECRET!), signature);
  if (!valid && HMAC_SECRET_PREV) {
    valid = constantTimeEq(await hmacSha256Hex(payload, HMAC_SECRET_PREV), signature);
  }
  if (!valid) return { ok: false, code: "INVALID_SIGNATURE" };
  return { ok: true };
}

// 🔒 Verifica server-side que el approver tiene tag 'backoffice'. La UX del
// page template (`{% if customer.tags contains 'backoffice' %}`) NO es la
// fuente de verdad — solo evita que un user normal vea la página por error.
async function assertBackofficeTag(approverId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const data = await gql<{ customer: { id: string; tags: string[] } | null }>(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: approverId },
  );
  if (!data.customer) return { ok: false, code: "APPROVER_NOT_FOUND" };
  if (!data.customer.tags.includes("backoffice")) return { ok: false, code: "NOT_BACKOFFICE" };
  return { ok: true };
}

type PendingNode = {
  id: string;
  defaultEmailAddress: { emailAddress: string } | null;
  empresa: { value: string } | null;
  nif: { value: string } | null;
  sector: { value: string } | null;
  fechaRegistro: { value: string } | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const startedAt = new Date().toISOString();
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const customerId = body.customerId as string | undefined;
    const timestamp = Number(body.timestamp);
    const signature = (body.signature as string | undefined)?.toLowerCase();

    if (!customerId || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ error: "invalid customerId", code: "INVALID_INPUT" }, 400);
    }
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return jsonResponse({ error: "invalid signature format", code: "INVALID_INPUT" }, 400);
    }

    const sigCheck = await verifyHmac(customerId, timestamp, signature);
    if (!sigCheck.ok) {
      logJson("warn", "auth_failed", { code: sigCheck.code, customerId });
      return jsonResponse({ error: sigCheck.code.toLowerCase(), code: sigCheck.code }, 401);
    }

    const tagCheck = await assertBackofficeTag(customerId);
    if (!tagCheck.ok) {
      logJson("warn", "auth_failed", { code: tagCheck.code, customerId });
      return jsonResponse({ error: tagCheck.code.toLowerCase(), code: tagCheck.code }, 403);
    }

    const data = await gql<{
      pending: {
        edges: Array<{ node: PendingNode }>;
        pageInfo: { hasNextPage: boolean };
      };
      aprobado: {
        edges: Array<{ node: { id: string } }>;
        pageInfo: { hasNextPage: boolean };
      };
      rechazado: {
        edges: Array<{ node: { id: string } }>;
        pageInfo: { hasNextPage: boolean };
      };
      shop: {
        whitelistEmails: { value: string } | null;
        whitelistLastUpdate: { value: string } | null;
      };
    }>(`
      query {
        pending: customers(first: ${PENDING_HARD_CAP}, query: "tag:'pendiente'", sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id
              defaultEmailAddress { emailAddress }
              empresa: metafield(namespace: "b2b", key: "empresa") { value }
              nif: metafield(namespace: "b2b", key: "nif") { value }
              sector: metafield(namespace: "b2b", key: "sector") { value }
              fechaRegistro: metafield(namespace: "b2b", key: "fecha_registro") { value }
            }
          }
          pageInfo { hasNextPage }
        }
        aprobado: customers(first: ${PENDING_HARD_CAP}, query: "tag:'aprobado'") {
          edges { node { id } }
          pageInfo { hasNextPage }
        }
        rechazado: customers(first: ${PENDING_HARD_CAP}, query: "tag:'rechazado'") {
          edges { node { id } }
          pageInfo { hasNextPage }
        }
        shop {
          whitelistEmails: metafield(namespace: "b2b", key: "whitelist_emails") { value }
          whitelistLastUpdate: metafield(namespace: "b2b", key: "whitelist_last_update") { value }
        }
      }
    `);

    const pending = data.pending.edges.map(({ node }) => ({
      id: node.id,
      email: node.defaultEmailAddress?.emailAddress ?? "",
      empresa: node.empresa?.value ?? "",
      nif: node.nif?.value ?? "",
      sector: node.sector?.value ?? "",
      fechaRegistro: node.fechaRegistro?.value ?? "",
    }));

    let whitelistEmails: string[] = [];
    if (data.shop.whitelistEmails?.value) {
      try {
        const parsed = JSON.parse(data.shop.whitelistEmails.value) as unknown[];
        whitelistEmails = parsed.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      } catch {
        whitelistEmails = [];
      }
    }

    const result = {
      ok: true,
      startedAt,
      pending,
      pendingTruncated: data.pending.pageInfo.hasNextPage,
      aprobadoTruncated: data.aprobado.pageInfo.hasNextPage,
      rechazadoTruncated: data.rechazado.pageInfo.hasNextPage,
      counts: {
        pendiente: pending.length,
        aprobado: data.aprobado.edges.length,
        rechazado: data.rechazado.edges.length,
        whitelist: whitelistEmails.length,
      },
      whitelist: {
        emails: whitelistEmails,
        lastUpdate: data.shop.whitelistLastUpdate?.value ?? null,
      },
    };

    logJson("info", "list_ok", {
      customerId,
      pendingShown: pending.length,
      pendingTruncated: result.pendingTruncated,
      counts: result.counts,
    });
    return jsonResponse(result);
  } catch (e) {
    const msg = (e as Error).message;
    logJson("error", "list_failed", { error: msg });
    return jsonResponse({ error: msg, code: "SHOPIFY_ERROR" }, 500);
  }
});
