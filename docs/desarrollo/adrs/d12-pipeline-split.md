# D12 · Pipeline split: sftp-sync (Edge) → ledsc4-import.yml (GHA)

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · PR-A1 + PR-A2 (mayo 2026) · vigente.

## Contexto

El importer ejecuta dos clases de trabajo con perfiles de ejecución muy distintos:

1. **Adquisición de datos** — conexión SFTP al servidor del cliente, descarga de 8 CSVs (~4 MB total), persistencia en Supabase Storage, registro de run. Pesa poco computacionalmente (transferencia I/O), tarda segundos.
2. **Procesamiento + escritura** — parsing de 745 productos × 6 idiomas, mapping a modelo Shopify, pre-upload de ~2700 imágenes ([D11](d11-image-pre-upload.md)), mutaciones GraphQL `productSet` + `translationsRegister` + `publishablePublish`. Tarda **~688s en run completo desde caché vacía**, ~460s en re-runs.

Restricciones técnicas:

- **Supabase Edge Functions tienen 60s de timeout** (Deno Edge runtime). Imposible ejecutar el writer completo.
- **Edge runtime no soporta `pg` nativamente** — el writer escribe en `private.sku_state` y `private.image_cache` con `pg.Client`, requiere conexión TCP completa.
- **Memoria limitada** del Edge runtime — los 6 CSVs en memoria + modelo Shopify completo + buffers de imágenes superan los límites prácticos.
- **`pg_cron` solo puede invocar SQL** desde Postgres, no triggers HTTP directos. Necesita un edge function como puente.

Las dos clases de trabajo no pueden vivir en el mismo runtime. Y la primera tiene que vivir en Edge por la integración con `pg_cron`.

## Decisión

Pipeline en **dos componentes** conectados por `private.import_runs` + `repository_dispatch`:

```
┌────────────────┐    ┌──────────────┐    ┌────────────────────┐
│   pg_cron       │───▶│  sftp-sync   │───▶│ ledsc4-import.yml  │
│  (5 schedules)  │    │  (Edge Fn)   │    │   (GHA workflow)   │
└────────────────┘    └──────────────┘    └────────────────────┘
                              │                       │
                              ▼                       ▼
                       ┌────────────────────────────────┐
                       │ private.import_runs (DB state)   │
                       └────────────────────────────────┘
                              │                       │
                              ▼                       ▼
                       ┌────────────────────────────────┐
                       │ Storage: ledsc4-imports/runs/<id>│
                       │   ├─ inputs/productos/...        │
                       │   ├─ inputs/stock/...            │
                       │   ├─ inputs/precios/...          │
                       │   └─ reports/...                 │
                       └────────────────────────────────┘
```

### Responsabilidades

**`sftp-sync` (Supabase Edge Function)** — `supabase/functions/sftp-sync/index.ts`:

1. Crea row en `private.import_runs` con `status='started'`, `kind='full'|'stock_only'`.
2. Conecta al SFTP del cliente, descarga los ficheros correspondientes al `kind`.
3. Sube cada fichero a `ledsc4-imports/runs/<run_id>/inputs/...` preservando la estructura de directorios (`productos/`, `stock/`, `precios/`).
4. Actualiza row: `status='downloaded'`, `files=[{name, path_in_storage, size_bytes, sftp_mtime}, ...]`.
5. Dispara `repository_dispatch` a GHA con `event_type='ledsc4-import'` y `client_payload={run_id}`.

**`ledsc4-import.yml` (GitHub Actions)** — `.github/workflows/ledsc4-import.yml`:

1. **Fetch metadata** del row vía `pg.Client` directo a Supabase. Valida `status='downloaded'`.
2. **Download files** desde Storage usando los paths del campo `files`.
3. **Mark processing**: `UPDATE status='processing' WHERE status='downloaded'`. Conditional para prevenir re-disparos del mismo `run_id`.
4. **Run writer**: invoca `runFullImport` o `runStockOnly` de `scripts/import-write.mjs` con `dbConnection` abierta.
5. **Upload reports** a `ledsc4-imports/runs/<run_id>/reports/`.
6. **Close run** (always): `completed` si writer ok, `failed` si stage='writer', sin tocar la row si la falla es pre-writer (operador puede re-disparar contra el mismo `run_id`).

### Triggers del workflow

Dual-source:

