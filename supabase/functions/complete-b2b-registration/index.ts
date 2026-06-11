// Supabase Edge Function: complete-b2b-registration
//
// Carril gemelo de register-b2b-customer para usuarios que YA tienen
// customer en Shopify (alta nativa por New Customer Accounts) y deben
// completar los datos B2B sobre el customer existente. register-b2b-customer
// usa customerCreate y daría EMAIL_ALREADY_EXISTS; aquí hacemos customerUpdate.
//
// Llamada desde el storefront (form en /pages/completar-registro, llega en
// Fase 2) al pulsar "Enviar solicitud". El customer ya está logueado: la
// page Liquid SSR firma `<timestamp>:<nonce>:<customer.id>` con
// settings.register_b2b_hmac_secret. Tras esta EF, el customer queda con
// metafields b2b.* completos + tag 'pendiente' → Flow W1 dispara igual
// que en register-b2b-customer.
//
// Auth: HMAC-SHA256 de `<timestamp>:<nonce>:<customerId>` con el MISMO
// secret REGISTER_B2B_HMAC_SECRET. TTL 1 hora. verify_jwt=false.
//
// Guardia de estado (no degradar):
//   - Si el customer no existe → 404 CUSTOMER_NOT_FOUND.
//   - Si tags ∋ 'aprobado' o 'rechazado' → 200 { ok:true, noop:true } sin
//     cambios. Solo procede si NO está aprobado ni rechazado (típico:
//     sin tag = alta nativa incompleta, o tag 'pendiente' = reintento).
//
// Input (body JSON):
//   {
//     timestamp: 1712345678,            // unix seconds, firmado
//     nonce: "<hex 16+ chars>",
//     signature: "<hex hmac>",          // hmac_sha256(<ts>:<nonce>:<gid>, SECRET)
//     customerId: "gid://shopify/Customer/123",
//     nombre, apellidos, telefono?, empresa, nif, sector, pais,
//     volumen_estimado?, condiciones: true
//   }
//   (NO email — el customer ya existe; el form lo muestra bloqueado.)
//
// Output:
//   { ok:true, customerId, status:"pendiente" }                            (200)
//   { ok:true, noop:true }                                                 (200; ya aprobado/rechazado)
//   { code:"VALIDATION_ERROR", fieldErrors:{...} }                         (400)
//   { code:"INVALID_PAYLOAD" }                                             (400)
//   { code:"INVALID_SIGNATURE" | "SIGNATURE_EXPIRED" }                     (401)
//   { code:"CUSTOMER_NOT_FOUND" }                                          (404)
//   { code:"SHOPIFY_UNAVAILABLE" }                                         (502)
//
// Secrets requeridos: mismos que register-b2b-customer.

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const HMAC_SECRET = Deno.env.get("REGISTER_B2B_HMAC_SECRET");
const STOREFRONT_ORIGIN = Deno.env.get("STOREFRONT_ORIGIN") ?? "*";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}
if (!HMAC_SECRET) {
  throw new Error("Missing REGISTER_B2B_HMAC_SECRET env var");
}

const HMAC_TTL_SECONDS = 3600;
const ENDPOINT = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

const SECTOR_ENUM = new Set([
  "instalador",
  "arquitecto_interiorismo",
  "retail_tienda",
  "distribuidor",
  "empresa_final",
  "otro",
]);

const VOLUMEN_ENUM = new Set([
  "",
  "<5k",
  "5k-25k",
  "25k-100k",
  ">100k",
  "no_se",
]);

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": STOREFRONT_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// --- HMAC ---------------------------------------------------------------

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

async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- NIF / NIE / CIF ---------------------------------------------------

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";

function isValidDNI(value: string): boolean {
  const m = /^([0-9]{8})([A-Z])$/.exec(value);
  if (!m) return false;
  const num = parseInt(m[1], 10);
  return DNI_LETTERS[num % 23] === m[2];
}

function isValidNIE(value: string): boolean {
  const m = /^([XYZ])([0-9]{7})([A-Z])$/.exec(value);
  if (!m) return false;
  const prefixMap: Record<string, string> = { X: "0", Y: "1", Z: "2" };
  const num = parseInt(prefixMap[m[1]] + m[2], 10);
  return DNI_LETTERS[num % 23] === m[3];
}

