-- Currency-A — pg_cron schedule para update-currency-rates.
--
-- Un único job: '0 6 * * *' (06:00 UTC daily). Hora local Madrid:
--   - Invierno (CET, UTC+1): 07:00 local.
--   - Verano  (CEST, UTC+2): 08:00 local.
-- Ventana antes del horario comercial — si el rate cambia, el storefront
-- empieza el día con el nuevo valor.
--
-- Pasamos with_auth=true porque update-currency-rates tiene
-- verify_jwt=true (no público). private.invoke_edge_function inyecta
-- Authorization: Bearer <supabase_anon_key> leyendo de private.config.
--
-- Idempotencia: cron.unschedule envuelto en DO/EXCEPTION antes de
-- cron.schedule para re-correr la migración sin duplicar el job ni
-- fallar si no existía previamente.

DO $$ BEGIN
  PERFORM cron.unschedule('leds_currency_rates_daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'leds_currency_rates_daily',
  '0 6 * * *',
  $cmd$SELECT private.invoke_edge_function('update-currency-rates', '{}'::jsonb, true)$cmd$
);
