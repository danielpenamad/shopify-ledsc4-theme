# Walkthrough — bodies de email

El store actual (Development / affiliate) no tiene acceso a Shopify Email.
La estrategia mixta que aplicamos:

- **Emails 01, 02, 04, 05, 06 (al cliente)** → acción de Flow
  **`Send marketing mail`** + plantilla guardada en **Shopify Messaging**.
  Se crean en el admin una vez; los Flows referencian la plantilla por nombre.
- **Email 03 (al backoffice)** → acción de Flow **`Send internal email`** con
  subject + body pegados **inline** en el step (Shopify no permite variables
  en el campo To; se hardcodea `daniel.pena+backoffice@creacciones.es`).

Los `.liquid` de esta carpeta son la **fuente de verdad** del contenido.

## Tabla general

| # | Archivo | Flow que lo usa | Mecanismo en Flow | To |
|---|---|---|---|---|
| 1 | `01-bienvenida-auto.liquid`             | W1 rama A | Send marketing mail (template en admin) | `{{ customer.email }}` |
| 2 | `02-solicitud-recibida.liquid`          | W1 rama B | Send marketing mail | `{{ customer.email }}` |
| 3 | `03-backoffice-nuevo-pendiente.liquid`  | W1 rama B | Send internal email (inline, To hardcoded) | `daniel.pena+backoffice@creacciones.es` |
| 4 | `04-cuenta-aprobada-manual.liquid`      | W2        | Send marketing mail | `{{ customer.email }}` |
| 5 | `05-cuenta-rechazada.liquid`            | W3        | Send marketing mail | `{{ customer.email }}` |
| 6 | `06-bienvenida-reevaluacion.liquid`     | W4        | Send marketing mail | `{{ customer.email }}` |

## Subjects (campo "Asunto" de cada envío)

| # | Subject |
|---|---|
| 1 | `Tu cuenta B2B de LedsC4 Outlet está activa` |
| 2 | `Hemos recibido tu solicitud de alta B2B` |
| 3 | `[B2B] Nuevo registro pendiente — {{ runCode.empresa }}` *(inline en Send internal email, con Flow Liquid)* |
| 4 | `Tu solicitud B2B ha sido aprobada` |
| 5 | `Estado de tu solicitud B2B` |
| 6 | `Tu cuenta B2B de LedsC4 Outlet está activa` |

## Cargar los 5 templates marketing en Shopify Messaging

El plan actual (Development) permite **crear** plantillas pero **no enviar**
(aviso "Actualiza tu plan para enviar correos"). Se guardan como borrador y
se activan automáticamente al pasar a un plan de pago.

Para cada uno de los 5 templates marketing (01, 02, 04, 05, 06):

1. Admin → **Marketing** → sección **Messaging** (o **Campañas** según UI) → **Crear** → **Correo electrónico**.
2. Nómbralo con la convención:
   - `B2B · 01 · Bienvenida (auto)`
   - `B2B · 02 · Solicitud recibida`
   - `B2B · 04 · Cuenta aprobada (manual)`
   - `B2B · 05 · Cuenta rechazada`
   - `B2B · 06 · Bienvenida (re-evaluación)`
3. **Asunto**: copia exacta de la tabla de Subjects de arriba.
4. En el editor, cambia a **vista de código** (icono `</>`).
5. Pega íntegramente el contenido del `.liquid` correspondiente (los
   ficheros ya incluyen `{{ unsubscribe_link }}` y `{{ open_tracking_block }}`
   que son obligatorios en marketing mail).
6. **Guardar como borrador**. No intentar enviar.
7. En Flow, en la acción **`Send marketing mail`**, selecciona este template
   por su nombre.

## Email 03 — pegar inline en Send internal email

Para el email al backoffice (rama B de W1):

- **Step de Flow**: `Send internal email`
- **To**: `daniel.pena+backoffice@creacciones.es` (literal)
- **Subject**: `[B2B] Nuevo registro pendiente — {{ runCode.empresa }}`
- **Body**: copia el contenido de `03-backoffice-nuevo-pendiente.liquid`
  (omitir el bloque `<!-- ... -->` y los comentarios; pegar desde la línea
  "Nuevo cliente pendiente..." en adelante).

El `.liquid` ya usa sintaxis de Flow (camelCase + `runCode.*`).

## Variables disponibles en los templates

### En Shopify Messaging (emails 01, 02, 04, 05, 06)

Liquid estándar de Shopify. Funciona:
- `{{ customer.first_name }}`, `{{ customer.last_name }}`, `{{ customer.email }}`, `{{ customer.phone }}`
- `{{ customer.metafields.b2b.empresa }}`, `.nif`, `.sector`, `.pais`, `.volumen_estimado`
- `{{ customer.metafields.b2b.fecha_registro }}`, `.fecha_aprobacion`, `.motivo_rechazo`
- `{{ shop.name }}`, `{{ shop.url }}`
- Obligatorios: `{{ unsubscribe_link }}`, `{{ open_tracking_block }}`

### En Send internal email de Flow (email 03)

Liquid de Flow — sintaxis distinta, camelCase + outputs de Run code:
- `{{ customer.firstName }}`, `{{ customer.lastName }}`
- `{{ customer.defaultEmailAddress.emailAddress }}` (customer.email deprecado)
- `{{ customer.defaultPhoneNumber.phoneNumber }}`
- `{{ runCode.empresa }}`, `.nif`, `.sector`, `.pais`, `.volumen_estimado`, `.fecha_registro`
  (outputs del Run code `parseAndNormalize` del workflow)
- GID filters: `{{ customer.id | split: '/' | last }}` extrae el ID numérico

## Cuando cambie un body

- **Marketing templates**: editar el `.liquid` en el repo **y** abrir la
  plantilla en Shopify Messaging para pegar la versión nueva. Guardar de
  nuevo como borrador.
- **Email 03 inline**: editar el `.liquid` **y** el body del step Send
  internal email de W1. Exportar `flows/W1-registro.flow.json` tras el cambio.

## Checklist

- [ ] 01 `B2B · 01 · Bienvenida (auto)` creado en Messaging (borrador)
- [ ] 02 `B2B · 02 · Solicitud recibida` creado
- [ ] 04 `B2B · 04 · Cuenta aprobada (manual)` creado
- [ ] 05 `B2B · 05 · Cuenta rechazada` creado
- [ ] 06 `B2B · 06 · Bienvenida (re-evaluación)` creado
- [ ] 03 `Send internal email` configurado inline en W1 rama B
- [ ] Test: variables se resuelven correctamente (no salen literales `{{ ... }}`)

## Deuda técnica declarada

En el plan Development no se pueden **enviar** marketing mails, solo
crearlos como borradores. En los 5 escenarios de test (`docs/test-scenarios.md`)
los emails que "deberían ir al cliente" no llegarán a ninguna bandeja. Valida
que Flow llega al step sin error; el envío real se verifica al migrar a Grow.

El email 03 (backoffice, internal) sí se envía en Development.
