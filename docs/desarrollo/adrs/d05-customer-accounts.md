# D5 · New customer accounts

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada (impuesta por plataforma)
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase B (junio 2025) · vigente.

No es una elección de diseño. Es una **restricción impuesta por Shopify**: desde febrero de 2026, las legacy customer accounts (login con email + password sobre templates Liquid) están deprecadas y no están disponibles para tiendas nuevas ni para tiendas existentes que no las estuvieran usando. El portal B2B se creó después de esa fecha, así que el sistema de autenticación quedó fijado a new customer accounts desde el primer momento.

## Contexto

Shopify mantiene dos sistemas de cuentas:

- **Legacy customer accounts** — login con email + password, templates Liquid (`templates/customers/login.liquid`, `register.liquid`, `account.liquid`…), reset por email. Deprecado desde febrero 2026.
- **New customer accounts** — login passwordless con código de 6 dígitos vía email, OAuth 2.0 con PKCE, portal hospedado por Shopify en `shop.myshopify.com/account`, branding gestionado por Branding API. Sistema único disponible para portales nuevos.

El portal B2B Outlet se construyó sobre new customer accounts por imposición de plataforma. La consecuencia no es trivial: el sistema cambia cómo se hace el alta, cómo se autentica, qué se puede customizar del portal, y cómo se integra con los Flow.

Las decisiones reales que sí se tomaron son las que cubren los huecos que dejan las new customer accounts respecto a un flujo B2B clásico:

1. **El register form B2B no puede vivir en `templates/customers/register.liquid`** (no existe en el nuevo sistema). Se mueve a la página `/pages/acceso-profesional` + edge function `register-b2b-customer`.
2. **El portal post-login (`/account`) no es customizable vía Liquid**. Se asume el look-and-feel hospedado, ajustado por Branding API.
3. **Los emails de invitación a cuenta se delegan a Shopify** (no se envían desde Flow). La edge function invoca `customerSendAccountInviteEmail`.

## Decisión

Aceptar el sistema impuesto y construir el flujo B2B alrededor:

- **Alta**: edge function `register-b2b-customer` ([05-registro-b2b](../05-registro-b2b.md)) recibe el form de `/pages/acceso-profesional`, crea el `Customer` con tag `b2b-pendiente`, persiste metafields de empresa, e invoca `customerSendAccountInviteEmail`. El comprador recibe el código de 6 dígitos y completa el login passwordless.
- **Login**: el flujo OAuth de Shopify maneja la autenticación. El gate del theme ([D4](d04-gate-hibrido.md)) trata las URLs `/customer_authentication/*` y `/account/*` como exempt paths.
- **Branding del portal**: `scripts/apply-customer-accounts-branding.mjs` aplica vía `checkoutBrandingUpsert`. Tokens actuales:
  - Color brand y accent: `#1A1A1A`.
  - Esquemas de fondo: blanco / gris claro.
  - Fuente: Assistant (la misma que Dawn).
  - Logo: `logo-ledsc4.png` en Shopify Files (PNG obligatorio — la API rechaza SVG).
  - Max width logo: 140px.
- **Cleanup de `templates/customers/register.json`** (9-may-2026): el archivo se elimina del repo porque no se sincroniza desde Dawn y no aporta nada al sistema actual.

## Alternativas consideradas

No las hay para el sistema de autenticación. La elección estaba forzada desde la creación del portal.

Las únicas alternativas reales eran sobre **cómo cubrir el alta B2B** que las new customer accounts no contemplan nativamente:

**Login custom con Auth0 / Supabase Auth.** Descartada por:
- El `Customer` en Shopify se crea de todas formas (es el modelo de B2B nativo, [D2](d02-b2b-nativo.md)). Auth externo significaría mantener dos sistemas de identidad sincronizados.
- Romper el flujo nativo de Shopify B2B (Company, CompanyLocation, Catalog) implicaría reimplementar permisos a mano.

**App embedida en Admin para el alta.** Descartada porque añade una capa de OAuth + sesiones para un flujo que solo necesita un endpoint HTTP.

## Consecuencias

- **El login vive en URLs hospedadas por Shopify** (`/customer_authentication/login`, `/customer_authentication/redirect`). El gate del theme las excluye como exempt paths.
- **El portal post-login (`/account`) lo hospeda Shopify**. No es customizable vía Liquid — solo vía Customer Account UI Extensions (no implementadas, pendientes Fase E para mejoras del dashboard del aprobado).
- **Magic code de 6 dígitos**, no magic link. Desde 2025 Shopify migró a códigos OTP vía email. La invocación de `customerSendAccountInviteEmail` dispara este flujo nativo.
- **Templates classic siguen en el repo pero inertes**. Shopify los ignora cuando new customer accounts está activo. Permanecen por compatibilidad con `dawn-sync.yml` ([13-github-actions](../13-github-actions.md)), que sincroniza upstream Dawn y los actualiza periódicamente. Eliminarlos rompería el sync. Archivos: `templates/customers/login.json`, `account.json`, `addresses.json`, `order.json`, `activate_account.json`, `reset_password.json`. `register.json` sí se eliminó porque no se sincroniza desde Dawn.
- **OAuth rechaza dominios preview**. `*.shopifypreview.com` no funciona como `redirect_uri`. Por eso el gate del theme ([D4](d04-gate-hibrido.md)) excluye preview hosts del bloqueo.
- **Branding API requiere scopes** `read_checkout_branding_settings` y `write_checkout_branding_settings`. Documentados en [14-secrets](../14-secrets.md).
- **Brand tokens duplicados**: el script tiene tokens hardcoded y `config/settings_data.json` los tiene como settings de Dawn. Cambiar identidad visual requiere actualizar ambos. Deuda conocida.
- **Sin protección contra bots en el register**. Las legacy accounts forzaban un form Liquid con honeypots/CAPTCHA opcional. Aquí, `/pages/acceso-profesional` + `register-b2b-customer` deben implementar la protección a mano (rate limiting en la edge, validación de email, etc. — ver [05-registro-b2b](../05-registro-b2b.md)).

## Cambios

- **v0.1** (15-may-2026): primera publicación.
