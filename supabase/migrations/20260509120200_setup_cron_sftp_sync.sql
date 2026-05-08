-- I4.3 — pg_cron schedule para sftp-sync.
--
-- Cinco jobs:
--   stock_only × 4: cada 6h en UTC, inicio a las 01:00 (01/07/13/19).
--   full        × 1: una vez al día en UTC a las 02:00.
--
-- Hora local Madrid:
--   - Invierno (CET, UTC+1): stock 02/08/14/20, full 03.
--   - Verano  (CEST, UTC+2): stock 03/09/15/21, full 04.
--   El desplazamiento ±1h por DST se acepta — los jobs siguen cayendo
--   en horas no-pico.
--
-- Cada job pasa with_auth=true para que invoke_edge_function añada el
-- header Authorization (sftp-sync tiene verify_jwt=true).
--
-- Idempotencia: cron.unschedule en bloque DO/EXCEPTION antes de cada
-- cron.schedule para que se pueda re-correr la migración sin duplicar
-- jobs ni fallar si el job no existía previamente.

-- ---- Job 1/5: stock_only @ 01:00 UTC ----
DO $$ BEGIN
  PERFORM cron.unschedule('sftp-sync-stock-01h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'sftp-sync-stock-01h',
  '0 1 * * *',
  $cmd$SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true)$cmd$
);

-- ---- Job 2/5: stock_only @ 07:00 UTC ----
DO $$ BEGIN
  PERFORM cron.unschedule('sftp-sync-stock-07h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'sftp-sync-stock-07h',
  '0 7 * * *',
  $cmd$SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true)$cmd$
);

-- ---- Job 3/5: stock_only @ 13:00 UTC ----
DO $$ BEGIN
  PERFORM cron.unschedule('sftp-sync-stock-13h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'sftp-sync-stock-13h',
  '0 13 * * *',
  $cmd$SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true)$cmd$
);

-- ---- Job 4/5: stock_only @ 19:00 UTC ----
DO $$ BEGIN
  PERFORM cron.unschedule('sftp-sync-stock-19h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'sftp-sync-stock-19h',
  '0 19 * * *',
  $cmd$SELECT private.invoke_edge_function('sftp-sync', '{"kind":"stock_only"}'::jsonb, true)$cmd$
);

-- ---- Job 5/5: full @ 02:00 UTC ----
DO $$ BEGIN
  PERFORM cron.unschedule('sftp-sync-full-02h');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
SELECT cron.schedule(
  'sftp-sync-full-02h',
  '0 2 * * *',
  $cmd$SELECT private.invoke_edge_function('sftp-sync', '{"kind":"full"}'::jsonb, true)$cmd$
);
