// Supabase Edge Function: generate-offer-pdf
//
// Fase 3 instaladores — genera el PDF de una solicitud (Draft Order) con
// pdf-lib, lo sube a Shopify Files, y escribe la URL en un metafield del
// draft para que Shopify Flow la lea y la incluya en el email de oferta.
// Esta función NO envía email — eso sigue siendo responsabilidad de Flow.
//
// Invocada desde Shopify Flow (ya configurado — Fase 3, fuera de este
// repo, mismo patrón que create-company-for-customer) cuando una
// solicitud está lista para convertirse en oferta.
//
// Auth: header X-Webhook-Secret == env GENERATE_OFFER_PDF_WEBHOOK_SECRET.
// Mismo patrón que create-company-for-customer — no HMAC, secreto plano
// compartido entre Flow y esta función.
//
// Input (body JSON):
//   { "draftOrderId": "gid://shopify/DraftOrder/123..." }
//
// Output:
//   { "pdf_url": "https://...", "total_oferta": "1.234,56 €",
//     "cp": "28001", "locale": "es", "nombre": "Juan",
//     "apellidos": "Pérez García", "email": "juan@empresa.com",
//     "telefono": "+34600000000", "nif": "12345678Z",
//     "utm_source": "meta",
//     "utm_medium": "paid_social", "utm_campaign": "instalador_q3",
//     "utm_term": "instalador+electricista", "utm_content": "carrusel_v2" } (200)
//   { "error": "...", ... }                                          (4xx/5xx)
//
// cp/locale/nombre/apellidos/email/telefono/nif/utm_* son passthrough de
// datos de registro (Fase 1/2) para que Flow arme el email (incl. el email
// interno "solicitud de oferta de instalador" con los datos de contacto
// para que el comercial pueda llamar) sin tener que releer el customer
// aparte. SIEMPRE string, "" (nunca null) si el metafield/campo no existe.
// nombre/apellidos vienen de firstName/lastName nativos del customer;
// email/telefono de defaultEmailAddress.emailAddress/
// defaultPhoneNumber.phoneNumber (también nativos, no metafields). cp y nif
// vienen de metafields `b2b.codigo_postal`/`b2b.nif`; los utm_* de
// `b2b.utm_source`/`utm_medium`/`utm_campaign`/`utm_term`/`utm_content`
// (namespace y claves confirmados leyendo register-b2b-customer/index.ts —
// el CP NO es `b2b.cp`, es `b2b.codigo_postal`; nif y los 5 UTM son
// opcionales ahí igual que aquí). locale es `customer.locale` tal cual
// (crudo, sin normalizar — Flow ya ramea con starts_with).
//
// Idempotencia (paso 1): si el draft ya tiene metafield b2b.pdf_url, se
// devuelve sin regenerar el PDF — evita duplicar en reintentos de Flow.
// La respuesta SIGUE incluyendo total_oferta/cp/locale/utm_* igual que en
// el camino normal (se calculan antes del check de idempotencia,
// independientes de si hace falta generar el PDF) — Flow necesita el
// mismo shape de respuesta se procese o no el PDF en esta invocación.
//
// Metafields del CUSTOMER (además de b2b.pdf_url en el draft, que se
// mantiene): las plantillas de Shopify Messaging (marketing mail) NO
// reciben contexto de draft order — {{ draft_order.name }} llega vacío,
// verificado — solo leen customer.metafields/shop.metafields. Por eso, en
// cada generación (Y en el hit idempotente, para no dejarlos desfasados
// tras un reintento) se escribe también:
//   b2b.ultima_oferta_pdf    = pdf_url
//   b2b.ultima_oferta_ref    = nombre del draft (draft.name, tal cual)
//   b2b.ultima_oferta_total  = total_oferta (string ya formateado con
//                              símbolo, NO el número crudo)
// Se sobrescriben en cada solicitud — es "última oferta", no un historial.
// Si el draft no tiene customer asociado (no debería pasar en un
// solicitud-b2b real), se salta esta escritura y se loguea un warning; el
// pdf_url del draft se escribe igual.
//
// total_oferta SIEMPRE en EUR (€) — la divisa real del draft
// (presentmentMoney.currencyCode, igual que sections/b2b-solicitud-
// detalle.liquid). NO se usa el símbolo cosmético de "Moneda mostrada"/
// "Símbolo moneda" que guarda submit-order-request: sin conversión de
// tasa, poner $/£ sobre un importe EUR sería engañoso (decisión Dani
// 2026-07-17).
//
// Markup instalador — CONFIRMADO por Dani (base de datos): los precios
// grabados en el Draft Order son SIEMPRE precio distribuidor. El precio
// instalador (distribuidor × 1,15) hoy se construye SOLO en el frontend de
// compra, nunca en el draft. Esta función NO toca submit-order-request
// (prohibido en el encargo), así que replica EXACTAMENTE la lógica del
// frontend — no una fórmula inventada:
//
//   Fuente única del factor: `layout/theme.liquid` línea ~72,
//     {%- assign ledsc4_installer_markup_factor = 1.15 -%}
//   — literal hardcodeado, NO es un setting ni metafield (confirmado
//   leyendo el Liquid; nada que leer de Shopify en runtime).
//
//   Fórmula real (assets/ledsc4-currency-display.js, función
//   `formatAmount(eurCents, currency, withApprox, skipMarkup)`):
//     value = (eurCents / 100) * rate * markup     // rate=1 para EUR
//     formatted = value.toLocaleString('es-ES', {
//       minimumFractionDigits: 2, maximumFractionDigits: 2,
//     })
//     body = formatted + ' ' + simbolo             // "11,39 €"
//
//   El precio UNITARIO de cada línea replica exactamente el nodo
//   `data-eur-amount` del frontend: `round(unitAmountRaw × markup, 2)` vía
//   `toLocaleString('es-ES', …)`. Verificado empíricamente que ese
//   redondeo en Deno (V8) coincide con el navegador, casos de empate
//   incluidos (p.ej. 9,90 × 1,15 = 11,385 → "11,39").
//
//   Coherencia aritmética del DOCUMENTO (corrección 2026-07-19, bug real
//   detectado en #D35: PDF mostraba "11,33 € × 8 = 90,62 €", pero
//   11,33 × 8 = 90,64 €). El frontend redondea precio unitario/subtotal de
//   línea/total como nodos de UI independientes porque nadie los lee "en
//   columna" — pero un PDF SÍ se lee así, y el lector espera que
//   unitario × cantidad dé el subtotal impreso, y que la suma de
//   subtotales dé el total. Por eso el PDF (y SOLO el PDF — no cambia
//   nada del frontend ni de submit-order-request) deriva en cascada desde
//   el unitario YA redondeado, no desde importes crudos independientes:
//     1. unitRounded  = round(unitAmountRaw × markup, 2)     — fuente única
//     2. lineSubtotal = round(unitRounded × cantidad, 2)     — NO usa
//        discountedTotalSet del draft
//     3. total        = round(Σ lineSubtotal, 2)             — NO usa
//        draft.totalPrice
//   Ver `computeOfferAmounts()`. NUNCA se escribe de vuelta en Shopify
//   (puramente cosmético en el PDF, igual que en el tema).
//
//   total_oferta (respuesta JSON / b2b.ultima_oferta_total, lo que lee el
//   email de Flow) sale del MISMO `computeOfferAmounts()` que el PDF — no
//   hay una segunda fórmula: PDF y email nunca pueden discrepar entre sí.
//
// Logo: sections/b2b-solicitud-detalle.liquid usa 'logo-ledsc4.svg' (asset
// del tema, SVG) pero pdf-lib NO puede incrustar SVG (solo PNG/JPG vía
// embedPng/embedJpg). En su lugar se descarga e incrusta el PNG real
// (LOGO_URL, misma función tryEmbedImage que ya usan las miniaturas de
// producto — reutilizado, no una descarga nueva independiente) en el
// header, ancho fijo LOGO_WIDTH con alto proporcional (nunca se deforma:
// se escala por el ratio real de la imagen, nunca con width+height fijos
// distintos). Si el fetch falla o el contenido no es una imagen válida,
// tryEmbedImage devuelve null (nunca lanza) y drawHeader() cae al wordmark
// de texto ("LEDS C4 · Outlet", el mismo que ya sirve de fallback en los
// email templates cuando no hay logo raster — email-templates/01-
// bienvenida-auto.liquid) — el PDF nunca falla por el logo.
//
// Fuente (ver informe de recon): Helvetica estándar de pdf-lib basta — su
// codificación WinAnsi (cp1252) ya cubre acentos españoles y € sin
// necesidad de incrustar una TTF (Arial es además una fuente propietaria;
// evitarla evita cualquier duda de licencia).
//
// Secrets requeridos en Supabase (Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN
//   SHOPIFY_ADMIN_TOKEN                 (ya tiene write_files/read_files,
//                                        probado por scripts/lib/image-upload.mjs)
//   SHOPIFY_API_VERSION                 (opcional, default 2025-10)
//   GENERATE_OFFER_PDF_WEBHOOK_SECRET    (nuevo, mismo valor en el header de Flow)

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";
const WEBHOOK_SECRET = Deno.env.get("GENERATE_OFFER_PDF_WEBHOOK_SECRET");

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}
if (!WEBHOOK_SECRET) {
  throw new Error("Missing GENERATE_OFFER_PDF_WEBHOOK_SECRET env var");
}

const endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// Poll acotado tras fileCreate: los PDF son pequeños y Shopify los deja
// READY casi al instante (a diferencia de vídeo/3D, no hay transcodificado
// pesado) — 10s de techo es margen amplio, no un valor ajustado al límite.
const POLL_MS = 1000;
const POLL_MAX_MS = 10_000;

const MARKUP_INSTALADOR = 1.15; // mismo factor que window.LEDSC4_INSTALLER_MARKUP (Fase 1)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function logJson(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, event, fn: "generate-offer-pdf", ...fields }));
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

// --- 1. Fetch del draft ---------------------------------------------------

interface DraftOrderData {
  draftOrder: {
    id: string;
    name: string;
    note2: string | null;
    tags: string[];
    totalPrice: string;
    pdfUrlMetafield: { value: string } | null;
    customer: {
      id: string;
      tags: string[];
      locale: string | null;
      firstName: string | null;
      lastName: string | null;
      defaultEmailAddress: { emailAddress: string } | null;
      defaultPhoneNumber: { phoneNumber: string } | null;
      cp: { value: string } | null;
      nif: { value: string } | null;
      utmSource: { value: string } | null;
      utmMedium: { value: string } | null;
      utmCampaign: { value: string } | null;
      utmTerm: { value: string } | null;
      utmContent: { value: string } | null;
    } | null;
    lineItems: {
      edges: Array<{
        node: {
          title: string;
          variantTitle: string | null;
          sku: string | null;
          quantity: number;
          originalUnitPriceSet: { presentmentMoney: { amount: string; currencyCode: string } };
          image: { url: string } | null;
        };
      }>;
    };
  } | null;
}

