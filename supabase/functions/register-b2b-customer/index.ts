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
//     empresa: "Instalaciones Luz SL", // opcional si sector === "instalador"
//     nif: "B12345678",             // opcional si sector === "instalador"; si viene, se valida + normaliza a uppercase
//     sector: "instalador",         // enum estricto
//     pais: "ES",                   // ISO 3166-1 alpha-2
//     volumen_estimado: "5k-25k",   // opcional
//     codigo_postal: "28001",       // obligatorio (Fase 2 instalador, 2026-07)
//     condiciones: true             // checkbox términos
//   }
//
// Fase 2 instalador completa (2026-07): esta función NO decide el rol ni
// aprueba a nadie — solo crea el customer con sus metafields y lo deja en
// 'pendiente' para que Shopify Flow W1 lo procese. El discriminador de
// carril que usa W1 es b2b.sector: sector === "instalador" (fijo en la
// landing dedicada /pages/acceso-instalador, hidden en el UI) → W1
// auto-aprueba como instalador SIN pasar por whitelist ni crear Company;
// cualquier otro sector → carril de distribuidor sin cambios (whitelist →
// distribuidor+Company, sin match → pendiente/backoffice). Ver
// flows/W1-walkthrough.md para el detalle completo (edición manual en
// Shopify Flow, fuera de este repo).
//
// b2b.sector se persiste SIEMPRE (es el discriminador; nunca se omite).
// b2b.empresa/b2b.nif se relajan a opcionales cuando sector === "instalador":
// - empresa se fuerza a vacío en ese carril aunque el body la traiga
//   rellena (la landing de instalador no expone el campo; un valor
//   presente solo puede venir de un payload crafteado a mano).
// - nif se acepta vacío; si se rellena, igual se valida el formato.
// Ambos se omiten del array de metafields cuando quedan vacíos (Shopify
// rechaza single_line_text_field con value "").
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
// Rotación de secret sin downtime: si está presente, se acepta también una
// firma válida contra el secret SALIENTE. Se retira al terminar la rotación.
const HMAC_SECRET_PREV = Deno.env.get("REGISTER_B2B_HMAC_SECRET_PREV");
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

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
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

// Verifica una firma contra el secret vigente y, si está configurado, contra el
// secret saliente (modo DUAL durante la rotación). Devuelve true si casa con
// cualquiera de los dos. Sin REGISTER_B2B_HMAC_SECRET_PREV → solo el vigente.
export async function verifyHmacSignature(payload: string, signature: string): Promise<boolean> {
  const sigPrimary = await hmacSha256Hex(payload, HMAC_SECRET!);
  if (constantTimeEq(sigPrimary, signature)) return true;
  if (HMAC_SECRET_PREV) {
    const sigPrev = await hmacSha256Hex(payload, HMAC_SECRET_PREV);
    if (constantTimeEq(sigPrev, signature)) return true;
  }
  return false;
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

// Validación ramificada por país:
//   - country === 'ES' → DNI / NIE / CIF con dígito de control (rama estricta).
//   - resto (o country null) → saneo mínimo: 4–20 chars alfanuméricos en
//     mayúsculas, sin algoritmo de control. Cubre VAT IDs de cualquier país
//     (PT123456789, FR12345678901, etc.) sin tener que mantener un dataset
//     por jurisdicción. La invariante real (cliente válido) la hace ops a
//     mano al aprobar la solicitud.
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
  codigo_postal?: string;
  condiciones?: boolean;
}

