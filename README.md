# LedsC4 B2B Outlet — Shopify theme

Portal mayorista privado de LedsC4 sobre Shopify para liquidar fin de
colección a clientes profesionales (instaladores, arquitectos, retail,
distribuidores). El portal vive en
`ledsc4-b2b-outlet.myshopify.com`, comparte tienda con la web pública de
LedsC4 vía B2B nativo de Shopify, y solo muestra catálogo y precios a
clientes que pasan por un proceso de alta (auto-aprobación por whitelist
o aprobación manual por backoffice).

Este repositorio contiene el **tema Shopify** (Dawn customizado), los
**scripts de setup B2B**, los **walkthroughs de Shopify Flow**, las
**plantillas de email** y las **edge functions de Supabase** que
complementan a Shopify Flow para operaciones que su sandbox no permite.
La rama `main` está conectada al tema live vía la integración nativa
GitHub↔Shopify — cualquier commit se deploya automáticamente al
storefront en ~30-60 segundos. Estado a 2026-05-04: **Fases A, B, C, D
entregadas y en producción** sobre plan Development; pendiente de
cutover a Grow.

## Mapa de carpetas

```
.
├─ assets/                  Imágenes, iconos, JS, CSS estáticos del tema
├─ config/                  settings_data.json (live) + settings_schema.json
├─ docs/                    Documentación (ver §Documentos clave abajo)
├─ email-templates/         Bodies en Liquid de los 7 emails (cliente + backoffice)
├─ flows/                   Walkthroughs de los workflows Shopify Flow (W1–W5)
├─ layout/                  Layouts Liquid (theme.liquid contiene el gate)
├─ locales/                 Traducciones del tema
├─ pages/                   Markdown de páginas estáticas (no usado activamente)
├─ reports/                 Reports CSV generados por scripts/audit-*
├─ scripts/                 Scripts Node.js .mjs idempotentes (setup B2B + branding)
├─ sections/                Secciones Liquid del tema (incluye b2b-* específicas)
├─ snippets/                Snippets Liquid reutilizables
├─ supabase/                Edge functions + cron + migrations
└─ templates/               Plantillas Liquid (incluye templates/customers/* deprecadas con new accounts)
```

## Stack

- **Shopify Plan Grow** (target) / Development (actual) — tienda, B2B
  nativo, custom roles, Shopify Messaging.
- **Tema Dawn customizado** — fork del Dawn upstream con sync semanal vía
  GitHub Actions (`.github/workflows/dawn-sync.yml`).
- **Shopify B2B nativo** — Companies, Catalogs, Price Lists, Company
  Location Catalogs.
- **Locksmith** (app) — gate de catálogo (1 lock).
- **Liquid en `layout/theme.liquid`** — gate complementario (anónimos,
  rechazados, redirect /checkout→/cart).
- **Shopify Flow** — workflows W1, W2, W3, W5 (registro, aprobación,
  rechazo, solicitud).
- **Supabase** (Deno edge functions + pg_cron) — 4 funciones que
  complementan a Flow:
  `promote-whitelist-matches` (W4),
  `create-company-for-customer` (helper W1/W2),
  `submit-order-request` (Fase D),
  `list-order-requests` (Fase D).
- **GitHub** + integración nativa GitHub↔Shopify — deploy automático del
  tema al hacer push a `main`.

## Cómo arrancar localmente

### Para editar el tema

Esto es un **tema Shopify estándar 2.0**. Para previsualizar localmente
con cambios en caliente:

```bash
# Pre-requisito: Shopify CLI instalado (https://shopify.dev/docs/themes/tools/cli)
shopify auth login --store=ledsc4-b2b-outlet.myshopify.com
shopify theme dev
```

`shopify theme dev` levanta un servidor local que usa los archivos del
filesystem y refleja los datos reales de la tienda (productos,
metafields, etc.). Útil para iteración rápida en Liquid/CSS/JS.

> **Caveat**: el gate de `theme.liquid` no dispara en
> `*.shopifypreview.com` (intencional — ver
> [docs/operations-runbook.md §5](docs/operations-runbook.md)). La
> validación funcional del gate solo se hace tras `Publish` en
> producción.

### Para correr scripts de setup B2B

Los scripts en `scripts/` son Node.js puros (sin `package.json`,
dependencias built-in). Necesitan variables de entorno:

```
SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxx       # Custom App con scopes ver scopes en docs/operations-runbook.md §3
SHOPIFY_API_VERSION=2025-10
```

Definidas en un fichero `.env` (gitignored). Convención del proyecto:
`shopify-ledsc4-theme.env` en la raíz del repo.

