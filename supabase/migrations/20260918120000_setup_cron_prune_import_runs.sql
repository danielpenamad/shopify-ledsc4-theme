-- Cron schedule para prune-import-runs (retención de Storage, 2026-09).
--
-- El bucket ledsc4-imports acumula runs/<id>/ sin límite (5 runs/día entre
-- sftp-sync full + stock_only) y superó la cuota de 1 GB del plan free.
-- Dispara la edge function una vez al día vía private.invoke_edge_function
-- (pg_net) para podar runs con más de RETENTION_DAYS (default 14, ver
-- supabase/functions/prune-import-runs/index.ts).
--
-- Horario: 05:00 UTC, después del full run de las 02:00 UTC (~15-60 min en
-- régimen estacionario, margen de timeout 180 min) y antes del siguiente
-- stock_only de las 07:00 UTC — no compite por Storage con un run en curso.
--
-- with_auth=true porque prune-import-runs tiene verify_jwt=true (mismo
-- patrón que sftp-sync).

DO $$ BEGIN
  PERFORM cron.unschedule('prune-import-runs-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'prune-import-runs-daily',
  '0 5 * * *',
  $cmd$SELECT private.invoke_edge_function('prune-import-runs', '{}'::jsonb, true)$cmd$
);
