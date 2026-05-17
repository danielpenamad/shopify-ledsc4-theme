// Supabase Edge Function: update-whitelist
//
// Reemplaza la edición manual del shop metafield `b2b.whitelist_emails`
// desde Admin → Settings → Custom data. Recibe texto libre del textarea
// del backoffice, parsea, valida, deduplica, hace merge con los emails
// existentes, y dispara `promote-whitelist-matches` para no esperar 30 min
// al próximo cron.
//
// 🔒 SECURITY: el caller (approver) DEBE tener tag 'backoffice'. La
// verificación se hace server-side aquí — el `{% if customer.tags contains
// 'backoffice' %}` del page template es solo UX. NUNCA borrar la llamada
// a `assertBackofficeTag` de abajo: sin ella cualquiera podría editar la
// whitelist y auto-aprobar emails.
//
// Auth: HMAC-SHA256 firmado en Liquid con settings.backoffice_hmac_secret
// (mismo patrón que submit-order-request, TTL 600s).
//
// Input (POST body JSON):
//   {
//     customerId: "gid://shopify/Customer/<approver_id>",
//     timestamp: <unix_seconds>,
//     signature: "<hex hmac>",
//     mode?: "add" (default) | "remove",
//     emails: "texto libre del textarea (uno por línea, comas, espacios...)",
//             en mode 'remove' lleva un único email a quitar,
//     dryRun?: false
//   }
//
// Output (mode 'add'):
//   {
//     ok: true,
//     added: number,
//     ignored_duplicates: number,
//     invalid: string[],
//     total_now: number,
//     promote_triggered: boolean
//   }
//
// Output (mode 'remove'):
//   {
//     ok: true,
//     mode: "remove",
//     removed: string | null,   // null si el email no estaba en la lista
//     not_found: boolean,
//     total_now: number
//   }
//
// ⚠ DEUDA CONOCIDA: tanto 'add' como 'remove' hacen read-modify-write
// last-write-wins sobre el metafield (readWhitelist → mutar en memoria →
// setWhitelistAndTimestamp). NO hay compare-and-swap: dos escrituras
// concurrentes pueden pisarse. No se aborda aquí (volumen bajo, edición
// manual por backoffice).
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
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   BACKOFFICE_HMAC_SECRET              (mismo valor que settings.backoffice_hmac_secret)
//   PROMOTE_WHITELIST_FUNCTION_URL      (opcional; si está, se invoca tras el update)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("BACKOFFICE_HMAC_SECRET");
const PROMOTE_URL = Deno.env.get("PROMOTE_WHITELIST_FUNCTION_URL");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN || !HMAC_SECRET) {
  throw new Error(
    "Missing required env vars: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, BACKOFFICE_HMAC_SECRET",
  );
}

const HMAC_TTL_SECONDS = 600;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
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
  console.log(JSON.stringify({ level, event, fn: "update-whitelist", ...fields }));
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
// la URL pública de la edge function podría editar la whitelist.
async function assertBackofficeTag(approverId: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const data = await gql<{ customer: { id: string; tags: string[] } | null }>(
    `query($id: ID!) { customer(id: $id) { id tags } }`,
    { id: approverId },
  );
  if (!data.customer) return { ok: false, code: "APPROVER_NOT_FOUND" };
  if (!data.customer.tags.includes("backoffice")) return { ok: false, code: "NOT_BACKOFFICE" };
  return { ok: true };
}

