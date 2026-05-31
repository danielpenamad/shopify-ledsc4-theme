// Supabase Edge Function: register-b2b-customer
//
// Reemplaza el flujo /account/register clásico que Shopify rompió al
// forzar new customer accounts (collapsado registro+login en OAuth
// hosteado, sin form de campos custom).
//
// Llamada desde el storefront (form /pages/acceso-profesional#registro)
// al pulsar "Enviar solicitud". Crea el customer en Shopify con tag
// 'pendiente' + metafields b2b.* completos + opt-in marketing (necesario
// para que los emails de Flow lleguen), y envía el invite por email
// para que active la cuenta. Cuando el usuario activa el invite, ya
// existe un customer con todos los datos B2B → Flow W1 puede decidir
// auto-aprobación por whitelist o pendiente revisión normalmente.
//
// Auth: HMAC-SHA256 del payload `<timestamp>:<nonce>` firmado por Liquid
// SSR de la página de registro con `settings.register_b2b_hmac_secret`.
// Mismo secret en env REGISTER_B2B_HMAC_SECRET. TTL 1 hora (margen para
// formularios B2B largos; el v26 hotfix en producción usaba 3600s y no se
// ha observado abuso).
//
// TODO Hardening producción:
//   - Implementar dedupe de nonce en KV (p.ej. Upstash o Redis-on-Supabase)
//     para evitar replay con misma signature dentro del TTL. Hoy se confía
//     en la ventana de 1 hora + rate-limit del gateway de Supabase. Replay
//     attack reduciría a "alguien crea N customers fake en 1 hora con datos
//     que intercepte". Customer Create es idempotente por email (devuelve
//     EMAIL_ALREADY_EXISTS) así que el daño práctico es bajo.
//   - Rate limit por IP a nivel edge (currently none).
//   - CAPTCHA en el form si llega spam.
//
// Input (body JSON):
//   {
//     timestamp: 1712345678,        // unix seconds, firmado
//     nonce: "<hex 16+ chars>",     // generado por Liquid SSR, parte del HMAC
//     signature: "<hex hmac>",      // hmac_sha256(<ts>:<nonce>, SECRET)
//     nombre: "Juan",
//     apellidos: "Pérez García",
//     email: "juan@empresa.com",
//     telefono: "+34600000000",     // opcional
//     empresa: "Instalaciones Luz SL",
//     nif: "B12345678",             // se valida + normaliza a uppercase
//     sector: "instalador",         // enum estricto
//     pais: "ES",                   // ISO 3166-1 alpha-2
//     volumen_estimado: "5k-25k",   // opcional
//     condiciones: true             // checkbox términos
//   }
//
// Output:
//   { ok: true, customerId: "gid://shopify/Customer/123", inviteSent: true }     (200)
//   { ok: true, customerId: "gid://shopify/Customer/123", inviteSent: false,
//     warning: "INVITE_EMAIL_FAILED" }                                            (200)
//   { code: "EMAIL_ALREADY_EXISTS", message: "..." }                              (409)
//   { code: "VALIDATION_ERROR", fieldErrors: { nif: "...", ... } }                (400)
//   { code: "SHOPIFY_UNAVAILABLE", message: "..." }                               (502)
//   { code: "INVALID_SIGNATURE" | "SIGNATURE_EXPIRED" | "INVALID_PAYLOAD" }       (401|400)
//
// Secrets requeridos:
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN          (scopes: write_customers)
//   SHOPIFY_API_VERSION          (opcional, default 2025-10)
//   REGISTER_B2B_HMAC_SECRET     (mismo valor en settings.register_b2b_hmac_secret del tema)
//   STOREFRONT_ORIGIN            (opcional, default '*'; setear para CORS estricto en prod)

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

const HMAC_TTL_SECONDS = 3600; // 1 hora — paridad con v26 hotfix en producción
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

// --- NIF / NIE / CIF (port del registro classic, eliminado en C.6 T6) ---

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

