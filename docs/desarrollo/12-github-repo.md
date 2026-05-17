# 12 · Repositorio GitHub

!!! info "Estado del documento"
    **Versión:** 1.1 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

`danielpenamad/shopify-ledsc4-theme` es el repositorio único del portal B2B Outlet. Contiene el theme Shopify, el pipeline de importación, las edge functions de Supabase, los walkthroughs de Shopify Flow, las plantillas de email y toda la documentación.

Este doc explica la **estructura del repo**: qué hay en cada carpeta, qué convenciones de ramas y commits se siguen, cuál es la política de lockfile y dependencias, y cómo se organiza `docs/`.

No se cubre aquí: los GitHub Actions workflows (ver 13-github-actions), el detalle del proyecto Supabase (ver 11-supabase), ni el pipeline del importer (ver 02-importer, 02b-importer-deploy). Este doc es sobre el repo como contenedor, no sobre lo que contiene.

Lectores principales: cualquier dev o IA que aterrice en el repo y necesite el mapa — dónde está cada cosa, cómo contribuir, qué no tocar.

## 2. El repo deploya solo

Punto más importante para entender el repo: **la rama `main` está conectada al theme live vía la integración nativa GitHub↔Shopify**. Cualquier commit a `main` que toque archivos del theme se despliega automáticamente al storefront de producción en ~30-60 segundos. No hay paso de build ni de aprobación — merge a `main` es deploy a producción.

Implicaciones:

- **`main` es producción.** Nunca se hace push directo a `main` con trabajo a medias. Todo cambio va por feature branch + PR.
- **Un PR roto mergeado rompe el storefront.** No hay staging entre `main` y el theme live. El único "staging" es `shopify theme dev` en local o un theme de preview manual.
- **No todos los archivos del repo son del theme.** Shopify solo sincroniza las carpetas estándar de theme (`assets/`, `config/`, `layout/`, `locales/`, `sections/`, `snippets/`, `templates/`). El resto (`docs/`, `scripts/`, `supabase/`, `flows/`, `.github/`, etc.) viven en el mismo repo pero Shopify los ignora. Un commit que solo toca `docs/` no redespliega el theme.

El detalle de la integración GitHub↔Shopify y su comportamiento se trata en 13-github-actions y en el runbook de operaciones.

## 3. Mapa de carpetas

```
.
├─ .github/workflows/    4 workflows GitHub Actions (ver 13-github-actions)
├─ assets/               CSS, JS, imágenes, fuentes del theme
├─ config/               settings_data.json (live) + settings_schema.json
├─ docs/                 Documentación (ver §7)
├─ email-templates/      Bodies Liquid de emails — legacy, ver nota abajo
├─ flows/                Walkthroughs de los workflows Shopify Flow
├─ layout/               Layouts Liquid — theme.liquid contiene el gate B2B
├─ locales/              Traducciones del theme (ver 09-i18n)
├─ pages/                Markdown de páginas estáticas — no usado activamente
├─ reports/              Output CSV de los scripts de auditoría (gitignored salvo .gitkeep)
├─ samples/              Ficheros de muestra (CSV de ejemplo del importer, etc.)
├─ scripts/              Scripts Node.js .mjs (importer + setup B2B + branding)
├─ sections/             Secciones Liquid del theme (incluye b2b-* y admin-backoffice-*)
├─ snippets/             Snippets Liquid reutilizables
├─ supabase/             Edge functions + migrations + config (ver 11-supabase)
└─ templates/            Plantillas Liquid (incluye templates/customers/* legacy)
```

### Carpetas del theme (sincronizadas con Shopify)

`assets`, `config`, `layout`, `locales`, `sections`, `snippets`, `templates` — son las 7 carpetas del estándar Shopify Theme 2.0. Lo que se commitee aquí se deploya. Detalle de las customizaciones en 03-theme-customizaciones.

### Carpetas que no son del theme

- **`scripts/`** — Node.js `.mjs`. El pipeline del importer (`import-parse`, `import-map`, `import-write`, etc.) y los scripts de setup B2B. Ver 15-scripts (cuando exista) y 02-importer.
- **`supabase/`** — proyecto Supabase completo. Ver 11-supabase.
- **`flows/`** — walkthroughs de configuración manual de los workflows Shopify Flow. No es código ejecutable. Ver 08-emails-transaccionales §2.
- **`.github/workflows/`** — 4 workflows de GitHub Actions. Ver 13-github-actions.
- **`docs/`** — documentación, publicada como sitio MkDocs. Ver §7.
- **`reports/`** — output de los scripts de auditoría. Gitignored (`reports/*` salvo `.gitkeep`).
- **`email-templates/`** — bodies Liquid de los emails. **Legacy**: tras la migración de `Send internal email` a Shopify Email (ver 08 §4), la fuente de verdad del copy de emails es Shopify Email, no estos ficheros. Quedan como referencia histórica; pendiente de evaluar si se eliminan.
- **`pages/`** — markdown de páginas estáticas. El README raíz lo marca como "no usado activamente". Candidato a limpieza.
- **`samples/`** — ficheros de muestra para desarrollo (CSV de ejemplo del feed del proveedor, etc.).

