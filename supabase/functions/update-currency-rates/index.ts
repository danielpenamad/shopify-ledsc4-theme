// Supabase Edge Function: update-currency-rates (Currency-A)
//
// Refresca diariamente los manualRate de los Markets UK (GBP) y USA (USD)
// de LedsC4 contra Open Exchange Rates. Invocada por pg_cron
// `leds_currency_rates_daily` a las 06:00 UTC (cron schedule en migration).
//
// Open Exchange Rates plan free: la base es USD obligatoria y `?base=EUR`
// devuelve 401. El cron asume plan free y recalcula a EUR-base:
//   - usdPerEur = 1 / rates.EUR
//   - gbpPerEur = rates.GBP / rates.EUR
// Si en el futuro se contrata plan paid, se puede simplificar a
// `?base=EUR&symbols=USD,GBP` y usar `rates.USD` / `rates.GBP` directos.
//
// Flow por invocación:
//   1. GET https://openexchangerates.org/api/latest.json?app_id=X&symbols=EUR,USD,GBP
//   2. Validar rates.EUR existe y > 0; recalcular EUR-base.
//   3. Listar markets, mapear por handle ('uk', 'usa').
//   4. marketUpdate cada Market con currencySettings.baseCurrencyManualRate
//      = rate EUR-base (precisión completa — Shopify redondea a 2 decimales
//      en el render del precio storefront).
//   5. INSERT en private.currency_rate_log con timestamp, usd_rate, gbp_rate,
//      status_usa, status_uk, error_text.
//
// Política de errores:
//   - OXR falla → no se toca Shopify. Se inserta una fila de log con ambos
//     status = 'oxr_error' y error_text con el detalle. HTTP 500.
//   - Shopify falla en un Market → se sigue con el otro. Log parcial con
//     status_usa/status_uk diferentes ('ok' vs 'shopify_error'). HTTP 207.
//   - DB insert log falla → se devuelve HTTP 500 con el detalle, pero los
//     cambios ya aplicados en Shopify NO se revierten (no es transaccional).
//
// DB access: private.currency_rate_log no está expuesta en PostgREST
// (schema 'private'). Conectamos directamente a Postgres vía npm:postgres
// (mismo patrón que sftp-sync — SUPABASE_DB_URL auto-inyectado).
//
// Auth: verify_jwt = true. La cron pasa with_auth=true en
// private.invoke_edge_function para inyectar Authorization: Bearer <anon_key>.
//
// Secrets requeridos (Supabase Project Settings → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN          ledsc4-b2b-outlet.myshopify.com
//   SHOPIFY_ADMIN_TOKEN           shpat_xxx
//   SHOPIFY_API_VERSION           2025-10  (opcional, default 2025-10)
//   OPEN_EXCHANGE_RATES_APP_ID    xxxxxxxx

// @ts-nocheck — Deno + npm: compat sin tipos TS completos.
import postgres from 'npm:postgres@3.4.4';

const SHOPIFY_STORE_DOMAIN = Deno.env.get('SHOPIFY_STORE_DOMAIN');
const SHOPIFY_ADMIN_TOKEN = Deno.env.get('SHOPIFY_ADMIN_TOKEN');
const SHOPIFY_API_VERSION = Deno.env.get('SHOPIFY_API_VERSION') ?? '2025-10';
const OXR_APP_ID = Deno.env.get('OPEN_EXCHANGE_RATES_APP_ID');
const SUPABASE_DB_URL = Deno.env.get('SUPABASE_DB_URL');

if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
  throw new Error('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN');
}
if (!OXR_APP_ID) throw new Error('Missing OPEN_EXCHANGE_RATES_APP_ID');
if (!SUPABASE_DB_URL) throw new Error('Missing SUPABASE_DB_URL');

