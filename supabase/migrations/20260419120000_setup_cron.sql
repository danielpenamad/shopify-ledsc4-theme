-- Cron schedule para promote-whitelist-matches (W4 — re-evaluación whitelist).
-- Dispara la edge function cada 30 minutos vía pg_net.
--
-- Requisitos (ambos ya vienen habilitados en Supabase de serie):
--   extensions: pg_cron, pg_net.
--
-- DESPUÉS de aplicar esta migración hay que setear UNA config por proyecto:
--
--   ALTER DATABASE postgres SET app.supabase_url = 'https://<project-ref>.supabase.co';
--
-- Eso hace que la migración sea portable entre proyectos (tú → cliente).
-- La función ya está codificada en /supabase/functions/promote-whitelist-matches/.

create schema if not exists private;

-- Helper: invoca la edge function cuyo nombre le pases.
-- Lee la URL base del proyecto de la config app.supabase_url (ver arriba).
create or replace function private.invoke_edge_function(
  function_name text,
  payload jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  project_url text := current_setting('app.supabase_url', true);
  request_id bigint;
begin
  if project_url is null or project_url = '' then
    raise exception
      'app.supabase_url no configurado. Ejecuta:  ALTER DATABASE postgres SET app.supabase_url = ''https://<project-ref>.supabase.co''';
  end if;

  select net.http_post(
    url := project_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := payload,
    timeout_milliseconds := 30000
  ) into request_id;

  return request_id;
end;
$$;

comment on function private.invoke_edge_function(text, jsonb) is
  'Llama a una edge function de este proyecto. Usa app.supabase_url como base.';

-- Idempotencia del schedule: si ya existe, lo quitamos antes de re-crearlo.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'promote-whitelist-matches') then
    perform cron.unschedule('promote-whitelist-matches');
  end if;
end;
$$;

select cron.schedule(
  'promote-whitelist-matches',
  '*/30 * * * *',
  $$select private.invoke_edge_function('promote-whitelist-matches')$$
);
