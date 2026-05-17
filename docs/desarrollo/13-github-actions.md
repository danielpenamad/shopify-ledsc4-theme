# 13 · GitHub Actions

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

`.github/workflows/` contiene 4 workflows de GitHub Actions. Este doc explica qué hace cada uno, cuándo se dispara, qué permisos y secrets usa, y los detalles de operación que no son evidentes leyendo el YAML.

Los 4 workflows cubren cuatro cosas independientes:

| Workflow | Para qué |
| --- | --- |
| `docs.yml` | Despliega el sitio MkDocs a GitHub Pages |
| `test-edge-functions.yml` | Corre los tests Deno de las edge functions en cada PR que las toca |
| `dawn-sync.yml` | Sincroniza el fork con `Shopify/dawn` upstream una vez por semana |
| `ledsc4-import.yml` | Ejecuta el writer del importer end-to-end contra Shopify y Supabase |

No se cubre aquí: la integración nativa GitHub↔Shopify que deploya el theme — esa **no es un GitHub Action**, es una integración del lado de Shopify (ver 12-github-repo §2). Tampoco el detalle del pipeline del importer (ver 02-importer, 02b-importer-deploy) ni del proyecto Supabase (ver 11-supabase).

Lectores principales: cualquier dev o IA que necesite entender la automatización del repo antes de tocar un workflow, debugear un run fallido, o disparar una importación manual.

## 2. `docs.yml` — despliegue del sitio MkDocs

Construye el sitio de documentación con MkDocs Material y lo publica en GitHub Pages.

### Triggers

- `push` a `main` que toque `docs/**`, `mkdocs.yml`, o el propio `.github/workflows/docs.yml`.
- `workflow_dispatch` — disparo manual desde la pestaña Actions.

El filtro de `paths` es lo que hace que un commit que solo toca código del theme no rebuilde la documentación, y viceversa.

### Permisos y concurrency

```yaml
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: false
```

Los permisos `pages: write` + `id-token: write` son los que exige `actions/deploy-pages`. El `concurrency` con grupo `pages` y `cancel-in-progress: false` serializa los despliegues: si llegan dos pushes seguidos, el segundo espera a que el primero termine en vez de cancelarlo — evita dejar Pages en un estado intermedio.

### Jobs

Dos jobs encadenados (`deploy` con `needs: build`):

- **`build`** — checkout, `actions/setup-python@v5` con Python 3.11, `pip install mkdocs-material`, `mkdocs build`, y sube el directorio `site/` como artifact de Pages con `actions/upload-pages-artifact@v3`.
- **`deploy`** — `actions/deploy-pages@v4`, environment `github-pages`. Publica el artifact.

Detalle no obvio: `pip install mkdocs-material` instala la última versión sin pin. Si MkDocs Material publica un cambio incompatible, el build podría romperse sin que nada del repo haya cambiado. Anotado en pendientes.

## 3. `test-edge-functions.yml` — tests Deno en PR

Corre la suite de tests de las edge functions de Supabase.

### Trigger

- `pull_request` que toque `supabase/functions/**`, `tests/edge-functions/**`, o el propio workflow.

Solo en PR, no en push a `main`. Es un gate de revisión: el resultado del workflow aparece en el PR antes del merge.

### Job

Un job único: checkout, `denoland/setup-deno@v1` con `deno-version: v1.x`, y `deno test tests/edge-functions/ --allow-all`.

Las edge functions están escritas en Deno (no Node), de ahí el runtime Deno. `--allow-all` concede todos los permisos al runner de tests — aceptable en CI porque el código bajo test es el del propio repo.

Detalle de operación: el workflow **no** es un check obligatorio configurado en branch protection (hoy `main` se protege por disciplina, no por configuración — ver 12-github-repo §8, nota operativa). Aparece en el PR pero no bloquea el merge si falla. Si quien gobierne el repo activa branch protection en `main`, este workflow es el candidato natural a check requerido.

## 4. `dawn-sync.yml` — sync con Shopify/dawn upstream

El theme es un fork de `Shopify/dawn`. Este workflow trae los cambios del Dawn upstream al repo de forma periódica, abriendo un PR para revisión manual.

### Triggers

- `schedule`: cron `0 8 * * 1` — todos los lunes a las 08:00 UTC (09:00 invierno / 10:00 verano hora de Madrid).
- `workflow_dispatch` — disparo manual.