```bash
node --env-file=shopify-ledsc4-theme.env scripts/<script>.mjs --dry-run
node --env-file=shopify-ledsc4-theme.env scripts/<script>.mjs
```

Todos los scripts son idempotentes (re-ejecutables sin duplicar) y
soportan `--dry-run`. Orden recomendado en
[docs/data-model.md §7](docs/data-model.md#7-scripts-incluidos).

### Para deployar edge functions Supabase

```bash
# Pre-requisito: Supabase CLI + autenticado
cd supabase/
supabase functions deploy <nombre-función> --project-ref mbjvmhaglbhnxoccwyex
```

Detalle completo en [supabase/README.md](supabase/README.md) y
runbook de rotación de secrets en
[docs/operations-runbook.md §3](docs/operations-runbook.md#3-rotaci%C3%B3n-de-shopify_admin_token).

## Documentos clave

Empieza por aquí si vienes nuevo al proyecto:

| Documento | Para qué |
|---|---|
| [docs/arquitectura.md](docs/arquitectura.md) | **Visión general en 15 minutos.** Stack, fases, flujos, gate, login, solicitudes. Punto de entrada. |
| [docs/historia-decisiones.md](docs/historia-decisiones.md) | ADRs ligeros — las 6 decisiones que más cambiaron la arquitectura desde el kickoff. |
| [docs/data-model.md](docs/data-model.md) | Modelo de datos completo: tags, metafields, catálogo, scripts, rol staff. |
| [docs/operations-runbook.md](docs/operations-runbook.md) | Runbook de mantenimiento: deploy, rotación de secrets, edge functions, smoke tests. |
| [docs/locksmith-rules.md](docs/locksmith-rules.md) | Implementación detallada del gate (Locksmith + Liquid). |
| [docs/shopify-customer-accounts-branding.md](docs/shopify-customer-accounts-branding.md) | Branding del login (new customer accounts). |
| [docs/grow-migration-checklist.md](docs/grow-migration-checklist.md) | Pendientes para el cutover Development→Grow. |

Guías de equipo:

| Documento | Audiencia |
|---|---|
| [docs/backoffice-aprobaciones.md](docs/backoffice-aprobaciones.md) | Staff con rol "Backoffice Aprobaciones" — cómo aprobar/rechazar altas. |
| [docs/backoffice-solicitudes.md](docs/backoffice-solicitudes.md) | Staff de backoffice — gestión de Draft Orders B2B. |

Workflows:

- [flows/](flows/) — walkthroughs detallados de W1, W2, W3, W4, W5.
- [supabase/README.md](supabase/README.md) — edge functions + cron.
- [email-templates/](email-templates/) — bodies de los 7 emails.

Test:

- [docs/test-scenarios.md](docs/test-scenarios.md) — escenarios Fase B
  (registro y aprobación).
- [docs/test-scenarios-fase-d.md](docs/test-scenarios-fase-d.md) —
  escenarios Fase D (solicitud de pedido).

## Convenciones del repo

- **Documentación viva en español**, scripts y código en inglés.
- **`main` = producción**. Trabajo nuevo en feature branches con PR.
- **Scripts idempotentes** y con `--dry-run`. Si un script no tiene
  `--dry-run`, considéralo bug.
- **Auditoría** de invariantes con `node scripts/audit-customer-state.js`
  entre cada cambio que toque tags o Companies.
- **Email backoffice hardcoded** en algunos Flows (Flow no acepta
  variables en `Send internal email > To`). Lista de ubicaciones en
  [docs/hardcoded-emails.md](docs/hardcoded-emails.md).
- **Secrets nunca en el repo**. `.env`, `*.env`, `.mcp.json` están en
  `.gitignore`. Para rotaciones ver
  [operations-runbook §3](docs/operations-runbook.md#3-rotaci%C3%B3n-de-shopify_admin_token).

## Estado actual

- ✅ Fase A — modelo de datos (metafields, catalog, smart collection, role)
- ✅ Fase B — registro y aprobación (W1, W2, W3, W4)
- ✅ Fase C — storefront gate (Locksmith Rule 2 + Liquid Rules 1+3)
- ✅ Fase D — solicitud de pedido (formulario + Supabase + Draft Order + W5)
- ✅ Branding de login (Customer Accounts Branding API)
- ⏳ Cutover Development → Grow ([checklist](docs/grow-migration-checklist.md))
- ⏳ Conector ERP (Microsoft AX → Shopify, ver [arquitectura §9](docs/arquitectura.md#9-conector-erp--pendiente))
- ⏳ Rediseño visual de los 7 emails ([checklist §7](docs/grow-migration-checklist.md))