function isValidCIF(value: string): boolean {
  const m = /^([ABCDEFGHJKLMNPQRSUVW])([0-9]{7})([0-9A-J])$/.exec(value);
  if (!m) return false;
  const digits = m[2];
  let sumEven = 0;
  let sumOdd = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = parseInt(digits[i], 10);
    if (i % 2 === 0) {
      const doubled = d * 2;
      sumOdd += doubled > 9 ? Math.floor(doubled / 10) + (doubled % 10) : doubled;
    } else {
      sumEven += d;
    }
  }
  const total = sumEven + sumOdd;
  const controlDigit = (10 - (total % 10)) % 10;
  const provided = m[3];
  if (/[0-9]/.test(provided)) return parseInt(provided, 10) === controlDigit;
  return CIF_CONTROL_LETTERS[controlDigit] === provided;
}

// Validación ramificada por país. Paridad con register-b2b-customer:
//   - country === 'ES' → DNI / NIE / CIF con dígito de control.
//   - resto (o country null) → saneo mínimo 4–20 alfanuméricos.
function validateTaxId(
  raw: string,
  country: string | null,
): { ok: boolean; normalized?: string; reason?: "es" | "format" } {
  if (!raw) return { ok: false, reason: country === "ES" ? "es" : "format" };
  const value = String(raw).toUpperCase().replace(/[\s.\-]/g, "");
  if (country === "ES") {
    if (isValidDNI(value) || isValidNIE(value) || isValidCIF(value)) {
      return { ok: true, normalized: value };
    }
    return { ok: false, reason: "es" };
  }
  if (/^[A-Z0-9]{4,20}$/.test(value)) {
    return { ok: true, normalized: value };
  }
  return { ok: false, reason: "format" };
}

// --- Helpers -----------------------------------------------------------

export function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLen);
}

export function normalizeCountry(raw: string): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(v)) return v;
  const map: Record<string, string> = {
    SPAIN: "ES",
    ESPAÑA: "ES",
    ESPANA: "ES",
    FRANCE: "FR",
    FRANCIA: "FR",
    PORTUGAL: "PT",
    ITALY: "IT",
    ITALIA: "IT",
    GERMANY: "DE",
    ALEMANIA: "DE",
  };
  return map[v] ?? null;
}

function isValidCustomerGid(s: string): boolean {
  return /^gid:\/\/shopify\/Customer\/[0-9]+$/.test(s);
}

// --- Shopify GraphQL ---------------------------------------------------

interface GqlResp<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as GqlResp<T>;
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// --- Serve --------------------------------------------------------------

