// Regresión sobre el builder puro de la semántica de rechazo
// (C.6 T5). El handler completo requiere mocking de Shopify Admin
// (TODO al final).
//
// Run: deno test tests/edge-functions/reject-customer.test.ts --allow-env

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Sentinel: evita que importar el módulo levante Deno.serve (colisión de
// puerto 8000 al cargar varios módulos en la misma tanda de `deno test`).
Deno.env.set("REJECT_CUSTOMER_TEST_MODE", "1");
Deno.env.set("SHOPIFY_STORE_DOMAIN", "test.myshopify.com");
Deno.env.set("SHOPIFY_ADMIN_TOKEN", "shpat_test");
Deno.env.set("BACKOFFICE_HMAC_SECRET", "test_secret");

const { buildRejectionSemanticsInput } = await import(
  "../../supabase/functions/reject-customer/index.ts"
);

const CUSTOMER = "gid://shopify/Customer/987654321";
const DATE = "2026-05-09";

// --- Caso 1: shape con motivo no vacío ------------------------------

Deno.test("buildRejectionSemanticsInput: shape con motivo (set fecha_rechazo + motivo_rechazo, delete fecha_aprobacion)", () => {
  const input = buildRejectionSemanticsInput(CUSTOMER, DATE, "Sector no relevante");

  assertEquals(input.sets.length, 2);
  assertEquals(input.sets[0], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "fecha_rechazo",
    type: "date",
    value: DATE,
  });
  assertEquals(input.sets[1], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "motivo_rechazo",
    type: "single_line_text_field",
    value: "Sector no relevante",
  });

  assertEquals(input.deletes.length, 1);
  assertEquals(input.deletes[0], {
    ownerId: CUSTOMER,
    namespace: "b2b",
    key: "fecha_aprobacion",
  });
});

// --- Caso 2: motivo vacío -> sólo set fecha_rechazo -----------------
//
// Contrato pinneado: si el motivo es string vacío, no se incluye en
// sets (motivo_rechazo no se setea). El delete de fecha_aprobacion sí.
// Esto coincide con el comportamiento del handler que ya hacía esto
// pre-T5 vía MOTIVO_MAX/trim/empty-check.

Deno.test("buildRejectionSemanticsInput: motivo vacío omite motivo_rechazo del set, mantiene fecha_rechazo + delete fecha_aprobacion", () => {
  const input = buildRejectionSemanticsInput(CUSTOMER, DATE, "");

  assertEquals(input.sets.length, 1);
  assertEquals(input.sets[0].key, "fecha_rechazo");

  assertEquals(input.deletes.length, 1);
  assertEquals(input.deletes[0].key, "fecha_aprobacion");
});

// --- Caso 3: motivo con caracteres especiales ------------------------
//
// El builder NO sanitiza — la sanitización es responsabilidad del
// caller (handler ya hace trim + slice MOTIVO_MAX). Aquí pasa el
// motivo literal tal cual, incluyendo emojis, comillas, saltos.

Deno.test("buildRejectionSemanticsInput: motivo con caracteres especiales pasa literal", () => {
  const motivoEspecial = "Datos incompletos: \"empresa\" vacía → revisar 🚫";
  const input = buildRejectionSemanticsInput(CUSTOMER, DATE, motivoEspecial);

  const motivoSet = input.sets.find((s) => s.key === "motivo_rechazo");
  assertEquals(motivoSet?.value, motivoEspecial);
});

// --- TODOs follow-up ------------------------------------------------
//
// Cuando se monte mocking del cliente Shopify Admin:
// - Test e2e: rechazar customer pendiente con motivo → verificar que
//   fecha_rechazo + motivo_rechazo quedan set y fecha_aprobacion no
//   existe.
// - Test e2e: rechazar customer que tenía aprobación previa → verificar
//   que fecha_aprobacion previa se borra.
// - Test e2e: rechazar sin motivo → verificar que motivo_rechazo no
//   queda residual de un rechazo previo (current behavior: no se
//   borra explícitamente — pinear si decidimos cambiar).
