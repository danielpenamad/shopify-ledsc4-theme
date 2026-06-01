-- El job promote-whitelist-matches se programó con la llamada de 1 arg,
-- que quedó ambigua al añadirse la sobrecarga (text, jsonb, boolean) de
-- invoke_edge_function. cron.schedule hace upsert por jobname → idempotente
-- y robusto al jobid (no asume jobid=1).
select cron.schedule(
  'promote-whitelist-matches',
  '*/30 * * * *',
  $$select private.invoke_edge_function('promote-whitelist-matches'::text, '{}'::jsonb, false)$$
);
