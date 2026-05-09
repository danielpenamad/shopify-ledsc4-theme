// Supabase Edge Function: reject-customer
//
// Reemplaza el flujo manual del staff descrito en
// docs/backoffice-aprobaciones.md §4. Igual que approve-customer pero hacia
// el estado 'rechazado'. Setea el motivo ANTES del cambio de tag para que
// W3 envíe el email 5 con el motivo bien rellenado (W3 lee
// `customer.metafields.b2b.motivo_rechazo` en el momento de disparar; si
// ponemos el tag primero, W3 puede dispararse antes y mandar el email sin
// motivo).
//
// 🔒 SECURITY: el caller (approver) DEBE tener tag 'backoffice'. La
// verificación se hace server-side aquí — el `{% if customer.tags contains
// 'backoffice' %}` del page template es solo UX. NUNCA borrar la llamada
// a `assertBackofficeTag` de abajo: sin ella cualquiera podría rechazar
// customers a voluntad y enviar emails de rechazo no autorizados.
//
// Reparto edge function ↔ Flow W3 (post C.6 T5):
//   - Esta edge function: ANTES del flip de tag, setea
//     `b2b.fecha_rechazo` (date) + `b2b.motivo_rechazo` (si hay) y
//     borra `b2b.fecha_aprobacion` si existía (residuo de una
//     aprobación previa). Después cambia tags atómicamente.
//   - W3: detecta el cambio de tag y manda el email 5 (lee el motivo
//     desde el metafield, por eso seteamos antes).
//
// El order set-then-flip es crítico para el motivo: W3 dispara con
// el cambio de tag y lee el metafield en ese momento. El delete de
// fecha_aprobacion también va antes para cerrar la coherencia
// estado-metafields antes de que cualquier suscriptor del evento
// observe el customer.
//
// Auth: HMAC-SHA256 firmado en Liquid con settings.backoffice_hmac_secret.
//
// Input (POST body JSON):
//   {
//     customerId: "gid://shopify/Customer/<approver_id>",
//     timestamp: <unix_seconds>,
//     signature: "<hex hmac>",
//     targetCustomerId: "gid://shopify/Customer/<target_id>",
//     motivo?: "texto libre opcional",
//     dryRun?: false
//   }
//
// Output:
//   { ok: true, customerId, taggedAt, previousTags, newTags, motivoSet, semantics }
//   semantics: "applied" si los metafields de estado se actualizaron
//   coherentemente, "skipped" si dryRun.
//
// Errores:
//   400 INVALID_INPUT
//   401 INVALID_SIGNATURE | SIGNATURE_EXPIRED
//   403 NOT_BACKOFFICE
//   404 TARGET_NOT_FOUND
//   409 INVALID_STATE
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
const MOTIVO_MAX = 500;
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
  console.log(JSON.stringify({ level, event, fn: "reject-customer", ...fields }));
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

// 🔒 Server-side enforcement del rol backoffice. Sin esto, cualquiera con
// la URL pública de la edge function podría rechazar customers arbitrariamente.
async function assertBackofficeTag(approverId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const data = await gql<{ customer: { id: string; tags: string[] } | null }>(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: approverId },
  );
  if (!data.customer) return { ok: false, code: "APPROVER_NOT_FOUND" };
  if (!data.customer.tags.includes("backoffice")) return { ok: false, code: "NOT_BACKOFFICE" };
  return { ok: true };
}

// --- Semántica de transición a 'rechazado' (C.6 T5) ------------------
//
// Antes del flip atómico de tags a 'rechazado', estos metafields deben
// quedar coherentes con el estado:
//   - b2b.fecha_rechazo → setear con fecha actual UTC (date type).
//   - b2b.motivo_rechazo → setear con el motivo recibido (omitir si vacío).
//   - b2b.fecha_aprobacion → borrar si existía (residuo de aprobación previa).
//
// El builder es puro y exportado para tests aislados.

export type SemanticsInput = {
  sets: Array<{ ownerId: string; namespace: string; key: string; type: string; value: string }>;
  deletes: Array<{ ownerId: string; namespace: string; key: string }>;
};

export function buildRejectionSemanticsInput(customerId: string, today: string, motivo: string): SemanticsInput {
  const sets: SemanticsInput["sets"] = [
    { ownerId: customerId, namespace: "b2b", key: "fecha_rechazo", type: "date", value: today },
  ];
  if (motivo && motivo.length > 0) {
    sets.push({
      ownerId: customerId,
      namespace: "b2b",
      key: "motivo_rechazo",
      type: "single_line_text_field",
      value: motivo,
    });
  }
  return {
    sets,
    deletes: [
      { ownerId: customerId, namespace: "b2b", key: "fecha_aprobacion" },
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

async function applyRejectionSemantics(targetId: string, motivo: string): Promise<void> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const input = buildRejectionSemanticsInput(targetId, todayIso, motivo);

  const data = await gql<SemanticsResp>(SEMANTICS_MUTATION, input);
  const setErrs = data.metafieldsSet.userErrors;
  const delErrs = data.metafieldsDelete.userErrors;
  if (setErrs.length) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(setErrs)}`);
  }
  if (delErrs.length) {
    // Borrar metafields que no existen NO es un error semántico
    // (idempotencia esperada). Solo logeamos; el flujo continúa.
    logJson("warn", "metafieldsDelete_warnings", { targetId, userErrors: delErrs });
  }
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
    const motivoRaw = (body.motivo as string | undefined) ?? "";
    const motivo = motivoRaw.trim().slice(0, MOTIVO_MAX);
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

    const newTags = target.tags.filter((t) => !STATE_TAGS.has(t));
    newTags.push("rechazado");

    if (dryRun) {
      logJson("info", "dry_run", { customerId, targetCustomerId, previousTags: target.tags, newTags, motivoLen: motivo.length });
      return jsonResponse({
        ok: true,
        startedAt,
        dryRun: true,
        customerId: targetCustomerId,
        previousTags: target.tags,
        newTags,
        motivoSet: motivo.length > 0,
        semantics: "skipped",
      });
    }

    // 1. Aplicar semántica de transición ANTES de cambiar el tag (C.6 T5):
    //    set fecha_rechazo + motivo_rechazo (si hay), delete fecha_aprobacion.
    //    W3 dispara con el cambio de tag y lee los metafields en ese momento.
    await applyRejectionSemantics(targetCustomerId, motivo);

    // 2. Cambiar tags atómicamente.
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
        error: "customerUpdate userErrors — metafields se setearon pero el tag NO se cambió",
        code: "SHOPIFY_ERROR",
        userErrors: errs,
      }, 500);
    }

    const taggedAt = new Date().toISOString();
    logJson("info", "reject_ok", {
      customerId,
      targetCustomerId,
      previousTags: target.tags,
      newTags: updateData.customerUpdate.customer?.tags ?? newTags,
      motivoSet: motivo.length > 0,
    });

    return jsonResponse({
      ok: true,
      startedAt,
      customerId: targetCustomerId,
      taggedAt,
      previousTags: target.tags,
      newTags: updateData.customerUpdate.customer?.tags ?? newTags,
      motivoSet: motivo.length > 0,
      semantics: "applied",
    });
  } catch (e) {
    const msg = (e as Error).message;
    logJson("error", "reject_failed", { error: msg });
    return jsonResponse({ error: msg, code: "SHOPIFY_ERROR" }, 500);
  }
});
