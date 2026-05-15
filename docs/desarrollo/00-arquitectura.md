# 00 · Arquitectura

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Es el **punto de entrada** del eje Desarrollo. Vista panorámica del sistema en 15 minutos: qué hay, cómo se conectan las piezas, dónde está cada cosa. Cada sección delega al doc del eje que profundiza.

Si eres dev nuevo, léelo entero antes que cualquier otro doc del eje.

## Vista general

LedsC4 B2B Outlet es un portal mayorista privado construido sobre tres piezas:

```
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│      Shopify         │◀──▶│      Supabase        │◀──▶│       GitHub         │
│                      │    │                      │    │                      │
│ • Theme Dawn forked  │    │ • Edge Functions     │    │ • Repo + secrets     │
│ • B2B nativo         │    │ • Postgres           │    │ • Actions workflows  │
│ • Flow + Messaging   │    │ • pg_cron            │    │ • Pages (docs)       │
│ • Locksmith (lock 2) │    │ • Storage            │    │                      │
│ • New customer accts │    │                      │    │                      │
└────────────────────┘    └────────────────────┘    └────────────────────┘
       storefront                  backend                   código + CI
   (cliente final ve)         (lógica privada)          (versionado + deploy)
```

Cada pieza tiene su doc:

- Shopify → [03-theme-customizaciones](03-theme-customizaciones.md), [04-storefront-gate](04-storefront-gate.md), [09-i18n](09-i18n.md), [10-multicurrency](10-multicurrency.md).
- Supabase → [11-supabase](11-supabase.md).
- GitHub → [12-github-repo](12-github-repo.md), [13-github-actions](13-github-actions.md).

## Stack en producción

### Shopify

`shop.ledsc4.com` (custom domain) + `ledsc4-b2b-outlet.myshopify.com` (respaldo). **Plan Grow** desde 13-may-2026 ([D1](adrs/d01-plan-grow.md)).

- **Theme Dawn forked** con customizaciones B2B. Rama `main` del repo conectada al tema live vía GitHub Connection.
- **B2B nativo** ([D2](adrs/d02-b2b-nativo.md)): Companies, CompanyContacts, CompanyLocations, Catalogs, Price Lists. 1 catalog activo "Outlet general" en EUR ([D6](adrs/d06-catalogo-unico.md)). 745 productos publicados al catalog vía smart collection `coleccion-2026` (sustituida progresivamente por la regla surtido+stock+precio del importer — [D10](adrs/d10-3-csvs-sftp.md)).
- **Shopify Flow**: W1, W2, W3, W5 vivos. W4 reemplazado por edge function ([D3](adrs/d03-flow-supabase.md)).
- **Locksmith**: Lock 806866 + Key 1084647. Solo Rule 2 (collection lock) — el resto del gate vive en Liquid ([D4](adrs/d04-gate-hibrido.md)).
- **New customer accounts** ([D5](adrs/d05-customer-accounts.md)) — impuesto por Shopify. Branding aplicado vía Branding API.

### Supabase

Proyecto `mbjvmhaglbhnxoccwyex`. Detalle en [11-supabase](11-supabase.md).

**10 edge functions** en `supabase/functions/`:

- Registro: `register-b2b-customer`.
- Backoffice: `approve-customer`, `reject-customer`, `list-pending-customers`, `update-whitelist`.
- Helpers de aprobación: `create-company-for-customer`, `promote-whitelist-matches`.
- Solicitudes de pedido: `submit-order-request`, `list-order-requests`.
- Importer: `sftp-sync`.

**10 migraciones** en `supabase/migrations/`. **3 tablas** en schema `private` (`import_runs`, `sku_state`, `image_cache`) + 1 tabla `private.config` (key/value). RLS off, service-role only.

**2 jobs `pg_cron`**: `promote-whitelist-matches` (cada 30 min) y `sftp-sync` (5 schedules — diario surtido + 4 stock cada 6h).

### GitHub

Repo: `danielpenamad/shopify-ledsc4-theme`. Detalle en [12-github-repo](12-github-repo.md).

**4 workflows** en `.github/workflows/`:

- `dawn-sync.yml` — sincroniza upstream Dawn periódicamente.
- `docs.yml` — despliega MkDocs Material a GitHub Pages.
- `ledsc4-import.yml` — writer del importer ([D12](adrs/d12-pipeline-split.md)).
- `test-edge-functions.yml` — tests de las edge functions.

Settings, secrets y ownership pendientes de transferir al cliente. Plan documentado en el doc de transferencia (cuando llegue).

## Mapa de flujos vivos

### Registro B2B

`/pages/acceso-profesional` (landing) → form → edge `register-b2b-customer` → Customer creado con tag `b2b-pendiente` → magic code de invitación → Flow W1 (backfill metafields + chequeo whitelist).

