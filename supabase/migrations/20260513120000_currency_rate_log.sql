-- Currency-A — tabla de log para refresh diario de FX (Markets UK/USA).
--
-- Una fila por ejecución de la edge function update-currency-rates.
-- Permite auditar (a) que el cron disparó la función, (b) qué rates
-- aportó Open Exchange Rates, (c) si Shopify aplicó el manualRate en
-- cada Market o falló parcialmente.
--
-- Schema 'private' (mismo patrón que import_runs, sku_state, image_cache):
-- fuera de PostgREST, sin exposición a anon/storefront. Lectura para
-- inspección manual desde Supabase Studio / psql.
--
-- Política de retención: no purgamos automáticamente. Una fila/día genera
-- ~365 rows/año — irrelevante en tamaño. Si en el futuro se quiere podar
-- a 90 días, basta con un DELETE WHERE created_at < now() - interval '90 days'.

create schema if not exists private;

create table if not exists private.currency_rate_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  -- Precisión completa de OXR (e.g. 1.0816499). Shopify redondea a 2
  -- decimales sólo en el render del precio storefront.
  usd_rate numeric,
  gbp_rate numeric,
  -- 'ok' | 'shopify_error' | 'oxr_error' | 'market_not_found' | 'pending'
  status_usa text not null,
  status_uk text not null,
  -- Detalle de error (OXR fallido, userErrors de Shopify, partial fail…).
  error_text text
);

comment on table private.currency_rate_log is
  'Log de cada invocación del cron leds_currency_rates_daily (Currency-A).';
