// Supabase Edge Function: promote-whitelist-matches
//
// Cada 30 min pg_cron invoca esta función. Promueve customers con tag
// 'pendiente' cuyo email esté en shop.metafields.b2b.whitelist_emails
// a tag 'aprobado'. Eso dispara W2 en Shopify Flow (fecha_aprobacion +
// emails al cliente y al backoffice).
//
// No crea Company — Opción A de Fase B: creación manual por backoffice.
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

type PendingCustomer = { id: string; email: string };

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

async function listPendingCustomers(): Promise<PendingCustomer[]> {
  const out: PendingCustomer[] = [];
  let cursor: string | null = null;
  do {
    const data = await gql<{
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        edges: Array<
          {
            node: {
              id: string;
              defaultEmailAddress: { emailAddress: string } | null;
            };
          }
        >;
      };
    }>(
      `
      query($cursor: String) {
        customers(first: 100, after: $cursor, query: "tag:'pendiente'") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              defaultEmailAddress { emailAddress }
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
        out.push({ id: node.id, email: email.trim().toLowerCase() });
      }
    }
    cursor = data.customers.pageInfo.hasNextPage
      ? data.customers.pageInfo.endCursor
      : null;
  } while (cursor);
  return out;
}

async function addApprovedTag(customerId: string): Promise<void> {
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
    { id: customerId, tags: ["aprobado"] },
  );
  const errs = data.tagsAdd?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`tagsAdd errors: ${JSON.stringify(errs)}`);
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
    if (whitelist.length === 0) {
      return jsonResponse({
        startedAt,
        promoted: 0,
        reason: "empty_whitelist",
      });
    }

    const pending = await listPendingCustomers();
    const toPromote = pending.filter((c) => whitelist.includes(c.email));

    let promoted = 0;
    const errors: string[] = [];
    for (const customer of toPromote) {
      try {
        await addApprovedTag(customer.id);
        promoted++;
      } catch (e) {
        errors.push(`${customer.email}: ${(e as Error).message}`);
      }
    }

    return jsonResponse({
      startedAt,
      promoted,
      totalPending: pending.length,
      whitelistSize: whitelist.length,
      promotedEmails: toPromote.map((c) => c.email),
      errors,
    });
  } catch (e) {
    return jsonResponse(
      { startedAt, error: (e as Error).message },
      500,
    );
  }
});
