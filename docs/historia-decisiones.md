# Historia de decisiones (ADRs)

_Estado a 2026-05-09 — sujeto a actualización. Para handover de cierre del proyecto._

Architecture Decision Records ligeros — las ~6 decisiones que más
cambiaron la arquitectura del proyecto desde el kickoff
`LedsC4_Arquitectura_F0.docx` (abril 2025) hasta el deploy de Fase D
(2026-04-29).

Cada entrada sigue el formato: **Decisión · Contexto · Alternativas
consideradas · Por qué se eligió · Consecuencias**.

---

## D1 — Plan Grow

**Decisión.** La tienda corre sobre el **plan Grow** (objetivo de
producción). El store actual está en plan Development, que hereda las
mismas features que Grow para validar end-to-end sin coste antes del
cutover.

**Contexto.** F0 contempló Basic como punto de partida con la idea de
escalar si hacía falta. Al diseñar Fase A (modelo de datos) se
identificaron tres requisitos duros que Basic no cubre:

1. **B2B nativo** (Companies, Catalogs, Price Lists per Company
   Location) — requisito obligatorio del modelo de datos elegido.
2. **Custom staff roles** con toggles granulares — necesarios para el
   rol "Backoffice Aprobaciones" sin acceso a ventas/productos/finanzas.
3. **Shopify Messaging operativo** (envío real de marketing mails desde
   Flow) — Basic permite crear plantillas pero no enviarlas.

**Alternativas consideradas.**
- **Basic** + Wholesale Club app + Customer Fields app + roles
  predeterminados (Limited / Full). Descartado por D2 y por la
  imposibilidad de un rol staff con el alcance pedido.
- **Plus**. Descartado por sobredimensionado y por precio. Plus aporta
  Shopify Functions, multi-store y SLA, ninguno necesario aquí.

**Por qué Grow.** Único plan que cumple los tres requisitos al precio
mínimo razonable. B2B nativo en Grow es funcionalmente equivalente a
Plus para nuestro caso (1 catálogo, 1 location por company, sin
descuentos por volumen complejos).

**Consecuencias.**
- Coste mensual mayor que Basic.
- Toda la arquitectura asume features Grow. Si el cliente decidiera
  bajar a Basic, habría que reescribir Fase A entera.
- Migración Development→Grow documentada en
  [docs/grow-migration-checklist.md](grow-migration-checklist.md).

---

## D2 — B2B nativo en lugar de Wholesale Club + Customer Fields

**Decisión.** Usar **Shopify B2B nativo** (Companies, Catalogs, Price
Lists, Company Location Catalogs) como fuente única de verdad para
permisos comerciales y precios B2B.

**Contexto.** F0 propuso un esquema "Basic-friendly" basado en dos apps:

- **Wholesale Club** — gestiona price lists por tag de cliente.
- **Customer Fields** — gestiona los campos extra del registro
  (empresa, NIF, sector, etc.).

Al detallar el modelo en Fase A se vio que ese esquema obligaba a
duplicar lógica:

- El precio B2B vivía en Wholesale Club (atado a tags).
- El permiso de ver el catálogo vivía en Locksmith (atado a tags).
- El detalle del cliente vivía en Customer Fields (custom metafield app).
- La identidad de la empresa no existía como entidad de primera clase
  (era un metafield del customer).

Cualquier cambio (renombrar un sector, cambiar la regla de descuento,
añadir un segundo catálogo) tocaba 3 sitios distintos.

**Alternativas consideradas.**
- **Wholesale Club + Customer Fields + Locksmith** (propuesta F0).
- **B2B nativo de Shopify** (disponible en Grow y Plus desde 2023).

**Por qué B2B nativo.**
- **Una sola entidad** — Company — agrupa customer, dirección,
  catálogos, descuentos, contactos. Modelable directamente en GraphQL
  Admin API.
