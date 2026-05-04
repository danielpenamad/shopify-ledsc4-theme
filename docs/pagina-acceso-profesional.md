# Página /pages/acceso-profesional

Página informativa pública. Su único objetivo es **explicar el portal a
quien todavía no se ha registrado**: qué es, quién puede entrar, cómo
funciona el proceso de aprobación, qué se encuentra dentro y FAQ. Sirve
de destino al que linkear desde emails comerciales, web corporativa o
firma de un comercial.

## Dónde encaja en el flujo

```
Web corporativa / email comercial / firma comercial
            │
            ▼
   /pages/acceso-profesional       ←  página informativa, gate-exempt
            │
            ▼ (CTAs)
            ├── /account/register                              (form B2B)
            └── /customer_authentication/login?return_to=...   (login OAuth)
```

La home pública (`/`, `b2b-portal-home`) tiene un link discreto bajo los
CTAs apuntando a esta página, para visitantes con dudas que prefieren
leer antes de pulsar "Solicitar acceso".

## Cómo se renderiza

| Pieza | Archivo | Rol |
|---|---|---|
| Page entity en Shopify Admin | gestionada por `scripts/create-b2b-pages.mjs` (entrada en `scripts/pages-manifest.json`) | Crea la URL `/pages/acceso-profesional` con `template_suffix=acceso-profesional`. |
| Template | `templates/page.acceso-profesional.json` | Apunta a la sección `main-acceso-profesional`. |
| Section | `sections/main-acceso-profesional.liquid` | Toda la UI + estilos scoped + schema. |
| Gate exempt | `layout/theme.liquid:332` | `/pages/acceso-profesional` añadido a `gate_exempt_paths` para que sea pública (anónimos pueden verla). |

## Cómo editar el copy

**La fuente de verdad es la sección Liquid** (`sections/main-acceso-profesional.liquid`).
El `body_html` del manifest es solo placeholder por si Shopify Admin
intenta renderizar el contenido de la entity sin template (no debería
ocurrir, pero defensivo).

Editar:
1. Abrir `sections/main-acceso-profesional.liquid`.
2. Modificar el texto en los `<p>`, `<h2>`, `<h3>`, `<details>` correspondientes.
3. Commit + push a `main`. La integración GitHub↔Shopify deploya al tema
   live en ~30-60s.

No hace falta volver a ejecutar `create-b2b-pages.mjs` salvo que cambie
algo del manifest (título, handle, template_suffix).

## Settings disponibles en theme editor

Sobre la sección `main-acceso-profesional`:

- **Esquema de color**: `dark` (por defecto, coherente con
  `b2b-portal-home`) o `light` (mayor legibilidad para texto largo).
- **Mostrar logo en cabecera**: por defecto off — la cabecera del tema
  (`b2b-header-simple`) ya muestra el logo. Activar solo si se quiere
  cabecera tipo landing autocontenida.
- **Padding superior / inferior**: rangos en px.

## Decisión sobre el handle

Elegido: **`acceso-profesional`**.

Descartados:

- `portal-acceso` — invertía orden natural en la URL, menos buscable.
- `como-funciona` — ambiguo cuando se descontextualiza (¿cómo funciona
  qué?). En navegación o emails fuera del contexto del portal, el
  visitante no sabe si es sobre el catálogo, los pedidos, etc.

`acceso-profesional` es explícito, en español, alineado con la
terminología que usa el resto del portal (`/pages/cuenta-en-revision`,
`/pages/cuenta-rechazada`, `/account/register`).

## Smoke test

1. Anónimo: `/pages/acceso-profesional` carga sin redirect (gate exempt).
2. Aprobado / pendiente / rechazado: misma URL, también accesible. Es
   informativa, no comercial.
3. Click "Solicitar acceso" → `/account/register` carga el form B2B.
4. Click "Ya tengo cuenta · Iniciar sesión" → `/customer_authentication/login?return_to=/pages/mis-solicitudes`.
5. En la home `/` (anónimo) aparece el link "¿Tienes dudas sobre el
   acceso? Mira cómo funciona →" bajo los CTAs.

## Ver también

- [docs/arquitectura.md](arquitectura.md) — visión general del proyecto.
- [docs/locksmith-rules.md](locksmith-rules.md) — gate de storefront,
  contexto de los `gate_exempt_paths`.
- [docs/shopify-customer-accounts-branding.md](shopify-customer-accounts-branding.md) —
  por qué el login real es Shopify-hosted.