## 4. Convenciones de ramas y commits

### Ramas

- **`main`** — producción. Protegida de facto por disciplina (ver §8 sobre branch protection). Todo merge a `main` deploya.
- **Feature branches** — todo trabajo nuevo. Convención de nombres observada en el repo:
  - `docs/<slug>` para documentación (`docs/11-supabase`, `docs/12-github-repo`).
  - `fix/<slug>` para correcciones (`fix/register-b2b-marketing-consent`).
  - Prefijos por tipo de trabajo, slug descriptivo en kebab-case.

No hay rama `develop` ni `staging` — el modelo es trunk-based: feature branch corta, PR, merge a `main`, borrar la rama.

### Commits

Convención observada: **Conventional Commits** con scope.

```
docs(desarrollo): 11 — proyecto Supabase
fix(edge): suscribir customer a marketing en register-b2b
docs(supabase): README al dia — 10 functions, 4 tablas
```

Formato: `<tipo>(<scope>): <descripción corta>` + cuerpo opcional explicando el qué y el porqué. Tipos en uso: `docs`, `fix`, `feat`, `chore`, `refactor`. Scopes habituales: `desarrollo`, `edge`, `supabase`, `importer`, `theme`.

El cuerpo del commit, cuando lo hay, es denso y explicativo — el repo trata el mensaje de commit como documentación de la decisión, no como una nota de una línea.

### Pull requests

- Un PR por unidad de trabajo coherente (un doc, un fix, un feature).
- El cuerpo del PR explica qué hace, qué no toca, y los pendientes que deja abiertos.
- Patrón de trabajo de documentación: borrador completo revisado en chat → validación → un PR único por doc.

## 5. Política de lockfile y dependencias

Decisión deliberada y poco habitual: **`package-lock.json` está en `.gitignore`**. El lockfile no se versiona.

Contexto en `package.json`:

```json
{
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.0.0" },
  "dependencies": { "pg": "^8.13.0" }
}
```

El `package.json` existe **solo** para declarar una dependencia opcional: `pg`, que usa `scripts/import-write.mjs` cuando se ejecuta con `--with-db` (upsert del fingerprint en `private.sku_state`). El propio `package.json` lo documenta en su campo `description`:

> El artefacto principal es el theme Liquid + edge functions; este `package.json` existe solo para declarar dependencias Node opcionales para el importer cuando se corre con `--with-db`. El CLI por defecto sin DB no necesita ninguna dependencia.

Por qué no se versiona el lockfile:

- El "producto" del repo es el theme Liquid + las edge functions Deno, no una aplicación Node. El theme no tiene dependencias npm; las edge functions usan imports de Deno (URLs, no `node_modules`).
- La única dependencia npm (`pg`) es opcional y de un único script. Un lockfile completo para una sola lib de uso marginal es ceremonia sin valor.
- Los scripts de setup B2B (la mayoría de `scripts/`) son Node.js puro con solo APIs built-in — sin dependencias.

Detalle no obvio que `package.json` documenta: se usa **`pg`, no `postgres@3.x`**. El segundo tiene un bug de SCRAM-SHA-256 contra el Session pooler de Supabase (la auth falla con `28P01` aunque `pg` con la misma URL funcione). Si alguien sustituye `pg` por `postgres` "porque es más moderno", romperá el `--with-db`.

Consecuencia operativa: como no hay lockfile, `npm install` resuelve `pg` a la última `8.x` compatible con el `^8.13.0`. Para un proyecto con una sola dependencia estable esto es aceptable; si el repo creciera en dependencias Node, convendría reconsiderar y versionar el lockfile.

### Scripts npm

`package.json` declara tres scripts:

| Script | Qué hace |
| --- | --- |
| `npm test` | Corre los 6 suites de test del importer (`import-parse`, `import-map`, `import-write`, `rate-limiter`, `fingerprint`, `image-upload`) |
| `npm run import:dry-run` | `node scripts/import-write.mjs` — pipeline en dry-run |
| `npm run import:apply` | `node --env-file=shopify-ledsc4-theme.env scripts/import-write.mjs --apply` — pipeline real |