const DRAFT_ORDER_QUERY = `
  query GenerateOfferPdf($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      note2
      tags
      totalPrice
      pdfUrlMetafield: metafield(namespace: "b2b", key: "pdf_url") { value }
      customer {
        id
        tags
        locale
        firstName
        lastName
        defaultEmailAddress { emailAddress }
        defaultPhoneNumber { phoneNumber }
        cp: metafield(namespace: "b2b", key: "codigo_postal") { value }
        nif: metafield(namespace: "b2b", key: "nif") { value }
        utmSource: metafield(namespace: "b2b", key: "utm_source") { value }
        utmMedium: metafield(namespace: "b2b", key: "utm_medium") { value }
        utmCampaign: metafield(namespace: "b2b", key: "utm_campaign") { value }
        utmTerm: metafield(namespace: "b2b", key: "utm_term") { value }
        utmContent: metafield(namespace: "b2b", key: "utm_content") { value }
      }
      lineItems(first: 100) {
        edges {
          node {
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { presentmentMoney { amount currencyCode } }
            image { url(transform: { maxWidth: 96, maxHeight: 96 }) }
          }
        }
      }
    }
  }
`;

// --- 2. Metafield write ----------------------------------------------------
//
// Un único mutation genérico: escribe b2b.pdf_url en el DRAFT y, en el
// mismo lote, "última oferta" (pdf/ref/total) en el CUSTOMER — las
// plantillas de Shopify Messaging (marketing mail) NO reciben contexto de
// draft order (verificado: {{ draft_order.name }} llega vacío), solo leen
// customer.metafields/shop.metafields, así que el email al instalador
// necesita estos datos colgados del customer, no solo del draft.

