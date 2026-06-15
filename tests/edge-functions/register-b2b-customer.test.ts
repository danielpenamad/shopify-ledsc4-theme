// Regresión sobre las funciones puras de register-b2b-customer.
//
// Causa raíz histórica: el path /account/register clásico (eliminado
// en C.6 T6) no sanitizaba el value del select de país, dejando tabs
// en `b2b.pais` de algunos customers (`\tES`, `\t\tES`). El path
// vigente (acceso-profesional + edge function register-b2b-customer)
// sí sanitiza vía `sanitizeText` (strippea control chars + trim) y
// `normalizeCountry` (uppercase + alias map → ISO 3166-1 alpha-2).
//
// Estos tests pinean ese contrato. El handler completo
// (Deno.serve(...)) requiere mocking del cliente Shopify Admin que
// todavía no existe; cuando se monte la infra de mocking, ampliar a
// tests end-to-end (TODO al final).
//
// Run: deno test tests/edge-functions/ --allow-env --allow-net=false

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars BEFORE the dynamic import — el módulo
// register-b2b-customer/index.ts hace Deno.env.get(...) a top-level y
// throws si faltan SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN /
// REGISTER_B2B_HMAC_SECRET. Para tests de funciones puras no nos
// importan los valores reales; basta con que existan.
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("REGISTER_B2B_HMAC_SECRET", "test_secret");
// Modo DUAL (rotación sin downtime): secret saliente que también debe aceptarse.
Deno.env.set("REGISTER_B2B_HMAC_SECRET_PREV", "test_secret_prev");

const { sanitizeText, normalizeCountry, hmacSha256Hex, verifyHmacSignature } = await import(
  "../../supabase/functions/register-b2b-customer/index.ts"
);

// --- sanitizeText -----------------------------------------------------

Deno.test("sanitizeText: strippea TAB inicial (causa raíz tabs en b2b.pais)", () => {
  assertEquals(sanitizeText("\tES", 60), "ES");
});

Deno.test("sanitizeText: strippea múltiples control chars + trim", () => {
  assertEquals(sanitizeText("\t\tES\n  ", 60), "ES");
});

Deno.test("sanitizeText: idempotente con input ya limpio", () => {
  assertEquals(sanitizeText("ES", 60), "ES");
});

// --- normalizeCountry -------------------------------------------------

Deno.test("normalizeCountry: trim antes de validar ISO (defensivo)", () => {
  assertEquals(normalizeCountry("\tES"), "ES");
});

Deno.test("normalizeCountry: uppercase ISO 2-letter", () => {
  assertEquals(normalizeCountry("es"), "ES");
});

Deno.test("normalizeCountry: alias 'España' → 'ES' vía map", () => {
  // Contrato actual (pinneado): el mapa de aliases incluye ESPAÑA → ES.
  // Si en el futuro se restringe a sólo ISO 2-letter, este test debe
  // actualizarse a `null`.
  assertEquals(normalizeCountry("España"), "ES");
});

Deno.test("normalizeCountry: ISO 2-letter no-ES pasa sin alias", () => {
  assertEquals(normalizeCountry("US"), "US");
});

// --- verifyHmacSignature (rotación DUAL) ------------------------------

Deno.test("verifyHmac: acepta firma del secret VIGENTE", async () => {
  const payload = "1700000000:nonce-abcdefgh";
  const sig = await hmacSha256Hex(payload, "test_secret");
  assertEquals(await verifyHmacSignature(payload, sig), true);
});

Deno.test("verifyHmac: acepta firma del secret SALIENTE (dual)", async () => {
  const payload = "1700000000:nonce-abcdefgh";
  const sig = await hmacSha256Hex(payload, "test_secret_prev");
  assertEquals(await verifyHmacSignature(payload, sig), true);
});

Deno.test("verifyHmac: rechaza firma de un secret desconocido", async () => {
  const payload = "1700000000:nonce-abcdefgh";
  const sig = await hmacSha256Hex(payload, "secret_que_no_existe");
  assertEquals(await verifyHmacSignature(payload, sig), false);
});

// --- TODOs follow-up --------------------------------------------------
//
// Cuando se monte mocking del cliente Shopify Admin:
// - Test e2e del handler: enviar `{ pais: "\tES", ... }` con HMAC
//   válido y verificar que el metafield resultante en el customer
//   creado es exactamente "ES" (sin tabs).
// - Test e2e: NIF inválido devuelve 400 VALIDATION_ERROR.
// - Test e2e: HMAC expirado devuelve 401 SIGNATURE_EXPIRED.
// - Test e2e: email duplicado devuelve 409 EMAIL_ALREADY_EXISTS.