interface IncomingBody {
  timestamp?: number | string;
  nonce?: string;
  signature?: string;
  customerId?: string;
  nombre?: string;
  apellidos?: string;
  telefono?: string;
  empresa?: string;
  nif?: string;
  sector?: string;
  pais?: string;
  volumen_estimado?: string;
  condiciones?: boolean;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
  }

  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let customerIdHash = "";

  try {
    const body = (await req.json().catch(() => ({}))) as IncomingBody;

    // --- 1. HMAC envelope (incluye customerId) ---
    const timestamp = Number(body.timestamp);
    const nonce = body.nonce;
    const signature = body.signature?.toLowerCase();
    const customerId = typeof body.customerId === "string" ? body.customerId : "";

    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid timestamp." }, 400);
    }
    if (!nonce || typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid nonce." }, 400);
    }
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid signature format." }, 400);
    }
    if (!customerId || !isValidCustomerGid(customerId)) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid customerId." }, 400);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > HMAC_TTL_SECONDS) {
      return jsonResponse({
        code: "SIGNATURE_EXPIRED",
        message: "El formulario ha caducado. Refresca la página y vuelve a enviar.",
      }, 401);
    }

    const expectedSig = await hmacSha256Hex(
      `${timestamp}:${nonce}:${customerId}`,
      HMAC_SECRET!,
    );
    if (!constantTimeEq(expectedSig, signature)) {
      return jsonResponse({ code: "INVALID_SIGNATURE", message: "Signature mismatch." }, 401);
    }

    customerIdHash = await sha256Hex(customerId);

    // --- 2. Field validation ---
    const fieldErrors: Record<string, string> = {};

    const nombre = sanitizeText(body.nombre, 100);
    const apellidos = sanitizeText(body.apellidos, 100);
    const telefonoRaw = sanitizeText(body.telefono, 30);
    const empresa = sanitizeText(body.empresa, 200);
    const nifRaw = sanitizeText(body.nif, 20);
    const sector = sanitizeText(body.sector, 50);
    const paisRaw = sanitizeText(body.pais, 60);
    const volumenEstimado = sanitizeText(body.volumen_estimado, 30);

    if (!nombre) fieldErrors.nombre = "El nombre es obligatorio.";
    if (!apellidos) fieldErrors.apellidos = "Los apellidos son obligatorios.";
    if (!empresa) fieldErrors.empresa = "La razón social es obligatoria.";

    // País antes que NIF: validateTaxId ramifica por country (ES estricto,
    // resto saneo mínimo). Ver register-b2b-customer para detalle.
    const paisIso = normalizeCountry(paisRaw);
    if (!paisIso) {
      fieldErrors.pais = "Selecciona un país.";
    }

    const nifResult = validateTaxId(nifRaw, paisIso);
    if (!nifResult.ok) {
      fieldErrors.nif = nifResult.reason === "es"
        ? "El NIF / CIF / NIE no es válido (revisa formato y dígito de control)."
        : "Introduce un identificador fiscal válido (4–20 caracteres, sin símbolos).";
    }

    if (!sector || !SECTOR_ENUM.has(sector)) {
      fieldErrors.sector = "Selecciona un sector válido.";
    }

    if (volumenEstimado && !VOLUMEN_ENUM.has(volumenEstimado)) {
      fieldErrors.volumen_estimado = "Volumen estimado no válido.";
    }

    if (body.condiciones !== true) {
      fieldErrors.condiciones = "Debes aceptar las condiciones para continuar.";
    }

    if (Object.keys(fieldErrors).length > 0) {
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "validation_error", fieldErrors,
      }));
      return jsonResponse({ code: "VALIDATION_ERROR", fieldErrors }, 400);
    }

    // --- 3. State guard: query existing customer ---
    interface CustomerLookupResp {
      customer: { id: string; tags: string[] } | null;
    }
    let lookup: CustomerLookupResp;
    try {
      lookup = await gql<CustomerLookupResp>(
        `query($id: ID!) { customer(id: $id) { id tags } }`,
        { id: customerId },
      );
    } catch (e) {
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "shopify_error_lookup",
        error: (e as Error).message,
      }));
      return jsonResponse({
        code: "SHOPIFY_UNAVAILABLE",
        message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
      }, 502);
    }

    if (!lookup.customer) {
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "customer_not_found",
      }));
      return jsonResponse({ code: "CUSTOMER_NOT_FOUND" }, 404);
    }

    const tags = lookup.customer.tags ?? [];
    if (tags.includes("aprobado") || tags.includes("rechazado")) {
      // No degradar el estado de un cliente ya resuelto.
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "noop_terminal_state",
        tags,
      }));
      return jsonResponse({ ok: true, noop: true });
    }

    // --- 4. customerUpdate ---
    const today = new Date().toISOString().slice(0, 10);

    interface CustomerUpdateResp {
      customerUpdate: {
        customer: { id: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }

    let updateData: CustomerUpdateResp;
    try {
      updateData = await gql<CustomerUpdateResp>(
        `
        mutation($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }
        `,
        {
          input: {
            id: customerId,
            firstName: nombre,
            lastName: apellidos,
            phone: telefonoRaw || null,
            // OJO: emailMarketingConsent NO se puede pasar en customerUpdate
            // (Shopify lo rechaza con userError "use the
            // customerEmailMarketingConsentUpdate Mutation instead"; causó
            // el 400 sistemático del 2026-06-11, primer día con tráfico
            // real). Se setea en una mutación aparte tras este update.
            metafields: [
              { namespace: "b2b", key: "empresa", type: "single_line_text_field", value: empresa },
              { namespace: "b2b", key: "nif", type: "single_line_text_field", value: nifResult.normalized! },
              { namespace: "b2b", key: "sector", type: "single_line_text_field", value: sector },
              // Trim explícito por paridad con register-b2b-customer (histórico
              // de `\tES` persistido; ver C.6 / docs/pendientes.md).
              { namespace: "b2b", key: "pais", type: "single_line_text_field", value: paisIso!.trim() },
              ...(volumenEstimado
                ? [{ namespace: "b2b", key: "volumen_estimado", type: "single_line_text_field", value: volumenEstimado }]
                : []),
              { namespace: "b2b", key: "fecha_registro", type: "date", value: today },
            ],
          },
        },
      );
    } catch (e) {
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "shopify_error_update",
        error: (e as Error).message,
      }));
      return jsonResponse({
        code: "SHOPIFY_UNAVAILABLE",
        message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
      }, 502);
    }

    const errs = updateData.customerUpdate.userErrors;
    if (errs.length > 0) {
      const mapped: Record<string, string> = {};
      for (const ue of errs) {
        const f = ue.field?.[ue.field.length - 1] ?? "_form";
        mapped[f] = ue.message;
      }
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "user_errors", userErrors: errs,
      }));
      return jsonResponse({ code: "VALIDATION_ERROR", fieldErrors: mapped }, 400);
    }

    if (!updateData.customerUpdate.customer) {
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "shopify_error_update",
        error: "customerUpdate returned no customer and no userErrors",
      }));
      return jsonResponse({
        code: "SHOPIFY_UNAVAILABLE",
        message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
      }, 502);
    }

    // --- 4.5 emailMarketingConsent (mutación dedicada, best-effort) ---
    //
    // Necesario para que los emails de Flow (W1 acuse, W2 aprobación)
    // lleguen: van por marketing activity y se descartan si el customer no
    // está SUBSCRIBED. Va aparte porque customerUpdate no acepta el campo.
    // Best-effort: si falla, el registro sigue (mismo criterio que el
    // invite email en register-b2b-customer); promote-whitelist-matches
    // re-asegura el consent al promover.
    let consentSet = true;
    try {
      const consentData = await gql<{
        customerEmailMarketingConsentUpdate: {
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }>(
        `
        mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            userErrors { field message }
          }
        }
        `,
        {
          input: {
            customerId,
            emailMarketingConsent: {
              marketingState: "SUBSCRIBED",
              marketingOptInLevel: "SINGLE_OPT_IN",
            },
          },
        },
      );
      const consentErrs = consentData.customerEmailMarketingConsentUpdate?.userErrors ?? [];
      if (consentErrs.length > 0) {
        consentSet = false;
        console.log(JSON.stringify({
          requestId, startedAt, customerIdHash, outcome: "consent_failed",
          userErrors: consentErrs,
        }));
      }
    } catch (e) {
      consentSet = false;
      console.log(JSON.stringify({
        requestId, startedAt, customerIdHash, outcome: "consent_failed",
        error: (e as Error).message,
      }));
    }

    // --- 5. tagsAdd: 'pendiente' (con retries; ver register-b2b-customer) ---
    //
    // Sin el tag, Flow W1 no dispara y el cliente queda huérfano (invisible
    // para el backoffice). Reintentos 3× con backoff ante errores
    // transitorios; userErrors no se reintentan. Failsafe final: cron de
    // reconciliación en promote-whitelist-matches.
    let tagsAdded = true;
    {
      interface TagsAddResp {
        tagsAdd: {
          node: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }
      const TAGS_ADD_MUTATION = `
        mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { ... on Customer { id } }
            userErrors { field message }
          }
        }
      `;
      for (let attempt = 1; attempt <= 3; attempt++) {
        tagsAdded = true;
        try {
          const tagsData = await gql<TagsAddResp>(
            TAGS_ADD_MUTATION,
            { id: customerId, tags: ["pendiente"] },
          );
          if (tagsData.tagsAdd.userErrors.length > 0) {
            tagsAdded = false;
            console.log(JSON.stringify({
              requestId, startedAt, customerIdHash, outcome: "tags_add_failed",
              attempt, customerId, userErrors: tagsData.tagsAdd.userErrors,
            }));
          }
          break;
        } catch (e) {
          tagsAdded = false;
          console.log(JSON.stringify({
            requestId, startedAt, customerIdHash, outcome: "tags_add_failed",
            attempt, customerId, error: (e as Error).message,
          }));
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
    }

    console.log(JSON.stringify({
      requestId, startedAt, customerIdHash, outcome: "updated",
      customerId, tagsAdded,
    }));

    const warnings: string[] = [];
    if (!tagsAdded) warnings.push("TAG_PENDIENTE_FAILED");
    if (!consentSet) warnings.push("CONSENT_FAILED");

    return jsonResponse({
      ok: true,
      customerId,
      status: "pendiente",
      tagsAdded,
      ...(warnings.length > 0 ? { warning: warnings.join(",") } : {}),
    });
  } catch (e) {
    console.log(JSON.stringify({
      requestId, startedAt, customerIdHash, outcome: "unhandled_error",
      error: (e as Error).message,
    }));
    return jsonResponse({
      code: "SHOPIFY_UNAVAILABLE",
      message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
    }, 502);
  }
}

// Exports para tests (no afectan al runtime de Deno.serve).
export { hmacSha256Hex, HMAC_TTL_SECONDS };

if (!Deno.env.get("COMPLETE_B2B_TEST_MODE")) {
  Deno.serve(handle);
}
