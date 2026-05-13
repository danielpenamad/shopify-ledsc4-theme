// One-shot: activa localCurrencies + baseCurrency + baseCurrencyManualRate
// en los Markets UK (GBP) y USA (USD) de LedsC4. Idempotente — si el Market
// ya tiene la currency configurada, hace skip. El rate inicial se obtiene
// de Open Exchange Rates en el momento de ejecución.
//
// OXR plan free → la base es USD obligatoria (`?base=EUR` devuelve 401).
// Pedimos symbols=EUR,USD,GBP y recalculamos a EUR-base con:
//   usdPerEur = 1 / rates.EUR
//   gbpPerEur = rates.GBP / rates.EUR
// Si en el futuro se contrata plan paid, se puede simplificar a
// `?base=EUR&symbols=USD,GBP` y usar `rates.USD` / `rates.GBP` directos.
//
// Uso:
//   OPEN_EXCHANGE_RATES_APP_ID=xxx \
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/activate-market-currencies.mjs
//
// Tras este one-shot, el refresh diario lo hace la edge function
// update-currency-rates (cron pg_cron 06:00 UTC). Este script NO debe
// re-correrse a diario — sólo tras el merge inicial o si se cambia
// manualmente la base currency de un Market.
//
// Nota API: en 2025-10 la mutation marketCurrencySettingsUpdate quedó
// consolidada dentro de marketUpdate(id, input: { currencySettings: {...} }).
// Los campos del input son baseCurrency (CurrencyCode), baseCurrencyManualRate
// (Decimal, precisión completa; Shopify redondea a 2 decimales en el render
// del precio storefront) y localCurrencies (Boolean).

import { gql, requireEnv } from './_shopify.mjs';

requireEnv();

const OXR_APP_ID = process.env.OPEN_EXCHANGE_RATES_APP_ID;
if (!OXR_APP_ID) {
  console.error('Missing OPEN_EXCHANGE_RATES_APP_ID env var.');
  process.exit(1);
}

// Spec LedsC4 Fase 1 multi-currency.
const TARGETS = [
  { handle: 'uk', currencyCode: 'GBP', oxrSymbol: 'GBP' },
  { handle: 'usa', currencyCode: 'USD', oxrSymbol: 'USD' },
];

// Devuelve { raw, eurBase } — raw es lo que devolvió OXR (USD-base en
// plan free); eurBase contiene los rates derivados que se aplican como
// manualRate en Shopify. Sin redondeo: Number preserva ~15 dígitos
// significativos. Shopify redondea a 2 decimales sólo en el render del
// precio storefront.
async function fetchInitialRates() {
  const symbols = 'EUR,USD,GBP';
  const url = `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(OXR_APP_ID)}&symbols=${symbols}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OXR HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json?.rates) throw new Error(`OXR response missing rates: ${JSON.stringify(json).slice(0, 300)}`);
  const eurUsd = json.rates.EUR;
  const gbpUsd = json.rates.GBP;
  if (typeof eurUsd !== 'number' || !(eurUsd > 0)) {
    throw new Error(`OXR rates.EUR invalid (${eurUsd}); cannot derive EUR-base rates`);
  }
  if (typeof gbpUsd !== 'number' || !(gbpUsd > 0)) {
    throw new Error(`OXR rates.GBP invalid (${gbpUsd}); cannot derive EUR-base GBP rate`);
  }
  const eurBase = {
    USD: 1 / eurUsd,
    GBP: gbpUsd / eurUsd,
  };
  return { raw: json.rates, eurBase };
}

async function listTargetMarkets() {
  const data = await gql(`
    query Markets {
      markets(first: 50) {
        nodes {
          id
          handle
          name
          currencySettings {
            localCurrencies
            baseCurrency { currencyCode manualRate }
          }
        }
      }
    }
  `);
  return data.markets.nodes;
}

async function updateMarketCurrency({ id, currencyCode, manualRate }) {
  const data = await gql(
    `
    mutation UpdateMarketCurrency($id: ID!, $input: MarketUpdateInput!) {
      marketUpdate(id: $id, input: $input) {
        market {
          id
          handle
          currencySettings {
            localCurrencies
            baseCurrency { currencyCode manualRate rateUpdatedAt }
          }
        }
        userErrors { field message }
      }
    }
    `,
    {
      id,
      input: {
        currencySettings: {
          localCurrencies: true,
          baseCurrency: currencyCode,
          baseCurrencyManualRate: String(manualRate),
        },
      },
    },
  );
  const errs = data.marketUpdate?.userErrors ?? [];
  if (errs.length) {
    throw new Error(`marketUpdate userErrors: ${JSON.stringify(errs)}`);
  }
  return data.marketUpdate.market;
}

function isAlreadyActive(market, currencyCode) {
  const cs = market.currencySettings;
  if (!cs) return false;
  if (cs.localCurrencies !== true) return false;
  if (cs.baseCurrency?.currencyCode !== currencyCode) return false;
  if (cs.baseCurrency?.manualRate == null) return false;
  return true;
}

(async () => {
  console.log('Fetching initial rates from Open Exchange Rates (free plan, base=USD)…');
  const { raw, eurBase: rates } = await fetchInitialRates();
  for (const t of TARGETS) {
    if (typeof rates[t.oxrSymbol] !== 'number' || !(rates[t.oxrSymbol] > 0)) {
      throw new Error(`Computed EUR-base rate for ${t.oxrSymbol} is invalid (${rates[t.oxrSymbol]})`);
    }
  }
  // Trazabilidad: raw (USD-base devuelto por OXR) + computed (EUR-base
  // aplicado a Shopify).
  console.log('OXR raw (USD-base):', raw);
  console.log('Computed (EUR-base):', rates);

  const markets = await listTargetMarkets();
  const byHandle = new Map(markets.map((m) => [m.handle, m]));

  for (const t of TARGETS) {
    const market = byHandle.get(t.handle);
    if (!market) {
      console.warn(`[skip] Market with handle "${t.handle}" not found — verifica los handles en admin.`);
      continue;
    }
    const rate = rates[t.oxrSymbol];

    if (isAlreadyActive(market, t.currencyCode)) {
      console.log(
        `[skip] ${market.name} (${market.handle}) — already active: ${market.currencySettings.baseCurrency.currencyCode} @ ${market.currencySettings.baseCurrency.manualRate}`,
      );
      continue;
    }

    console.log(`[apply] ${market.name} (${market.handle}) → localCurrencies=true, baseCurrency=${t.currencyCode}, manualRate=${rate}`);
    const updated = await updateMarketCurrency({
      id: market.id,
      currencyCode: t.currencyCode,
      manualRate: rate,
    });
    const applied = updated.currencySettings;
    console.log(
      `[ok]    ${updated.handle} → ${applied.baseCurrency.currencyCode} @ ${applied.baseCurrency.manualRate} (rateUpdatedAt=${applied.baseCurrency.rateUpdatedAt})`,
    );
  }
  console.log('Done.');
})().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
