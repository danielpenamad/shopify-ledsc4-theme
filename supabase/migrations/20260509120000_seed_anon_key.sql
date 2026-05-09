-- I4.3 — Seed slot for the Supabase anon key in private.config.
--
-- Why an anon key in plain text in a DB table:
--   The anon key is by design publishable (it ships with every Supabase
--   frontend's client bundle). It's the JWT-form gateway pass for any
--   request, but it cannot read RLS-protected data on its own. Storing it
--   in private.config matches the existing pattern for `supabase_url`
--   (also plain text in the same table) and lets pg_cron read it from
--   the same security_definer function that already fronts edge function
--   invocations.
--
-- The actual key value is NOT committed to the repo. After applying this
-- migration, run manually against the project:
--
--     UPDATE private.config
--     SET value = '<paste anon key here>'
--     WHERE key = 'supabase_anon_key';
--
-- (anon key viene de Project Settings → API en Supabase Studio. Es la
-- misma key que se usa en el .env del frontend / clients.)
--
-- The companion function `private.invoke_edge_function` (extended in the
-- next migration) reads this row when called with `with_auth = true` and
-- raises if it's missing or still the placeholder.

INSERT INTO private.config (key, value)
VALUES ('supabase_anon_key', 'REPLACE_ME_AFTER_MERGE')
ON CONFLICT (key) DO NOTHING;