function validateSpanishTaxId(raw: string): { ok: boolean; normalized?: string } {
  if (!raw) return { ok: false };
  const value = String(raw).toUpperCase().replace(/[\s-]/g, "");
  if (isValidDNI(value)) return { ok: true, normalized: value };
  if (isValidNIE(value)) return { ok: true, normalized: value };
  if (isValidCIF(value)) return { ok: true, normalized: value };
  return { ok: false };
}

// --- Helpers -----------------------------------------------------------

export function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  // Strip basic HTML tags and trim. No full HTML escaping — Shopify Admin API
  // stores text as-is and renders escaped in admin; we just prevent obvious
  // injection of <script> or <img> via the form.
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLen);
}

function isValidEmail(s: string): boolean {
  // Pragmatic email regex. Shopify validates strictly on its side too.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

export function normalizeCountry(raw: string): string | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  // ISO alpha-2 directly.
  if (/^[A-Z]{2}$/.test(v)) return v;
  // Aliases comunes que el form podría enviar como nombre.
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
  nombre?: string;
  apellidos?: string;
  email?: string;
  telefono?: string;
  empresa?: string;
  nif?: string;
  sector?: string;
  pais?: string;
  volumen_estimado?: string;
  condiciones?: boolean;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
  }

  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let emailHash = "";

  try {
    const body = (await req.json().catch(() => ({}))) as IncomingBody;

    // --- 1. HMAC envelope ---
    const timestamp = Number(body.timestamp);
    const nonce = body.nonce;
    const signature = body.signature?.toLowerCase();

    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid timestamp." }, 400);
    }
    if (!nonce || typeof nonce !== "string" || nonce.length < 8 || nonce.length > 128) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid nonce." }, 400);
    }
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      return jsonResponse({ code: "INVALID_PAYLOAD", message: "Missing or invalid signature format." }, 400);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestamp) > HMAC_TTL_SECONDS) {
      return jsonResponse({
        code: "SIGNATURE_EXPIRED",
        message: "El formulario ha caducado. Refresca la página y vuelve a enviar.",
      }, 401);
    }

    const expectedSig = await hmacSha256Hex(`${timestamp}:${nonce}`, HMAC_SECRET!);
    if (!constantTimeEq(expectedSig, signature)) {
      return jsonResponse({ code: "INVALID_SIGNATURE", message: "Signature mismatch." }, 401);
    }

    // --- 2. Field validation ---
    const fieldErrors: Record<string, string> = {};

    const nombre = sanitizeText(body.nombre, 100);
    const apellidos = sanitizeText(body.apellidos, 100);
    const email = sanitizeText(body.email, 254).toLowerCase();
    const telefonoRaw = sanitizeText(body.telefono, 30);
    const empresa = sanitizeText(body.empresa, 200);
    const nifRaw = sanitizeText(body.nif, 20);
    const sector = sanitizeText(body.sector, 50);
    const paisRaw = sanitizeText(body.pais, 60);
    const volumenEstimado = sanitizeText(body.volumen_estimado, 30);

    emailHash = email ? await sha256Hex(email) : "";

    if (!nombre) fieldErrors.nombre = "El nombre es obligatorio.";
    if (!apellidos) fieldErrors.apellidos = "Los apellidos son obligatorios.";
    if (!email) fieldErrors.email = "El email es obligatorio.";
    else if (!isValidEmail(email)) fieldErrors.email = "El email no parece válido.";
    if (!empresa) fieldErrors.empresa = "La razón social es obligatoria.";

    const nifResult = validateSpanishTaxId(nifRaw);
    if (!nifResult.ok) {
      fieldErrors.nif = "El NIF / CIF / NIE no es válido (revisa formato y dígito de control).";
    }

    if (!sector || !SECTOR_ENUM.has(sector)) {
      fieldErrors.sector = "Selecciona un sector válido.";
    }

    const paisIso = normalizeCountry(paisRaw);
    if (!paisIso) {
      fieldErrors.pais = "Selecciona un país.";
    }

    if (volumenEstimado && !VOLUMEN_ENUM.has(volumenEstimado)) {
      fieldErrors.volumen_estimado = "Volumen estimado no válido.";
    }

    if (body.condiciones !== true) {
      fieldErrors.condiciones = "Debes aceptar las condiciones para continuar.";
    }

    if (Object.keys(fieldErrors).length > 0) {
      console.log(JSON.stringify({
        requestId, startedAt, emailHash, outcome: "validation_error", fieldErrors,
      }));
      return jsonResponse({ code: "VALIDATION_ERROR", fieldErrors }, 400);
    }

    // --- 3. customerCreate ---
    const today = new Date().toISOString().slice(0, 10); // date type expects YYYY-MM-DD per metafield-definitions.json

    interface CustomerCreateResp {
      customerCreate: {
        customer: { id: string; email: string } | null;
        userErrors: Array<{ field: string[] | null; message: string }>;
      };
    }

    let createData: CustomerCreateResp;
    try {
      // NOTE: Shopify Admin API 2025-10 removió el campo `tags` de
      // CustomerInput. Lo añadimos por separado con tagsAdd tras el create
      // (ver bloque siguiente). Si `tags` se vuelve a aceptar en versiones
      // futuras, se puede consolidar.
      createData = await gql<CustomerCreateResp>(
        `
        mutation($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id email }
            userErrors { field message }
          }
        }
        `,
        {
          input: {
            email,
            firstName: nombre,
            lastName: apellidos,
            phone: telefonoRaw || null,
            // Sin opt-in, la action `Send marketing email` de Flow descarta
            // el envío en silencio (no hay error en el run history): los 5
            // emails al cliente —W1-acuse, W1-bienvenida, W2-aprobacion,
            // W3-rechazo, W5-acuse— nunca llegarían. Base legal del consent:
            // checkbox `condiciones` obligatorio (validado arriba).
            // SINGLE_OPT_IN (no double-opt-in) — paridad con v26 hotfix en
            // producción. CONFIRMED_OPT_IN haría que Shopify exija al cliente
            // confirmar suscripción por email antes de marcarlo SUBSCRIBED, y
            // los emails de Flow (W1 acuse, W2 aprobación, W3 rechazo) NO
            // llegarían hasta esa confirmación → regresión grave en el alta.
            emailMarketingConsent: {
              marketingState: "SUBSCRIBED",
              marketingOptInLevel: "SINGLE_OPT_IN",
            },
            metafields: [
              { namespace: "b2b", key: "empresa", type: "single_line_text_field", value: empresa },
              { namespace: "b2b", key: "nif", type: "single_line_text_field", value: nifResult.normalized! },
              { namespace: "b2b", key: "sector", type: "single_line_text_field", value: sector },
              // Belt-and-suspenders trim: sanitizeText + normalizeCountry ya
              // limpian, pero un set de customers historicos quedó con `\tES`
              // o `\t\tES` en este metafield (root cause no localizada en el
              // path actual; ver C.6 / docs/pendientes.md). Trim explícito
              // aquí para garantizar que el write nunca persiste whitespace.
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
        requestId, startedAt, emailHash, outcome: "shopify_error",
        error: (e as Error).message,
      }));
      return jsonResponse({
        code: "SHOPIFY_UNAVAILABLE",
        message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
      }, 502);
    }

    const errs = createData.customerCreate.userErrors;
    if (errs.length > 0) {
      // Map to field errors when possible.
      // UserError no tiene campo `code` (solo CustomerUserError sí; customerCreate
      // devuelve UserError pelado). Detectar email duplicado por regex sobre message.
      const emailTaken = errs.some((e) =>
        /taken|already|exist/i.test(e.message) &&
        (e.field?.includes("email") ?? false)
      );
      if (emailTaken) {
        console.log(JSON.stringify({
          requestId, startedAt, emailHash, outcome: "email_taken",
        }));
        return jsonResponse({
          code: "EMAIL_ALREADY_EXISTS",
          message: "Ya existe una cuenta con este email. Prueba a iniciar sesión.",
        }, 409);
      }

      const mapped: Record<string, string> = {};
      for (const ue of errs) {
        const f = ue.field?.[ue.field.length - 1] ?? "_form";
        mapped[f] = ue.message;
      }
      console.log(JSON.stringify({
        requestId, startedAt, emailHash, outcome: "user_errors", userErrors: errs,
      }));
      return jsonResponse({ code: "VALIDATION_ERROR", fieldErrors: mapped }, 400);
    }

    const customer = createData.customerCreate.customer;
    if (!customer) {
      // Shouldn't happen if no userErrors, but be defensive.
      console.log(JSON.stringify({
        requestId, startedAt, emailHash, outcome: "shopify_error",
        error: "customerCreate returned no customer and no userErrors",
      }));
      return jsonResponse({
        code: "SHOPIFY_UNAVAILABLE",
        message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
      }, 502);
    }

    // --- 4. tagsAdd: 'pendiente' (best-effort, separado del create) ---
    //
    // Shopify Admin API 2025-10 removió `tags` de CustomerInput, así que se
    // hace en una segunda mutación. Si falla, el customer ya está creado y
    // Flow W1 no disparará por el tag → backoffice debe taguear a mano. No
    // bloqueamos la respuesta al usuario.
    let tagsAdded = true;
    try {
      interface TagsAddResp {
        tagsAdd: {
          node: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }
      const tagsData = await gql<TagsAddResp>(
        `
        mutation($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            node { ... on Customer { id } }
            userErrors { field message }
          }
        }
        `,
        { id: customer.id, tags: ["pendiente"] },
      );
      if (tagsData.tagsAdd.userErrors.length > 0) {
        tagsAdded = false;
        console.log(JSON.stringify({
          requestId, startedAt, emailHash, outcome: "tags_add_failed",
          customerId: customer.id, userErrors: tagsData.tagsAdd.userErrors,
        }));
      }
    } catch (e) {
      tagsAdded = false;
      console.log(JSON.stringify({
        requestId, startedAt, emailHash, outcome: "tags_add_failed",
        customerId: customer.id, error: (e as Error).message,
      }));
    }

    // --- 5. customerSendAccountInviteEmail (best-effort) ---
    let inviteSent = true;
    try {
      interface InviteResp {
        customerSendAccountInviteEmail: {
          customer: { id: string } | null;
          userErrors: Array<{ field: string[] | null; message: string }>;
        };
      }
      const inviteData = await gql<InviteResp>(
        `
        mutation($customerId: ID!) {
          customerSendAccountInviteEmail(customerId: $customerId) {
            customer { id }
            userErrors { field message }
          }
        }
        `,
        { customerId: customer.id },
      );
      const ie = inviteData.customerSendAccountInviteEmail.userErrors;
      if (ie.length > 0) {
        inviteSent = false;
        console.log(JSON.stringify({
          requestId, startedAt, emailHash, outcome: "invite_failed",
          userErrors: ie,
        }));
      }
    } catch (e) {
      inviteSent = false;
      console.log(JSON.stringify({
        requestId, startedAt, emailHash, outcome: "invite_failed",
        error: (e as Error).message,
      }));
    }

    console.log(JSON.stringify({
      requestId, startedAt, emailHash, outcome: "created",
      customerId: customer.id, inviteSent, tagsAdded,
    }));

    const warnings: string[] = [];
    if (!inviteSent) warnings.push("INVITE_EMAIL_FAILED");
    if (!tagsAdded) warnings.push("TAG_PENDIENTE_FAILED");

    return jsonResponse({
      ok: true,
      customerId: customer.id,
      inviteSent,
      tagsAdded,
      ...(warnings.length > 0 ? { warning: warnings.join(",") } : {}),
    });
  } catch (e) {
    console.log(JSON.stringify({
      requestId, startedAt, emailHash, outcome: "unhandled_error",
      error: (e as Error).message,
    }));
    return jsonResponse({
      code: "SHOPIFY_UNAVAILABLE",
      message: "Servicio no disponible, vuelve a intentarlo en unos minutos.",
    }, 502);
  }
});
