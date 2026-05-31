# LedsC4 B2B — notas operativas

## Deploy de edge functions (Supabase): MANUAL

**Las edge functions de `supabase/functions/*` NO se despliegan con push a `main`.**
Solo el tema (Shopify) se sincroniza por GitHub Actions; las edge functions
quedan en el repo y hay que desplegarlas explícitamente.

Cada vez que toques un `supabase/functions/<slug>/index.ts` y quieras subirlo:

```bash
# Opción A: CLI
supabase functions deploy <slug> --project-ref mbjvmhaglbhnxoccwyex

# Opción B: MCP Supabase desde Claude Code
# usar la herramienta deploy_edge_function con files=[{name, content}]
```

Verifica `verify_jwt` al desplegar: la mayoría de funciones B2B son
`verify_jwt: false` (auth por HMAC propio). Solo `sftp-sync` usa
`verify_jwt: true`. **Heredar mal este flag rompe la función.**

Tras desplegar, valida con `supabase functions list` que `version` subió
y revisa logs en Supabase Dashboard → Edge Functions → Logs.

## Funciones desplegadas (referencia)

| slug | verify_jwt | invocador |
|---|---|---|
| `register-b2b-customer` | false | form storefront (HMAC) |
| `submit-order-request` | false | storefront (HMAC) |
| `list-order-requests` | false | storefront (HMAC) |
| `approve-customer` / `reject-customer` | false | backoffice (HMAC) |
| `list-pending-customers` | false | backoffice (HMAC) |
| `update-whitelist` | false | backoffice (HMAC) |
| `create-company-for-customer` | false | Shopify Flow (header secret) |
| `promote-whitelist-matches` | false | pg_cron cada 30 min |
| `update-fx-rates` | false | pg_cron semanal (lun 06:00 UTC) |
| `sftp-sync` | **true** | pg_cron (4× stock/día + 1 full/día) |
