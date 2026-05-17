# 04 · Storefront gate

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Describe el sistema completo que decide **quién puede ver qué URL** del storefront B2B. Cubre:

- Las 3 reglas conceptuales del gate (anónimo, rechazado, solo-aprobados-ven-catálogo).
- El reparto entre Locksmith (Rule 2) y Liquid (Rules 1 y 3).
- Paths exempt, escape hatches, gotchas.
- Header y footer gates (qué section se renderiza según tag).

No cubre:

- Cómo se registra un anónimo → [05-registro-b2b](05-registro-b2b.md).
- Cómo se aprueba un pendiente → [06-backoffice](06-backoffice.md).
- Cómo se brandea la pantalla de login Shopify-hosted → [03-theme-customizaciones](03-theme-customizaciones.md) §branding customer accounts.

Decisión arquitectónica: [D4](adrs/d04-gate-hibrido.md).

## Resumen ejecutivo

Tres reglas conceptuales:

| Regla | Significado | Implementación |
|---|---|---|
| **Rule 1** — rechazados | Customer con tag `rechazado` no ve nada del portal. | Liquid en `layout/theme.liquid` (capa 1). |
| **Rule 2** — solo aprobados ven catálogo | Sin tag `aprobado` no se ve `/products/*`, `/collections/*`, `/cart`, `/search`, `/checkout`. | Liquid en `layout/theme.liquid` (capa 1) **+** Locksmith Lock 806866 (capa 2, defense in depth). |
| **Rule 3** — login obligatorio | Anónimo no ve catálogo ni páginas internas. | Liquid en `layout/theme.liquid` (capa 1). |

Las 3 viven en el theme. Locksmith refuerza Rule 2 como segunda capa. El plan original era 3 locks Locksmith pero **Locksmith falló al instalar 2 locks Entire Store con `High-level job failure`** ([D4](adrs/d04-gate-hibrido.md)). La solución fue mover Rules 1 y 3 al theme y dejar solo Rule 2 en Locksmith.

## Capa 1 — Liquid en `layout/theme.liquid`

Bloque en el `<head>` que corre en cada página. Ubicación: `layout/theme.liquid` líneas 332-393.

### Estructura del bloque

```liquid
{%- unless request.design_mode or request.host contains '.shopifypreview.com' or request.page_type == 'password' -%}
  {%- assign locale_prefix = routes.root_url -%}
  {%- if locale_prefix == '/' -%}{%- assign locale_prefix = '' -%}{%- endif -%}
  {%- assign gate_path = request.path -%}
  {%- assign gate_exempt = false -%}
  {%- assign gate_exempt_paths = '/,/account/login,/account/register,...,/pages/acceso-profesional' | split: ',' -%}
  {%- for p in gate_exempt_paths -%}
    {%- if gate_path == p -%}{%- assign gate_exempt = true -%}{%- break -%}{%- endif -%}
  {%- endfor -%}
  {%- if gate_path contains '/policies/' -%}{%- assign gate_exempt = true -%}{%- endif -%}
  {%- if gate_path contains '/account/activate' -%}{%- assign gate_exempt = true -%}{%- endif -%}
  {%- if gate_path contains '/account/reset_password' -%}{%- assign gate_exempt = true -%}{%- endif -%}

  {%- unless gate_exempt -%}
    {%- if customer == nil -%}
      <script>window.location.replace({{ locale_prefix | append: '/pages/acceso-profesional' | json }});</script>
    {%- elsif customer.tags contains 'rechazado' -%}
      <script>window.location.replace({{ locale_prefix | append: '/pages/cuenta-rechazada' | json }});</script>
    {%- elsif customer.tags contains 'aprobado' -%}
      {%- if gate_path contains '/checkout' -%}
        <script>window.location.replace({{ routes.cart_url | json }});</script>
      {%- endif -%}
    {%- else -%}
      {%- if gate_path contains '/products' or gate_path contains '/collections' or gate_path contains '/cart' or gate_path contains '/search' or gate_path contains '/pages/solicitud' or gate_path contains '/pages/mis-solicitudes' or gate_path contains '/checkout' -%}
        <script>window.location.replace({{ locale_prefix | append: '/pages/cuenta-en-revision' | json }});</script>
      {%- endif -%}
    {%- endif -%}
  {%- endunless -%}
{%- endunless -%}
```