function parseEmails(raw: string): { valid: string[]; invalid: string[] } {
  const candidates = raw
    .split(/[\n,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = new Set<string>();
  const invalid = new Set<string>();
  for (const c of candidates) {
    if (EMAIL_RE.test(c)) valid.add(c);
    else invalid.add(c);
  }
  return { valid: Array.from(valid), invalid: Array.from(invalid) };
}

async function readWhitelist(): Promise<string[]> {
  const data = await gql<{ shop: { metafield: { value: string } | null } }>(`
    query {
      shop { metafield(namespace: "b2b", key: "whitelist_emails") { value } }
    }
  `);
  if (!data.shop.metafield?.value) return [];
  try {
    const parsed = JSON.parse(data.shop.metafield.value) as unknown[];
    return parsed.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

async function setWhitelistAndTimestamp(emails: string[], shopGid: string): Promise<void> {
  const data = await gql<{
    metafieldsSet: { userErrors: Array<{ field: string[]; message: string; code: string }> };
  }>(
    `
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message code }
      }
    }
    `,
    {
      metafields: [
        {
          ownerId: shopGid,
          namespace: "b2b",
          key: "whitelist_emails",
          type: "list.single_line_text_field",
          value: JSON.stringify(emails),
        },
        {
          ownerId: shopGid,
          namespace: "b2b",
          key: "whitelist_last_update",
          type: "date_time",
          value: new Date().toISOString(),
        },
      ],
    },
  );
  const errs = data.metafieldsSet.userErrors;
  if (errs.length) throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
}

async function getShopGid(): Promise<string> {
  const data = await gql<{ shop: { id: string } }>(`query { shop { id } }`);
  return data.shop.id;
}

async function triggerPromote(): Promise<boolean> {
  if (!PROMOTE_URL) return false;
  try {
    // Fire-and-forget con timeout corto. Si falla no rompemos el response del
    // approver — el cron de pg_cron lo recogerá en máximo 30 min.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(PROMOTE_URL, { method: "POST", signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch (e) {
    logJson("warn", "promote_trigger_failed", { error: (e as Error).message });
    return false;
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
    const rawEmails = (body.emails as string | undefined) ?? "";
    const mode = body.mode === "remove" ? "remove" : "add";
    const dryRun = body.dryRun === true;

    if (!customerId || !customerId.startsWith("gid://shopify/Customer/")) {
      return jsonResponse({ error: "invalid customerId", code: "INVALID_INPUT" }, 400);
    }
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return jsonResponse({ error: "invalid signature format", code: "INVALID_INPUT" }, 400);
    }
    if (typeof rawEmails !== "string" || rawEmails.length > 50_000) {
      return jsonResponse({ error: "emails missing or too long", code: "INVALID_INPUT" }, 400);
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

    // --- mode 'remove': quita un único email del metafield ---------------
    // Reescribe el metafield y devuelve. NO llama a triggerPromote(): quitar
    // un email nunca genera matches nuevos (promote-whitelist-matches es
    // puramente aditivo). Mismo read-modify-write last-write-wins que 'add'.
    if (mode === "remove") {
      // Normaliza el target con el mismo parser que 'add' (trim + lowercase)
      // para que el match contra la lista sea consistente.
      const { valid: targets } = parseEmails(rawEmails);
      const target = targets[0] ?? null;
      if (!target) {
        return jsonResponse({ error: "no valid email to remove", code: "INVALID_INPUT" }, 400);
      }

      const existingList = await readWhitelist();
      const newList = existingList.filter((e) => e !== target);
      const wasPresent = newList.length !== existingList.length;

      if (dryRun) {
        logJson("info", "dry_run", { customerId, mode, target, would_remove: wasPresent });
        return jsonResponse({
          ok: true,
          startedAt,
          mode: "remove",
          dryRun: true,
          removed: wasPresent ? target : null,
          not_found: !wasPresent,
          total_now: existingList.length,
          wouldTotal: newList.length,
        });
      }

      if (!wasPresent) {
        logJson("info", "remove_noop", { customerId, target });
        return jsonResponse({
          ok: true,
          startedAt,
          mode: "remove",
          removed: null,
          not_found: true,
          total_now: existingList.length,
        });
      }

      const shopGid = await getShopGid();
      await setWhitelistAndTimestamp(newList, shopGid);

      logJson("info", "remove_ok", { customerId, target, total_now: newList.length });
      return jsonResponse({
        ok: true,
        startedAt,
        mode: "remove",
        removed: target,
        not_found: false,
        total_now: newList.length,
      });
    }

    const { valid: parsedValid, invalid } = parseEmails(rawEmails);
    const existing = await readWhitelist();
    const existingSet = new Set(existing);
    const toAdd = parsedValid.filter((e) => !existingSet.has(e));
    const ignoredDuplicates = parsedValid.length - toAdd.length;

    const newList = [...existing, ...toAdd];

    if (dryRun) {
      logJson("info", "dry_run", { customerId, would_add: toAdd.length, invalid: invalid.length });
      return jsonResponse({
        ok: true,
        startedAt,
        dryRun: true,
        added: 0,
        wouldAdd: toAdd.length,
        ignored_duplicates: ignoredDuplicates,
        invalid,
        total_now: existing.length,
        wouldTotal: newList.length,
        promote_triggered: false,
      });
    }

    if (toAdd.length === 0) {
      logJson("info", "noop", { customerId, ignored_duplicates: ignoredDuplicates, invalid: invalid.length });
      return jsonResponse({
        ok: true,
        startedAt,
        added: 0,
        ignored_duplicates: ignoredDuplicates,
        invalid,
        total_now: existing.length,
        promote_triggered: false,
      });
    }

    const shopGid = await getShopGid();
    await setWhitelistAndTimestamp(newList, shopGid);
    const promoteTriggered = await triggerPromote();

    logJson("info", "update_ok", {
      customerId,
      added: toAdd.length,
      ignored_duplicates: ignoredDuplicates,
      invalid: invalid.length,
      total_now: newList.length,
      promote_triggered: promoteTriggered,
    });

    return jsonResponse({
      ok: true,
      startedAt,
      added: toAdd.length,
      ignored_duplicates: ignoredDuplicates,
      invalid,
      total_now: newList.length,
      promote_triggered: promoteTriggered,
    });
  } catch (e) {
    const msg = (e as Error).message;
    logJson("error", "update_failed", { error: msg });
    return jsonResponse({ error: msg, code: "SHOPIFY_ERROR" }, 500);
  }
});