- **Catálogos son objetos de primera clase** con price list propio.
  Multi-catalog-ready sin esfuerzo adicional (ver
  [ADR D6](#d6-cat%C3%A1logo-%C3%BAnico-multi-ready)).
- Los metafields del customer siguen siendo Shopify nativos, no
  dependen de una app de terceros que pueda subir precio o cerrar API.
- **Encaja con el rol "Backoffice Aprobaciones"** — permisos sobre
  Companies y Customers son toggles separados.

**Consecuencias.**
- Forzó la decisión de Grow ([ADR D1](#d1-plan-grow)).
- Eliminó dos dependencias de apps de terceros (Wholesale Club y
  Customer Fields). Locksmith se mantiene solo para el gate del
  storefront (ver [ADR D4](#d4-gate-h%C3%ADbrido)).
- La creación de Company requiere una mutation no trivial que Flow no
  expone como acción nativa, lo que motivó parte de
  [ADR D3](#d3-flow--supabase).

---

## D3 — Shopify Flow + Supabase Edge Functions en lugar de Mechanic

**Decisión.** Usar **Shopify Flow** (built-in) para los workflows que
sus triggers y acciones cubren, y **Supabase edge functions + pg_cron**
para todo lo que Flow no puede hacer.

**Contexto.** F0 propuso **Mechanic** (app de pago) para la automatización
de eventos: alta de customer → email + tag, scheduled cleanup, etc.
Mechanic es famosa por ser muy flexible y tener "cualquier cosa" como
trigger custom.

Al diseñar W1 (registro) en Fase B, el primer Run code que escribimos
necesitaba `await fetch(...)` para llamar a la Admin API. Resultó que
**Flow Run code es un sandbox puro** (Lessons learned 2026-04-19):

- Sin `async`/`await`.
- Sin `fetch`.
- Sin `shopify.graphql()` (la versión interna de mecánica).

Es decir, Run code de Flow es para transformación pura de datos. Para
cualquier "side effect" hace falta otro sistema.

Triggers que Flow tampoco expone:
- Scheduled (sí existe pero no expone una lista de customers como
  input — bloqueo para W4).
- "Shop metafield updated" (sería ideal para disparar cuando admin
  añade un email a la whitelist).

**Alternativas consideradas.**
- **Mechanic** (propuesta F0). Permite triggers custom y Liquid runner
  con `shopify.graphql`. Pero es 9$/mes y añade dependencia de un
  proveedor externo del runtime.
- **Shopify Flow** sólo. Cubre 80% de los casos del proyecto sin coste
  pero tiene los bloqueos descritos arriba.
- **Supabase edge functions** (Deno runtime completo) con pg_cron como
  scheduler. Plan free aguanta perfectamente el volumen previsto.

**Por qué Flow + Supabase.**
- Flow + Supabase juntos cubren el 100% de los casos sin pagar Mechanic.
- Separación clara de responsabilidades: Flow para orquestación
  declarativa, Supabase para lógica/IO/estado.
- Migración futura entre tenants: Flow se exporta/importa con
  configuración; Supabase es código en este repo (`supabase/`).

**Consecuencias.**
- 4 edge functions en `supabase/functions/`:
  - `promote-whitelist-matches` — W4 (cron 30 min).
  - `create-company-for-customer` — invocada por W1/W2 vía
    `Send HTTP request` con `X-Webhook-Secret`.
  - `submit-order-request` — Fase D, valida HMAC + crea Draft Order.
  - `list-order-requests` — Fase D, valida HMAC + lista.
- Deploy y secrets gestionados con Supabase CLI; runbook completo en
  [docs/operations-runbook.md §2-3](operations-runbook.md#2-edge-functions--deploy-y-secrets).
- Gotcha crítico: `verify_jwt = false` declarado en
  `supabase/config.toml`. El CLI sobrescribe el dashboard al deployar;
  el fichero es la fuente de verdad. Ver
  [supabase/README.md](../supabase/README.md).
- Acoplamiento Flow↔Supabase vía URLs hardcoded en `Send HTTP request`.
  Al migrar a otro tenant Supabase, hay que actualizar las URLs en W1
  rama Then y W2.

---

## D4 — Gate híbrido Locksmith + Liquid en lugar de Locksmith puro (3 locks)

**Decisión.** El gate de storefront se implementa **híbrido**: 1 lock en
Locksmith (Rule 2 — solo aprobados ven catálogo) + redirects en Liquid
en `layout/theme.liquid` (Rules 1 y 3 — anónimo→login,
rechazado→cuenta-rechazada).

**Contexto.** El plan original (F0 + diseño detallado en
[docs/locksmith-rules.md](locksmith-rules.md) §"[Diseño original — solo
referencia]") era **3 locks Locksmith**:

- Rule 1 — Entire store con redirect a `/pages/cuenta-rechazada` para
  customers con tag `rechazado`.
- Rule 2 — Specific resources (productos + colecciones) con redirect a
  `/pages/cuenta-en-revision` para no-aprobados.
- Rule 3 — Entire store con redirect a `/account/login` para anónimos.

Al instalar el segundo lock Entire Store en Fase C (deploy 2026-04-19),
Locksmith devolvió **"High-level job failure"** y abortó la instalación.
La causa exacta no quedó clara con su soporte; según ellos, "ciertas
combinaciones de locks Entire Store" fallan.

**Alternativas consideradas.**
- **Esperar a que Locksmith resuelva el bug**. Sin ETA, no era opción
  para el deploy planificado.
- **Cambiar de app de gate**. Bloqueado por permisos de la tienda y
  por el coste de migrar lógica ya validada.
- **Gate puro en Liquid** (sin Locksmith). Posible, pero pierde el
  enforcement server-side de Locksmith (que mete redirects HTTP 302
  reales) y deja todo client-side JS.
- **Híbrido**: dejar el lock que sí funciona (Rule 2) en Locksmith, y
  mover los otros dos al theme Liquid.

**Por qué híbrido.**
- Mínimo cambio respecto al plan original.
- Mantiene el enforcement server-side de Locksmith para el caso más
  crítico (proteger productos y colecciones de no-aprobados).
- Las Rules 1 y 3 en Liquid client-side son aceptables para el perfil
  de usuario (B2B con clientes profesionales que no deshabilitan JS).
- 100% reversible: si Locksmith resuelve el bug, los Rules 1 y 3 se
  recrean en la app y se borra el bloque Liquid.

**Consecuencias.**
- Bloque de gate en `layout/theme.liquid:329-379` con la lista de paths
  exempt y los redirects.
- Documentación detallada en
  [docs/locksmith-rules.md](locksmith-rules.md), incluyendo el gotcha
  de `redirect_url` en KEY vs LOCK que costó otro deploy fix
  (2026-04-29, commit `522d1df`).
- Los `<script>window.location.replace(...)</script>` corren en el
  `<head>` antes de que se renderice contenido — minimizan flash de
  contenido. Excepción de aprobados-en-checkout: redirige a `/cart` para
  que la decisión sobre checkout (deshabilitado en Fase D) no cause
  carga de UI sensible.

---

## D5 — New customer accounts (no se eligió — Shopify lo forzó)

**Decisión.** El portal usa el sistema **new customer accounts** de
Shopify (login y customer area hospedados en `shopify.com/<shop>/account`).

**Contexto.** F0 contempló el **classic customer accounts** del tema:
páginas `templates/customers/login.liquid`, `register.liquid`,
`account.liquid` etc., totalmente brandeables desde el código del tema.

Durante 2025 Shopify deprecó classic y lo sustituyó por new customer
accounts. **No es opcional** para tiendas nuevas; cualquier tienda creada
o promocionada después del cutoff tiene new accounts forzado.

**Alternativas consideradas.**
- Ninguna realista. Habría que mantener una tienda en classic y nunca
  modificar el plan o el tema (con riesgo de migración forzada en
  cualquier momento).

**Por qué new customer accounts.**
- Forzado por Shopify.

**Consecuencias.**
- **Login deprecated en theme**: archivos
  `templates/customers/login.json`, `register.json`,
  `reset_password.json` y sus secciones `sections/main-login.liquid`,
  `main-register.liquid`, `main-reset-password.liquid` no intervienen
  en el flujo real. Se conservan pero no aportan funcionalidad.
- **Branding limitado a la Checkout & Customer Accounts Branding API**.
  Logo, fuentes, colores, esquinas, imagen de cover, favicon —
  configurables. Strings del formulario y layout — fijos por Shopify.
  Detalle en
  [docs/shopify-customer-accounts-branding.md](shopify-customer-accounts-branding.md).
- **OAuth con `redirect_uri` validado contra el dominio real** —
  dominios `*.shopifypreview.com` no están en la whitelist. Validación
  funcional del gate de auth solo tras `Publish` en producción.
- **Customer Account UI Extensions** son la única vía para añadir copy
  custom (mensajes B2B, links al portal) — extensión de app Shopify,
  fuera del tema. No abordado.
- Para gate, el redirect a login se hace contra
  `/customer_authentication/login?return_to=...` (que sí respeta el
  querystring) en lugar de `/account/login` (que en new accounts no lo
  respeta) — ver
  [layout/theme.liquid:356](../layout/theme.liquid).

---

## D6 — Catálogo único "Outlet general" con arquitectura multi-catalog-ready

**Decisión.** Arrancar con **un solo catálogo B2B** ("Outlet general",
0% sobre shop, EUR, smart collection `coleccion-2026`), y diseñar el
modelo de datos de forma que añadir un segundo catálogo no requiera
refactor.

**Contexto.** F0 planteó múltiples tarifas por sector y/o por país desde
el día uno. Al detallar Fase A se vio que:

- Los 745 SKUs del outlet 2026 son fin de colección — el descuento real
  es 0% sobre los precios de outlet (que ya están reducidos en shop).
- La señal real de demanda de tarifas diferenciadas no existe todavía;
  el primer caso B2B aún no se ha cerrado.
- Mantener N catálogos vacíos por si acaso es trabajo (publication,
  price list, asignación a Company Locations) sin valor inmediato.

**Alternativas consideradas.**
- **N catálogos desde el inicio** (1 por sector / país / volumen).
  Exceso de trabajo prematuro y tiempo perdido configurándolos sin uso
  real.
- **Un catálogo, lógica de negocio acoplada a esa decisión** — peligro
  de hacer el añadir un segundo catálogo después un refactor doloroso.

**Por qué catálogo único multi-ready.**
- Arrancar simple, escalar cuando haya señal real (YAGNI).
- El modelo de datos B2B nativo ya soporta N catálogos por shop sin
  cambio. La política "1 customer = 1 Company = 1 catálogo Outlet
  general" vive en `create-company-for-customer` (edge function), que
  es un único punto de cambio cuando llegue la diferenciación.

**Cómo se añade un segundo catálogo cuando llegue.**

1. Crear el catálogo (`scripts/setup-b2b-catalog.mjs` parametrizado por
   título y price list).
2. Modificar `create-company-for-customer` para decidir el catálogo
   destino a partir de los metafields del customer (p.ej.
   `b2b.sector == 'distribuidor'` → catálogo "Distribuidores"; resto
   → "Outlet general").
3. Documentar el criterio.

**Consecuencias.**
- Hoy: 1 publication, 1 price list, 1 catálogo asignado a todas las
  Company Locations.
- Mañana: cambio localizado, sin migrar datos existentes (las
  Companies ya creadas siguen apuntando a "Outlet general"; las nuevas
  van al catálogo correspondiente según la regla).
- El frontend no necesita saber qué catálogo está consumiendo —
  Shopify B2B lo resuelve a nivel API según la Company Location del
  customer logueado.

---

## D7 — Página backoffice en theme con tag `backoffice`

**Decisión.** Construir `/pages/admin-backoffice` como page del theme
gateado por un tag `backoffice` en el customer. Reemplaza la edición a
mano del shop metafield `b2b.whitelist_emails` y el flujo de aprobación
manual con doble cambio de tag desde Admin. Detalle en
[docs/backoffice-page.md](backoffice-page.md).

**Contexto.** El flujo manual descrito en
[docs/backoffice-aprobaciones.md](backoffice-aprobaciones.md) tiene un
bug operacional: si el staff no quita `pendiente` y añade `aprobado` en
el **mismo Save**, W2 puede no disparar (su condición es
`'aprobado' IS IN tags AND 'pendiente' IS IN tags_previous`). El staff
real hace doble click con frecuencia, sobre todo bajo presión, y la
incidencia "aprobé y no llegó email / no se creó Company" estaba en el
top de pendientes. Aparte, editar la whitelist requería ir a Settings →
Custom data, lo que mete fricción y necesita rol con `Edit custom data`.

**Alternativas consideradas.**

- **Mantener flujo manual** + entrenamiento del staff en el doble click. Frágil: una persona nueva o un mal día reproduce el bug.
- **Locksmith** para gatear la página backoffice (en lugar del tag). Descartado: el bug "High-level job failure" con un segundo lock Entire Store ([ADR D4](#d4--gate-h%C3%ADbrido-locksmith--liquid-en-lugar-de-locksmith-puro-3-locks)) ya nos quemó. Añadir más superficie a Locksmith por una página interna no compensa el riesgo.
- **Shopify Polaris admin app embebida**. Hubiera sido lo "correcto" para una herramienta interna, pero añade un proyecto entero (oauth, hosting, mantenimiento) por una UI minúscula. Out of scope por coste.
- **Page del theme + tag custom + edge functions** (elegida).

**Por qué tag `backoffice` + page del theme.**

- **Reusa la infra existente**. HMAC pattern de `submit-order-request`, deploy GitHub→Shopify, settings_data.json para secrets en Liquid SSR.
- **Sin app nueva**. Cero superficie de mantenimiento extra fuera del theme y las edge functions.
- **Atomicidad real del flip de tag**. La edge function usa `customerUpdate(input: { tags })` (Admin API 2025-10) que reemplaza el array de tags en una sola operación; W2 detecta el cambio limpio sin estado intermedio.
- **Escalable a N staff** sin refactor. Cualquier customer con tag `backoffice` opera la página; el script `create-backoffice-customer.mjs` es idempotente y parametrizable por env.

**Por qué Liquid `{% if %}` es UX y NO seguridad.**

El page template hace `{% if customer.tags contains 'backoffice' %}` para
decidir qué pintar. Eso evita que un usuario normal vea la UI por
accidente. Pero no es seguridad: si alguien manipulara DOM o si las
edge functions confiaran solo en el HMAC client-side, tendrían un
boquete enorme. Por eso **cada edge function repite la verificación
server-side**: resuelve al approver vía Admin API y comprueba que tiene
tag `backoffice`. Sin esa función `assertBackofficeTag`, las URLs son
públicas (verify_jwt = false, mismo patrón que el resto de funciones
storefront-facing).

Cada edge function tiene un comentario 🔒 explícito recordando esto, para
que nadie en el futuro lo borre pensando que es redundante.

**Por qué 1 staff ahora.**

El cliente actual no tiene volumen para necesitar varios approvers.
Diseñar para n staff hubiera implicado roles diferenciados, auditoría
con actor, posible UI de aceptar/declinar como par de aprobador… nada
de eso aporta valor hoy. La decisión está tomada de tal forma que añadir
n staff es un setting (más customers con tag `backoffice`) y no un
refactor — pero la fase no construye herramientas para ello.

**Decisión transitoria — customer backoffice provisional.**

Durante la fase de desarrollo el customer backoffice es
`daniel.pena+backoffice@creacciones.es`. Antes de la entrega al cliente
se sustituye por uno suyo cambiando un env var
(`BACKOFFICE_CUSTOMER_EMAIL`) y re-ejecutando
`scripts/create-backoffice-customer.mjs`. Procedimiento completo en
[docs/backoffice-page.md §6 Cutover](backoffice-page.md#cutover-al-cliente-final).

**Consecuencias.**

- 4 edge functions nuevas en `supabase/functions/`: `list-pending-customers`, `update-whitelist`, `approve-customer`, `reject-customer`.
- 2 metafields nuevos: `customer · b2b.fecha_rechazo` (date) y `shop · b2b.whitelist_last_update` (date_time).
- 1 secret nuevo `BACKOFFICE_HMAC_SECRET` + setting `settings.backoffice_hmac_secret`. **Distinto** del HMAC de solicitudes y register: el blast radius (operaciones de approver) es mucho mayor.
- 1 page template + 3 sections + 2 assets nuevos en el theme.
- Reparto edge function ↔ Flow: la edge function solo cambia tags. W2 sigue haciendo fecha + Company + email; W3 sigue mandando el email de rechazo. Sin esa separación, hay carrera y duplicación.
- El gate de `theme.liquid` ya exempts pages no comerciales — `/pages/admin-backoffice` no requirió tocar el gate.

**Decisión revisada 2026-05-05.** `customersCount(query:)` no respeta el
filtro en API 2025-10. Fallback a `customers(first: 250, query:)` y
`.length`. Documentado en pendientes.

---

## D8 — Mapping CSV "Predeterminado" pendiente

**Decisión.** La columna `Predeterminado` (índice 2 del CSV de surtido,
ver [`docs/import-pipeline.md` §2](import-pipeline.md)) se importa al
metafield `product.predeterminado` con `access.storefront = NONE` hasta
que el cliente confirme su semántica. La definición existe para no
perder dato y dejar el mapper limpio, pero no se expone al storefront
ni se documenta en ficha de producto.

**Contexto.** El mapping del ERP (entregado el 2026-05-04) incluye una
columna llamada "Predeterminado" cuyo significado funcional el cliente
no ha aclarado todavía. Posibles interpretaciones internas: variante
por defecto, código interno, flag de catálogo… Cualquiera de ellas
implicaría una semántica de producto distinta.

**Por qué importar pero ocultar.** Importar y exponer sin saber
significaría arriesgar mostrar un dato confuso al cliente B2B.
Bloquear la importación de la columna implicaría perder el dato
histórico hasta que se clarifique. La opción intermedia — importar al
metafield con `access.storefront = NONE` — preserva el dato sin
filtrarlo al frontend. Cuando el cliente confirme la semántica, basta
con cambiar `access.storefront` a `PUBLIC_READ` y, si procede, añadir
contexto al mapper o al template de ficha.

**Consecuencias.** El bloque dedicado en `mapping.json` lleva
`visible_in_storefront: false`; la definición en
`metafield-definitions.json` lleva `access.storefront: NONE`; el
nombre admin (`Predeterminado (interno — no exponer)`) avisa al staff
que esa columna no debe usarse en filtros, fichas ni colecciones
inteligentes hasta que esta decisión se revise.

---

## D9 — Modelo de metafields ampliado para outlet

**Decisión.** Pasar de las 13 definiciones existentes (Fase A) a un
total de 45 definiciones tras Fase I1, añadiendo 32 nuevas en
`ownerType=PRODUCT, namespace=product` para cubrir el modelo de datos
del importador del ERP descrito en
[`docs/import-pipeline.md`](import-pipeline.md). El mapeo
columna-a-metafield es autoritativo en
[`scripts/mapping.json`](../scripts/mapping.json).

**Contexto.** Hasta Fase D el modelo de metafields cubría únicamente
Customer (`b2b.*`, 8 definiciones), Shop (`b2b.whitelist_emails`,
`b2b.email_backoffice`), 2 Page (mensajes editables del staff) y 1
Producto (`b2b.cbm_caja`, usado por `submit-order-request` para
calcular el CBM total de cada solicitud). El ERP del cliente (Microsoft
Dynamics AX) emite un CSV de surtido de 79 columnas; tras descartar
cajas/masterbox/códigos por país (no relevantes para el outlet) quedan
32 columnas que se mapean a metafields de producto.

**Bloques nuevos (32 definiciones, todas `PRODUCT/product.*`).**

- **Identificadores** (2): `version`, `predeterminado`.
- **Comerciales traducibles** (8): `tipo`, `familia`, `catalogo`,
  `garantia`, `etiqueta_vf`, `material`, `acabado`, `accesorio`.
- **Texto extendido traducible** (2): `tender_text`, `fuente_luz`.
- **Comercial no traducible** (1): `tipo_regulacion` (sí marcado
  translatable=true en mapping). Total **11 metafields traducibles**
  según `mapping.json` — coincide con el listado de §4.2 del
  pipeline.
- **Dimensionales** (5): `dim_largo_mm`, `dim_ancho_mm`,
  `dim_alto_mm`, `proyeccion_mm`, `peso_neto_kg`.
- **Lumínicos / técnicos** (10): `vatios`, `lumenes`,
  `lumenes_reales`, `temperatura_color`, `cri`, `rayo_luz`, `ip`,
  `ik`, `incluye_bombilla` (boolean), `eficiencia_energetica`.
- **URLs PDF** (3): `ficha_url`, `ficha_comercial_url`, `ee_url`.
- **Eficiencia comercial** (1): `imc` (semántica pendiente como
  `predeterminado`, pero visible).

(Los 11 traducibles son: `tipo`, `familia`, `catalogo`, `garantia`,
`etiqueta_vf`, `tender_text`, `material`, `acabado`, `fuente_luz`,
`tipo_regulacion`, `accesorio`. Las traducciones EN/IT/DE/FR/PT se
cargan en Fase I3 vía `translationsRegister` — fuera de I1.)

**Decisiones de modelado.**

- **`pin_in_admin` por entrada en `mapping.json`**, no por heurística
  en el script. Razón: el cliente puede renegociar pinning
  (importancia visual en admin) sin tocar código. El script lee el
  flag literal y falla si falta — fuente única de verdad.
- **`access.storefront = PUBLIC_READ`** por defecto para 31 de las 32;
  `NONE` solo para `predeterminado` (ver D8).
  `access.admin` y `access.customerAccount` se omiten para que apliquen
  los defaults Shopify (`MERCHANT_READ_WRITE`, `NONE` respectivamente).
- **`validations` deliberadamente vacío.** Las enumeraciones del ERP
  (eficiencia A–G + "NA EPREL", IP rating, temperatura color
  "TUNABLE WHITE" / rangos, rayo luz "SPOT/MEDIUM/FLOOD" / grados)
  admiten valores nuevos en cualquier export. Validar contra una
  lista cerrada bloquearía el pipeline y rompería el principio "ERP
  es fuente de verdad". Si en el futuro se quiere control, va vía
  reporte (dashboard de valores fuera de rango), no vía bloqueo.
- **`apply-metafield-definitions.mjs`** se extiende mínimamente: query
  previa por `ownerType` + clasificación
  Create/Unchanged/NeedsManualUpdate/DriftBlocked + Summary nuevo.
  NO implementa `metafieldDefinitionUpdate` aún — los diffs de
  description/pin/access se reportan pero el operador los aplica a
  mano. Pragmático: en I1 todas las 32 son nuevas, así que el path de
  Update no se ejerce; implementarlo "por si acaso" sería código no
  testeado. Cuando se necesite, está documentado como TODO en la
  cabecera del script.

**Consecuencias.**

- `metafield-definitions.json` pasa de 13 a 45 entradas, ordenadas por
  `(ownerType, namespace, key)` para que el diff de PR sea legible.
- Las 13 existentes (`b2b.*` Customer/Shop/Page + `b2b.cbm_caja`
  Product) se respetan tal cual. Coexisten dos namespaces a nivel
  Producto: `b2b.cbm_caja` (Fase D) y `product.*` (Fase I1) — sin
  colisión.
- Las traducciones `translatable=true` de `mapping.json` no requieren
  flag a nivel de definición: Translate & Adapt detecta los tipos de
  texto automáticamente. La carga real de traducciones se hace en I3
  vía `translationsRegister`.
- Se conservan los 745 SKUs ya publicados al catálogo "Outlet
  general" (Fase A). El importador (I3/I4) los re-actualizará
  poblando los nuevos metafields y, a partir de ahí, la regla de
  publicación pasa a ser "en surtido AND stock>0 AND precio>0" (ver
  `docs/import-pipeline.md §1`), reemplazando al criterio actual
  basado en el tag `Coleccion:2026`.

Fuentes vivas: [`scripts/mapping.json`](../scripts/mapping.json) y
[`docs/import-pipeline.md`](import-pipeline.md).
