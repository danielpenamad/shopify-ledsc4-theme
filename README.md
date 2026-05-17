# LedsC4 B2B Outlet — Shopify theme

Portal mayorista privado de LedsC4 sobre Shopify para liquidar fin de
colección a clientes profesionales (instaladores, arquitectos, retail,
distribuidores). El portal vive en
`ledsc4-b2b-outlet.myshopify.com`, comparte tienda con la web pública de
LedsC4 vía B2B nativo de Shopify, y solo muestra catálogo y precios a
clientes que pasan por un proceso de alta (auto-aprobación por whitelist
o aprobación manual por backoffice).

Este repositorio contiene el **tema Shopify** (Dawn customizado), el
**pipeline de importación**, los **scripts de setup B2B**, los
**walkthroughs de Shopify Flow**, las **plantillas de email** y las
**edge functions de Supabase** que complementan a Shopify Flow para
operaciones que su sandbox no permite. La rama `main` está conectada al
tema live vía la integración nativa GitHub↔Shopify — cualquier commit
que toque el theme se deploya automáticamente al storefront en ~30-60
segundos.

## Mapa de carpetas

```
.
├─ .github/workflows/       4 workflows GitHub Actions
├─ assets/                  CSS, JS, imágenes, fuentes del tema
├─ config/                  settings_data.json (live) + settings_schema.json
├─ docs/                    Documentación — sitio MkDocs (ver §Documentación)
├─ email-templates/         Bodies Liquid de emails — legacy (ver nota)
├─ flows/                   Walkthroughs de los workflows Shopify Flow
├─ layout/                  Layouts Liquid (theme.liquid contiene el gate)
├─ locales/                 Traducciones del tema
├─ pages/                   Markdown de páginas estáticas (no usado activamente)
├─ reports/                 Output CSV de los scripts de auditoría (gitignored)
├─ samples/                 Ficheros de muestra para desarrollo
├─ scripts/                 Scripts Node.js .mjs (importer + setup B2B + branding)
├─ sections/                Secciones Liquid del tema (incluye b2b-* y admin-backoffice-*)
├─ snippets/                Snippets Liquid reutilizables
├─ supabase/                Edge functions + cron + migrations
└─ templates/               Plantillas Liquid (incluye templates/customers/* legacy)
```

> **Nota**: `email-templates/` es legacy. Tras la migración a Shopify
> Email, la fuente de verdad del copy de emails es Shopify Email, no
> estos ficheros. Detalle en
> [docs/desarrollo/08-emails-transaccionales.md](docs/desarrollo/08-emails-transaccionales.md).

## Stack

- **Shopify Plan Grow** — tienda, B2B nativo, custom roles,
  Shopify Messaging. Ver [D1](docs/desarrollo/adrs/d01-plan-grow.md).
- **Tema Dawn customizado** — fork del Dawn upstream con sync vía GitHub
  Actions (`.github/workflows/dawn-sync.yml`).
- **Shopify B2B nativo** — Companies, Catalogs, Price Lists, Company
  Location Catalogs.
- **Locksmith** (app) — gate de catálogo (1 lock).
- **Liquid en `layout/theme.liquid`** — gate complementario (anónimos,
  rechazados, redirect /checkout→/cart).
- **Shopify Flow** — workflows W1, W2, W3, W5 (registro, aprobación,
  rechazo, solicitud).
- **Supabase** (Deno edge functions + pg_cron + Postgres) — 10 edge
  functions que complementan a Flow, más cron y base de datos. Inventario
  completo en [docs/desarrollo/11-supabase.md](docs/desarrollo/11-supabase.md)
  y [supabase/README.md](supabase/README.md).
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
> `*.shopifypreview.com` (intencional). La validación funcional del gate
> solo se hace tras `Publish` en producción. Detalle en
> [docs/desarrollo/04-storefront-gate.md](docs/desarrollo/04-storefront-gate.md).

