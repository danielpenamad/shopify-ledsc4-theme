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
`verify_jwt: false` (auth por HMAC propio). `sftp-sync` y `csv-grep`
usan `verify_jwt: true`. **Heredar mal este flag rompe la función.**

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
| `csv-grep` | **true** | utilidad ops: grep en CSVs del bucket `ledsc4-imports` |

### `csv-grep` — buscar texto en CSVs del proveedor

Útil cuando un cliente dice "falta el SKU X". Confirma rápido si X está
o no en el feed del proveedor del run en cuestión, sin descargar el CSV
a mano.

```sql
SELECT private.invoke_edge_function(
  'csv-grep',
  jsonb_build_object(
    'run_id', '<uuid de private.import_runs>',
    'needle', '05-2831-81-81',   -- case-insensitive por defecto
    'max_lines', 20              -- default 50, máx 500
  ),
  true
) AS req_id;
-- Tras 1-2s leer la respuesta:
SELECT content::jsonb FROM net._http_response WHERE id = <req_id>;
```

Por defecto busca en `runs/<run_id>/productos/listado_productos_ES.csv`.
Para otros locales / stock / precios, pasar `path` explícito:

```sql
jsonb_build_object(
  'path', 'runs/<uuid>/stock/stock.csv',
  'needle', '05-2831'
)
```

## Importación nocturna (writer GHA)

El pipeline NO está dentro de la edge function `sftp-sync`. Esa edge function
**solo descarga** los CSVs del SFTP de LedsC4 al bucket `ledsc4-imports` y
dispara `repository_dispatch` (event_type=`ledsc4-import`) contra el repo;
el procesamiento real (parseo + Shopify productSet + traducciones +
inventario + image upload) lo hace el job `writer` del workflow
[.github/workflows/ledsc4-import.yml](.github/workflows/ledsc4-import.yml)
en GitHub Actions.

### Estados en `private.import_runs`

| status | quién lo escribe |
|---|---|
| `started` | `sftp-sync` al insertar la fila |
| `downloaded` | `sftp-sync` tras subir todos los CSV a Storage |
| `processing` | step "Mark run as processing" del workflow GHA |
| `completed` | step "Close import_runs row" si `writer-result.json` ok |
| `failed` | step "Close import_runs row" si `writer-result.json` no ok, **o** si el job fue cancelado externamente y el row sigue en `processing` (caso timeout) |

Un row colgado en `processing` mucho tiempo después de `started_at` significa
que el writer murió a media iteración sin escribir `writer-result.json` —
hasta el fix 2026-06-02 esto se quedaba huérfano; ahora el step de cierre
lo detecta y lo marca `failed` con `error_stage='timeout'`.

### Timeout del writer

`timeout-minutes: 180` (subido de 60 el 2026-06-02 tras 12 noches consecutivas
muriendo a los 60min). El run típico es ~17min en régimen estacionario; los
180min son margen 10× para crecimiento de catálogo o degradación del CDN.

### Cache de imágenes (`private.image_cache`)

Para evitar resubir las ~1.500 imágenes del catálogo en cada full run, cada
imagen se cachea en `private.image_cache` con dos índices de lookup:

1. **Por `source_url` (lookup pre-fetch, añadido 2026-06-02)** — short-circuit:
   si la URL ya produjo un Shopify File, devolvemos el GID sin tocar el CDN.
   Asume URLs inmutables (LedsC4 renombra el path cuando la imagen cambia).
2. **Por `sha256`** — fallback: si la URL es nueva (o falla el lookup por URL),
   descargamos el binario del CDN, calculamos hash y consultamos.

El cuello de botella histórico era el rate-limit del CDN del proveedor a
1 GET/3s. Con el cache por URL en régimen estacionario el full corre con
hit rate ~99,9% (1 GET en 1.500 imágenes) y no necesita descargar nada.

`reconcileImageCache` corre al inicio del full run y borra entradas cuyo
GID de Shopify ya no existe (media re-subida o borrada fuera de banda).

### Cómo disparar un run manual

Cuando hace falta forzar un full fuera del cron de las 02:00 UTC:

```sql
SELECT private.invoke_edge_function('sftp-sync', '{"kind":"full"}'::jsonb, true);
-- O 'stock_only' para refrescar solo inventario.
```