### Las 4 ramas

| Estado del Customer | Condición | Destino |
|---|---|---|
| Anónimo | `customer == nil` | `/pages/acceso-profesional` (landing informativa). |
| Rechazado | `customer.tags contains 'rechazado'` | `/pages/cuenta-rechazada`. |
| Aprobado en ruta `/checkout` | `customer.tags contains 'aprobado'` AND `gate_path contains '/checkout'` | `routes.cart_url`. El checkout nativo está deshabilitado en Fase D — la solicitud de pedido es el sustituto ([07-solicitudes-pedido](07-solicitudes-pedido.md)). |
| Pendiente o sin tag, en ruta comercial | Cualquier otro estado AND la ruta contiene `/products`, `/collections`, `/cart`, `/search`, `/pages/solicitud`, `/pages/mis-solicitudes`, `/checkout` | `/pages/cuenta-en-revision`. |

Notar:

- El aprobado solo se redirige si entra a `/checkout`. En cualquier otra ruta pasa libremente.
- El "pendiente o sin tag" solo se redirige si la ruta es comercial. En otras páginas (legales, páginas informativas) pasa libremente.
- El redirect es JS client-side (`<script>window.location.replace(...)</script>`).

### Paths exempt (lista exhaustiva)

Paths que no disparan el gate, sea cual sea el estado del Customer:

**Match exacto** (16):

- `/` — home pública.
- `/account/login`, `/account/register`, `/account/recover`, `/account/logout`, `/account/sign_out`.
- `/pages/cuenta-en-revision`, `/pages/cuenta-rechazada`.
- `/pages/acceso-profesional` — landing informativa.
- `/pages/registro-recibido` — pantalla post-registro.
- `/pages/aviso-legal`, `/pages/politica-de-privacidad`, `/pages/condiciones-de-uso`, `/pages/canal-de-denuncias`.

**Match por substring** (3 patrones):

- `/policies/*` — políticas auto-generadas por Shopify.
- `/account/activate*` — links de email de invitación.
- `/account/reset_password*` — links de email de recuperación.

Cualquier otro path está sujeto al gate.

### Escape hatches (no disparan el gate)

Tres condiciones globales que saltan el gate entero:

| Condición | Por qué |
|---|---|
| `request.design_mode` | Theme editor de Shopify. Sin esto, no se podría editar el theme (todas las páginas redirigirían). |
| `request.host contains '.shopifypreview.com'` | Preview de theme. El OAuth de new customer accounts ([D5](adrs/d05-customer-accounts.md)) rechaza `redirect_uri` de dominios preview, así que aplicar gate aquí encadenaría errores. |
| `request.page_type == 'password'` | Tienda en password protection. La página de password ya bloquea acceso; el gate sobraría. |

### Locale awareness

El gate usa `routes.root_url` para construir `locale_prefix`:

```liquid
{%- assign locale_prefix = routes.root_url -%}
{%- if locale_prefix == '/' -%}{%- assign locale_prefix = '' -%}{%- endif -%}
```

- En la raíz: `locale_prefix = ''`.
- En `/fr`: `locale_prefix = '/fr'`.

Los redirects se construyen como `locale_prefix + '/pages/...'`, manteniendo el locale tras el redirect.

## Capa 2 — Locksmith Lock 806866 / Key 1084647

Segunda capa de defensa **solo para Rule 2** (collection / product lock). Defense in depth — si el script del head falla a cargar (CSP, error JS, navegador con JS deshabilitado), Locksmith atrapa el acceso directo a producto/colección.

### Configuración

| Pieza | Valor |
|---|---|
| Lock ID | `806866` |
| Lock scope | Productos + colección `all`. |
| Lock redirect URL | `/pages/cuenta-en-revision`. |
| Key ID | `1084647` |
| Key conditions | `customer_signed_in` AND `customer_tag = aprobado`. |
| Key redirect URL | **Vacío** (ver gotcha). |

### Snippets inyectados

Locksmith inyecta automáticamente 3 snippets en el theme:

