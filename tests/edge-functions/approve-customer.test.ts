// Regresión sobre el builder puro de la semántica de aprobación
// (C.6 T5). El handler completo (Deno.serve(...)) requiere mocking del
// cliente Shopify Admin que todavía no existe; cuando se monte la
// infra, ampliar a tests end-to-end (TODO al final).
//
// Run: deno test tests/edge-functions/approve-customer.test.ts --allow-env

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Set required env vars BEFORE the dynamic import — el módulo
// approve-customer/index.ts hace Deno.env.get(...) a top-level y
// throws si faltan SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN /
// BACKOFFICE_HMAC_SECRET. Para tests del builder puro no nos importan
// los valores reales.
// Sentinel: evita que importar el módulo levante Deno.serve (colisión de
// puerto 8000 al cargar varios módulos en la misma tanda de `deno test`).
Deno.env.set("APPROVE_CUSTOMER_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("BACKOFFICE_HMAC_SECRET", "test_secret");

const { buildApprovalSemanticsInput } = await import(
  "../../supabase/functions/approve-customer/index.ts"
);

const CUSTOMER = "gid://shopify/Customer/123456789";
const DATE = "2026-05-09";

// --- Caso 1: shape correcto -----------------------------------------

Deno.test("buildApprovalSemanticsInput: shape correcto (set fecha_aprobacion, delete fecha_rechazo + motivo_rechazo)", () => {
  const input = buildApprovalSemanticsInput(CUSTOMER, DATE);

  assertEquals(input.sets.length, 1);
  assertEquals(input.sets[0], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "fecha_aprobacion",
    type: "date",
    value: DATE,
  });

  assertEquals(input.deletes.length, 2);
  assertEquals(input.deletes[0], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "fecha_rechazo",
  });
  assertEquals(input.deletes[1], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "motivo_rechazo",
  });
});

// --- Caso 2: idempotencia -------------------------------------------

Deno.test("buildApprovalSemanticsInput: idempotente (mismas entradas → mismas salidas)", () => {
  const a = buildApprovalSemanticsInput(CUSTOMER, DATE);
  const b = buildApprovalSemanticsInput(CUSTOMER, DATE);
  assertEquals(a, b);
});

// --- Caso 3: formato fecha -----------------------------------------

Deno.test("buildApprovalSemanticsInput: value de fecha_aprobacion es YYYY-MM-DD (10 chars)", () => {
  const input = buildApprovalSemanticsInput(CUSTOMER, DATE);
  const value = input.sets[0].value;
  assertEquals(value.length, 10);
  assertEquals(/^\d{4}-\d{2}-\d{2}$/.test(value), true);
});

// --- TODOs follow-up ------------------------------------------------
//
// Cuando se monte mocking del cliente Shopify Admin:
// - Test e2e: aprobar customer pendiente → verificar que fecha_aprobacion
//   queda set y fecha_rechazo + motivo_rechazo no existen.
// - Test e2e: aprobar customer que tenía rechazo previo → verificar
//   que los metafields del rechazo previo se borran.
// - Test e2e: dryRun devuelve `semantics: "skipped"` y no toca nada.
