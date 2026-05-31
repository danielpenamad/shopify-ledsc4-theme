-- Cron schedule para update-fx-rates (Fase Currency-Display).
-- Dispara la edge function una vez por semana (lunes 06:00 UTC) vía
-- private.invoke_edge_function (que usa pg_net + private.config).
--
-- La EF refresca el shop metafield ledsc4.fx_rates con tasas Frankfurter.
-- verify_jwt = false en la EF → no se pasa Authorization (with_auth=false).
--
-- Frankfurter actualiza tasas BCE en días laborables ~16:00 CET. Lunes
-- 06:00 UTC garantiza usar el cierre del viernes anterior recién publicado.

-- Idempotencia: si ya existe el schedule, recreamos.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'update-fx-rates') then
    perform cron.unschedule('update-fx-rates');
  end if;
end;
$$;

-- Argumentos tipados explícitos: hay dos overloads de
-- private.invoke_edge_function (2-arg y 3-arg con defaults), y una
-- llamada con literales sin tipar dispara "function is not unique".
select cron.schedule(
  'update-fx-rates',
  '0 6 * * 1',
  $cron$select private.invoke_edge_function('update-fx-rates'::text, '{}'::jsonb, false)$cron$
);