### Para correr scripts de setup B2B e importer

Los scripts en `scripts/` son Node.js `.mjs`. Los de setup B2B usan solo
APIs built-in; el importer con `--with-db` necesita la dependencia
opcional `pg` (`npm install`). Necesitan variables de entorno:

```
SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxx
SHOPIFY_API_VERSION=2025-10
```

Definidas en un fichero `.env` (gitignored). Convención del proyecto:
`shopify-ledsc4-theme.env` en la raíz del repo.

```bash
node --env-file=shopify-ledsc4-theme.env scripts/<script>.mjs --dry-run
node --env-file=shopify-ledsc4-theme.env scripts/<script>.mjs
```

Todos los scripts son idempotentes (re-ejecutables sin duplicar) y
soportan `--dry-run`.

### Para deployar edge functions Supabase

```bash
# Pre-requisito: Supabase CLI + autenticado
cd supabase/
supabase functions deploy <nombre-función> --project-ref mbjvmhaglbhnxoccwyex
```

Detalle completo en [supabase/README.md](supabase/README.md).

## Documentación

La documentación vive en `docs/` y se publica como sitio MkDocs Material
en GitHub Pages tras cada merge a `main` que la afecte:

**Sitio público:** https://danielpenamad.github.io/shopify-ledsc4-theme/

Está organizada por audiencias:

| Eje | Para quién | Empieza por |
|---|---|---|
| [`docs/desarrollo/`](docs/desarrollo/) | Equipo técnico | [00-arquitectura.md](docs/desarrollo/00-arquitectura.md) — visión general |
| [`docs/administracion/`](docs/administracion/) | Administrador del negocio | [00-vision-general.md](docs/administracion/00-vision-general.md) |
| [`docs/operador/`](docs/operador/) | Operador de back-office | [00-flujo-diario.md](docs/operador/00-flujo-diario.md) |

El eje de desarrollo incluye los **ADRs** (Architecture Decision
Records) en [docs/desarrollo/adrs/](docs/desarrollo/adrs/) — D1 a D14,
las decisiones técnicas que más definieron la arquitectura.

> Los `.md` sueltos en la raíz de `docs/` (`arquitectura.md`,
> `data-model.md`, `historia-decisiones.md`, etc.) son documentación
> histórica anterior a la estructura por ejes. Su contenido vivo se ha
> ido refundiendo en `docs/desarrollo/`; quedan pendientes de archivar.

## Convenciones del repo

- **Documentación viva en español**, scripts y código en inglés.
- **`main` = producción**. Trabajo nuevo en feature branches con PR.
  Detalle en [docs/desarrollo/12-github-repo.md](docs/desarrollo/12-github-repo.md).
- **Scripts idempotentes** y con `--dry-run`. Si un script no tiene
  `--dry-run`, considéralo bug.
- **Conventional Commits** con scope (`docs(desarrollo): …`, `fix(edge): …`).
- **`package-lock.json` no se versiona** — política deliberada, ver
  [12-github-repo §5](docs/desarrollo/12-github-repo.md).
- **Secrets nunca en el repo**. `.env`, `*.env`, `.mcp.json`, `.claude/`
  están en `.gitignore`.

## Estado actual

- ✅ Fase A — modelo de datos (metafields, catalog, smart collection, role)
- ✅ Fase B — registro y aprobación (W1, W2, W3, W4)
- ✅ Fase C — storefront gate (Locksmith Rule 2 + Liquid Rules 1+3)
- ✅ Fase D — solicitud de pedido (formulario + Supabase + Draft Order + W5)
- ✅ Branding de login (Customer Accounts Branding API)
- ✅ Importer (pipeline SFTP → Supabase → Shopify)
- ✅ Multidivisa Currency-B (presentación EUR/USD/GBP)
- ✅ Cutover Development → Grow (13-may-2026)
- ⏳ Conector ERP (Microsoft AX → Shopify)
