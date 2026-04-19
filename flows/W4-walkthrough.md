# W4 — MOVIDO A SUPABASE (no existe en Flow)

**W4 (re-evaluación de whitelist cada 30 min) NO está configurado en Shopify
Flow.** Está implementado como **edge function de Supabase** disparada por
`pg_cron`.

## Por qué

Diseño original: Flow con trigger `Scheduled time` + Run code que iteraba
customers pendientes + comparaba con whitelist + aplicaba tagsAdd.

Bloqueos encontrados en Fase B (2026-04-19):

1. Run code de Flow es sandbox puro: **sin `async`, sin `shopify.graphql()`, sin `fetch()`**. No se puede iterar customers ni aplicar mutaciones desde Run code.
2. Scheduled trigger no expone lista de customers como input.
3. No existe trigger "Shop metafield updated" (sería ideal para disparar cuando el admin añade un email a la whitelist).

## Dónde vive ahora

- Edge function: `supabase/functions/promote-whitelist-matches/index.ts`
- Cron: `supabase/migrations/20260419120000_setup_cron.sql` (jobname `promote-whitelist-matches`, schedule `*/30 * * * *`)
- Endpoint: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/promote-whitelist-matches`
- Ver [supabase/README.md](../supabase/README.md) para setup completo.

## Flujo real

```
pg_cron (cada 30 min)
 └→ private.invoke_edge_function('promote-whitelist-matches')
     └→ net.http_post → edge function
         ├─ Lee shop.metafields.b2b.whitelist_emails
         ├─ Pagina customers con tag 'pendiente'
         ├─ Filtra por email en whitelist
         └─ tagsAdd 'aprobado' a cada match
             └→ Dispara W2 en Shopify Flow (mismo path que aprobación manual)
                 ├─ Remove tag 'pendiente'
                 ├─ Update fecha_aprobacion
                 ├─ Send HTTP request → create-company-for-customer
                 ├─ Send internal email backoffice
                 └─ [PENDIENTE GROW] Send marketing mail 04
```

Cuando W4-Supabase promueve un customer, la cascada ocurre a través de W2 —
no necesitamos duplicar lógica. El único "downside" es que el email al
cliente será el 04 ("Cuenta aprobada manual"), no el 06 ("Bienvenida
re-evaluación"). Si se quiere distinguir:

**Opción futura**: la edge function añade también un tag marker
`aprobado_via_whitelist` además de `aprobado`. W2 detecta el marker con
`Check if` y decide enviar 04 vs 06. Cambio localizado (una mutation en
la edge function + un Check if en W2). No aplica en Fase B.

## Testing

Manual: invocar la función con curl (ver `supabase/README.md §Verificar`).

Scheduled: cada 30 min. Logs en `cron.job_run_details` y
`supabase functions logs promote-whitelist-matches`.

## Export JSON

No aplica — W4 no vive en Flow. El equivalente versionado es el código
fuente en `supabase/` (edge function + migración SQL), ya en el repo.