interface MetafieldEntry {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

const SET_OFFER_METAFIELDS_MUTATION = `
  mutation SetOfferMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value }
      userErrors { field message code }
    }
  }
`;

async function writeOfferMetafields(metafields: MetafieldEntry[]): Promise<void> {
  if (metafields.length === 0) return;
  const data = await gql<{
    metafieldsSet: { userErrors: Array<{ field: string[] | null; message: string; code: string }> };
  }>(SET_OFFER_METAFIELDS_MUTATION, { metafields });
  const errs = data.metafieldsSet.userErrors;
  if (errs.length > 0) {
    throw new Error(`metafieldsSet errors: ${JSON.stringify(errs)}`);
  }
}

// "Última oferta" del customer — se SOBRESCRIBE en cada solicitud (no es un
// historial, es un puntero al último PDF generado); comportamiento deseado.
function customerOfferMetafields(customerId: string, pdfUrl: string, ref: string, total: string): MetafieldEntry[] {
  return [
    { ownerId: customerId, namespace: "b2b", key: "ultima_oferta_pdf", type: "single_line_text_field", value: pdfUrl },
    { ownerId: customerId, namespace: "b2b", key: "ultima_oferta_ref", type: "single_line_text_field", value: ref },
    { ownerId: customerId, namespace: "b2b", key: "ultima_oferta_total", type: "single_line_text_field", value: total },
  ];
}

// --- 3. Staged upload + fileCreate (patrón de scripts/lib/image-upload.mjs, adaptado a Deno) ---

const STAGED_UPLOADS_CREATE = `
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        ... on GenericFile { fileStatus url }
      }
      userErrors { field message code }
    }
  }
`;

const FILE_NODE_QUERY = `
  query FileNode($id: ID!) {
    node(id: $id) {
      ... on GenericFile { id fileStatus url fileErrors { message } }
    }
  }
`;

async function uploadPdfToShopifyFiles(pdfBytes: Uint8Array, filename: string): Promise<string> {
  // 1. stagedUploadsCreate — resource FILE (no IMAGE: esto es un PDF).
  const stagedData = await gql<{
    stagedUploadsCreate: {
      stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(STAGED_UPLOADS_CREATE, {
    input: [{ resource: "FILE", filename, mimeType: "application/pdf", httpMethod: "POST" }],
  });
  const stagedErrs = stagedData.stagedUploadsCreate.userErrors;
  if (stagedErrs.length > 0) {
    throw new Error(`stagedUploadsCreate errors: ${JSON.stringify(stagedErrs)}`);
  }
  const target = stagedData.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("stagedUploadsCreate: no stagedTargets returned");

  // 2. POST binary — Deno tiene FormData/Blob nativos (Web standard), igual
  // que el patrón Node de image-upload.mjs. Los parameters van primero, el
  // file al final (S3 streamea y para de leer al encontrar el file).
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([pdfBytes as BlobPart], { type: "application/pdf" }), filename);

  const uploadRes = await fetch(target.url, { method: "POST", body: form });
  if (!uploadRes.ok) {
    const body = await uploadRes.text().catch(() => "");
    throw new Error(`staged upload POST ${uploadRes.status}: ${body.slice(0, 300)}`);
  }

  // 3. fileCreate.
  const createData = await gql<{
    fileCreate: {
      files: Array<{ id: string; fileStatus?: string; url?: string | null }>;
      userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    };
  }>(FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: "FILE", filename }],
  });
  const createErrs = createData.fileCreate.userErrors;
  if (createErrs.length > 0) {
    throw new Error(`fileCreate errors: ${JSON.stringify(createErrs)}`);
  }
  const file = createData.fileCreate.files[0];
  if (!file?.id) throw new Error("fileCreate: no file returned");

  if (file.fileStatus === "READY" && file.url) return file.url;
  if (file.fileStatus === "FAILED") throw new Error("fileCreate: file entered FAILED status immediately");

  // 4. Poll acotado — NO bloquea indefinidamente (paso 7 del encargo). Si no
  // llega a READY en el techo, se propaga el error: mejor fallar claro que
  // escribir una URL vacía/incorrecta en el metafield. Un reintento de Flow
  // relanzará la generación completa (caso raro — PDFs pequeños suelen
  // resolver en 1-2s).
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const nodeData = await gql<{
      node: { id: string; fileStatus: string; url: string | null; fileErrors: Array<{ message: string }> } | null;
    }>(FILE_NODE_QUERY, { id: file.id });
    const node = nodeData.node;
    if (!node) throw new Error("file poll: node not found");
    if (node.fileStatus === "READY" && node.url) return node.url;
    if (node.fileStatus === "FAILED") {
      const msg = node.fileErrors[0]?.message ?? "unknown";
      throw new Error(`file processing FAILED: ${msg}`);
    }
    // UPLOADED / PROCESSING → seguir esperando.
  }
  throw new Error(`file status poll timeout after ${POLL_MAX_MS}ms (still processing)`);
}

// --- 4. Generación del PDF (pdf-lib, replica sections/b2b-solicitud-detalle.liquid) ---

interface OfferLine {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  // Importe CRUDO (precio distribuidor, sin markup) — fuente única para el
  // precio unitario. El resto (subtotal de línea, total) se DERIVA del
  // unitario ya redondeado, ver computeOfferAmounts().
  unitAmountRaw: number;
  currencyCode: string;
  imageUrl: string | null;
}

interface ComputedLine {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitRounded: number;
  lineSubtotalRounded: number;
  currencyCode: string;
  imageUrl: string | null;
}

// Mismo mapa que SYMBOLS en assets/ledsc4-currency-display.js.
const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