const SHOPIFY_ENDPOINT =
  `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

// Spec LedsC4 Fase 1 multi-currency (mismo set que activate-market-currencies.mjs).
const TARGETS = [
  { handle: 'uk', currencyCode: 'GBP', oxrSymbol: 'GBP', logColumn: 'status_uk', rateColumn: 'gbp_rate' },
  { handle: 'usa', currencyCode: 'USD', oxrSymbol: 'USD', logColumn: 'status_usa', rateColumn: 'usd_rate' },
] as const;

type OxrResponse = { base?: string; rates: Record<string, number> };

// OXR plan free → base USD implícita. Pedimos symbols=EUR,USD,GBP y
// recalculamos EUR-base. Sin redondeo: Number preserva ~15 dígitos
// significativos (suficiente para precisión real del rate). Shopify
// redondea a 2 decimales en el render del precio storefront.
async function fetchRates(): Promise<{
  raw: Record<string, number>;
  eurBase: Record<string, number>;
}> {
  // Pedimos también EUR aunque la base sea USD: lo necesitamos como
  // divisor para convertir a EUR-base.
  const symbols = 'EUR,USD,GBP';
  const url =
    `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(OXR_APP_ID!)}&symbols=${symbols}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OXR HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as OxrResponse;
  if (!json?.rates) {
    throw new Error(`OXR response missing rates: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const eurUsd = json.rates.EUR; // EUR per 1 USD
  const gbpUsd = json.rates.GBP; // GBP per 1 USD
  if (typeof eurUsd !== 'number' || !(eurUsd > 0)) {
    throw new Error(
      `OXR rates.EUR invalid (${eurUsd}); cannot derive EUR-base rates`,
    );
  }
  if (typeof gbpUsd !== 'number' || !(gbpUsd > 0)) {
    throw new Error(
      `OXR rates.GBP invalid (${gbpUsd}); cannot derive EUR-base GBP rate`,
    );
  }
  const eurBase = {
    USD: 1 / eurUsd, // USD per 1 EUR
    GBP: gbpUsd / eurUsd, // GBP per 1 EUR
  };
  return { raw: json.rates, eurBase };
}

async function shopifyGql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(SHOPIFY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN!,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

async function listMarketsByHandle(): Promise<Map<string, { id: string; name: string }>> {
  const data = await shopifyGql<{
    markets: {
      nodes: Array<{ id: string; handle: string; name: string }>;
    };
  }>(`
    query Markets {
      markets(first: 50) {
        nodes { id handle name }
      }
    }
  `);
  return new Map(
    data.markets.nodes.map((m) => [m.handle, { id: m.id, name: m.name }]),
  );
}

async function updateMarketRate(
  marketId: string,
  currencyCode: string,
  manualRate: number,
): Promise<void> {
  const data = await shopifyGql<{
    marketUpdate: { userErrors: Array<{ field: string[] | null; message: string }> };
  }>(
    `
    mutation UpdateMarketCurrency($id: ID!, $input: MarketUpdateInput!) {
      marketUpdate(id: $id, input: $input) {
        userErrors { field message }
      }
    }
    `,
    {
      id: marketId,
      input: {
        currencySettings: {
          localCurrencies: true,
          baseCurrency: currencyCode,
          // Decimal scalar: pasamos string para evitar pérdida de precisión
          // si JS notation rounds (e.g. 1.0816999999...). Shopify almacena
          // precisión completa; el redondeo a 2 decimales sólo ocurre en el
          // render del precio storefront, no aquí.
          baseCurrencyManualRate: String(manualRate),
        },
      },
    },
  );
  const errs = data.marketUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`marketUpdate userErrors: ${JSON.stringify(errs)}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (_req) => {
  const startedAt = new Date().toISOString();
  const sql = postgres(SUPABASE_DB_URL!, { prepare: false, max: 1 });

  // Log row construido incrementalmente; se inserta una sola vez al final.
  const logRow: {
    usd_rate: number | null;
    gbp_rate: number | null;
    status_usa: string;
    status_uk: string;
    error_text: string | null;
  } = {
    usd_rate: null,
    gbp_rate: null,
    status_usa: 'pending',
    status_uk: 'pending',
    error_text: null,
  };

  // 1) OXR (plan free, base USD) + recálculo EUR-base.
  let rates: Record<string, number>;
  try {
    const fetched = await fetchRates();
    rates = fetched.eurBase;
    logRow.usd_rate = rates.USD;
    logRow.gbp_rate = rates.GBP;
    // Trazabilidad: rates crudos (USD-base devueltos por OXR) + rates
    // derivados (EUR-base aplicados a Shopify). Visibles en
    // `supabase functions logs update-currency-rates`.
    console.log(
      'OXR rates USD-base (raw):',
      JSON.stringify(fetched.raw),
      '| EUR-base (computed):',
      JSON.stringify(fetched.eurBase),
    );
  } catch (e) {
    const msg = (e as Error).message;
    // Distingue error de validación (rates.EUR null/0/missing) del
    // error de transporte (HTTP/JSON). En currency_rate_log queda como
    // oxr_error en ambos casos; el error_text distingue el motivo.
    const isValidation =
      /rates\.EUR invalid|rates\.GBP invalid|missing rates/.test(msg);
    logRow.status_usa = 'oxr_error';
    logRow.status_uk = 'oxr_error';
    logRow.error_text = isValidation
      ? `OXR validation failed (no Shopify writes): ${msg}`
      : `OXR: ${msg}`;
    console.error('OXR fetch failed; Shopify NOT touched:', msg);
    await persistLog(sql, logRow).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    return jsonResponse({ startedAt, ...logRow }, 500);
  }

  // 2) Resolver Markets por handle.
  let marketsByHandle: Map<string, { id: string; name: string }>;
  try {
    marketsByHandle = await listMarketsByHandle();
  } catch (e) {
    logRow.status_usa = 'shopify_error';
    logRow.status_uk = 'shopify_error';
    logRow.error_text = `markets query: ${(e as Error).message}`;
    await persistLog(sql, logRow).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    return jsonResponse({ startedAt, ...logRow }, 500);
  }

  // 3) Update por Market, error en uno no aborta el otro.
  const partialErrors: string[] = [];
  for (const t of TARGETS) {
    const market = marketsByHandle.get(t.handle);
    if (!market) {
      logRow[t.logColumn] = 'market_not_found';
      partialErrors.push(`${t.handle}: market not found`);
      continue;
    }
    try {
      await updateMarketRate(market.id, t.currencyCode, rates[t.oxrSymbol]);
      logRow[t.logColumn] = 'ok';
    } catch (e) {
      logRow[t.logColumn] = 'shopify_error';
      partialErrors.push(`${t.handle}: ${(e as Error).message}`);
    }
  }
  if (partialErrors.length) {
    logRow.error_text = partialErrors.join(' | ');
  }

  // 4) Persistir log. Si falla, devolvemos 500 con el detalle, pero los
  //    cambios en Shopify ya están aplicados (no transaccional).
  try {
    await persistLog(sql, logRow);
  } catch (e) {
    await sql.end({ timeout: 5 }).catch(() => {});
    return jsonResponse(
      {
        startedAt,
        ...logRow,
        log_error: `failed to persist log: ${(e as Error).message}`,
      },
      500,
    );
  }
  await sql.end({ timeout: 5 }).catch(() => {});

  const allOk = logRow.status_usa === 'ok' && logRow.status_uk === 'ok';
  return jsonResponse({ startedAt, ...logRow }, allOk ? 200 : 207);
});

async function persistLog(
  sql: ReturnType<typeof postgres>,
  row: {
    usd_rate: number | null;
    gbp_rate: number | null;
    status_usa: string;
    status_uk: string;
    error_text: string | null;
  },
): Promise<void> {
  await sql`
    insert into private.currency_rate_log
      (usd_rate, gbp_rate, status_usa, status_uk, error_text)
    values
      (${row.usd_rate}, ${row.gbp_rate}, ${row.status_usa}, ${row.status_uk}, ${row.error_text})
  `;
}
