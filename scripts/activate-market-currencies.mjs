// One-shot: activa localCurrencies=true + baseCurrency en los Markets
// UK (GBP) y USA (USD) de LedsC4. Idempotente — si el Market ya está
// activo con la baseCurrency esperada, hace skip.
//
// Aproximación: auto-rates de Shopify Markets, NO manualRate.
//
// Razón: la API rechaza la combinación `localCurrencies=true +
// baseCurrencyManualRate` con "Manual exchange rates cannot be used
// when local currencies are enabled." Auto-rates es la única opción
// soportada para multidivisa sin contratar Shopify Payments, y para
// LedsC4 fase 1 (sin checkout, sólo presentación de precios) es
// suficiente — Shopify aplica el rate en tiempo real al renderizar
// el precio storefront.
//
// Sin OXR, sin cron, sin tabla de log, sin edge function. Toda la
// infra de PR-CURRENCY-A v1 quedó revertida en PR #78.
//
// Uso:
//   SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com \
//   SHOPIFY_ADMIN_TOKEN=shpat_xxx \
//   node scripts/activate-market-currencies.mjs
//
// Scopes Shopify Admin: read_markets, write_markets.

import { gql, requireEnv } from './_shopify.mjs';

requireEnv();

const TARGETS = [
  { handle: 'uk', currencyCode: 'GBP' },
  { handle: 'usa', currencyCode: 'USD' },
];

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
            baseCurrency { currencyCode }
          }
        }
      }
    }
  `);
  return data.markets.nodes;
}

async function updateMarketCurrency({ id, currencyCode }) {
  const data = await gql(
    `
    mutation UpdateMarketCurrency($id: ID!, $input: MarketUpdateInput!) {
      marketUpdate(id: $id, input: $input) {
        market {
          id
          handle
          currencySettings {
            localCurrencies
            baseCurrency { currencyCode }
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
  return true;
}

(async () => {
  const markets = await listTargetMarkets();
  const byHandle = new Map(markets.map((m) => [m.handle, m]));

  for (const t of TARGETS) {
    const market = byHandle.get(t.handle);
    if (!market) {
      console.warn(`[skip] Market with handle "${t.handle}" not found — verifica los handles en admin.`);
      continue;
    }

    if (isAlreadyActive(market, t.currencyCode)) {
      console.log(
        `[skip] ${market.name} (${market.handle}) — already active: localCurrencies=true, baseCurrency=${market.currencySettings.baseCurrency.currencyCode}`,
      );
      continue;
    }

    console.log(`[apply] ${market.name} (${market.handle}) → localCurrencies=true, baseCurrency=${t.currencyCode}`);
    const updated = await updateMarketCurrency({
      id: market.id,
      currencyCode: t.currencyCode,
    });
    const applied = updated.currencySettings;
    console.log(
      `[ok]    ${updated.handle} → localCurrencies=${applied.localCurrencies}, baseCurrency=${applied.baseCurrency.currencyCode}`,
    );
  }
  console.log('Done.');
})().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
