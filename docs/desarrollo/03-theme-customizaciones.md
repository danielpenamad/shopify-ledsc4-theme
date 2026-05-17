# 03 · Theme customizaciones

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

El theme de LedsC4 B2B Outlet parte de **Dawn 15.4.1** sin fork. Sobre esa base hay un conjunto acotado de **desviaciones** —sections nuevas, snippets B2B, assets corporativos, settings adicionales, modificaciones a auth pages de Shopify— que conviven con el Dawn original. Cualquier dawn-sync futuro (ver `.github/workflows/dawn-sync.yml`) debe poder pasar sobre los archivos Dawn sin tocar nada del listado de este documento.

Este doc inventaría qué hay desviado, dónde vive y por qué. Si un día Dawn 16 cambia el contrato de algo que tocamos, este doc es la lista de lugares donde mirar primero.

Lo que **no** está aquí: catálogo Dawn vanilla, templates de checkout (no editables fuera de Plus, ver D5), Customer Account UI Extensions (no implementadas — ver §11). El gate B2B en `<head>` vive en 04-storefront-gate; las pantallas concretas del flujo del cliente viven en 04, 05, 06, 07.

## 2. Sections custom B2B

Inventario completo de sections que no vienen de Dawn. Todas viven en `sections/` y, salvo el header, todas se renderizan vía template JSON desde `templates/`.

| Section | Dominio | Doc relacionado |
| --- | --- | --- |
| `b2b-header.liquid` | Header unificado catálogo (aprobados) | §3 |
| `b2b-header-simple.liquid` | Header minimalista no-aprobados | §3 |
| `b2b-portal-home.liquid` | Home del portal (2 ramas según `aprobado`) | §5 |
| `b2b-account-dashboard.liquid` | Dashboard /account (legacy, no renderiza) | §6 |
| `b2b-cuenta-revision.liquid` | /pages/cuenta-en-revision | §4 |
| `b2b-cuenta-rechazada.liquid` | /pages/cuenta-rechazada | §4 |
| `b2b-solicitud-enviada.liquid` | /pages/solicitud-enviada (Fase D) | 07-solicitudes-pedido §3 |
| `b2b-solicitud-form.liquid` | /pages/solicitud (Fase D submit) | 07-solicitudes-pedido §4 |
| `b2b-solicitud-detalle.liquid` | /pages/solicitud-detalle (Fase D ficha) | 07-solicitudes-pedido §5 |
| `b2b-mis-solicitudes.liquid` | /pages/mis-solicitudes (Fase D listado) | 07-solicitudes-pedido §6 |
| `main-acceso-profesional.liquid` | Landing pública + form registro | 05-registro-b2b §3 |
| `main-registro-recibido.liquid` | Confirmación post-registro | 05-registro-b2b §5 |
| `admin-backoffice-pendientes.liquid` | Pestaña pendientes del backoffice | 06-backoffice §3 |
| `admin-backoffice-whitelist.liquid` | Pestaña whitelist del backoffice | 06-backoffice §4 |
| `admin-backoffice-resumen.liquid` | Pestaña resumen del backoffice | 06-backoffice §5 |

Además hay 5 sections **Shopify-hosted** modificadas levemente (auth pages clásicas): `main-account`, `main-activate-account`, `main-addresses`, `main-login`, `main-reset-password`. Estas no se renderizan con New Customer Accounts activado (el flujo de auth vive en `shopify.com/<shop>/account` y no usa theme); las mantenemos por dos motivos: (1) si algún día se desactiva NCA volveríamos a Classic y necesitamos branding, (2) son alcanzables vía `/account/login` directo si alguien construye esa URL a mano. Las modificaciones se limitan a clase CSS extra y referencias a `assets/customer.css` (§9).

## 3. Header dual

Hay dos headers B2B distintos en el theme, elegidos por `layout/theme.liquid` según el estado del customer:

- **`b2b-header.liquid`** (24KB) — header completo con menú de categorías. Solo se renderiza para customers con tag `aprobado` (catálogo visible).
- **`b2b-header-simple.liquid`** (5KB) — header minimalista: solo logo a la izquierda + login/logout a la derecha. Se renderiza para anónimos, pendientes y rechazados, además de en las pantallas de estado.

La razón es proteger el catálogo: el header completo contiene `linklists.main-menu` con nombres de colecciones que filtrarían información comercial a no-aprobados. El gate de header en `theme.liquid` (líneas 413-418, ver 04-storefront-gate §4) elige entre uno y otro.

### `b2b-header-simple` — particularidades técnicas

Tres detalles que no son obvios:

1. **`locale_prefix` normalization**. `routes.root_url` devuelve `'/'` en home y `'/fr'` (sin trailing slash) en locales alternos. Para que las concatenaciones tipo `locale_prefix + '/pages/mis-solicitudes'` produzcan rutas válidas en ambos contextos, se normaliza el `'/'` de home a cadena vacía. Mismo patrón aparece en `b2b-portal-home`, `b2b-account-dashboard` y todas las sections B2B con links internos locale-aware.

2. **Visibilidad condicional del currency switcher**. El switcher de Currency-B (ver D13 y 10-multicurrency cuando exista) se renderiza para anónimos en la landing /pages/acceso-profesional —donde un visitante puede pre-elegir divisa antes de registrarse— y se **oculta** en las pantallas terminales de estado (`cuenta-en-revision`, `cuenta-rechazada`) porque desde ahí no hay catálogo visible y el switcher carecería de función. La detección se hace por `template.suffix`, que Shopify pone a `b2b-cuenta-en-revision` / `b2b-cuenta-rechazada` derivándolo del nombre del JSON template — sin mapeo manual.

3. **Login URL**. Usa `/customer_authentication/login?return_to=...&locale=...`, **no** `/account/login`. Bajo New Customer Accounts, `/account/login` ignora el query string `return_to` y manda siempre a `shopify.com/<shop>/account/orders`. `/customer_authentication/login` sí respeta el redirect. Ver decisión completa en D5 y 04-storefront-gate §6.

## 4. Páginas de estado del flujo B2B

Cuatro sections, todas con el mismo patrón visual (`.b2b-status`) salvo `solicitud-enviada` que usa su propio scope:

- `b2b-cuenta-revision.liquid` → /pages/cuenta-en-revision. Mostrada a customers con tag `pendiente` (Locksmith Rule 2 redirige aquí desde catálogo y home, ver 04-storefront-gate §3). Renderiza datos B2B del customer (empresa, NIF, sector, email) para que confirme lo enviado, y un mensaje configurable vía `page.metafields.b2b.cuenta_revision_mensaje` con fallback a `section.settings.default_message`. El email del backoffice se lee de `shop.metafields.b2b.email_backoffice` (default hardcoded: `backoffice@ledsc4.com`).

- `b2b-cuenta-rechazada.liquid` → /pages/cuenta-rechazada. Mismo patrón que revisión, badge en rojo, mensaje configurable. Se llega aquí cuando un customer rechazado intenta acceder al portal.

- `main-registro-recibido.liquid` → /pages/registro-recibido. Confirmación inmediata tras submit del form de registro B2B (ver 05-registro-b2b §5).

- `b2b-solicitud-enviada.liquid` → /pages/solicitud-enviada. Confirmación tras submit de solicitud de pedido (Fase D, ver 07-solicitudes-pedido §3).

Las cuatro comparten la convención BEM `b2b-status__` (badge, heading, lead, datos, datos-list, datos-heading, correct, ctas, btn). El CSS vive inline en cada section (no se ha extraído todavía a un asset compartido — deuda menor).

## 5. `b2b-portal-home`

La home del portal B2B. Section con dos ramas decididas por `customer.tags contains 'aprobado'`:

### Rama aprobada (`.b2b-aprobado-home`)

Dashboard claro y corto: hero con saludo personalizado + grid de colecciones renderizado vía snippet `b2b-dashboard-cards` (lee `linklists.main-menu` con fallback a "ver catálogo completo") + CTA destacado a /pages/mis-solicitudes. Se renderiza con el header completo `b2b-header.liquid` ya inyectado por `theme.liquid`.

El saludo usa una cascade con tres niveles:

```
customer.metafields.b2b.empresa  →  customer.first_name  →  fallback i18n
```

Hay un patrón importante en cómo se aplica `| t` al fallback (bug histórico PR B, mayo 2026):

```liquid
{%- assign fallback_bienvenido = 'ledsc4.common.greeting.fallback_bienvenido' | t -%}
{%- assign saludo = customer.metafields.b2b.empresa
  | default: customer.first_name
  | default: fallback_bienvenido
-%}
```

El `| t` se pre-resuelve aparte. En la cascade solo viajan valores ya resueltos. Si se pone `| t` pegado al fallback dentro de la misma cascade, Shopify intentaría traducir el resultado final como clave i18n: cuando `customer.metafields.b2b.empresa` traía `"Instalaciones Prueba SL"`, el render salía como `"Translation missing: es.Instalaciones Prueba SL"`. El patrón correcto está replicado en `b2b-mis-solicitudes` y `b2b-account-dashboard` (mismo bug, misma corrección, en commits relacionados).