### Permisos

```yaml
permissions:
  contents: write
  pull-requests: write
```

`contents: write` para poder hacer commits de la rama de sync; `pull-requests: write` para que `peter-evans/create-pull-request` abra el PR.

### Flujo del job

1. **Checkout** de `main` con `fetch-depth: 0` (historia completa, necesaria para el merge).
2. **Configura git** con un bot identity (`dawn-sync-bot`).
3. **Fetch upstream** — añade el remote `upstream` apuntando a `https://github.com/Shopify/dawn.git`, hace fetch de `upstream/main`, y cuenta cuántos commits por detrás está el fork (`git rev-list --count HEAD..upstream/main` → output `behind`). Si `behind` es 0, el workflow no hace nada más.
4. **Attempt merge** (solo si `behind != 0`) — intenta `git merge upstream/main`. El step tiene `continue-on-error: true` y produce un output `status`:
   - `status=clean` si el merge no tuvo conflictos.
   - `status=conflicts` si los hubo — en ese caso hace `git add -A && git commit` para dejar los archivos con los markers de conflicto commiteados, de modo que `peter-evans/create-pull-request` pueda abrir el PR igualmente.
5. **Create or update PR** (solo si `behind != 0`) — `peter-evans/create-pull-request@v6` abre o actualiza un PR desde la rama `automated/dawn-sync` a `main`, con labels `dawn-upstream` y `automated`.

### El PR de sync

El cuerpo del PR generado lista los archivos propios con **alta probabilidad de conflicto** — las customizaciones LedsC4 sobre Dawn:

- `layout/theme.liquid`
- `sections/header.liquid`, `sections/footer.liquid`, `sections/main-product.liquid`
- `assets/base.css`, `assets/section-product-custom.css`
- `config/settings_data.json`, `config/settings_schema.json`

Y aclara que las piezas nuevas del proyecto B2B (`sections/b2b-*.liquid`, `snippets/b2b-*`, `templates/page.b2b-*`) **no** deberían tener conflictos, porque Dawn no las toca — son archivos que solo existen en el fork.

Si el PR sale con `status=conflicts`, hay que resolver los markers a mano antes de mergear: checkout de `automated/dawn-sync`, resolver en el editor, `git commit --amend`, `git push --force-with-lease`.

### Relación con el deploy del theme

`dawn-sync.yml` solo abre el PR. El deploy ocurre **al mergear** ese PR a `main` — y no por este workflow, sino por la integración nativa GitHub↔Shopify (ver 12-github-repo §2). Es decir: el workflow trae el código, el merge lo despliega.

## 5. `ledsc4-import.yml` — el writer del importer

El workflow más complejo de los cuatro (Fase A — PR-A1 + PR-A2). Ejecuta el writer del importer (`runFullImport` / `runStockOnly`) end-to-end: toma un run que `sftp-sync` ya dejó listo, descarga los CSV, los procesa contra Shopify y Supabase, y cierra el run.

Este workflow es la segunda mitad del pipeline de importación. La primera mitad — `sftp-sync` descargando del SFTP del proveedor a Storage — se documenta en 02b-importer-deploy. El detalle del writer en sí (parse, map, write) está en 02-importer. Aquí se documenta el workflow como orquestador.

### Triggers

- **`workflow_dispatch`** — disparo manual. Inputs:
  - `run_id` (required) — UUID del row de `private.import_runs` a procesar.
  - `kind_override` (optional, choice `''` / `full` / `stock_only`) — fuerza el tipo de import. Vacío = usar el `kind` de la row.
- **`repository_dispatch`** con `event_type: ledsc4-import` — disparo automático. Lo emite `sftp-sync` con un `client_payload` que contiene solo `run_id`. El `kind` no viaja en el payload; se resuelve desde la row.

### Patrón dual-source de inputs

Como hay dos triggers que aportan el `run_id` por vías distintas, el workflow lo resuelve con un fallback:

```yaml
RUN_ID: ${{ inputs.run_id || github.event.client_payload.run_id }}
KIND_OVERRIDE: ${{ inputs.kind_override || '' }}
```

