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

### El rol admin SIEMPRE garantizado (auto-reparación, v40 2026-06-16)

**En cualquier camino de alta/unión el contacto DEBE acabar con el rol admin
sobre la location.** Un contacto con `roleAssignments=[]` no puede comprar
("no tiene permisos para comprar"). El bug histórico: si el paso de assign-rol
fallaba una vez, `joinCustomerToCompany` abortaba y el contacto quedaba creado
pero sin rol, permanentemente (no se auto-reparaba).

`create-company-for-customer` v40 lo arregla y es idempotente:
- Si el customer YA es contacto, NO aborta: resuelve el `companyContactId`
  existente vía `companyContactProfiles` y continúa.
- `ensureAdminRole` lee los `roleAssignments` del contacto y **solo asigna si
  falta** (no-op si ya está → evita el error de rol duplicado). Un reintento
  sobre un contacto sin rol converge a "contacto + rol".

### Modelo MULTI-SEDE de la madre: selección por ocupación (v43)

Shopify admite hasta **50** asignaciones de cliente por `CompanyLocation`
(límite duro de plataforma, NO configurable; **confirmado empíricamente**: la
primaria de la madre dio `LIMIT_REACHED` a 50 exactos), **PERO el contacto nº 50
se queda sin capacidad de compra efectiva** — Shopify le muestra "You can't
purchase for this location" pese a tener el rol asignado. Por eso el **cupo
operativo real es 49** (bajado de 50 el 2026-07-01, v43): en cuanto una sede
llega a 49 las altas nuevas van a la siguiente. Para escalar hay que usar
**varias sedes** (49 × nº sedes); no existe "un bucket de 100".

**La madre LedsC4 SA tiene, por diseño, varias sedes** (primaria + "sede 2" +
las que haga falta). NO es un error ni hay que fusionarlas. Cada empleado es
contacto de la company y admin sobre UNA sede.

`create-company-for-customer` **v43** reparte location-aware en `ensureAdminRole`:
- **NO se clava en una `company_location_id` fija.** Lee la ocupación real
  (`roleAssignments` count) de cada sede y elige dinámicamente.
- **Umbral con margen:** `LOCATION_HARD_CAP=49` (cupo operativo — el slot 50 de
  Shopify no puede comprar), `LOCATION_SOFT_CAP=45` (margen). Coloca en una sede
  bajo SOFT_CAP, **la más llena primero** (concentra, no deja sedes casi vacías);
  solo cuando todas pasan SOFT rellena la franja 45–49. **Crea sede nueva SOLO si
  todas están al HARD_CAP (49)** — nunca una sede por contacto.
- **Sedes de overflow homogéneas:** `"<company> — sede N+1"` replica la
  `buyerExperienceConfiguration` de la 1ª sede (mismo `checkoutToDraft`,
  `editableShippingAddress`, payment terms), misma shippingAddress placeholder
  Madrid/ES y **sin catálogo propio** → un contacto en sede 2/3/… compra idéntico
  a la principal (mismo Market ES/EUR; el precio NO depende de la sede).
- **Reactivo ante carreras:** si el count decía hueco pero el assign da
  `LIMIT_REACHED`, prueba la siguiente sede. `LocationFullError`→409 solo como
  red de seguridad (sede recién creada ya llena = imposible).

Implicación: `company_domains.company_location_id` es solo una **pista** con
multi-sede; la sede efectiva la decide la ocupación. La respuesta trae
`companyLocationId` (la usada) y `hintLocationId` (la de la fila). **NO**
reintroducir el targeting a una location fija ni "repuntar company_domains a
mano" — ya no hace falta.

**Caso real:** la primaria `8330346823` está llena; "sede 2"
(`CompanyLocation/11600101703`) absorbe el overflow. Cuando sede 2 llegue a 49,
v43 abrirá sede 3 sola. Rol admin per-company `CompanyContactRole/14443512135`
(mapeado por note). Históricos role-less reparados a mano (13 el 2026-06-16 +
`karinferrer`/`josepsabate` el mismo día, cap de la primaria, no bug).

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

## Fase 2 instalador: registro, CP y enrutado de rol (2026-07)

**Objetivo de negocio**: captación masiva de instaladores con mínima fricción.

**Regla de enrutado — el origen del alta manda; la whitelist solo actúa
dentro del carril de distribuidor**:

| Carril de entrada | ¿Whitelist? | Resultado |
|---|---|---|
| Landing de instalador (`/pages/acceso-instalador`, `sector` fijo `"instalador"`) | irrelevante | Instalador auto-aprobado, sin Company |
| Form de distribuidor (`main-acceso-profesional`) | Sí | Distribuidor aprobado + Company (sin cambios) |
| Form de distribuidor | No | Pendiente → backoffice (sin cambios) |