### Rama no-aprobada (`.b2b-portal`)

Anónimos, pendientes y rechazados ven la misma pantalla: hero oscuro full-screen con CTAs (login + solicitar acceso) + features tripartito + footer legal local. La uniformidad es deliberada — no queremos exponer estados internos a anónimos ni rebozar a pendientes/rechazados con redundancia frente a las pantallas /pages/cuenta-*.

El layout está estable desde el 2026-04-19. No modificar sin revisar el flujo completo de adquisición (landing → registro → estados). Renderiza **sin header** (`theme.liquid` lo suprime para esta rama en /index) y el footer legal local sustituye al footer-group de Dawn — que solo se renderiza para aprobados (ver 04-storefront-gate §5).

Settings expuestos: logo image_picker (fallback si `shop.brand.logo` está vacío) + range logo_width.

## 6. `b2b-account-dashboard` — legacy no renderizado

Section que existe pero **no se ve** con la configuración actual. Reemplaza el `main-account` de Dawn con una vista B2B minimal (CTAs a catálogo, mis-solicitudes, logout). Solo se renderizaría si la tienda cambiase a Classic Customer Accounts en Settings.

Con New Customer Accounts (default Shopify 2026), `/account` está hosteado en `shopify.com/<shop>/account` ignorando el theme. La alternativa adoptada en Fase D post-launch (opción E, ver 07-solicitudes-pedido §1) fue ocultar `/account` del flujo user-facing: todos los CTAs van a /pages/mis-solicitudes o a `/customer_authentication/login?return_to=%2Fpages%2Fmis-solicitudes`.

Mantenemos el archivo por dos motivos: (1) opción de rollback a Classic si NCA da problemas no resueltos, (2) referencia viva del patrón i18n cascade replicado en otras sections. Coste cero, alcanzable a mano desde `/account` si alguien construye esa URL.

## 7. Backoffice sections

Tres sections `admin-backoffice-*.liquid` que renderizan las pestañas de /pages/admin-backoffice. Detalle completo en 06-backoffice §3-§5. Aquí solo el inventario:

- `admin-backoffice-pendientes.liquid` — tabla de clientes pendientes (lista desde edge `list-pending-customers`, acciones aprobar/rechazar)
- `admin-backoffice-whitelist.liquid` — gestión de whitelist por dominio/NIF (edge `update-whitelist`)
- `admin-backoffice-resumen.liquid` — métricas y enlaces rápidos

Estas sections leen sus endpoints y HMAC desde el grupo `B2B · Backoffice (página de aprobaciones)` de `settings_schema.json` (§10). El JavaScript del backoffice está en `assets/admin-backoffice.js` (12KB) y los estilos en `assets/admin-backoffice.css` (8KB) — assets dedicados, no inline.

## 8. Customer accounts branding

Las cinco auth pages de Shopify Classic (`main-account`, `main-activate-account`, `main-addresses`, `main-login`, `main-reset-password`) están **modificadas levemente** para branding B2B: clase CSS extra, referencias a `assets/customer.css` (13KB con paleta y tipografía LedsC4) y assets/customer.js.

Con New Customer Accounts activo (default), estas pages no se renderizan — Shopify hospeda /account fuera del theme. El branding de NCA se configura vía **Shopify Branding API** (ver D5), no en el theme. La razón de mantener las modificaciones del theme: si algún día se vuelve a Classic, el branding sigue presente.

Pendiente real: **Customer Account UI Extensions** no están implementadas (ver §12). Esas serían la vía oficial para inyectar UI custom dentro del /account hosteado.

## 9. Assets custom B2B

Inventario de archivos en `assets/` que no vienen de Dawn:

| Archivo | Tamaño | Función |
| --- | --- | --- |
| `admin-backoffice.css` | 8KB | Estilos del backoffice (pestañas, tabla pendientes, formularios whitelist) |
| `admin-backoffice.js` | 12KB | Lógica del backoffice (fetch a edges, render, HMAC handling cliente) |
| `b2b-register-v2.js` | 13KB | Form de registro B2B (validación cliente, submit a edge `register-b2b-customer`). Ver 05-registro-b2b §4 |
| `customer.css` | 13KB | Modificada vs Dawn original — paleta y tipografía LedsC4 para auth pages Classic |
| `logo-ledsc4.svg` | 2.7KB | Logo principal (fondo claro) |
| `logo-ledsc4-white.svg` | 2.7KB | Logo blanco (fondo oscuro hero) |
| `GlikoModernL-Light.woff2` | 36KB | Fuente corporativa heading |
| `MaisonNeueWEB-Book.woff2` | 38KB | Fuente corporativa body |
| `feed_producto.xlsx` | 1.2MB | **Legacy eliminable**. Sobra de pruebas iniciales del importer; el feed productivo viaja por SFTP, ver 02-importer §2. Nada en runtime lo referencia |
| `stock.csv` | 48KB | **Legacy eliminable**. Mismo caveat que el feed |

