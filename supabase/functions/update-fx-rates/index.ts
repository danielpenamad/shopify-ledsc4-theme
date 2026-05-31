// Supabase Edge Function: update-fx-rates
//
// Refresca el shop metafield `ledsc4.fx_rates` (type json) con las tasas
// EUR→USD y EUR→GBP de Frankfurter (BCE, sin API key). El theme lee ese
// metafield desde Liquid para mostrar precios convertidos cosméticamente
// — EUR sigue siendo la única divisa real (carrito/draft/factura).
//
// La función es idempotente y autoseed: en su primera ejecución crea la
// metafield definition (namespace=ledsc4, key=fx_rates, type=json,
// access.storefront=PUBLIC_READ) si no existe, luego escribe el valor.
//
// Disparadores:
//   - pg_cron semanal (lunes 06:00 UTC).
//   - Invocación manual (POST sin body) para forzar refresh.
//
// Secrets requeridos (Supabase Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN   ledsc4-b2b-outlet.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    shpat_xxx   (scopes: write_metafields)
//   SHOPIFY_API_VERSION    2025-10  (opcional)
//
// Despliegue: MCP Supabase (deploy_edge_function). NO se despliega con push
// a main — ver [memory] project_edge_fn_deploy.

const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
const SHOPIFY_ADMIN_TOKEN = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
const SHOPIFY_API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-10";

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN env vars");
}

const NAMESPACE = "ledsc4";
const KEY = "fx_rates";
const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=EUR&to=USD,GBP";

const endpoint =
  `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

type FrankfurterResponse = {
  amount: number;
  base: string;
  date: string;
  rates: { USD: number; GBP: number };
};

type FxRates = {
  base: "EUR";
  USD: number;
  GBP: number;
  rate_date: string;     // fecha BCE (YYYY-MM-DD) del feed
  updated_at: string;    // timestamp de escritura en Shopify (ISO)
  source: "frankfurter";
};

function logJson(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, event, ...data }));
}

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

async function fetchFxRates(): Promise<FrankfurterResponse> {
  const res = await fetch(FRANKFURTER_URL);
  if (!res.ok) {
    throw new Error(`Frankfurter HTTP ${res.status}`);
  }
  const json = await res.json() as FrankfurterResponse;
  if (
    !json?.rates ||
    typeof json.rates.USD !== "number" ||
    typeof json.rates.GBP !== "number"
  ) {
    throw new Error(`Frankfurter payload inválido: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getShopGid(): Promise<string> {
  const data = await gql<{ shop: { id: string } }>(`query { shop { id } }`);
  return data.shop.id;
}

// Crea la metafield definition si no existe. TAKEN se considera éxito
// (la definition ya estaba creada — por ejemplo manualmente en Admin
// si el token no tenía permiso de write_metaobject_definitions).
async function ensureDefinition(): Promise<{ created: boolean; takenOrExisting: boolean }> {
  const query = `
    mutation FxDefCreate($definition: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $definition) {
        createdDefinition { id }
        userErrors { field message code }
      }
    }
  `;
  const variables = {
    definition: {
      name: "FX rates (display only)",
      namespace: NAMESPACE,
      key: KEY,
      description:
        "Tasas EUR→USD/GBP usadas por el theme para mostrar precios convertidos cosméticamente. EUR sigue siendo la divisa real del carrito y la facturación.",
      type: "json",
      ownerType: "SHOP",
      access: { storefront: "PUBLIC_READ" },
    },
  };
  const data = await gql<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null;
      userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    };
  }>(query, variables);

  const errs = data.metafieldDefinitionCreate.userErrors;
  if (data.metafieldDefinitionCreate.createdDefinition) {
    return { created: true, takenOrExisting: false };
  }
  // TAKEN = ya existe → OK.
  if (errs.some((e) => e.code === "TAKEN")) {
    return { created: false, takenOrExisting: true };
  }
  throw new Error(`metafieldDefinitionCreate userErrors: ${JSON.stringify(errs)}`);
}

async function writeMetafield(shopGid: string, payload: FxRates): Promise<void> {
  const query = `
    mutation FxSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message code }
      }
    }
  `;
  const variables = {
    metafields: [{
      ownerId: shopGid,
      namespace: NAMESPACE,
      key: KEY,
      type: "json",
      value: JSON.stringify(payload),
    }],
  };
  const data = await gql<{
    metafieldsSet: {
      metafields: Array<{ id: string }>;
      userErrors: Array<{ field: string[] | null; message: string; code: string }>;
    };
  }>(query, variables);
  const errs = data.metafieldsSet.userErrors;
  if (errs.length > 0) {
    throw new Error(`metafieldsSet userErrors: ${JSON.stringify(errs)}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    logJson("info", "fx_rates_refresh_start");

    const def = await ensureDefinition();
    logJson("info", "definition_ensured", def);

    const fx = await fetchFxRates();
    logJson("info", "frankfurter_fetched", { rate_date: fx.date, rates: fx.rates });

    const shopGid = await getShopGid();

    const payload: FxRates = {
      base: "EUR",
      USD: fx.rates.USD,
      GBP: fx.rates.GBP,
      rate_date: fx.date,
      updated_at: new Date().toISOString(),
      source: "frankfurter",
    };

    await writeMetafield(shopGid, payload);
    logJson("info", "fx_rates_metafield_written", payload);

    return new Response(
      JSON.stringify({ ok: true, applied: payload }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logJson("error", "fx_rates_refresh_failed", { message });
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