- **`workflow_dispatch`** — invocación manual desde UI o `gh workflow run`. Acepta `run_id` (required) y `kind_override` (optional choice).
- **`repository_dispatch`** — invocación automática desde `sftp-sync` vía `POST /repos/.../dispatches` con `event_type='ledsc4-import'` y `client_payload={run_id}`. Solo `run_id` viaja en el payload; `kind` se resuelve desde la row.

`RUN_ID: ${{ inputs.run_id || github.event.client_payload.run_id }}` — exactamente uno se popula por invocación.

### Máquina de estados

```
started ──→ downloaded ──→ processing ──→ completed
   │              │              │            
   │              │              └──→ failed (stage=writer|upload_reports)
   │              │              
   │              └─ [pre-writer failure] → row intacta, GHA red
   │              
   └─ [sftp-sync failure] → row marcada failed con error_stage
```

Solo `downloaded` es procesable. Reruns requieren fresh `run_id` (nueva invocación de `sftp-sync`).

## Alternativas consideradas

**Writer en Edge Function.** Descartada por las restricciones de plataforma (60s timeout, sin `pg`, memoria limitada). El run completo tarda ~688s — imposible en Edge.

**Writer en Supabase pgsql (procedure).** Descartada: el writer hace llamadas a Shopify GraphQL, Shopify Files API, fetch externo a la CDN del cliente. Postgres no es runtime para eso.

**Writer en runner self-hosted (VPS propio).** Descartada por coste operativo (mantener VPS, deploys, monitoreo). GHA es runtime gratis con el plan actual.

**Webhook directo de Storage → GHA** (sin row de control). Descartada: sin estado intermedio en DB, no hay forma de:
- Distinguir runs duplicados.
- Reintentar un run fallido manualmente con el mismo input.
- Auditar el histórico de qué se procesó y con qué resultado.

**`pg_cron` invocando GHA directamente.** Descartada: `pg_cron` no puede llamar HTTP externo. Necesita pasar por una función Postgres o un edge function intermedio. El edge function ya tiene que hacer el SFTP — añadir la responsabilidad de disparar el workflow es coste marginal.

## Consecuencias

- **Latencia entre disparo SFTP y arranque del writer**: ~10-30s (tiempo de queue de GHA workflow + setup runner + npm install). Aceptable para un cron que tarda 10+ minutos.
- **Dispatch best-effort**: `repository_dispatch` puede fallar (rate-limit GHA API, transient errors). Mitigación: el row queda en `downloaded`, operador puede re-disparar manualmente con `workflow_dispatch` pasando el `run_id`. Documentado en [13-github-actions](../13-github-actions.md).
- **Conditional UPDATE en `mark_processing`**: previene race conditions si dos workflows aciertan a ejecutarse sobre el mismo `run_id` (escenario: dispatch best-effort + workflow_dispatch manual simultáneos). El segundo workflow ve `rowCount=0` y aborta con error.
- **Pre-writer failures dejan la row intacta** (`status='downloaded'`). El operador puede re-disparar `workflow_dispatch` contra el mismo `run_id` sin generar uno nuevo. Reduce coste de re-bajar del SFTP.
- **Reports siempre se intentan subir** (`if: always()`). Incluso runs fallidos producen logs accesibles desde Supabase Storage para debug.
- **Secrets viven en dos planos**:
  - **Supabase** (`sftp-sync`): credenciales SFTP, `GITHUB_TOKEN` para `repository_dispatch`, `supabase_anon_key` para llamarse a sí mismo desde `pg_cron`.
  - **GHA secrets** (workflow): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_TOKEN`.
  Inventario completo en [14-secrets](../14-secrets.md).
- **Observabilidad fragmentada**: el log de un run vive en (a) Supabase logs del Edge, (b) `cron.job_run_details` si el disparo fue desde cron, (c) GHA workflow run, (d) row de `import_runs`, (e) `reports/run.log` en Storage. No hay tracing unificado. Para depurar, suele bastar empezar por `import_runs` (status + error_stage) y derivar a los otros logs.
- **No lockfile en npm** — el repo ignora `package-lock.json` (policy Shopify theme). El workflow usa `npm install`, no `npm ci`, y sin caché de setup-node. Documentado en [12-github-repo](../12-github-repo.md).
- **`verify_jwt=true` en `sftp-sync`**: la URL pública del edge function rechaza requests sin JWT. `pg_cron` inyecta la anon key via `private.invoke_edge_function(..., with_auth=true)`. Documentado en [11-supabase](../11-supabase.md).

## Cambios

- **v0.1** (15-may-2026): primera publicación.