`workflow_dispatch` rellena `inputs`; `repository_dispatch` rellena `github.event.client_payload`. Exactamente uno está poblado por invocación, y el `||` elige el no vacío. `kind_override` solo existe en la vía `workflow_dispatch`.

### Permisos, runner, timeout

```yaml
permissions:
  contents: read
timeout-minutes: 60
```

Permisos mínimos — el workflow no escribe en el repo, solo lee el código. El timeout de 60 min es la cota para un import completo.

### Secrets

| Secret | Para qué |
| --- | --- |
| `SUPABASE_URL` | Base URL del proyecto Supabase (Storage API) |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth para descargar/subir en Storage |
| `SUPABASE_DB_URL` | Connection string Postgres (lee/escribe `private.import_runs`, upsert `sku_state`) |
| `SHOPIFY_SHOP` | Dominio de la tienda — se mapea a `SHOPIFY_STORE_DOMAIN` en el env |
| `SHOPIFY_ADMIN_TOKEN` | Auth de la Admin API para el writer |

Constantes (no secrets): `STORAGE_BUCKET: ledsc4-imports`, `REPORT_PREFIX: runs/<run_id>/reports/`.

### Política de lockfile en este workflow

El setup de Node merece atención porque toca la política de lockfile (ver 12-github-repo §5):

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 20
- run: npm install --no-audit --no-fund
```

`setup-node` **sin** `cache: npm`, y `npm install` **en vez de** `npm ci`. Ambas cosas requerirían un `package-lock.json` versionado, y el repo lo ignora por política. El propio workflow lleva un comentario advirtiendo de no reintroducir ni el cache ni `npm ci` sin cambiar antes esa política. La única dependencia que `npm install` resuelve aquí es `pg`, que el writer usa para hablar con Postgres.

### Pasos del job

El job `writer` ejecuta, en orden:

1. **checkout** + **setup-node** + **`npm install`**.
2. **Setup tmp dirs** — crea `tmp/inputs` y `tmp/reports`.
3. **Fetch run metadata** — consulta la row de `private.import_runs` por `run_id`. Guard estricto: el `status` **debe** ser `downloaded`; cualquier otro valor aborta. Resuelve el `kind` (override o el de la row) y pasa el JSON de `files` al step siguiente.
4. **Download files from Storage** — descarga cada fichero listado en `files` desde el bucket `ledsc4-imports`, preservando los subdirectorios (`productos/`, `stock/`, `precios/`) bajo `tmp/inputs`. El writer espera esos subdirs literalmente.
5. **Mark run as processing** — `UPDATE ... SET status='processing' WHERE id=$1 AND status='downloaded'`. El `WHERE` condicional es un lock anti-race: si otra invocación concurrente sobre el mismo `run_id` ya lo cambió, este UPDATE afecta 0 filas y el workflow aborta.
6. **Run writer** — importa `./scripts/import-write.mjs` y llama `runFullImport` o `runStockOnly` con la conexión a la BD abierta (para el upsert de `sku_state`). Captura stdout/stderr a `tmp/reports/run.log` y escribe `tmp/writer-result.json` con el resultado.
7. **Upload reports to Storage** (`if: always()`) — sube todo `tmp/reports/*` a `runs/<run_id>/reports/` en el bucket. Corre siempre, incluso si el writer falló, para preservar el log.
8. **Close import_runs row** (`if: always()`) — cierra el run según el resultado.

### Máquina de estados y el cierre del run

El comportamiento del último step es el detalle más importante para operar el workflow. `private.import_runs` tiene la FSM `started → downloaded → processing → completed | failed` (ver 11-supabase §5). Este workflow gestiona la transición `downloaded → processing → completed|failed`:

- Si `tmp/writer-result.json` indica `ok: true` → `UPDATE ... SET status='completed', counts=..., completed_at=now() WHERE id=$1 AND status='processing'`.
- Si el resultado indica `stage: writer` (el writer se ejecutó y falló) → `status='failed'` con `error_stage`, `error_message`, `failed_at`.
- Si la falla fue **pre-writer** (en `fetch_metadata`, `download` o `mark_processing`) → **la row no se toca**. Queda en su estado original, y el operador puede re-disparar el workflow contra el mismo `run_id`. El run de GitHub Actions sale en rojo, que es la señal.

Todos los UPDATE de cierre llevan `WHERE ... AND status='processing'`: nunca sobrescriben una row que no esté en el estado que este workflow marcó. Una row `completed` o `failed` es historia inmutable.

### Reruns

Un run en estado `completed` o `failed` **no** se puede reprocesar — el guard de `Fetch run metadata` exige `downloaded`. Para reimportar hay que generar un `run_id` nuevo, lo que significa una nueva invocación de `sftp-sync`. Esto es deliberado: cada `run_id` representa una descarga concreta del SFTP, y reprocesar con datos viejos no tendría sentido.

## 6. Política de lockfile y los workflows

Resumen del punto que afecta a más de un workflow: el repo no versiona `package-lock.json` (ver 12-github-repo §5). Consecuencias en GitHub Actions:

- `ledsc4-import.yml` usa `npm install`, no `npm ci`, y `setup-node` sin `cache: npm`. Ambas alternativas exigen lockfile.
- `docs.yml` no usa npm en absoluto (es Python/MkDocs), así que no le afecta.
- `test-edge-functions.yml` usa Deno, que resuelve dependencias por URL sin `node_modules` ni lockfile.

Si algún día se decide versionar el lockfile, `ledsc4-import.yml` es el único workflow a actualizar (y se podría entonces activar el cache de npm para acelerarlo).

## 7. Secrets usados por los workflows

Inventario de los secrets de repositorio que consumen los workflows. El inventario maestro de todos los secrets del proyecto irá en 14-secrets.

| Secret | Workflow | Para qué |
| --- | --- | --- |
| `SUPABASE_URL` | `ledsc4-import.yml` | Base URL del proyecto (Storage API) |
| `SUPABASE_SERVICE_ROLE_KEY` | `ledsc4-import.yml` | Auth Storage (download/upload) |
| `SUPABASE_DB_URL` | `ledsc4-import.yml` | Connection string Postgres |
| `SHOPIFY_SHOP` | `ledsc4-import.yml` | Dominio de la tienda |
| `SHOPIFY_ADMIN_TOKEN` | `ledsc4-import.yml` | Auth Admin API |

`docs.yml`, `test-edge-functions.yml` y `dawn-sync.yml` no usan secrets de repositorio — operan con el `GITHUB_TOKEN` automático que GitHub Actions inyecta (los permisos declarados en cada workflow acotan qué puede hacer ese token).

## 8. Pendientes

- **`docs.yml` instala MkDocs Material sin pin de versión**. `pip install mkdocs-material` resuelve a la última versión. Un cambio incompatible upstream podría romper el build del sitio sin que nada del repo haya cambiado. Conviene fijar la versión (`mkdocs-material==X.Y.Z`) o usar un `requirements.txt` para los docs.

- **`test-edge-functions.yml` no es check obligatorio**. El workflow corre en cada PR que toca las edge functions, pero al protegerse `main` por disciplina y no por configuración (ver 12-github-repo §8, nota operativa), un PR con tests en rojo se puede mergear igual. Si se activa branch protection, marcar este workflow como check requerido.

- **`dawn-sync.yml` puede acumular conflictos no resueltos**. Si un PR de sync sale con `status=conflicts` y no se atiende, el siguiente run semanal actualiza la misma rama `automated/dawn-sync` (`delete-branch: false`) y los conflictos se acumulan. Conviene atender cada PR de sync antes del siguiente lunes, o pausar el cron si no se va a mantener.

- **`ledsc4-import.yml` — runs colgados en `processing`**. Si el workflow muere entre `Mark run as processing` y `Close import_runs row` de forma que ni siquiera corre el step de cierre (p. ej. timeout de 60 min, o cancelación), la row queda en `processing` indefinidamente. Son detectables (status `processing` con `started_at` viejo y sin `completed_at`/`failed_at`), pero no hay un proceso que los limpie automáticamente. Cross-link al runbook (16) — debería documentar cómo identificar y resolver un run colgado.

- **Sin workflow de lint/validación del theme**. No hay ningún check automático sobre el código Liquid/CSS/JS del theme. Un commit con Liquid roto se deploya a producción sin que ningún workflow lo detecte. Evaluar añadir `shopify theme check` como workflow de PR.

- **Cross-link a 14-secrets**. La tabla de §7 lista los secrets por workflow; el inventario maestro con rotación y origen de cada secret debe vivir en 14-secrets.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 16-may-2026.
