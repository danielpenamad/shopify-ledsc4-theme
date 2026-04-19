# Locksmith — reglas del storefront gate (Fase C)

Guía de configuración de Locksmith para el portal B2B de LedsC4 Outlet.
3 reglas (locks) cubren todos los casos. Orden de evaluación por
especificidad del resultado: rechazado gana > aprobado gate > login gate.

## Prerrequisito

Locksmith app instalada: Admin → **Apps → Shopify App Store → Locksmith → Add app**. Hasta $9-19/mes según plan; en Development store suele estar gratis.

Tras instalar:
- Admin → **Apps → Locksmith**
- **Create a new lock** en el asistente.

---

## Regla 1 — "Rechazados: redirigir siempre" (prioridad alta)

Un customer con tag `rechazado` no debe ver NADA del portal excepto la
página informativa y el logout. Aplicamos un lock con alcance "Entire store"
y excepción URL.

### Config en admin

1. **Create a new lock** → alcance: **Entire store**.
2. Nombre: `B2B — rechazados redirect`.
3. Descripción: `Customers con tag 'rechazado' van a /pages/cuenta-rechazada.`

4. **Keys** (qué abre el lock):
   - **Customer is not logged in** → NO tiene esta llave.
   - **Customer is logged in AND customer tag does not include 'rechazado'** → SÍ tiene la llave (el lock se abre).
   - El atajo en el UI de Locksmith: añadir una key "Customer tag does not include" → value `rechazado`. Si Locksmith no tiene ese operador, invertir la lógica con "Custom key" y condiciones avanzadas.

5. **When locked, redirect to**: `/pages/cuenta-rechazada`

6. **Exclusions / Bypass URLs** (estas rutas escapan del lock):
   - `/pages/cuenta-rechazada`
   - `/account/logout`
   - `/account/sign_out`
   - `/policies/*`
   - `/pages/aviso-legal`
   - `/pages/politica-de-privacidad`
   - `/pages/condiciones-de-uso`
   - `/pages/canal-de-denuncias`

---

## Regla 2 — "Solo aprobados ven catálogo" (prioridad media)

Cualquier customer sin tag `aprobado` (anónimo, sin tags, con `pendiente`) que
intente ver catálogo es redirigido a la página de "cuenta en revisión". El
homepage (`/`), las páginas informativas y `/account/*` no disparan este lock
(lo gestionan la Regla 3 o son públicas).

### Config en admin

1. **Create a new lock** → alcance: **Specific resources** → selecciona
   todos los productos + todas las colecciones. O **Custom scope** con regla
   URL (ver abajo si Locksmith lo permite).
2. Nombre: `B2B — solo aprobados ven catálogo`.
3. Descripción: `Redirige a /pages/cuenta-en-revision si no tiene tag aprobado.`

4. **Keys**:
   - **Customer is logged in AND customer tag includes 'aprobado'** → SÍ tiene la llave.

5. **When locked, redirect to**: `/pages/cuenta-en-revision`

6. **Recursos cubiertos**:
   - All products (`/products/*`)
   - All collections (`/collections/*`)
   - Cart (`/cart`, `/cart/*`)
   - Products search (`/search`)

> Si Locksmith solo ofrece "All products" y "All collections" pero no `/cart`
> ni `/search`, crear locks adicionales del mismo tipo para esos recursos.

---

## Regla 3 — "Login obligatorio" (prioridad baja, catch-all)

Si el customer no está logueado, cualquier URL del portal (salvo las públicas
listadas) redirige a `/account/login`.

### Config en admin

1. **Create a new lock** → alcance: **Entire store**.
2. Nombre: `B2B — login requerido`.
3. Descripción: `Anónimos → /account/login. Homepage y legales quedan públicos.`

4. **Keys**:
   - **Customer is logged in** → SÍ tiene la llave.

5. **When locked, redirect to**: `/account/login`

6. **Exclusions / Bypass URLs**:
   - `/` (homepage — página pública del portal)
   - `/account/login`
   - `/account/register`
   - `/account/recover`
   - `/account/activate/*` (link de email de invitación)
   - `/account/reset_password/*` (link de email de recuperación)
   - `/account/logout`, `/account/sign_out`
   - `/pages/cuenta-en-revision`
   - `/pages/cuenta-rechazada`
   - `/pages/aviso-legal`
   - `/pages/politica-de-privacidad`
   - `/pages/condiciones-de-uso`
   - `/pages/canal-de-denuncias`
   - `/policies/*`

---

## Tabla de comportamiento esperado

| Customer | URL | Regla que dispara | Destino |
|---|---|---|---|
| Anónimo | `/` | — | 200 (home pública) |
| Anónimo | `/products/X` | Regla 3 | `/account/login` |
| Anónimo | `/collections/Y` | Regla 3 | `/account/login` |
| Anónimo | `/pages/aviso-legal` | — | 200 |
| Anónimo | `/account/register` | — | 200 |
| Logueado sin tags | `/` | — | 200 (home con mensaje pendiente) |
| Logueado sin tags | `/products/X` | Regla 2 | `/pages/cuenta-en-revision` |
| Logueado `pendiente` | `/collections/coleccion-2026` | Regla 2 | `/pages/cuenta-en-revision` |
| Logueado `pendiente` | `/pages/aviso-legal` | — | 200 |
| Logueado `rechazado` | `/` | Regla 1 | `/pages/cuenta-rechazada` (no puede ver ni home) |
| Logueado `rechazado` | `/products/X` | Regla 1 | `/pages/cuenta-rechazada` |
| Logueado `aprobado` | `/products/X` | — | 200 |
| Logueado `aprobado` | `/pages/cuenta-en-revision` | — | 200 (lo ve pero no útil) |

## Orden de evaluación en Locksmith

Locksmith aplica **todos los locks activos** para un recurso. Si el customer
no tiene la llave de algún lock que protege el recurso, se redirige. Si hay
varios locks que redirigen, Locksmith usa el **primero en orden de la lista**
(configurable desde el admin de la app).

**Orden recomendado** (editar en Locksmith admin si no sale por defecto):

1. `B2B — rechazados redirect` (debe evaluar primero para que un rechazado
   vea `/pages/cuenta-rechazada` y no `/pages/cuenta-en-revision`).
2. `B2B — solo aprobados ven catálogo`
3. `B2B — login requerido`

## Testing post-config

Ver [docs/test-scenarios.md](test-scenarios.md) §Storefront gate.

## Exportar los 3 locks

Locksmith ofrece **Export** en el admin de la app (`⋯` → Export). Guardar los 3
JSON en `docs/locksmith/` (crear carpeta al exportar) para versionado.

## Troubleshooting

- **Customer aprobado ve la página "en revisión"**: la Regla 2 se dispara sobre
  una URL que no debería. Revisar scope del lock — no debe incluir páginas
  informativas ni `/account/*`.
- **Rechazado ve catálogo**: la Regla 1 no dispara primero. Revisar orden.
- **Anónimo puede ver productos**: la Regla 3 no protege `/products/*`. Locksmith
  con alcance "Entire store" debería cubrirlo; si no, añadir un lock específico
  para products.

## Futuro — cuando se abra el catálogo a visitantes

Si se decide que anónimos vean productos pero sin precios ni botón comprar:
- Quitar `/products/*` de la Regla 3 (o cambiar scope).
- En `templates/product.json` / sections, gatear los bloques de precio y
  botón de compra con `{% if customer.tags contains 'aprobado' %}`. No está
  en alcance de Fase C.