## 6. Gestión de secrets

Regla absoluta: **secrets nunca en el repo**. El `.gitignore` cubre:

```
.env
.env.*
*.env
!.env.example
!*.env.example
.mcp.json
.claude/
```

Las variables de entorno reales viven en ficheros `.env` gitignored. Convención del proyecto: `shopify-ledsc4-theme.env` en la raíz del repo (lo lee `npm run import:apply` vía `--env-file`).

Los ficheros `*.env.example` sí se versionan — son plantillas sin valores reales. Hay dos: `.env.example` en la raíz y `supabase/.env.example`.

`.mcp.json` y `.claude/` están gitignored porque son configuración local por desarrollador (settings de Claude Code), no parte del proyecto.

El inventario completo de secrets se documenta en 14-secrets (cuando exista). El runbook de rotación está en el operations runbook.

## 7. Organización de `docs/`

`docs/` se publica como sitio web con MkDocs Material en GitHub Pages tras cada merge a `main` que la afecte (workflow `docs.yml`, ver 13-github-actions). Sitio: `https://danielpenamad.github.io/shopify-ledsc4-theme/`.

### Estructura por audiencias (vigente)

La estructura objetivo organiza la documentación en tres ejes por audiencia:

- **`docs/desarrollo/`** — equipo técnico. Arquitectura, pipeline, theme, Supabase, GitHub, i18n, multidivisa. Incluye `adrs/` con los ADRs D1–D14.
- **`docs/administracion/`** — administrador del negocio. Gestión de catálogo, categorías, emails, traducciones.
- **`docs/operador/`** — operador de back-office. Flujo diario, aprobar altas, whitelist, incidencias.

Cada eje tiene un `index.md`. La plantilla de ADR es: Estado · Contexto · Decisión · Alternativas · Consecuencias · Cambios.

### Material legacy plano (archivado)

Antes de la reorganización por ejes convivían en la raíz de `docs/`
archivos planos: `arquitectura.md`, `data-model.md`,
`historia-decisiones.md`, `import-pipeline.md`, `operations-runbook.md`,
`locksmith-rules.md`, `secrets.md`, `backoffice-*.md`,
`test-scenarios*.md`, `grow-migration-checklist.md`,
`hardcoded-emails.md`, `pagina-acceso-profesional.md`, `pendientes.md`,
`shopify-customer-accounts-branding.md`.

Eran la documentación v0.1 (mayo 2026), previa a la estructura por
ejes. Su contenido vivo se refundió en los docs de `desarrollo/` y los
ficheros planos se archivaron en `docs/_archive/` (PR #120), excluida
del build de MkDocs.

## 8. Pendientes

Pendientes de infraestructura del repo. El saneamiento de la
documentación —estructura por ejes, archivado del material legacy
plano en `docs/_archive/`, sincronización del `nav`, actualización de
los README y de las cabeceras de estado— se completó en los PRs
#118–#124.

- **Evaluar eliminación de `email-templates/`**. Tras la migración a
  Shopify Email (08 §4) la fuente de verdad del copy de emails ya no
  es el repo. Verificar que no se pierde nada y eliminar, o mover a
  `docs/_archive/`.

- **Evaluar `pages/`**. El README raíz la marca como no usada
  activamente. Confirmar y eliminar si procede.

- **Branch protection en `main` (nota operativa, no pendiente del
  proyecto)**. Hoy la protección de `main` es disciplina, no
  configuración. Con el modelo `main`→deploy de Shopify (cada merge
  despliega a producción sin staging), activar branch protection real
  en GitHub —requerir PR, requerir que pasen los workflows de test
  (`test-edge-functions.yml`, y un futuro lint de theme), no permitir
  push directo— es una **recomendación operativa estándar** que aplica
  quien gobierne el repo en cada momento. No es un entregable de cierre
  del proyecto, sino una práctica de operación continua. Cross-link a
  13-github-actions.

- **CODEOWNERS**. No hay fichero `CODEOWNERS`. Para cuando el repo se
  transfiera al cliente o entren más manos, definir ownership por
  carpeta (theme, supabase, docs) ayudaría a enrutar reviews. Baja
  prioridad mientras el repo tenga un solo mantenedor.

## Cambios

- **v1.1** (17-may-2026): saneadas las secciones obsoletas de §7 (eliminadas las subsecciones sobre esqueletos v0.1 y `nav` desincronizado; la subsección de material legacy plano pasada a tiempo pasado) y §8 Pendientes reescrita — toda la deuda descrita estaba ya resuelta en los PRs #118–#124.
- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 16-may-2026.