El discriminador de carril es **`b2b.sector === "instalador"`**, comprobado
en Shopify Flow W1 **antes** de la lógica de whitelist. La whitelist nunca
se consulta para el carril instalador — ni siquiera si el email de un
instalador coincidiera con ella.

### Piezas ya en código (este repo)

- Landing nueva `/pages/acceso-instalador` ([sections/main-acceso-instalador.liquid](sections/main-acceso-instalador.liquid), [templates/page.acceso-instalador.json](templates/page.acceso-instalador.json)): copia de `main-acceso-profesional.liquid` sin campo "empresa", NIF opcional, hidden `sector="instalador"`. Mismo backend (`register-b2b-customer` + `b2b-register-v2.js`) que la landing de distribuidor — **la edge function no decide el rol ni aprueba a nadie**, solo crea el customer en `pendiente` con `b2b.sector` como discriminador para que Flow W1 lo procese.
- Metafield nuevo `b2b.codigo_postal` (`scripts/metafield-definitions.json`), obligatorio en `register-b2b-customer` **y** en `complete-b2b-registration` (los tres formularios).
- `register-b2b-customer`: `b2b.sector` se persiste siempre (es el discriminador). `empresa`/`nif` pasan a opcionales cuando `sector === "instalador"`; `empresa` se fuerza vacía en ese carril aunque el body la traiga rellena (defensa contra payload crafteado, ya que la landing no expone el campo). Ambos se omiten del `customerCreate` si quedan vacíos (Shopify rechaza `single_line_text_field` con value `""`).
- `complete-b2b-registration` (carril de alta nativa OAuth, **siempre distribuidor**): solo se le añadió `codigo_postal` obligatorio. Empresa/NIF siguen obligatorios ahí — no existe landing de instalador equivalente para ese carril.
- `gate_exempt_paths` en `layout/theme.liquid` incluye la nueva ruta.
- El markup visual +15% de precios (Fase 1) ya se activa por el tag `instalador` — Fase 2 es quien realmente lo aplica al hacer que ese tag exista en producción.

### Lo que NO está en código — edición manual pendiente en Shopify Flow

**Bloqueante real, no un detalle menor**: el enrutado de rol vive en
**Shopify Flow W1**, fuera de este repo. La API pública de Flow no permite
crear/editar workflows por código — es edición manual en Admin → Apps →
Flow. El cambio exacto que falta aplicar está redactado paso a paso en
[flows/W1-walkthrough.md](flows/W1-walkthrough.md) bajo el aviso
"⚠️ PENDIENTE DE APLICAR": una condición nueva justo tras el parseo
(`sector == "instalador"`) que bifurca ANTES del `whitelistCheck` — si es
instalador, auto-aprueba con tags `aprobado`+`instalador` y nunca llama a
`create-company-for-customer` ni consulta la whitelist; si no, el carril de
distribuidor sigue exactamente igual que hoy. **Sin ese cambio, un alta por
la landing de instalador se queda en `pendiente` (o puede llegar a colgar
el workflow entero si el backfill de `empresa` intenta escribir vacío —
ver la nota de "Piezas clave" del walkthrough)** — el código de este repo
no lo puede forzar.

`create-company-for-customer` ya aborta sin crear Company si `b2b.empresa`
está vacío (comportamiento existente, sin cambios) — sigue siendo relevante
como segunda red de seguridad, porque W2 (`Customer tags added` con
`aprobado`) se dispara igualmente cuando W1 taguea a un instalador y vuelve
a invocar esa función; aborta sola sin problema.

### Decisiones de cierre (2026-07)

- **Sin email interno de FYI a backoffice en el carril instalador.** En
  captación masiva, un aviso por cada alta genera ruido; el email que
  importa operativamente es el de la oferta (Fase 3, por draft order), no
  uno por registro. El carril instalador queda sin ningún email hasta que
  se active el de bienvenida (pendiente Grow).
- **Clientes sin `b2b.sector` (altas manuales en Admin, imports, apps
  ajenas a los dos formularios) ya no entran a W1 ni reciben tag de
  estado.** Es la operativa aceptada de LedsC4, no un fallo a corregir —
  cerrado, no requiere acción.

### Pasos operativos (estado)

