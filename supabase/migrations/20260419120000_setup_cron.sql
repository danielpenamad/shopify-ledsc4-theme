-- Cron schedule para promote-whitelist-matches (W4 — re-evaluación whitelist).
-- Dispara la edge function cada 30 minutos vía pg_net.
--
-- Portabilidad: al migrar al proyecto del cliente, tras aplicar esta migración
-- sólo hay que actualizar una fila en private.config:
--
--   update private.config set value = 'https://<client-project-ref>.supabase.co'
--   where key = 'supabase_url';

-- Habilitar extensiones requeridas. En Supabase vienen disponibles pero no
-- pre-instaladas en proyectos nuevos, así que las habilitamos aquí.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;

-- Tabla key/value para config privada del proyecto.
-- Alternativa a ALTER DATABASE SET app.* (bloqueado por permisos en Supabase).
-- No expuesta por PostgREST (schema 'private' fuera de 'public'/'api').
create table if not exists private.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Seed con la URL del proyecto actual. Al migrar, cambiar el value.
insert into private.config (key, value)
values ('supabase_url', 'https://mbjvmhaglbhnxoccwyex.supabase.co')
on conflict (key) do update set value = excluded.value, updated_at = now();

-- Helper: invoca cualquier edge function del proyecto por su nombre.
-- Lee la URL base de private.config.
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
  project_url text;
  request_id bigint;
begin
  select value into project_url from private.config where key = 'supabase_url';
  if project_url is null or project_url = '' then
    raise exception 'supabase_url no configurado en private.config';
  end if;

  select net.http_post(
    url := project_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := payload,
    timeout_milliseconds := 30000
  ) into request_id;

  return request_id;
end;
$$;

comment on function private.invoke_edge_function(text, jsonb) is
  'Llama a una edge function de este proyecto. Usa private.config(supabase_url) como base.';

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
  $cron$select private.invoke_edge_function('promote-whitelist-matches')$cron$
);
