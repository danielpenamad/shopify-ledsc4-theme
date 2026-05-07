-- Move public.import_runs → private.import_runs (Fase I4.1 cleanup).
--
-- Reasoning: import_runs es una tabla operacional del importer (state
-- machine de los runs de sftp-sync). NO se consume desde frontend ni
-- requiere PostgREST. Mantenerla en public.* la dejaba expuesta a la
-- anon key (sin RLS) — ahora la sacamos del API entirely moviéndola al
-- schema `private`, igual que `private.config` (creada en
-- 20260419120000_setup_cron.sql).
--
-- Acceso post-migration:
--   - Edge Functions con service role key: vía
--     supabase.schema('private').from('import_runs').
--   - PostgREST (anon, authenticated): no visible. Devuelve 404.
--   - Supabase Studio Table Editor: solo si se añade 'private' a
--     Project Settings → API → Exposed schemas (decisión del operador).

create schema if not exists private;

alter table public.import_runs set schema private;

-- Belt-and-suspenders: aunque mover al schema private ya saca la tabla
-- del scope de PostgREST, revocamos explícitamente cualquier permiso
-- residual que pudiera haber heredado.
revoke all on schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;

-- One-shot cleanup: borrar la row residual de la primera invocación de
-- sftp-sync, que falló por un bug de ssh2-sftp-client.fastGet usando
-- Deno.lstatSync (blocklisted en Edge Runtime). Fix aplicado en el
-- mismo PR de I4.1 (cambiado a sftp.get + Buffer en memoria); la row
-- es ruido del journey de implementación, no un fallo real.
delete from private.import_runs
where error_message like '%lstatSync%';