Detalle en [05-registro-b2b](05-registro-b2b.md).

### Aprobación / rechazo

`/pages/admin-backoffice` (gate UX por tag `backoffice` + HMAC server-side en cada request) → edges `list-pending-customers` / `approve-customer` / `reject-customer` / `update-whitelist` → tag flip → Flow W2 (aprobado) o W3 (rechazado).

Detalle en [06-backoffice](06-backoffice.md). Decisión arquitectónica: [D7](adrs/d07-backoffice-page.md).

### Whitelist re-evaluation

`pg_cron` cada 30 min → edge `promote-whitelist-matches` → recorre `public.whitelist`, busca Customer matches no-aprobados, aplica tag `b2b-aprobado` → cascada W2.

Detalle en [11-supabase](11-supabase.md) §helpers.

### Storefront gate

`layout/theme.liquid` (`<head>`) redirige según tag del customer:

- Anónimo → `/pages/acceso-profesional`.
- Tag `rechazado` → `/pages/cuenta-rechazada`.
- Tag `aprobado` → acceso completo (más Locksmith Rule 2 sobre `coleccion-2026`).
- Sin tag → `/pages/cuenta-en-revision` para rutas comerciales.

Detalle en [04-storefront-gate](04-storefront-gate.md). Decisión: [D4](adrs/d04-gate-hibrido.md).

### Solicitud de pedido

`/pages/solicitar-pedido` (Customer aprobado) → edge `submit-order-request` (HMAC) → `draftOrderCreate` con custom attributes → Flow W5 (emails al cliente y al backoffice).

Listado de solicitudes propias del Customer: `/pages/mis-solicitudes` → edge `list-order-requests`.

Detalle en [07-solicitudes-pedido](07-solicitudes-pedido.md).

### Import pipeline

`pg_cron` (5 schedules) → edge `sftp-sync` (descarga del SFTP del cliente a Supabase Storage, escribe row en `private.import_runs`) → `repository_dispatch` a GitHub → workflow `ledsc4-import.yml` → `scripts/import-write.mjs` (parser + mapper + writer + reporter) → Shopify Admin GraphQL.

Pieza más compleja del proyecto. Detalle en [02-importer](02-importer.md). Arquitectura: [D12](adrs/d12-pipeline-split.md).

## Fases del proyecto

Cronológico, para que los nombres de fase que aparecen en commits y PRs tengan referencia:

| Fase | Cuándo | Qué entregó |
|---|---|---|
| **A** | abr-jun 2025 | Modelo de datos: B2B nativo, metafields Fase A, edge `create-company-for-customer`. |
| **B** | jul-sep 2025 | Aprobación automatizada: Flow W1/W2/W3, edge `promote-whitelist-matches`. |
| **C** | oct-dic 2025 | Storefront gate (Locksmith → Liquid), customer accounts branding, theme B2B (header + colecciones + filtros). |
| **D** | ene-mar 2026 | Solicitudes de pedido: edges `submit-order-request` y `list-order-requests`, Flow W5, página `/pages/solicitar-pedido` + `/pages/mis-solicitudes`. |
| **BO** | may 2026 | Backoffice page: `/pages/admin-backoffice`, edges `list-pending-customers` / `approve-customer` / `reject-customer` / `update-whitelist`. |
| **I** | mar-may 2026 | Importer (en curso): `sftp-sync`, `ledsc4-import.yml`, `image_cache`, `sku_state`, `import_runs`, 32 metafields nuevos de producto. |
| **Currency** | may 2026 | Multidivisa Fase 1 (presentación-only). |

## Lecturas siguientes

Si llegas nuevo:

1. Acaba este doc.
2. Pasa a [01-data-model](01-data-model.md) (modelo de entidades, lo cita medio repo).
3. Lee los ADRs por orden: D1-D14 en [adrs/](adrs/index.md). Son cortos. Entender las decisiones evita reabrir conversaciones cerradas.
4. Después, salta al doc del componente que vayas a tocar.

Si vas a tocar:

- **Theme / Liquid / JS del storefront** → [03-theme-customizaciones](03-theme-customizaciones.md), [04-storefront-gate](04-storefront-gate.md).
- **Edge functions / Supabase** → [11-supabase](11-supabase.md) + doc consumidor de la edge (backoffice, solicitudes, importer, registro).
- **Importer** → [02-importer](02-importer.md). Largo; léelo entero antes de cambiar nada.
- **CI / deploy** → [13-github-actions](13-github-actions.md), [12-github-repo](12-github-repo.md).
- **Producción / deploy / rotación de secrets** → [16-operations-runbook](16-operations-runbook.md), [14-secrets](14-secrets.md).

## Cambios

- **v0.1** (15-may-2026): primera publicación.
