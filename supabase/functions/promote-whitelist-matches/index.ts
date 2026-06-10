// Supabase Edge Function: promote-whitelist-matches
//
// Cada 30 min pg_cron invoca esta función. Promueve customers cuyo email
// esté en shop.metafields.b2b.whitelist_emails y NO estén ya aprobados
// ni rechazados a tag 'aprobado'. Eso dispara W2 en Shopify Flow
// (fecha_aprobacion + emails al cliente + create-company).
//
// Backstop del caso "alta no-`pendiente`" (jefe da de alta a un cliente
// whitelisted manualmente o por import): W1 no se dispara porque solo
// reacciona al evento customer_created del form; este cron lo recoge
// igual y fuerza la transición pendiente→aprobado que W2 necesita
// (condición: aprobado IN tags AND pendiente IN tags_previous).
//
// Por cada customer a promover:
//   1. customerEmailMarketingConsentUpdate SUBSCRIBED + SINGLE_OPT_IN
//      (idempotente; los emails de Flow van por marketing activity y
//      se descartan en silencio si no está SUBSCRIBED).
//   2. Si no tiene tag 'pendiente', tagsAdd(['pendiente']) — Shopify
//      Flow lee tags_previous antes del último customer_updated, así
//      que el flip de dos pasos garantiza que pendiente esté en
//      tags_previous cuando W2 evalúa.
//   3. customerUpdate(tags = sin estados + 'aprobado') — flip atómico.
//      El primer customer_updated (post-tagsAdd) no satisface
//      'aprobado IN tags' → no dispara. El segundo sí, con
//      pendiente IN tags_previous → W2 dispara una sola vez.
//
// Idempotente: si ya tiene 'aprobado', salta el customer entero.
//
// empresa-less: si el customer no tiene b2b.empresa (alta manual o
// registro sin completar metafields), saltamos la promoción. Si no,
// W2 intentaría create-company y fallaría con 400, dejando al cliente
// aprobado sin Company. Se loguea el email saltado y se reintentará
// en la siguiente pasada cuando complete el formulario.
//
// Secrets requeridos (Supabase Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN   ledsc4-b2b-outlet.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    shpat_xxx
//   SHOPIFY_API_VERSION    2025-10  (opcional, default)

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}

const endpoint =
  `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

const STATE_TAGS = new Set(["pendiente", "aprobado", "rechazado"]);

type Candidate = {
  id: string;
  email: string;
  tags: string[];
  hasEmpresa: boolean;
};

async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
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
    throw new Error(`Shopify HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

async function readWhitelist(): Promise<string[]> {
  const data = await gql<{ shop: { metafield: { value: string } | null } }>(`
    query {
      shop {
        metafield(namespace: "b2b", key: "whitelist_emails") { value }
      }
    }
  `);
  const raw = data.shop.metafield?.value ?? null;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown[];
    return parsed
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let cursor: string | null = null;
  do {
    const data = await gql<{
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<{
          node: {
            id: string;
            tags: string[];
            defaultEmailAddress: { emailAddress: string } | null;
            empresa: { value: string } | null;
          };
        }>;
      };
    }>(
      `
      query($cursor: String) {
        customers(first: 100, after: $cursor, query: "-tag:aprobado AND -tag:rechazado") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              tags
              defaultEmailAddress { emailAddress }
              empresa: metafield(namespace: "b2b", key: "empresa") { value }
            }
          }
        }
      }
      `,
      { cursor },
    );
    for (const { node } of data.customers.edges) {
      const email = node.defaultEmailAddress?.emailAddress;
      if (email) {
        out.push({
          id: node.id,
          email: email.trim().toLowerCase(),
          tags: node.tags ?? [],
          hasEmpresa: !!(node.empresa?.value && node.empresa.value.trim().length > 0),
        });
      }
    }
    cursor = data.customers.pageInfo.hasNextPage
      ? data.customers.pageInfo.endCursor
      : null;
  } while (cursor);
  return out;
}

