# Branding del login (new customer accounts)

Aplicado **2026-05-04** vía Admin GraphQL — `checkoutBrandingUpsert`.

## Contexto

Shopify ha forzado el sistema **new customer accounts** para todas las tiendas.
La página `/account/login` ya **no se renderiza desde el tema** sino desde una
URL hospedada por Shopify (`shopify.com/<shop_id>/account/...`).

Consecuencia para este repo:

- `templates/customers/login.json` y `sections/main-login.liquid` ya **no
  intervienen** en el login real. Son del flujo classic (deprecado por
  Shopify). No los borramos por compatibilidad si Shopify revierte algo, pero
  cualquier cambio ahí es invisible al usuario.
- La personalización del login se hace por **Branding API**, que vive bajo
  el `CheckoutProfile` (nomenclatura desafortunada: el API se llama
  "checkout branding" pero también estiliza customer accounts; comparten
  panel en Admin → Settings → Checkout → Customizations).

## Lo aplicado

| Token | Valor | Fuente en el tema |
|---|---|---|
| `customizations.header.logo.image` | `logo-ledsc4.png` (800×181) — PNG, **NO SVG** | `assets/logo-ledsc4.svg` convertido |
| `customizations.header.logo.maxWidth` | `140px` | coherente con `b2b-header-simple` (default 140) |
| `customizations.favicon.image` | mismo PNG | — |
| `designSystem.colors.global.brand` | `#1A1A1A` | fill del SVG + `scheme-1.button` del tema |
| `designSystem.colors.global.accent` | `#1A1A1A` | igual |
| `designSystem.colors.schemes.scheme1.base.background` | `#FFFFFF` | `scheme-1.background` del tema |
| `designSystem.colors.schemes.scheme2.base.background` | `#F5F5F5` | `scheme-2.background` del tema |
| `designSystem.typography.primary.shopifyFontGroup` | `Assistant` 400/700 | `type_header_font: assistant_n4` |
| `designSystem.typography.secondary.shopifyFontGroup` | `Assistant` 400/700 | `type_body_font: assistant_n4` |

`text`, `accent`, `border`, `decorative`, `icon` y los botones (primary /
secondary) **no se setean explícitamente**: la API los auto-deriva del
`brand` y los `background` para garantizar contraste WCAG. En la query de
lectura aparecen como `null` — eso es "auto", no "vacío". Comprobado
visualmente en `/account/login` (logo + header en negro + botón "Continuar"
auto-rellenado en negro sobre blanco).

## Limitaciones (UI propiedad de Shopify)

No se pueden personalizar:

- Strings del formulario: `"Iniciar sesión"`, `"Correo electrónico"`,
  `"Continuar"`, `"Enviar"`, `"Política de privacidad"`. Son fixed strings
  de Shopify, traducidos por locale (`es-ES` aquí).
- Layout / orden de campos del formulario.
- Comportamiento de OTP y enlace mágico.

Para añadir copy custom (mensaje de bienvenida, info B2B, links a páginas
del portal aprobado) hay que crear un **Customer Account UI Extension**
(extensión de app Shopify, fuera del tema). Pendiente — no abordado.

## Reproducibilidad

### Pre-requisitos

1. **Plan**: Plus o Development (limitación de la Branding API).
2. **Scopes** del Custom App (Admin → Apps → Develop apps → tu app →
   Configuration → Admin API access scopes):
   - `read_checkout_branding_settings`
   - `write_checkout_branding_settings`
   - `read_themes` y `write_themes` (si en el futuro hay que tocar tema)
3. **Logo en formato PNG** subido a Shopify Files. La API rechaza SVG con
   `"Media image cannot be in SVG format."`.

### Convertir SVG a PNG (one-time)

Cualquier herramienta sirve. Opción rápida con Node + sharp en una carpeta
temporal:

```bash
mkdir -p /tmp/svgconv && cd /tmp/svgconv
npm init -y && npm install sharp
node -e "
  const sharp = require('sharp');
  const fs = require('fs');
  const svg = fs.readFileSync('/path/to/assets/logo-ledsc4.svg');
  sharp(svg, { density: 600 })
    .resize({ width: 800 })
    .png({ compressionLevel: 9 })
    .toFile('/path/to/logo-ledsc4.png');
"
```

Luego subir a Admin → **Content → Files** (drag & drop) o vía
`stagedUploadsCreate` + `fileCreate` — ver
`scripts/apply-customer-accounts-branding.mjs`.

### Aplicar branding

```bash
node --env-file=shopify-ledsc4-theme.env scripts/apply-customer-accounts-branding.mjs
```

El script es idempotente (re-ejecutable). Hace:

1. `checkoutProfiles` → encontrar el profile publicado.
2. `files(query:"filename:logo-ledsc4.png")` → resolver el `MediaImage` ID.
3. `checkoutBrandingUpsert` con los tokens documentados arriba.

## Verificación

Abrir en navegador (incógnito o tras `/account/logout`):

```
https://ledsc4-b2b-outlet.myshopify.com/account/login
```

Debe mostrar:

- Logo "LedsC4" en negro centrado en la cabecera.
- Card blanca sobre fondo gris claro.
- Heading "Iniciar sesión" en Assistant.
- Botón "Continuar" en negro con texto blanco.

## Referencias

- [Shopify Admin API — `checkoutBrandingUpsert`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/checkoutBrandingUpsert)
- [Schema `CheckoutBrandingInput`](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/CheckoutBrandingInput)
- [New customer accounts overview](https://help.shopify.com/en/manual/customers/customer-accounts/new-customer-accounts)