El edge function arranca un row nuevo en `private.import_runs` y dispara el
workflow GHA. **No** se puede relanzar un run existente con el mismo `run_id`
porque el workflow exige `status='downloaded'` (que ya se consume al pasar a
`processing`).

## Currency cosmético (display USD/GBP, factura EUR)

**El B2B logueado está clavado al Market ES — la única divisa real es EUR.**
USD/GBP son solo conversión cosmética en cliente: cookie + asset JS reescribe
los importes que Liquid ya pintó. **No tocar Markets/presentment**: rompe la
sesión cross-domain (ya pasó dos veces, ver PRs #140 y #141).

| Capa | Implementación |
|---|---|
| Tasas | EF [`update-fx-rates`](supabase/functions/update-fx-rates/index.ts) → metafield del shop `ledsc4.fx_rates` (json, storefront PUBLIC_READ). Fuente: Frankfurter (BCE, sin API key). |
| Cron | pg_cron lunes 06:00 UTC. Args tipados explícitos. |
| Switcher UI | [`snippets/currency-switcher.liquid`](snippets/currency-switcher.liquid). Click → setCookie + `CustomEvent('ledsc4:currency-changed')`. Sin redirect, sin `{% form 'localization' %}`. |
| Asset conversor | [`assets/ledsc4-currency-display.js`](assets/ledsc4-currency-display.js). Lee `window.LEDSC4_FX` (inyectado por `layout/theme.liquid` desde el metafield) y reescribe `textContent` de los nodos `[data-eur-amount]`. Símbolo `≈` solo en nodos `[data-fx-approx="1"]`. Se reaplica tras `cartUpdate`. |
| Anti-flash | Si la cookie ≠ EUR, los precios arrancan con `visibility:hidden`. Failsafe triple: timeout 1500ms, `window.onerror`, `<noscript>`. EUR no se oculta nunca. |
| Form solicitud | El submit lee la cookie y manda divisa al draft; `submit-order-request` valida EUR/USD/GBP. **El draft y la factura siguen en EUR** — la divisa mostrada se guarda como note_attribute. |

Verificar a la semana que `updated_at` del metafield `ledsc4.fx_rates` cambió
(que el cron sigue vivo).

## Unión de Companies por dominio (`create-company-for-customer` v35+)

**Modelo INVERTIDO 2026-06-14 (Víctor vía Dani): cadenas multi-delegación van
como Companies SEPARADAS.** La función ya **NO auto-siembra** dominios. Por
defecto **siempre crea Company nueva**; solo une si el dominio ya está en
`public.company_domains`, fila puesta **a mano** por un humano para fusionar.

El modelo anterior (v33-v34, auto-siembra de cada dominio nuevo) colapsaba las
cadenas: saltoki.es llegó a tener 3 contactos fusionados que no debían estarlo,
elektracat.com estaba a punto de lo mismo, y grupoelectrostocks.com (~60
buzones) / sonepar.es (~19) eran bombas latentes.

- Tabla árbitro: `public.company_domains` (PK `domain`; RLS sin policies,
  solo service role). **Gestión MANUAL**: añadir filas a mano solo para
  fusionar deliberadamente.
- Dominio con fila → unir a esa company (`joined: true, via: "domain"`,
  assign + rol admin). Dominio sin fila → crear company nueva, **sin sembrar**.
  Un segundo alias del mismo dominio no sembrado crea OTRA company.
- Dominios genéricos (gmail, hotmail…) en `GENERIC_DOMAINS` del código:
  siempre crean Company propia, sin tocar la tabla.
- **Race del MISMO customer** (Flow W1+W2 concurrentes, caso iluvi): ya no la
  cubre el `ON CONFLICT` de la siembra (eliminada). Ahora se serializa con un
  `pg_advisory_lock(hashtext(customerId))` session-level (conexión directa
  `npm:postgres` vía `SUPABASE_DB_URL`) sostenido durante toda la sección
  crítica; se re-leen `companyContactProfiles` DENTRO del lock antes de crear.
  La 2ª invocación entra al lock cuando la 1ª ya creó → `skipped`.
- La función ya NO toca catálogos ("Outlet general" ARCHIVED, Fase D) y
  asigna SOLO el rol admin de sistema (no el ordering-only).
- Si se borra a mano una Company que está en `company_domains`, **borrar
  también su fila** o los siguientes registros de ese dominio fallarán al
  intentar unirse a una Company inexistente.
- Filas vigentes en `company_domains` (2026-06-14): manuales de fusión
  `ledsc4.com`, `leds-c4.com`, `coelca.com`, `iluminacioncoben.com`,
  `hiperdeluz.es`, `bover.es`; sedes únicas `velax.com.pe`, `techluz.com`,
  `iluvi.com`; pendientes de confirmación Víctor `thelux.es`, `gascon.es`.
  Semillas de cadena `saltoki.es` y `elektracat.com` BORRADAS 2026-06-14
  (migración `20260614120000_unseed_chain_domains.sql`). Los contactos ya
  fusionados de la company "Saltoki" (9946497351) y las dos SALTOKI VIGO **no**
  se reorganizan todavía: pasa aparte cuando Víctor defina la estructura.
- Limpieza retroactiva de duplicados históricos: HECHA 2026-06-11 (25
  variantes LedsC4 fusionadas a la madre, 11 huérfanas/tests borradas, 2
  renombres). Restricción aprendida: un customer NO puede ser contacto de dos
  companies → para fusionar hay que companyContactDelete del viejo ANTES de
  companyAssignCustomerAsContact.

## Whitelist B2B

### Metafield `b2b.whitelist_emails` es tipo `json` (no `list.*`)

Cambiado en PR #139 porque `list.single_line_text_field` está **capado a 128
entradas**. Ahora soporta ~5 MB (decenas de miles de emails). El formato del
valor sigue siendo un array JSON de strings, así que los lectores
(`promote-whitelist-matches`, `list-pending-customers`, `readWhitelist`)
funcionan sin cambios. **No recrear la definición como `list.*`** si en algún
re-setup la migración aparece por defecto así.

### `promote-whitelist-matches` salta candidatos sin `b2b.empresa`

Por diseño: si un email whitelisted aún no tiene `b2b.empresa` (porque el
cliente no ha completado el formulario), el cron lo salta con log
`skip (no b2b.empresa): <email>` y espera a la pasada siguiente. **No es un
fallo del cron**: antes (pre-PR #145) intentaba ejecutar W2 →
`create-company-for-customer` y se llevaba HTTP 400 en bucle, que sí ensuciaba
los logs.

## Secret HMAC de registro (metafield de shop `b2b.hmac_secret`)

El secret que firma los formularios B2B de `register-b2b-customer` y
`complete-b2b-registration` **ya NO vive en `config/settings_data.json`**
(estaba quemado en el repo público; rotado 2026-06-14). Ahora:

- **Tema (firma):** `main-acceso-profesional.liquid` y
  `main-completar-registro.liquid` firman con
  `shop.metafields.b2b.hmac_secret.value`. La definición del metafield tiene
  `access.storefront = NONE` → legible en Liquid SSR, **NO** expuesto en la
  Storefront API pública ni en el HTML.
- **Supabase (verifica):** env `REGISTER_B2B_HMAC_SECRET` (mismo valor que el
  metafield). Ambas funciones verifican vía `verifyHmacSignature()`.
- **Rotación sin downtime:** las funciones aceptan además
  `REGISTER_B2B_HMAC_SECRET_PREV` (secret saliente) durante la transición.
  Orden: (1) deploy dual con env viejo → (2) `secrets set` primary=NUEVO +
  PREV=VIEJO → (3) redeploy → (4) tema firma con metafield NUEVO (merge) →
  (5) verificar prod → (6) `secrets unset ..._PREV` + redeploy = solo-NUEVO.
  Para escribir el valor del metafield sin que pase por logs/chat se usó una
  edge function efímera que copia el env `REGISTER_B2B_HMAC_SECRET` → metafield
  vía Admin token (desplegada, invocada y borrada).

> **DEUDA DE SEGURIDAD (reportada 2026-06-14, sin rotar aún):** en el mismo
> `settings_data.json` quedan quemados en el repo público otros dos HMAC:
> `order_request_hmac_secret` y `backoffice_hmac_secret` (este último de blast
> radius alto: firma aprobar/rechazar en backoffice). Rotarlos con el mismo
> patrón (env Supabase `ORDER_REQUEST_HMAC_SECRET` / `BACKOFFICE_HMAC_SECRET`
> + metafields de shop dedicados, `access.storefront = NONE`).