// Redondeo a 2 decimales — devuelve el NÚMERO (no un string), para poder
// seguir operando con él (unitario_redondeado × cantidad). OJO: NO usar
// `value.toFixed(2)` aquí — tiene un bug conocido de redondeo en casos de
// empate por imprecisión de coma flotante (9,90 × 1,15 = 11.385 en binario
// es en realidad 11.384999999999998..., así que toFixed da "11.38", pero
// `toLocaleString`/Intl SÍ redondea correctamente a "11,39", que es lo que
// muestra el frontend — verificado empíricamente, ver comentario de
// cabecera). Formateamos con locale 'en-US' (mismo motor Intl que
// 'es-ES', el redondeo numérico no depende del locale — solo cambia el
// separador decimal) para poder re-parsear el resultado con
// Number.parseFloat sin lidiar con comas.
function roundToCents(value: number): number {
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
  return Number.parseFloat(formatted);
}

function formatEur(amount: number, currencyCode: string): string {
  const sym = CURRENCY_SYMBOLS[currencyCode] ?? currencyCode;
  const formatted = amount.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${sym}`;
}

// Fuente única de verdad para los importes de la oferta — usada TANTO por
// el PDF (generateOfferPdf) COMO por total_oferta (respuesta JSON /
// b2b.ultima_oferta_total): PDF y email nunca pueden discrepar entre sí.
// Ver comentario de cabecera "Coherencia aritmética del documento".
function computeOfferAmounts(
  lines: OfferLine[],
  markup: number,
): { lines: ComputedLine[]; totalRounded: number } {
  const computedLines: ComputedLine[] = lines.map((line) => {
    const unitRounded = roundToCents(line.unitAmountRaw * markup);
    const lineSubtotalRounded = roundToCents(unitRounded * line.quantity);
    return {
      title: line.title,
      variantTitle: line.variantTitle,
      sku: line.sku,
      quantity: line.quantity,
      unitRounded,
      lineSubtotalRounded,
      currencyCode: line.currencyCode,
      imageUrl: line.imageUrl,
    };
  });
  const totalRounded = roundToCents(computedLines.reduce((sum, l) => sum + l.lineSubtotalRounded, 0));
  return { lines: computedLines, totalRounded };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const STATUS_LABELS: Record<string, string> = {
  "pendiente-revision": "En revisión",
  "en-tramite": "En trámite",
  "confirmada": "Confirmada",
  "cancelada": "Cancelada",
};

function mapStatus(tags: string[]): string {
  for (const t of ["cancelada", "confirmada", "en-tramite", "pendiente-revision"]) {
    if (tags.includes(t)) return t;
  }
  return "pendiente-revision";
}

// Word-wrap simple por ancho real de fuente — corta en el último espacio
// que quepa; si una sola palabra no cabe, la deja tal cual (no la parte).
function wrapText(text: string, font: import("npm:pdf-lib@1.17.1").PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Descarga una imagen de producto y la incrusta. Nunca lanza — si falla
// (red, formato no soportado, lo que sea) devuelve null y el llamador
// pinta un hueco vacío en su lugar (paso 3 del encargo: "si falta, hueco
// vacío, no falles").
async function tryEmbedImage(
  pdfDoc: import("npm:pdf-lib@1.17.1").PDFDocument,
  url: string | null,
): Promise<import("npm:pdf-lib@1.17.1").PDFImage | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (contentType.includes("png")) return await pdfDoc.embedPng(bytes);
    // Shopify sirve casi todo como JPEG salvo que el original sea PNG;
    // probamos JPEG por defecto y caemos a PNG si el propio pdf-lib lo rechaza.
    try {
      return await pdfDoc.embedJpg(bytes);
    } catch {
      return await pdfDoc.embedPng(bytes);
    }
  } catch {
    return null;
  }
}

// Logo real (PNG, 800×181px) — reemplaza el wordmark de texto en el header
// cuando la descarga funciona; ver comentario más arriba sobre el fallback.
const LOGO_URL = "https://shop.ledsc4.com/cdn/shop/files/logo-ledsc4.png";
const LOGO_WIDTH = 160;

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const COL_THUMB_X = MARGIN;
const COL_THUMB_SIZE = 32;
const COL_TITLE_X = MARGIN + COL_THUMB_SIZE + 12;
const COL_TITLE_W = 250;
const COL_UDS_X = 400;
const COL_PRECIO_X = 445;
const COL_SUBTOTAL_X = 515;
const ROW_HEIGHT = 46;
const TABLE_BOTTOM_MARGIN = 160; // deja hueco para totales + nota + footer

async function generateOfferPdf(params: {
  name: string;
  createdAtIso: string;
  status: string;
  note: string | null;
  totalRounded: number;
  currencyCode: string;
  lines: ComputedLine[];
}): Promise<Uint8Array> {
  const { name, createdAtIso, status, note, totalRounded, currencyCode, lines } = params;

  const pdfDoc = await PDFDocument.create();
  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Se descarga/incrusta UNA vez (el header solo se pinta en la primera
  // página) — null si falla, drawHeader() cae al wordmark de texto.
  const logoImage = await tryEmbedImage(pdfDoc, LOGO_URL);

  const gray = rgb(0.4, 0.4, 0.4);
  const black = rgb(0.08, 0.09, 0.1);
  const accent = rgb(0, 0.32, 1); // aprox var(--color-ledsc4-accent)

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function drawHeader(): void {
    const dateLabel = fmtDate(createdAtIso);
    const dateWidth = helv.widthOfTextAtSize(dateLabel, 9);
    page.drawText(dateLabel, { x: PAGE_WIDTH - MARGIN - dateWidth, y: y + 2, size: 9, font: helv, color: gray });

    if (logoImage) {
      // Ancho fijo, alto proporcional al ratio real de la imagen — nunca se
      // deforma (nunca se fuerza width+height independientes).
      const logoScale = LOGO_WIDTH / logoImage.width;
      const logoHeight = logoImage.height * logoScale;
      page.drawImage(logoImage, { x: MARGIN, y: y - logoHeight, width: LOGO_WIDTH, height: logoHeight });
      // El siguiente elemento (drawTitleAndMeta) dibuja texto a 20pt cuyo
      // ascender sube ~14pt por encima de su baseline — el padding tiene
      // que cubrir eso + un margen visual, si no el título "sube" hasta
      // solapar el logo (medido visualmente contra un PDF real).
      y -= logoHeight + 26;
    } else {
      page.drawText("LEDS C4 · Outlet", { x: MARGIN, y, size: 13, font: helvBold, color: black });
      y -= 34;
    }
  }

  function drawTitleAndMeta(): void {
    page.drawText(`Solicitud ${name}`, { x: MARGIN, y, size: 20, font: helvBold, color: black });
    y -= 22;
    const statusLabel = STATUS_LABELS[status] ?? status;
    page.drawText(`Estado: ${statusLabel}`, { x: MARGIN, y, size: 10, font: helv, color: gray });
    y -= 26;
  }

  function drawTableHeader(): void {
    const headerY = y;
    page.drawText("PRODUCTO", { x: COL_TITLE_X, y: headerY, size: 8, font: helvBold, color: gray });
    page.drawText("UDS.", { x: COL_UDS_X, y: headerY, size: 8, font: helvBold, color: gray });
    page.drawText("PRECIO UNIT.", { x: COL_PRECIO_X, y: headerY, size: 8, font: helvBold, color: gray });
    page.drawText("SUBTOTAL", { x: COL_SUBTOTAL_X, y: headerY, size: 8, font: helvBold, color: gray });
    y -= 14;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85),
    });
    y -= 14;
  }

  function newPage(): void {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
    drawTableHeader();
  }

  drawHeader();
  drawTitleAndMeta();
  drawTableHeader();

  for (const line of lines) {
    if (y - ROW_HEIGHT < TABLE_BOTTOM_MARGIN) newPage();

    const rowTop = y;
    const img = await tryEmbedImage(pdfDoc, line.imageUrl);
    if (img) {
      const dims = img.scaleToFit(COL_THUMB_SIZE, COL_THUMB_SIZE);
      page.drawImage(img, {
        x: COL_THUMB_X + (COL_THUMB_SIZE - dims.width) / 2,
        y: rowTop - COL_THUMB_SIZE + (COL_THUMB_SIZE - dims.height) / 2,
        width: dims.width,
        height: dims.height,
      });
    } else {
      // Hueco vacío (marco gris) cuando no hay imagen o falla la descarga.
      page.drawRectangle({
        x: COL_THUMB_X,
        y: rowTop - COL_THUMB_SIZE,
        width: COL_THUMB_SIZE,
        height: COL_THUMB_SIZE,
        borderColor: rgb(0.85, 0.85, 0.85),
        borderWidth: 0.5,
      });
    }

    const titleLines = wrapText(line.title, helvBold, 9, COL_TITLE_W);
    let textY = rowTop - 9;
    for (const tl of titleLines.slice(0, 2)) {
      page.drawText(tl, { x: COL_TITLE_X, y: textY, size: 9, font: helvBold, color: black });
      textY -= 11;
    }
    const subParts: string[] = [];
    if (line.variantTitle && line.variantTitle !== "Default Title") subParts.push(line.variantTitle);
    if (line.sku) subParts.push(`SKU: ${line.sku}`);
    if (subParts.length > 0) {
      page.drawText(subParts.join(" · "), { x: COL_TITLE_X, y: textY, size: 7.5, font: helv, color: gray });
    }

    const qtyStr = String(line.quantity);
    page.drawText(qtyStr, { x: COL_UDS_X, y: rowTop - 9, size: 9, font: helv, color: black });

    // unitRounded/lineSubtotalRounded ya vienen calculados en cascada
    // desde computeOfferAmounts() — aquí solo se formatean para imprimir.
    const unitStr = formatEur(line.unitRounded, line.currencyCode);
    page.drawText(unitStr, { x: COL_PRECIO_X, y: rowTop - 9, size: 9, font: helv, color: black });

    const subtotalStr = formatEur(line.lineSubtotalRounded, line.currencyCode);
    page.drawText(subtotalStr, { x: COL_SUBTOTAL_X, y: rowTop - 9, size: 9, font: helvBold, color: black });

    y = rowTop - ROW_HEIGHT;
  }

  y -= 10;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
  y -= 22;

  // Totales — SOLO "Importe estimado". El CBM sigue oculto a propósito
  // (paso 4 del encargo, paridad con b2b-solicitud-detalle.liquid).
  const totalLabel = "Importe estimado";
  const totalValue = formatEur(totalRounded, currencyCode);
  page.drawText(totalLabel, { x: MARGIN, y, size: 12, font: helvBold, color: black });
  const totalValueWidth = helvBold.widthOfTextAtSize(totalValue, 14);
  page.drawText(totalValue, { x: PAGE_WIDTH - MARGIN - totalValueWidth, y: y - 2, size: 14, font: helvBold, color: accent });
  y -= 34;

  if (note) {
    page.drawText("NOTA DEL CLIENTE", { x: MARGIN, y, size: 8, font: helvBold, color: gray });
    y -= 14;
    const noteLines = wrapText(note, helvOblique, 9, PAGE_WIDTH - MARGIN * 2);
    for (const nl of noteLines.slice(0, 6)) {
      page.drawText(nl, { x: MARGIN, y, size: 9, font: helvOblique, color: rgb(0.3, 0.3, 0.3) });
      y -= 12;
    }
    y -= 12;
  }

  // Footer legal en todas las páginas.
  for (const p of pdfDoc.getPages()) {
    p.drawText("LEDS C4, SA · CIF A59410910 · Carretera de Rubí 88, 2ª planta, Sant Cugat del Vallés", {
      x: MARGIN,
      y: 30,
      size: 7,
      font: helv,
      color: gray,
    });
  }

  return await pdfDoc.save();
}

// --- Handler ---------------------------------------------------------------

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const startedAt = new Date().toISOString();

  // 1. Auth: X-Webhook-Secret header — mismo patrón que create-company-for-customer.
  const providedSecret = req.headers.get("x-webhook-secret");
  if (providedSecret !== WEBHOOK_SECRET) {
    return jsonResponse({ startedAt, error: "invalid or missing X-Webhook-Secret header" }, 401);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const draftOrderId = body.draftOrderId as string | undefined;
    if (!draftOrderId || !draftOrderId.startsWith("gid://shopify/DraftOrder/")) {
      return jsonResponse({ startedAt, error: "invalid draftOrderId" }, 400);
    }

    // 2. Fetch del draft.
    const data = await gql<DraftOrderData>(DRAFT_ORDER_QUERY, { id: draftOrderId });
    const draft = data.draftOrder;
    if (!draft) {
      return jsonResponse({ startedAt, error: "draft_order_not_found", draftOrderId }, 404);
    }

    // 3. Passthrough para Flow (cp/locale/utm_*) + total_oferta — calculados
    // ANTES del check de idempotencia para que la respuesta tenga siempre
    // el mismo shape, se regenere o no el PDF en esta invocación (ver
    // comentario de cabecera). Nunca null: "" si el metafield/campo falta.
    const customer = draft.customer;
    const cp = customer?.cp?.value ?? "";
    const locale = customer?.locale ?? "";
    const nombre = customer?.firstName ?? "";
    const apellidos = customer?.lastName ?? "";
    const email = customer?.defaultEmailAddress?.emailAddress ?? "";
    const telefono = customer?.defaultPhoneNumber?.phoneNumber ?? "";
    const nif = customer?.nif?.value ?? "";
    const utmSource = customer?.utmSource?.value ?? "";
    const utmMedium = customer?.utmMedium?.value ?? "";
    const utmCampaign = customer?.utmCampaign?.value ?? "";
    const utmTerm = customer?.utmTerm?.value ?? "";
    const utmContent = customer?.utmContent?.value ?? "";
    const passthrough = {
      cp,
      locale,
      nombre,
      apellidos,
      email,
      telefono,
      nif,
      utm_source: utmSource,
      utm_medium: utmMedium,
      utm_campaign: utmCampaign,
      utm_term: utmTerm,
      utm_content: utmContent,
    };

    // Markup instalador — cosmético, calculado aquí (ver comentario de
    // cabecera). NUNCA se escribe de vuelta en Shopify.
    const isInstalador = customer?.tags.includes("instalador") ?? false;
    const markup = isInstalador ? MARKUP_INSTALADOR : 1;

    // Importe CRUDO por línea (precio distribuidor) — la extracción es
    // barata (solo mapea datos ya traídos por la query, sin red extra), así
    // que se hace SIEMPRE, incluso en el camino idempotente: total_oferta
    // tiene que salir del mismo computeOfferAmounts() que el PDF, se
    // regenere o no el PDF en esta invocación (ver comentario de cabecera
    // "Coherencia aritmética del documento" — PDF y email nunca discrepan).
    const lines: OfferLine[] = draft.lineItems.edges.map((e) => {
      const n = e.node;
      const unitMoney = n.originalUnitPriceSet.presentmentMoney;
      return {
        title: n.title,
        variantTitle: n.variantTitle,
        sku: n.sku,
        quantity: n.quantity,
        unitAmountRaw: Number.parseFloat(unitMoney.amount),
        currencyCode: unitMoney.currencyCode,
        imageUrl: n.image?.url ?? null,
      };
    });
    const currencyCode = lines[0]?.currencyCode ?? "EUR";
    const { lines: computedLines, totalRounded } = computeOfferAmounts(lines, markup);
    const totalOferta = `${totalRounded.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

    // 4. Idempotencia: si ya hay PDF, devolverlo sin regenerar — pero
    // reescribiendo igualmente "última oferta" en el customer, para que un
    // reintento de Flow sobre un draft ya procesado no lo deje desfasado
    // (ref/total corresponden a ESTE draft aunque el PDF ya existiera).
    const existingUrl = draft.pdfUrlMetafield?.value;
    if (existingUrl) {
      logJson("info", "idempotent_hit", { draftOrderId, pdf_url: existingUrl });
      if (customer?.id) {
        await writeOfferMetafields(customerOfferMetafields(customer.id, existingUrl, draft.name, totalOferta));
      }
      return jsonResponse({ startedAt, pdf_url: existingUrl, total_oferta: totalOferta, ...passthrough });
    }

    const status = mapStatus(draft.tags);

    logJson("info", "generating_pdf", { draftOrderId, name: draft.name, isInstalador, lineCount: lines.length });

    // 5. Generar PDF. unitRounded/lineSubtotalRounded/totalRounded ya
    // vienen calculados en cascada por computeOfferAmounts() — el markup
    // no se vuelve a aplicar aquí.
    const pdfBytes = await generateOfferPdf({
      name: draft.name,
      createdAtIso: new Date().toISOString(), // fecha de generación de la oferta, no de creación del draft
      status,
      note: draft.note2,
      totalRounded,
      currencyCode,
      lines: computedLines,
    });

    // 6. Subir a Shopify Files.
    const filenameSafe = draft.name.replace(/[^A-Za-z0-9]/g, "");
    const pdfUrl = await uploadPdfToShopifyFiles(pdfBytes, `oferta-${filenameSafe}.pdf`);

    // 7. Escribir b2b.pdf_url en el draft + "última oferta" en el customer
    // (mismo lote de metafieldsSet — ver comentario de cabecera de la
    // sección 2 sobre por qué el customer también necesita estos datos).
    const metafields: MetafieldEntry[] = [
      { ownerId: draft.id, namespace: "b2b", key: "pdf_url", type: "url", value: pdfUrl },
    ];
    if (customer?.id) {
      metafields.push(...customerOfferMetafields(customer.id, pdfUrl, draft.name, totalOferta));
    } else {
      logJson("warn", "no_customer_for_offer_metafields", { draftOrderId });
    }
    await writeOfferMetafields(metafields);

    logJson("info", "pdf_generated", { draftOrderId, name: draft.name, pdf_url: pdfUrl, total_oferta: totalOferta });

    return jsonResponse({ startedAt, pdf_url: pdfUrl, total_oferta: totalOferta, ...passthrough });
  } catch (e) {
    logJson("error", "unhandled_error", { error: (e as Error).message });
    return jsonResponse({ startedAt, error: (e as Error).message }, 500);
  }
}

// Guard env-sentinel: en tests se setea GENERATE_OFFER_PDF_TEST_MODE antes
// del import para que importar el módulo NO levante el server (evita
// colisión de puerto al cargar varios módulos en la misma tanda de
// `deno test`). En el runtime de Supabase Edge la sentinel no está → sirve
// normalmente.
if (!Deno.env.get("GENERATE_OFFER_PDF_TEST_MODE")) {
  Deno.serve(handle);
}

export { computeOfferAmounts, handle };
