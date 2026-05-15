# D4 · Gate híbrido (Liquid + Locksmith)

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase C (mayo 2025) · vigente. Iteración del destino para anónimos: 4-may-2026 (intercalación de la landing `/pages/acceso-profesional`).

## Contexto

El portal necesita un gate de acceso con tres reglas por estado del Customer:

1. **Anónimo** — debe ver la landing comercial y los CTAs de registro/login. No puede acceder a productos, colecciones, checkout, ni páginas internas.
2. **Pendiente / rechazado** — autenticado pero sin tag `aprobado`. Debe ver una página de estado (cuenta en revisión o cuenta rechazada) y no acceder a rutas comerciales.
3. **Aprobado** — acceso completo al catálogo y a `/pages/solicitar-pedido` (sustitutivo del checkout nativo, deshabilitado en Fase D).

El plan original (kickoff Fase C) era implementar las tres reglas con **Locksmith**:

- Rule 1: `customer.tags contains 'rechazado'` → bloquea y redirige.
- Rule 2: `customer.tags NOT contains 'aprobado'` → bloquea colección `coleccion-2026`.
- Rule 3: Entire Store, anónimo → bloquea y redirige a login.

Al instalar Locksmith con scope **Entire Store** (Rule 3), la app falla con `High-level job failure` y no permite completar la regla. Causa raíz no resuelta — el soporte de Locksmith atribuye el fallo al tamaño del catálogo y a las particularidades del template B2B. Rules 1 y 2 sí se pueden definir, pero Rule 1 redirige por path completo (no contempla rutas dinámicas como `/account/*`) y queda inutilizable.

## Decisión

Gate principal **en Liquid**, dentro de `layout/theme.liquid` (`<head>`, justo antes de `</head>`). Locksmith queda como **segunda capa de defensa** únicamente para Rule 2 (collection lock).

Lógica del gate en theme:

```liquid
{%- unless request.design_mode or request.host contains '.shopifypreview.com' or request.page_type == 'password' -%}
  {%- assign gate_exempt_paths = '/,/account/login,/account/register,...,/pages/acceso-profesional' | split: ',' -%}
  {%- if gate_path is exempt -%}
    {# no-op #}
  {%- elsif customer == nil -%}
    <script>window.location.replace('{{ locale_prefix }}/pages/acceso-profesional');</script>
  {%- elsif customer.tags contains 'rechazado' -%}
    <script>window.location.replace('{{ locale_prefix }}/pages/cuenta-rechazada');</script>
  {%- elsif customer.tags contains 'aprobado' -%}
    {%- if gate_path contains '/checkout' -%}
      <script>window.location.replace('{{ routes.cart_url }}');</script>
    {%- endif -%}
  {%- else -%}
    {# pendiente: bloquea solo rutas comerciales #}
    <script>window.location.replace('{{ locale_prefix }}/pages/cuenta-en-revision');</script>
  {%- endif -%}
{%- endunless -%}
```

Tres excepciones técnicas que no aplican gate:

- `request.design_mode` — theme editor de Shopify (rompería previsualización).
- `request.host contains '.shopifypreview.com'` — preview de theme. El OAuth de new customer accounts rechaza `redirect_uri` de dominios preview, así que aplicar gate aquí encadenaría errores.
- `request.page_type == 'password'` — tienda en password protection.

Paths exentos (acceso público): home, `/account/login`, `/account/register`, `/account/recover`, `/account/activate/*`, `/account/reset_password/*`, `/account/logout`, `/account/sign_out`, `/pages/cuenta-en-revision`, `/pages/cuenta-rechazada`, `/pages/acceso-profesional`, `/pages/registro-recibido`, `/pages/aviso-legal`, `/pages/politica-de-privacidad`, `/pages/condiciones-de-uso`, `/pages/canal-de-denuncias`, `/policies/*`.

**Locksmith Rule 2** sigue activa como segunda capa: bloquea la collection `coleccion-2026` a customers sin tag `aprobado`. Es defense-in-depth — si el script del head falla a cargar (CSP, error JS, navegador antiguo), Locksmith atrapa el acceso directo a producto/colección.

### Destino del anónimo (iteración 4-may-2026)

Hasta el 4-may-2026, anónimo redirigía directamente a `/customer_authentication/login?return_to=...`. Desde esa fecha, se intercala la landing `/pages/acceso-profesional`, que presenta el portal y ofrece dos CTAs:

- Primario — `/account/register` (form B2B real).
- Secundario — login OAuth con `return_to` correcto.

Motivo del cambio: reducir fricción para visitantes que no conocen aún la marca y dar contexto antes de pedir credenciales.

## Alternativas consideradas

**Locksmith puro (3 reglas).** Bloqueada por el fallo `High-level job failure` en Rule 3 (Entire Store). Sin Rule 3 no hay gate para anónimo, así que la opción quedó técnicamente inviable.

**Liquid puro (sin Locksmith).** Descartada — sin segunda capa, un fallo del script en `<head>` deja toda la colección accesible vía URL directa. Locksmith Rule 2 mitiga este escenario en el path crítico (compra).

**Customer Account UI Extensions.** Shopify expone extensiones para customizar el portal hospedado en `/account` (post-login). No cubren el gate de storefront, solo personalizan vistas internas. Pendiente para Fase E (mejora del dashboard del aprobado, no del gate).

## Consecuencias

- **Mantenimiento del gate vive en el theme**. Cualquier cambio en estados de customer (nuevas tags, nuevos paths exentos) requiere editar `layout/theme.liquid`. Documentado en [04-storefront-gate](../04-storefront-gate.md).
- **No hay protección server-side**. El gate redirige client-side con `window.location.replace`. Un cliente con JS deshabilitado, o una request directa a la API del storefront, ve la página. Mitigaciones: Locksmith Rule 2 en colecciones críticas, y el catálogo B2B nativo ([D2](d02-b2b-nativo.md)) que limita qué productos son visibles a quién (los precios B2B no aparecen sin Company asignada).
- **Locale-aware**. El gate usa `routes.root_url` para construir `locale_prefix` (`''` en raíz, `/fr` en `/fr`). Mantiene el locale tras redirect.
- **Excepciones no son configurables**. Lista de exempt paths está hardcoded en el theme. Añadir uno requiere PR. Documentado en [04-storefront-gate](../04-storefront-gate.md).
- **Customer Account UI Extensions** ([D5](d05-customer-accounts.md)) viven en otro plano y no comparten lógica con este gate.

## Cambios

- **v0.1** (15-may-2026): primera publicación.
