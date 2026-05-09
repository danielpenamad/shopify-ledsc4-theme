// Supabase Edge Function: approve-customer
//
// Reemplaza el flujo manual del staff descrito en
// docs/backoffice-aprobaciones.md §3.1 (quitar tag 'pendiente' + añadir
// 'aprobado' en el mismo Save). El bug crítico del flujo manual: si el
// staff hace dos Save separados, W2 puede no disparar porque su
// condición es `'aprobado' IS IN tags AND 'pendiente' IS IN tags_previous`.
//
// Esta función usa `customerUpdate(input: { tags: [...] })` que reemplaza
// el array de tags atómicamente (Admin API 2025-10) — un solo evento de
// `Customer updated` que pasa la condición de W2 limpiamente. Documentado
// en CustomerInput.tags: "Updating tags overwrites any existing tags".
//
// 🔒 SECURITY: el caller (approver) DEBE tener tag 'backoffice'. La
// verificación se hace server-side aquí — el `{% if customer.tags contains
// 'backoffice' %}` del page template es solo UX. NUNCA borrar la llamada
// a `assertBackofficeTag` de abajo: sin ella cualquiera podría aprobar
// customers arbitrarios y crear Companies en el catálogo Outlet.
//
// Reparto edge function ↔ Flow W2 (post C.6 T5):
//   - Esta edge function: cambia tags atómicamente Y aplica la semántica
//     de transición de estado: set b2b.fecha_aprobacion + delete
//     b2b.fecha_rechazo + delete b2b.motivo_rechazo. Garantiza
//     coherencia entre tag y metafields (caso real visto en
//     ledsc4-test2 antes del cleanup manual: aprobado con
//     motivo_rechazo activo de un rechazo previo).
//   - W2 (Shopify Flow): detecta el cambio de tag y se encarga de la
//     llamada a `create-company-for-customer` y email 4 al cliente.
//     Si W2 también setea fecha_aprobacion (legacy step 3.2), el
//     overwrite es idempotente con la fecha de hoy.
//
// Auth: HMAC-SHA256 firmado en Liquid con settings.backoffice_hmac_secret.
//
// Input (POST body JSON):
//   {
//     customerId: "gid://shopify/Customer/<approver_id>",
//     timestamp: <unix_seconds>,
//     signature: "<hex hmac>",
//     targetCustomerId: "gid://shopify/Customer/<target_id>",
//     dryRun?: false
//   }
//
// Output:
//   { ok: true, customerId, taggedAt, previousTags, newTags, semantics }
//   semantics: "applied" si los metafields de estado se actualizaron
//   coherentemente, "skipped" si dryRun.
//
// Errores:
//   400 INVALID_INPUT
//   401 INVALID_SIGNATURE | SIGNATURE_EXPIRED
//   403 NOT_BACKOFFICE
//   404 TARGET_NOT_FOUND
//   409 INVALID_STATE (target no tiene tag 'pendiente')
//   500 SHOPIFY_ERROR
//
// Secrets requeridos en Supabase:
//   SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, BACKOFFICE_HMAC_SECRET
//   SHOPIFY_API_VERSION  (opcional, default 2025-10)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("BACKOFFICE_HMAC_SECRET");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN || !HMAC_SECRET) {
  throw new Error(
    "Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, BACKOFFICE_HMAC_SECRET",
  );
}

const HMAC_TTL_SECONDS = 600;
const STATE_TAGS = new Set(["pendiente", "aprobado", "rechazado"]);
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
  console.log(JSON.stringify({ level, event, fn: "approve-customer", ...fields }));
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
  const expected = await hmacSha256Hex(`${customerId}:${timestamp}`, HMAC_SECRET!);
  if (!constantTimeEq(expected, signature)) return { ok: false, code: "INVALID_SIGNATURE" };
  return { ok: true };
}

// --- Semántica de transición a 'aprobado' (C.6 T5) -------------------
//
// Tras el flip atómico de tags a 'aprobado', estos metafields deben
// quedar coherentes con el estado:
//   - b2b.fecha_aprobacion → setear con fecha actual UTC (date type).
//   - b2b.fecha_rechazo, b2b.motivo_rechazo → borrar si existían
//     (residuos de un rechazo previo no deben sobrevivir a una aprobación).
//
// El builder es puro y exportado para tests aislados.

export type SemanticsInput = {
  sets: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }>;
  deletes: Array<{ ownerId: string; namespace: string; key: string }>;
};

export function buildApprovalSemanticsInput(customerId: string, today: string): SemanticsInput {
  return {
    sets: [
      { ownerId: customerId, namespace: "b2b", key: "fecha_aprobacion", type: "date", value: today },
    ],
    deletes: [
      { ownerId: customerId, namespace: "b2b", key: "fecha_rechazo" },
      { ownerId: customerId, namespace: "b2b", key: "motivo_rechazo" },
    ],
  };
}

const SEMANTICS_MUTATION = `
  mutation ApplySemantics(
    $sets: [MetafieldsSetInput!]!,
    $deletes: [MetafieldIdentifierInput!]!
  ) {
    metafieldsSet(metafields: $sets) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
    metafieldsDelete(metafields: $deletes) {
      deletedMetafields { ownerId namespace key }
      userErrors { field message }
    }
  }
`;