Los CSS de componentes Dawn (`component-*.css`, `section-*.css`) están sin tocar — cualquier override visual vive en estilos inline dentro de las sections custom B2B o en los CSS dedicados de arriba.

Las fuentes corporativas (`Gliko`, `MaisonNeue`) están cargadas vía `@font-face` con `font-display: swap` (verificado), de modo que no hay FOUT pendiente de auditar.

## 10. `settings_schema.json` — grupos custom B2B

Sobre los grupos estándar de Dawn (theme_info, logo, colors, typography, layout, animations, buttons, variant_pills, inputs, cards, collection_cards, blog_cards, content_containers, media, popups, drawers, badges, brand_information, social-media, search_input, currency_format, cart), el theme añade **dos grupos B2B**:

### `B2B · Solicitudes de pedido`

Settings para las edges de form-submit del cliente:

| Setting | Default | Propósito |
| --- | --- | --- |
| `order_request_endpoint` | `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/submit-order-request` | Edge que recibe POST de /pages/solicitud |
| `order_request_hmac_secret` | (vacío en repo) | DEBE coincidir con `ORDER_REQUEST_HMAC_SECRET` en Supabase env. Vive en `settings_data.json` no commiteado |
| `list_order_requests_endpoint` | `…/list-order-requests` | Edge que devuelve historial de solicitudes del customer |
| `register_b2b_endpoint` | `…/register-b2b-customer` | Edge que recibe POST de /pages/acceso-profesional#registro |
| `register_b2b_hmac_secret` | (vacío en repo) | DEBE coincidir con `REGISTER_B2B_HMAC_SECRET` en Supabase env. **Distinto** del HMAC de solicitudes — rotación independiente |

### `B2B · Backoffice (página de aprobaciones)`

Settings para las edges del backoffice (operaciones de approver):

| Setting | Default | Propósito |
| --- | --- | --- |
| `backoffice_base_endpoint` | `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/` | Base URL; el backoffice concatena `list-pending-customers`, `update-whitelist`, `approve-customer`, `reject-customer`. Debe terminar con barra |
| `backoffice_hmac_secret` | (vacío en repo) | DEBE coincidir con `BACKOFFICE_HMAC_SECRET` en Supabase env. **Distinto** de los otros dos — el blast radius es mucho mayor (operaciones de approver), rotación independiente |

Por qué tres HMAC distintos en vez de uno solo: rotación independiente y aislamiento de blast radius. Si se filtra el secret del form de registro, no compromete el backoffice. Si se compromete el backoffice (más serio: incluye `approve-customer`), se rota solo ese sin tocar el flujo de cliente. Ver inventario completo de secrets en 14-secrets (cuando exista).

Los valores reales viven en `config/settings_data.json` (no commiteado al repo público, gestionado vía Shopify admin) y en Supabase env vars.

## 11. Snippets custom B2B

Inventario de snippets no-Dawn en `snippets/`:

| Snippet | Función |
| --- | --- |
| `b2b-dashboard-cards.liquid` | Grid de tarjetas de colecciones en home aprobado. Lee `linklists.main-menu` con fallback. Estilos inline |
| `currency-switcher.liquid` | Currency-B switcher (Currency-B, ver D13). Renderizado condicional en `b2b-header-simple` |
| `collection-sidebar-nav.liquid` | Sidebar de navegación de colecciones (parent-child) usado en `main-collection-product-grid` |
| `locksmith.liquid` | Wrapper de integración con app Locksmith |
| `locksmith-variables.liquid` | Variables liquid expuestas a Locksmith para reglas de gate |
| `locksmith-content-variables.liquid` | Variables específicas para reglas Locksmith de tipo "show content" |
| `product-display-title.liquid` | Title de producto con post-procesado (categoría + nombre amigable) |
| `product-documents.liquid` | Bloque de documentos descargables del producto (`product.metafields.docs.*`) |
| `product-spec-badges.liquid` | Badges de specs (IP rating, dimable, etc.) sobre la card de producto |
| `product-specs-table.liquid` | Tabla detallada de specs en la PDP |

El resto de snippets en `snippets/` son Dawn vanilla — no documentados aquí salvo que un futuro PR los modifique.

## 12. Convenciones BEM

