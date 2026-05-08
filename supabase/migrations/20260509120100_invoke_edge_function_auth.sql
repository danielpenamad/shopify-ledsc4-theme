-- I4.3 — Extend private.invoke_edge_function with optional Authorization header.
--
-- Backward compatibility: the new `with_auth boolean default false`
-- parameter goes at the end of the signature. Existing callers (the
-- promote-whitelist-matches cron, which calls with `verify_jwt = false`)
-- keep working unchanged — they get the default `false` and the function
-- behaves exactly as before (Content-Type only, no Authorization).
--
-- New callers (the sftp-sync crons in I4.3) pass `with_auth = true`.
-- The function then reads `supabase_anon_key` from private.config and
-- injects `Authorization: Bearer <anon_key>` so requests pass the
-- `verify_jwt = true` gate of edge functions like sftp-sync.
--
-- Hard-fail on missing / placeholder anon_key: if `with_auth = true` is
-- requested but the row is absent, empty, or still 'REPLACE_ME_AFTER_MERGE'
-- (the seed value), the function raises an exception. cron jobs surface
-- this in cron.job_run_details so a forgotten manual UPDATE is loud, not
-- silent.

CREATE OR REPLACE FUNCTION private.invoke_edge_function(
  function_name text,
  payload jsonb DEFAULT '{}'::jsonb,
  with_auth boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  project_url text;
  anon_key text;
  request_headers jsonb;
  request_id bigint;
BEGIN
  SELECT value INTO project_url
  FROM private.config
  WHERE key = 'supabase_url';
  IF project_url IS NULL OR project_url = '' THEN
    RAISE EXCEPTION 'supabase_url no configurado en private.config';
  END IF;

  request_headers := jsonb_build_object('Content-Type', 'application/json');

  IF with_auth THEN
    SELECT value INTO anon_key
    FROM private.config
    WHERE key = 'supabase_anon_key';
    IF anon_key IS NULL OR anon_key = '' OR anon_key = 'REPLACE_ME_AFTER_MERGE' THEN
      RAISE EXCEPTION 'supabase_anon_key no configurado o es placeholder en private.config — UPDATE manualmente tras aplicar la migración';
    END IF;
    request_headers := request_headers
      || jsonb_build_object('Authorization', 'Bearer ' || anon_key);
  END IF;

  SELECT net.http_post(
    url := project_url || '/functions/v1/' || function_name,
    headers := request_headers,
    body := payload,
    timeout_milliseconds := 30000
  ) INTO request_id;

  RETURN request_id;
END;
$$;

COMMENT ON FUNCTION private.invoke_edge_function(text, jsonb, boolean) IS
  'Llama a una edge function de este proyecto. with_auth=true inyecta Authorization: Bearer <anon_key> leído de private.config (necesario para edge functions con verify_jwt=true como sftp-sync).';
