# D3 · Shopify Flow + Supabase Edge Functions

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase A (mayo 2025) · vigente.

## Contexto

Tras adoptar B2B nativo ([D2](d02-b2b-nativo.md)) hay dos clases de tarea automatizable:

1. **Reaccionar a eventos del shop** — customer.created, customer tagged, draft order created, scheduled jobs (diario). Triggers nativos, sin necesidad de polling.
2. **Ejecutar lógica que Flow no puede hacer**:
   - Mutaciones GraphQL no expuestas como acción de Flow (`companyCreate`, `companyContactCreate`, `companyLocationUpdate`, `customerSendAccountInviteEmail`).
   - Lectura/escritura en base de datos propia (whitelist, audit logs).
   - Procesamiento de payloads de formularios externos (registro B2B).
   - HTTP a servicios externos con autenticación HMAC.
   - Cron jobs (Flow tiene `Scheduled time` pero no orquesta colas ni reintentos).

Flow corre en un sandbox JavaScript sin `async/await`, sin `fetch`, sin `shopify.graphql`. La acción `Run code` está pensada para transformaciones puras de payload, no para integración.

Mechanic (alternativa de pago) habría cubierto buena parte de lo anterior, pero introduce coste recurrente por trigger, modelo de quotas opaco, y bloquea el rol staff de aprobaciones (que necesita un dominio donde escribir audit logs sin tocar Shopify Admin).

## Decisión

Arquitectura híbrida:

- **Shopify Flow** orquesta el control: detecta eventos, evalúa condiciones, ramifica, envía mails internos y marketing.
- **Supabase Edge Functions** ejecutan las mutaciones, lecturas DB y llamadas HTTP que Flow no puede hacer. Flow las invoca con `Send HTTP request` apuntando a `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/<function-name>`.

Las edge functions son **stateless** (cualquier estado vive en `public.*` / `private.*` schemas) e **idempotentes** sobre Shopify (reentrantes ante fallos de Flow).

## Inventario actual (10 edge functions)

Agrupadas por dominio:

| Dominio | Edge function | Invocador | Propósito |
|---|---|---|---|
| **Registro B2B** | `register-b2b-customer` | Form storefront `/pages/acceso-profesional` | Crea Customer con tag `b2b-pendiente` y metafields de empresa. Envía magic link. |
| **Aprobaciones** | `create-company-for-customer` | Flow W1 (whitelist hit), W2 (aprobación manual) | Crea `Company` + `CompanyContact` + `CompanyLocationCatalog`. Idempotente. |
| | `approve-customer` | Página backoffice `/pages/admin-backoffice` | Tag `b2b-aprobado`, dispara cascada W2. |
| | `reject-customer` | Página backoffice | Tag `b2b-rechazado`, dispara W3. |
| | `list-pending-customers` | Página backoffice | Lectura GraphQL de customers con tag `b2b-pendiente`. |
| **Whitelist** | `promote-whitelist-matches` | `pg_cron` (diario) | Recorre `public.whitelist` y aprueba los Customer matchs. |
| | `update-whitelist` | Página backoffice | CRUD de `public.whitelist`. |
| **Solicitudes de pedido** | `submit-order-request` | Form storefront `/pages/solicitar-pedido` | Crea Draft Order con custom attributes + HMAC. |
| | `list-order-requests` | Página storefront `/pages/mis-solicitudes` | Lista Draft Orders del Customer autenticado. |
| **Importer** | `sftp-sync` | `pg_cron` (cada 6h) y `pg_cron` (diario 2 AM) | Descarga CSVs del SFTP del cliente, parsea, dispara `repository_dispatch` a GHA. |

Detalle de cada función (endpoint, payload, errores, secrets) en su doc consumidor:

- Registro → [05-registro-b2b](../05-registro-b2b.md)
- Backoffice (4 edges) → [06-backoffice](../06-backoffice.md)
- Solicitudes (2 edges) → [07-solicitudes-pedido](../07-solicitudes-pedido.md)
- Importer → [02-importer](../02-importer.md)
- `create-company-for-customer` y `promote-whitelist-matches` → [11-supabase](../11-supabase.md) §helpers

El proyecto Supabase (`mbjvmhaglbhnxoccwyex`), config global (`verify_jwt`, secrets, cron), esquemas (`public.*`, `private.*`) y migraciones se documentan en [11-supabase](../11-supabase.md).

## Alternativas consideradas

**Solo Shopify Flow.** Descartada: el sandbox no expone `companyCreate` ni similares. Forzaría una app intermedia o renunciar al modelo B2B nativo.

**Mechanic.** Descartada por:
- Coste mensual por trigger activo.
- Sin dominio propio para escribir audit logs / whitelist sin tocar Shopify.
- Bloquea el rol staff "Backoffice Aprobaciones" — Mechanic no se gestiona desde un toggle de staff.
- Dependencia de app de terceros con su propio versionado.

**Implementación monolítica en una app embedida en Admin.** Descartada por:
- Coste de desarrollo (OAuth, hosting de Admin extension, sesiones).
- Latencia añadida vs Flow trigger directo.
- Más superficie de fallo (refresh tokens, webhooks, sessión).

## Consecuencias

- **Dependencia de Supabase**. El proyecto `mbjvmhaglbhnxoccwyex` es crítico. Transferencia al cliente y backups documentados en [11-supabase](../11-supabase.md).
- **Latencia de Flow → Supabase**: cada `Send HTTP request` añade ~200-400ms. Asumido — los flujos son asíncronos (eventos, no interactivos).
- **Secrets en dos planos**: Supabase guarda `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_SHOP_DOMAIN`, etc. Shopify Flow guarda los headers de invocación (`X-Cron-Secret`, `X-Webhook-Signature`). Inventario en [14-secrets](../14-secrets.md).
- **Versionado**: edge functions versionadas en `supabase/functions/<name>/index.ts` del repo, deploy con `supabase functions deploy`. Workflows de Flow exportados a `flows/*.flow.json` cuando aplique ([13-github-actions](../13-github-actions.md)).
- **Observabilidad asimétrica**: logs de edge functions en Supabase Dashboard (Logs Explorer). Logs de Flow en Shopify Admin (Activity log de cada workflow). No hay tracing end-to-end — para depurar un caso suele hacer falta correlacionar `customer_id` entre ambos lados.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