type SemanticsResp = {
  metafieldsSet: { userErrors: Array<{ field: string[] | null; message: string; code: string }> };
  metafieldsDelete: { userErrors: Array<{ field: string[] | null; message: string }> };
};

// 🔒 Server-side enforcement del rol backoffice. Sin esto, cualquiera con
// la URL pública de la edge function podría aprobar customers a voluntad.
async function assertBackofficeTag(approverId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const data = await gql<{ customer: { id: string; tags: string[] } | null }>(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: approverId },
  );
  if (!data.customer) return { ok: false, code: "APPROVER_NOT_FOUND" };
  if (!data.customer.tags.includes("backoffice")) return { ok: false, code: "NOT_BACKOFFICE" };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const startedAt = new Date().toISOString();
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const customerId = body.customerId as string | undefined;
    const timestamp = Number(body.timestamp);
    const signature = (body.signature as string | undefined)?.toLowerCase();
    const targetCustomerId = body.targetCustomerId as string | undefined;
    const dryRun = body.dryRun === true;

    if (!customerId || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ error: "invalid customerId", code: "INVALID_INPUT" }, 400);
    }
    if (!targetCustomerId || !targetCustomerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ error: "invalid targetCustomerId", code: "INVALID_INPUT" }, 400);
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

    const targetData = await gql<{ customer: { id: string; tags: string[] } | null }>(
      `query($id: ID!) { customer(id: $id) { id tags } }`,
      { id: targetCustomerId },
    );
    const target = targetData.customer;
    if (!target) {
      return jsonResponse({ error: "target customer not found", code: "TARGET_NOT_FOUND" }, 404);
    }
    if (!target.tags.includes("pendiente")) {
      logJson("warn", "invalid_state", { targetCustomerId, currentTags: target.tags });
      return jsonResponse({
        error: "target customer is not in 'pendiente' state",
        code: "INVALID_STATE",
        currentTags: target.tags,
      }, 409);
    }

    // Construir nuevos tags: quitar todos los state tags + añadir 'aprobado'.
    // Conserva tags no-estado (ej. nif_invalido, datos_incompletos).
    const newTags = target.tags.filter((t) => !STATE_TAGS.has(t));
    newTags.push("aprobado");

    if (dryRun) {
      logJson("info", "dry_run", { customerId, targetCustomerId, previousTags: target.tags, newTags });
      return jsonResponse({
        ok: true,
        startedAt,
        dryRun: true,
        customerId: targetCustomerId,
        previousTags: target.tags,
        newTags,
        semantics: "skipped",
      });
    }

    const updateData = await gql<{
      customerUpdate: {
        customer: { id: string; tags: string[] } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(
      `
      mutation($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id tags }
          userErrors { field message }
        }
      }
      `,
      { input: { id: targetCustomerId, tags: newTags } },
    );

    const errs = updateData.customerUpdate.userErrors;
    if (errs.length) {
      logJson("error", "customerUpdate_failed", { targetCustomerId, userErrors: errs });
      return jsonResponse({
        error: "customerUpdate userErrors",
        code: "SHOPIFY_ERROR",
        userErrors: errs,
      }, 500);
    }

    // C.6 T5: aplicar semántica de transición de estado.
    // El customerUpdate ya commitó el tag 'aprobado'. Si los metafields
    // fallan, el customer queda con tag correcto pero metafields posibles
    // residuales — caso degradado pero no crítico (W2 se encarga de
    // create-company; los metafields de estado son auxiliares).
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const semInput = buildApprovalSemanticsInput(targetCustomerId, today);
    const semResp = await gql<SemanticsResp>(SEMANTICS_MUTATION, semInput);
    const setErrs = semResp.metafieldsSet.userErrors;
    const delErrs = semResp.metafieldsDelete.userErrors;

    if (setErrs.length) {
      // Set falló — error real (el metafield no quedó coherente).
      logJson("error", "metafieldsSet_failed", { targetCustomerId, userErrors: setErrs });
      return jsonResponse({
        error: "metafieldsSet userErrors — tag aprobado se aplicó pero fecha_aprobacion NO se setteó",
        code: "SHOPIFY_ERROR",
        userErrors: setErrs,
      }, 500);
    }
    if (delErrs.length) {
      // Delete falló — borrar metafields que no existen NO es un error
      // semántico (idempotencia esperada). Solo logeamos.
      logJson("warn", "metafieldsDelete_warnings", { targetCustomerId, userErrors: delErrs });
    }

    const taggedAt = new Date().toISOString();
    logJson("info", "approve_ok", {
      customerId,
      targetCustomerId,
      previousTags: target.tags,
      newTags: updateData.customerUpdate.customer?.tags ?? newTags,
      semantics: "applied",
    });

    return jsonResponse({
      ok: true,
      startedAt,
      customerId: targetCustomerId,
      taggedAt,
      previousTags: target.tags,
      newTags: updateData.customerUpdate.customer?.tags ?? newTags,
      semantics: "applied",
    });
  } catch (e) {
    const msg = (e as Error).message;
    logJson("error", "approve_failed", { error: msg });
    return jsonResponse({ error: msg, code: "SHOPIFY_ERROR" }, 500);
  }
});