async function setMarketingConsent(customerId: string): Promise<void> {
  // Idempotente: si ya está SUBSCRIBED, Shopify no falla.
  const data = await gql<{
    customerEmailMarketingConsentUpdate: {
      userErrors: Array<{ message: string }>;
    };
  }>(
    `
    mutation($input: CustomerEmailMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $input) {
        userErrors { message }
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
  const errs = data.customerEmailMarketingConsentUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`marketingConsent errors: ${JSON.stringify(errs)}`);
  }
}

async function addPendienteTag(customerId: string): Promise<void> {
  const data = await gql<{
    tagsAdd: { userErrors: Array<{ message: string }> };
  }>(
    `
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }
    `,
    { id: customerId, tags: ["pendiente"] },
  );
  const errs = data.tagsAdd?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`tagsAdd pendiente errors: ${JSON.stringify(errs)}`);
  }
}

async function flipToAprobado(
  customerId: string,
  knownTags: string[],
): Promise<void> {
  // Construye tags finales: quita los 3 de estado, asegura 'aprobado'.
  // Para customers que NO tenían 'pendiente', el caller ya ejecutó
  // addPendienteTag antes — pasamos [...knownTags, 'pendiente'] y el
  // filter STATE_TAGS lo elimina junto con cualquier 'aprobado'/'rechazado'
  // residual. Resultado: 1) en la pasada anterior (post-addPendienteTag)
  // el customer tenía 'pendiente'; 2) esta mutation produce el evento
  // customer_updated con tags={..., 'aprobado'} y tags_previous={..., 'pendiente'}.
  // W2 (aprobado IN tags AND pendiente IN tags_previous) dispara una vez.
  const finalTags = Array.from(
    new Set(knownTags.filter((t) => !STATE_TAGS.has(t))),
  );
  finalTags.push("aprobado");
  const data = await gql<{
    customerUpdate: { userErrors: Array<{ message: string }> };
  }>(
    `
    mutation($input: CustomerInput!) {
      customerUpdate(input: $input) {
        userErrors { message }
      }
    }
    `,
    { input: { id: customerId, tags: finalTags } },
  );
  const errs = data.customerUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`customerUpdate flip errors: ${JSON.stringify(errs)}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (_req) => {
  const startedAt = new Date().toISOString();
  try {
    const whitelist = await readWhitelist();
    const candidates = await listCandidates();
    const toPromote = whitelist.length === 0 ? [] : candidates.filter(
      (c) => whitelist.includes(c.email) && !c.tags.includes("aprobado"),
    );

    let promoted = 0;
    const errors: string[] = [];
    const skippedNoEmpresa: string[] = [];
    for (const customer of toPromote) {
      if (!customer.hasEmpresa) {
        console.log(`skip (no b2b.empresa): ${customer.email}`);
        skippedNoEmpresa.push(customer.email);
        continue;
      }
      try {
        await setMarketingConsent(customer.id);
        if (!customer.tags.includes("pendiente")) {
          await addPendienteTag(customer.id);
        }
        await flipToAprobado(customer.id, [...customer.tags, "pendiente"]);
        promoted++;
      } catch (e) {
        errors.push(`${customer.email}: ${(e as Error).message}`);
      }
    }

    // --- Reconciliación de huérfanos (2026-06-10) ---
    //
    // Huérfano: customer SIN ningún tag de estado (ni pendiente ni
    // aprobado ni rechazado) pero CON b2b.empresa — rellenó el formulario
    // B2B pero el tagsAdd de register-/complete-b2b-registration falló
    // (era best-effort; ahora reintenta 3×, esto es el failsafe final).
    // Sin tag, Flow W1 no disparó y el backoffice no lo ve. Le ponemos
    // 'pendiente' para reintroducirlo en el circuito normal de revisión.
    //
    // Los huérfanos SIN b2b.empresa se dejan estar a propósito: son altas
    // nativas (OAuth/newsletter) que no han pasado por el form; el gate
    // del tema ya los empuja a /pages/completar-registro, que al completar
    // setea empresa + pendiente. Taguearlos aquí los colaría en la cola de
    // revisión sin datos.
    //
    // Los whitelisted ya promovidos arriba quedan con 'aprobado' en
    // `promoted` y no entran en este filtro (se evalúa sobre el snapshot
    // de tags pre-promoción, por eso excluimos los emails ya promovidos).
    const promotedEmails = new Set(
      toPromote.filter((c) => c.hasEmpresa).map((c) => c.email),
    );
    const orphans = candidates.filter(
      (c) =>
        c.hasEmpresa &&
        !promotedEmails.has(c.email) &&
        !c.tags.some((t) => STATE_TAGS.has(t)),
    );
    let reconciled = 0;
    const reconciledEmails: string[] = [];
    for (const orphan of orphans) {
      try {
        await addPendienteTag(orphan.id);
        reconciled++;
        reconciledEmails.push(orphan.email);
        console.log(`reconciled (tag pendiente añadido): ${orphan.email}`);
      } catch (e) {
        errors.push(`reconcile ${orphan.email}: ${(e as Error).message}`);
      }
    }

    return jsonResponse({
      startedAt,
      promoted,
      reconciled,
      totalCandidates: candidates.length,
      whitelistSize: whitelist.length,
      promotedEmails: toPromote
        .filter((c) => c.hasEmpresa)
        .map((c) => c.email),
      reconciledEmails,
      skippedNoEmpresa,
      errors,
    });
  } catch (e) {
    return jsonResponse(
      { startedAt, error: (e as Error).message },
      500,
    );
  }
});