1. ✅ `scripts/apply-metafield-definitions.mjs` — `b2b.codigo_postal` creada y fijada en la tienda (2026-07).
2. ✅ `scripts/create-b2b-pages.mjs` — Page `/pages/acceso-instalador` creada (2026-07).
3. ✅ `supabase functions deploy` de `register-b2b-customer` (v39) y `complete-b2b-registration` (v13) — hecho (2026-07).
4. ⬜ Aplicar a mano el cambio de Flow W1 descrito arriba — **sigue pendiente**, es lo único que falta para que el enrutado real funcione en producción.
5. ✅ `scripts/audit-customer-state.js` actualizado para no marcar `approved_without_company` en clientes con tag `instalador`.
6. ⬜ Crear en Shopify Messaging el template `B2B · 08 · Bienvenida instalador` (fuente: `email-templates/08-bienvenida-instalador.liquid`) cuando se active el envío de marketing mail — hoy sigue marcado `[PENDIENTE GROW]` igual que los demás.

### Extra A — atribución de campaña (UTMs, 2026-07)

Captura y persistencia únicamente (uso en oferta/email interno es Fase 3).
`assets/b2b-register-v2.js` lee `utm_source/medium/campaign/term/content`
de `window.location.search` (un único sitio, las dos landings comparten el
asset) y los manda opcionales a `register-b2b-customer`, que los sanea sin
validar formato y los persiste como 5 metafields `b2b.utm_*` (omitidos si
vienen vacíos). No aplica a `complete-b2b-registration` (fuera de alcance).
Nuevas definitions en `scripts/metafield-definitions.json` — **pendiente
de `apply-metafield-definitions.mjs`** tras el merge de esta rama.

## REGLA PERMANENTE: ningún secret en `settings_data.json`

**NUNCA pongas un secret en `config/settings_data.json` ni en
`settings_schema.json`.** Ese fichero se sincroniza siempre al repo (GitHub +
"Update from Shopify"), así que cualquier secret ahí queda quemado — **nos ha
mordido 3 veces** (register, order-request, backoffice). Todo secret de firma
(HMAC u otro) va en un **metafield de shop con `access.storefront = NONE`** y se
lee desde Liquid con `shop.metafields.<ns>.<key>.value`: legible en Liquid SSR,
**NO** expuesto en la Storefront API pública ni en el HTML. Las URLs de endpoint
y flags no-secretos sí pueden seguir en settings.

## Secrets HMAC en metafields de shop (`b2b.*`, `storefront:NONE`)

Los tres secrets HMAC de firma B2B viven en metafields de shop (rotados y
sacados de `settings_data.json`, donde estaban quemados en el repo público;
register/complete 2026-06-14, order-request + backoffice 2026-06-15):

| Secret (metafield) | Env Supabase | Firma en (tema) | Verifica en (funciones) |
|---|---|---|---|
| `b2b.hmac_secret` | `REGISTER_B2B_HMAC_SECRET` | `main-acceso-profesional`, `main-completar-registro` | `register-b2b-customer`, `complete-b2b-registration` |
| `b2b.order_request_hmac_secret` | `ORDER_REQUEST_HMAC_SECRET` | `b2b-solicitud-form`, `b2b-solicitud-detalle`, `b2b-mis-solicitudes` | `submit-order-request`, `list-order-requests` |
| `b2b.backoffice_hmac_secret` | `BACKOFFICE_HMAC_SECRET` | `admin-backoffice-resumen` | `approve-customer`, `reject-customer`, `list-pending-customers`, `update-whitelist` |

El segundo cerrojo del backoffice (`assertBackofficeTag`, tag `backoffice`
server-side) es independiente del HMAC y **no se toca** en la rotación.

**Rotación sin downtime** (verificada, mismo procedimiento para los tres):
1. Deploy dual de las funciones con env viejo (leen `<ENV>_PREV` opcional →
   aceptan secret vigente **o** saliente).
2. `secrets set` primary=NUEVO + `<ENV>_PREV`=VIEJO → redeploy → dual vivo.
3. Metafield: definición `storefront:NONE` + valor=NUEVO escrito por una **edge
   function efímera** que copia el env → metafield vía Admin token (desplegada,
   invocada, borrada); el valor nunca pasa por chat/logs/repo.
4. Tema firma con el metafield NUEVO (merge del PR) + quitar el secret de
   `settings_data.json`/`settings_schema.json`.
5. Verificar en prod: firma NUEVA real → 2xx/4xx de validación; petición forjada
   con el secret VIEJO → 401.
6. `secrets unset <ENV>_PREV` + redeploy = solo-NUEVO (el viejo queda inservible).

> El `X-Webhook-Secret` de `create-company` (Flow→función) NO está en el repo
> (vive en la cabecera del paso HTTP de Flow) → no aplica esta regla.