async function handle(req: Request): Promise<Response> {
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

    if (!(await verifyHmacSignature(`${timestamp}:${nonce}`, signature))) {
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
    const codigoPostal = sanitizeText(body.codigo_postal, 12);

    // Instalador (landing dedicada, sector fijo "instalador"): sin Company
    // por decisión de negocio → empresa/nif dejan de ser obligatorios.
    // Cualquier otro sector (incl. "otro", hidden del form distribuidor)
    // mantiene el requisito histórico.
    const isInstalador = sector === "instalador";
    // Fuerza vacío en carril instalador aunque el body traiga empresa
    // rellena (defensa contra un payload crafteado a mano; la landing de
    // instalador no expone este campo en el UI).
    const empresaToPersist = isInstalador ? "" : empresa;

    emailHash = email ? await sha256Hex(email) : "";

    if (!nombre) fieldErrors.nombre = "El nombre es obligatorio.";
    if (!apellidos) fieldErrors.apellidos = "Los apellidos son obligatorios.";
    if (!email) fieldErrors.email = "El email es obligatorio.";
    else if (!isValidEmail(email)) fieldErrors.email = "El email no parece válido.";
    if (!empresa && !isInstalador) fieldErrors.empresa = "La razón social es obligatoria.";
    if (!codigoPostal) fieldErrors.codigo_postal = "El código postal es obligatorio.";

    // Teléfono (opcional): pre-validación con mensaje útil; sin ella
    // Shopify rechaza el customerCreate con userError field=["phone"] que
    // el front no pinta (input name="telefono"). Ver complete-b2b (2026-06-11).
    const telefonoNorm = telefonoRaw.replace(/[\s.\-()\/]/g, "");
    if (telefonoNorm && !/^\+?[0-9]{7,15}$/.test(telefonoNorm)) {
      fieldErrors.telefono =
        "Teléfono no válido: usa solo dígitos, con prefijo internacional opcional (ej. +34600112233), o déjalo vacío.";
    }

    // Calculamos país primero porque validateTaxId ramifica por country:
    // rama 'ES' = NIF/NIE/CIF estricto, rama resto = saneo mínimo. Si el
    // país es null el error de país ya se reporta por su lado; pasamos
    // null a validateTaxId para tratar el NIF por la rama "resto" en lugar
    // de bloquear con un mensaje ES que no aplica.
    const paisIso = normalizeCountry(paisRaw);
    if (!paisIso) {
      fieldErrors.pais = "Selecciona un país.";
    }

    // Instalador con NIF vacío: opcional, se omite sin error. Si escribe
    // algo, igualmente se valida el formato (calidad de dato).
    const nifOptionalAndEmpty = isInstalador && !nifRaw;
    const nifResult = nifOptionalAndEmpty
      ? { ok: true as const, normalized: undefined }
      : validateTaxId(nifRaw, paisIso);
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
            phone: telefonoNorm || null,
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
              // empresa: nunca se persiste para sector === "instalador", aunque
              // el body la traiga rellena (payload crafteado a mano, ya que la
              // landing de instalador no tiene este campo en el UI) — el
              // discriminador de carril del Flow (b2b.sector) decide el rol,
              // y el carril instalador no debe poder generar Company. Además,
              // Shopify rechaza single_line_text_field con value vacío, así
              // que se omite entera cuando no aplica.
              ...(empresaToPersist
                ? [{ namespace: "b2b", key: "empresa", type: "single_line_text_field", value: empresaToPersist }]
                : []),
              ...(nifResult.normalized
                ? [{ namespace: "b2b", key: "nif", type: "single_line_text_field", value: nifResult.normalized }]
                : []),
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
              { namespace: "b2b", key: "codigo_postal", type: "single_line_text_field", value: codigoPostal },
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
        let f = ue.field?.[ue.field.length - 1] ?? "_form";
        // Mapeo Shopify→form: sin esto el front no encuentra el input y
        // el error queda invisible para el usuario (2026-06-11).
        if (f === "phone") f = "telefono";
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

    // --- 4. tagsAdd: 'pendiente' (separado del create, con retries) ---
    //
    // Shopify Admin API 2025-10 removió `tags` de CustomerInput, así que se
    // hace en una segunda mutación. Sin el tag, Flow W1 no dispara y el
    // cliente queda invisible para el backoffice (huérfano), así que
    // reintentamos hasta 3 veces con backoff ante errores transitorios
    // (red/5xx). Los userErrors NO se reintentan (deterministas). Si aun
    // así falla, no bloqueamos la respuesta: el cron de reconciliación
    // (promote-whitelist-matches) lo recoge en la pasada siguiente.
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
            { id: customer.id, tags: ["pendiente"] },
          );
          if (tagsData.tagsAdd.userErrors.length > 0) {
            tagsAdded = false;
            console.log(JSON.stringify({
              requestId, startedAt, emailHash, outcome: "tags_add_failed",
              attempt, customerId: customer.id,
              userErrors: tagsData.tagsAdd.userErrors,
            }));
          }
          break; // éxito o userError determinista: no reintentar
        } catch (e) {
          tagsAdded = false;
          console.log(JSON.stringify({
            requestId, startedAt, emailHash, outcome: "tags_add_failed",
            attempt, customerId: customer.id, error: (e as Error).message,
          }));
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
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
}

// Guard env-sentinel: en tests se setea REGISTER_B2B_TEST_MODE antes del import
// para que importar el módulo NO levante el server (evita colisión de puerto al
// cargar varios módulos en la misma tanda de `deno test`). En el runtime de
// Supabase Edge la sentinel no está → sirve normalmente.
if (!Deno.env.get("REGISTER_B2B_TEST_MODE")) {
  Deno.serve(handle);
}