- `snippets/locksmith.liquid`
- `snippets/locksmith-variables.liquid`
- `snippets/locksmith-content-variables.liquid`

**No editar manualmente** — la app los regenera en cada instalación. Si se modifican, los cambios se pierden la próxima vez que Locksmith reinstale.

### ⚠️ Gotcha — `redirect_url` en KEY vs LOCK

Locksmith permite poner `redirect_url` tanto en la **lock** como en la **key**. Tienen comportamientos **opuestos**:

| Campo | A quién se aplica | Cuándo se usa |
|---|---|---|
| `redirect_url` en la **lock** | Visitantes que **NO** tienen la key (acceso denegado). | Caso normal: "redirige a no-aprobados a /pages/cuenta-en-revision". |
| `redirect_url` en la **key** | Visitantes que **SÍ** abren el lock con esa key (acceso concedido). | Casos raros: "tras autenticarse, mandar a una página específica". |

**Bug histórico** (deploy 2026-04-29, commit `522d1df`): la key 1084647 tuvo configurado `redirect_url = /pages/cuenta-en-revision` **por error**. Resultado: customers aprobados eran redirigidos a en-revisión cada vez que abrían una ficha de producto o `/collections/all` (Locksmith mapea `product → product_in_collection` con `collection.handle == "all"`).

**Reglas para mantenimiento**:

- En la **key 1084647**: `redirect_url` siempre **vacío**. Su único trabajo es abrir el lock.
- En la **lock 806866**: `redirect_url = /pages/cuenta-en-revision`. Redundante con el gate del theme pero no estorba.

Si en el futuro se recrea la key (reset, otro entorno, migración), revisar este punto antes de publicar el tema.

## Capa 3 — Header & footer gates

Independientes del gate de redirección. Deciden qué section se renderiza en cada página según el tag del Customer.

### Header gate

`layout/theme.liquid` líneas 413-418:

```liquid
{%- if customer.tags contains 'aprobado' -%}
  {% section 'b2b-header' %}
{%- elsif template == 'index' -%}
  {%- comment -%} home pública: sin header, brand-block en hero {%- endcomment -%}
{%- else -%}
  {% section 'b2b-header-simple' %}
{%- endif -%}
```

| Estado | Header renderizado |
|---|---|
| Aprobado en cualquier ruta | `b2b-header` (header unificado con nav comercial, search, cart). |
| No-aprobado en `template == 'index'` | Sin header. El hero de `b2b-portal-home` actúa como brand-block full-page. |
| No-aprobado en cualquier otra ruta | `b2b-header-simple` (minimalista, evita filtrar nav comercial). |

### Footer gate

`layout/theme.liquid` líneas 430+:

```liquid
{%- if customer.tags contains 'aprobado' -%}
  {% sections 'footer-group' %}
{%- endif -%}
```

| Estado | Footer renderizado |
|---|---|
| Aprobado | Footer estándar de Dawn (`footer-group`). |
| No-aprobado | Sin footer — las páginas status / portal tienen su propio footer dentro de su section. |
| Legales (cualquier estado) | Sin footer — evita links comerciales en pantallas de aviso legal. |

## Tabla de comportamiento esperado

Matriz Customer × URL → destino final. Util para QA y para validar cambios al gate.

| Customer | URL | Capa que dispara | Destino |
|---|---|---|---|
| Anónimo | `/` | — | 200 (home pública). |
| Anónimo | `/products/X` | Capa 1 (Liquid) | `/pages/acceso-profesional`. |
| Anónimo | `/collections/Y` | Capa 1 (Liquid) | `/pages/acceso-profesional`. |
| Anónimo | `/pages/acceso-profesional` | — | 200 (exempt). |
| Anónimo | `/pages/aviso-legal` | — | 200 (exempt). |
| Anónimo | `/account/register` | — | 200 (form B2B; accesible directo con URL). |
| Logueado sin tags | `/` | — | 200 (home con mensaje pendiente). |
| Logueado sin tags | `/products/X` | Capa 1 (Liquid) | `/pages/cuenta-en-revision`. |
| Logueado `pendiente` | `/collections/coleccion-2026` | Capa 1 (Liquid) + Capa 2 (Locksmith) | `/pages/cuenta-en-revision`. |
| Logueado `pendiente` | `/pages/aviso-legal` | — | 200 (exempt). |
| Logueado `rechazado` | `/` | Capa 1 (Liquid) | `/pages/cuenta-rechazada`. |
| Logueado `rechazado` | `/products/X` | Capa 1 (Liquid) | `/pages/cuenta-rechazada`. |
| Logueado `aprobado` | `/products/X` | — | 200. |
| Logueado `aprobado` | `/checkout` | Capa 1 (Liquid) | `routes.cart_url`. |
| Logueado `aprobado` | `/pages/cuenta-en-revision` | — | 200 (lo ve pero no útil). |
| Logueado `aprobado` | `/pages/admin-backoffice` (sin tag `backoffice`) | Capa 1 (Liquid) — no exempt | (sigue path normal del gate; ver [06-backoffice](06-backoffice.md) para el sub-gate UX) |

