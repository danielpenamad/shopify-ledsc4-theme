-- Tracking table for import-pipeline runs (Fase I4.1).
--
-- One row per invocation of the sftp-sync Edge Function. Records what was
-- downloaded, where it lives in Storage, and the run state machine
-- (started → downloaded → processing → completed | failed).
--
-- I4.1 only writes the 'started' → 'downloaded' (or 'failed') transitions.
-- I4.2 adds 'processing' → 'completed' from the shopify-write Job 2.

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  -- 'full' downloads productos + stock + precios; 'stock_only' just stock.
  kind text not null check (kind in ('full', 'stock_only')),
  -- State machine. New rows start as 'started' and transition through the
  -- listed states. Terminal states: 'completed' (success) and 'failed'.
  status text not null check (status in (
    'started', 'downloaded', 'processing', 'completed', 'failed'
  )),
  started_at timestamptz not null default now(),
  downloaded_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  -- [{ name, path_in_storage, size_bytes, sftp_mtime }]
  files jsonb,
  -- One of: 'sftp_connect' | 'sftp_list' | 'sftp_download'
  --       | 'storage_upload' | 'host_key' | 'auth' | 'shopify_write' | etc.
  error_stage text,
  error_message text,
  -- Path prefix in the ledsc4-imports Storage bucket where this run's files
  -- live. Conventionally 'runs/{id}/' so each run has its own folder.
  storage_prefix text
);

create index idx_import_runs_status on public.import_runs (status);
create index idx_import_runs_started_at on public.import_runs (started_at desc);

-- RLS deliberately DISABLED on this table. The only writers are Edge
-- Functions running with the service role key (sftp-sync in I4.1,
-- shopify-write in I4.2). The only readers are the same plus the operator
-- via Supabase Studio / SQL editor. Keeping RLS off avoids ceremony with
-- service-role bypass policies; if we ever expose run status to a
-- storefront UI, we'll add restrictive policies at that point.
alter table public.import_runs disable row level security;

comment on table public.import_runs is
  'I4 import pipeline runs. One row per sftp-sync invocation. RLS off — service-role only.';

-- One-shot bucket creation for the import-pipeline staging area.
-- Private bucket (public=false). Files are written by the sftp-sync Edge
-- Function with service role key and read by shopify-write (I4.2) the
-- same way. No anon / signed URL access in this phase.
--
-- Idempotent: if the bucket already exists (e.g. created via dashboard or
-- by re-running this migration on a fresh project), the insert is a no-op.
insert into storage.buckets (id, name, public)
values ('ledsc4-imports', 'ledsc4-imports', false)
on conflict (id) do nothing;
