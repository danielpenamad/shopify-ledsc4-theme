-- company_domains: unificación de Companies B2B por dominio corporativo.
--
-- Decisión de negocio (Víctor, 2026-06-10): el segundo registro de un
-- dominio corporativo se AUTO-UNE en silencio a la Company existente de
-- ese dominio, en vez de crear una Company duplicada (caso ~22 variantes
-- "LedsC4" de empleados @ledsc4.com; SALTOKI VIGO x2; etc.).
--
-- La tabla la lee/escribe SOLO la edge function create-company-for-customer
-- con service role key. Va en `public` (PostgREST no expone `private`) con
-- RLS activado y SIN policies: anon/authenticated no pueden tocarla; la
-- service role bypassa RLS.
--
-- El PRIMARY KEY sobre domain es lo que cierra la race de creación
-- concurrente (caso josepinas: 2 companies el mismo segundo): el segundo
-- INSERT conflicta y la función une el customer a la fila ganadora.

create table if not exists public.company_domains (
  domain text primary key,
  company_id text not null,
  company_location_id text not null,
  created_at timestamptz not null default now()
);

alter table public.company_domains enable row level security;

-- Seed: Company madre LedsC4 SA. NO sembrar más dominios aquí
-- (saltoki/pablocrespo van en la limpieza retroactiva, fase aparte).
insert into public.company_domains (domain, company_id, company_location_id)
values (
  'ledsc4.com',
  'gid://shopify/Company/7410123079',
  'gid://shopify/CompanyLocation/8330346823'
)
on conflict (domain) do nothing;
