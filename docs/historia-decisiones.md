# Historia de decisiones (ADRs)

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