El CSS de las sections custom B2B sigue BEM con tres prefijos base según el dominio funcional:

| Prefijo | Dominio | Ejemplo |
| --- | --- | --- |
| `b2b-acceso__` | Landing y form de registro (`main-acceso-profesional`) | `.b2b-acceso__form`, `.b2b-acceso__field--error` |
| `b2b-portal__` | Home no-aprobado (`b2b-portal-home` rama anónimo) | `.b2b-portal__hero`, `.b2b-portal__btn--primary` |
| `b2b-aprobado-home__` | Home aprobado (`b2b-portal-home` rama aprobado) | `.b2b-aprobado-home__heading`, `.b2b-aprobado-home__solicitudes-card` |
| `b2b-status__` | Pantallas de estado (revision, rechazada, solicitud-enviada, registro-recibido) | `.b2b-status__badge--pending`, `.b2b-status__datos-list` |
| `b2b-backoffice__` | Sections del backoffice y assets dedicados | `.b2b-backoffice__tab`, `.b2b-backoffice__pendiente-row` |
| `b2b-account__` | Dashboard /account (legacy no renderizado) | `.b2b-account__grid`, `.b2b-account__card--primary` |
| `b2b-header-simple__` | Header minimalista | `.b2b-header-simple__brand`, `.b2b-header-simple__link` |

El BEM es consistente dentro de cada section. No hay un design system formal con tokens — los colores y tipografías se replican inline en cada `<style>`, lo que crea cierta deuda (cambiar la paleta requiere tocar varios archivos). La paleta efectiva está sin embargo bien acotada:

- Fondo claro: `#fff`, `#f5f5f7` (alt), `#fafaf7` (cards)
- Tinta: `#000`, `#121212` (heading), `rgba(15,18,23,*)` con opacidades 0.55-0.95 (cuerpos)
- Acento azul corporativo: `var(--color-ledsc4-accent)` (definido en `base.css` como `#0051ff` — confirmado)
- Estados: amarillo pendiente `rgb(130,85,0)` sobre `rgba(230,160,0,0.12)`, rojo rechazo (en `b2b-cuenta-rechazada`)

Las CSS vars de Dawn (`--color-foreground`, `--color-background`, `--color-button`, `--color-button-text`, `--font-body-family`, `--font-heading-family`) sí se usan en la rama aprobada de `b2b-portal-home` y en `b2b-account-dashboard` — los componentes que coexisten con catálogo Dawn respetan las vars; los componentes 100% custom (`.b2b-portal`, `.b2b-status`) inline-an valores hex.

## 13. CSS organization

No hay un único CSS B2B central. La organización efectiva es:

1. **CSS inline dentro de sections** — patrón dominante. Cada section custom B2B incluye su `<style>` con scope al elemento raíz (`.b2b-portal`, `.b2b-status`, `.b2b-aprobado-home`, etc.). Ventaja: portabilidad y aislamiento. Desventaja: duplicación.

2. **Assets CSS dedicados** — solo el backoffice (`admin-backoffice.css`, 8KB) y la layer de auth Classic (`customer.css`, 13KB).

3. **Dawn CSS** — sin tocar. Cualquier override visual sobre componentes Dawn (cards, facets, cart) vive como CSS adicional en la section que los usa, no como modificación de los `component-*.css`.

Si en algún futuro PR se extrae un CSS B2B compartido (`b2b-shared.css`), debería empezar por los tokens (paleta, tipografía, radios, espaciados) y los componentes repetidos (`.b2b-status` aparece en 4 sections idéntico).

## 14. Pendientes

- **Customer Account UI Extensions** — no implementadas. Serían la vía oficial moderna para inyectar UI custom en el /account hosteado (NCA). El sustituto actual (ocultar /account y redirigir todo a /pages/mis-solicitudes) funciona y está estable, pero es un workaround. Migrar a UI Extensions implicaría: app dedicada en Shopify Partners, target `customer-account.profile.block.render` o similar, redeploy de assets. Trade-off: ganaríamos integración nativa con /account; perderíamos control absoluto sobre el layout que tenemos con /pages/mis-solicitudes.

- **Extracción de CSS compartido** — `.b2b-status` está duplicado en 4 sections. Si se modifica el diseño de las pantallas de estado, hay que tocar las 4. Deuda menor, no urgente.

- **Eliminar `feed_producto.xlsx` y `stock.csv` de `assets/`** — confirmado como legacy eliminable. El feed productivo viaja por SFTP (ver 02-importer §2) y nada en runtime referencia estos archivos. PR de limpieza pendiente — borra 1.25MB del repo y deja `assets/` enfocado en lo activo.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 12-may-2026.