Test scenarios completos en [16-operations-runbook](16-operations-runbook.md) §smoke test.

## Gotchas conocidos

### Redirect client-side

El redirect del bloque Liquid es JS (`<script>window.location.replace(...)</script>`). Implicaciones:

- **Cliente con JS deshabilitado**: ve la página antes del redirect. Para perfil B2B profesional (compradores en empresas, navegadores estándar) se acepta.
- **Crawlers SEO**: ven la página antes del redirect. El gate no afecta a posicionamiento si los robots.txt no excluyen las URLs gateadas — actualmente no se excluyen (deuda pendiente, ver [16-operations-runbook](16-operations-runbook.md) §seo).
- **Alternativa futura**: meta refresh server-side (`<meta http-equiv="refresh">`). Sería más resistente pero no permite control de locale dinámico tan limpio. Aparcada.

### Locksmith `redirect_url` en key

Documentado arriba en §Capa 2. Resumen: si se recrea la key, dejar `redirect_url` **vacío**.

### Preview hosts no aplican gate

`*.shopifypreview.com` está en el escape hatch porque el OAuth de new customer accounts rechaza preview como `redirect_uri`. En preview el gate **no funciona** — comprobar siempre el comportamiento en el dominio real antes de validar un cambio.

### Theme editor no aplica gate

`request.design_mode` también está en el escape hatch. Esto significa que cualquier change que el dev edite en theme editor no verá el gate. Si una sección depende de que el gate haya redirigido, en theme editor no se comportará como en producción. **Probar siempre en preview real con un customer real**.

## Pendientes y deuda

### Customer Account UI Extensions (no implementadas)

La pantalla de login de Shopify (new customer accounts) está hosteada por Shopify. Solo se puede customizar:

- **Branding**: colores, logo, fuentes vía Branding API ([D5](adrs/d05-customer-accounts.md), [03-theme-customizaciones](03-theme-customizaciones.md)).
- **Copy custom**: requiere Customer Account UI Extensions — son extensiones de una **Shopify app**, no del theme. Implementarlas implicaría crear un proyecto de app aparte.

Si el cliente pide en el futuro un mensaje de bienvenida o links B2B dentro del login, hay que construir esa extensión.

### Recreación de Locksmith Rule 1 y 3 (reversible)

Si Locksmith resuelve el bug `High-level job failure` que impedía 2 locks Entire Store:

1. Crear Lock para Rule 1 (rechazado → `/pages/cuenta-rechazada`).
2. Crear Lock para Rule 3 (anónimo → `/pages/acceso-profesional`).
3. Eliminar el bloque Liquid del `<head>` en `layout/theme.liquid`.

Cambio 100% reversible. El bloque Liquid se borra; los redirects los pasa a hacer Locksmith server-side. Cuándo merece la pena: si el caveat del JS client-side se vuelve crítico (cambio de perfil de clientes, requisitos SEO, etc.).

### `robots.txt` no excluye rutas gateadas

Hoy los crawlers pueden indexar `/products/...` aunque al cargarlas redirijan. Bajo impacto — Google no indexa URLs con `<script>` de redirect inmediato si llega a renderizar JS. Mitigación pendiente: excluir las rutas comerciales en `robots.txt` y/o `<meta name="robots">` condicional según tag.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
