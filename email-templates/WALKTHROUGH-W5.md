# W5 · Solicitud B2B creada — walkthrough

Flow que dispara los 2 emails (cliente + backoffice) al crearse un draft
order con tag `solicitud-b2b`. El draft lo crea la edge function
`submit-order-request` desde el storefront `/pages/solicitud`.

## 1. Crear el workflow

Apps → Flow → Create workflow → Start from scratch.

## 2. Trigger

- **Trigger**: `Draft order created`
- Sin customizar nada más.

## 3. Condicion / filtro

- Action: **Check if**
- Condition: `Draft order → Tags → contains → solicitud-b2b`
- Rama **Then** → sigue el flujo.
- Rama **Otherwise** → fin (no hacer nada).

## 4. Step: Send marketing mail (cliente)

En la rama Then, añadir `Send marketing mail`:

- **Template**: `B2B · 07 · Solicitud recibida`  
  (crear antes el template en admin → Marketing → Messaging → Marketing
  emails → Create template, pegando el cuerpo de
  `email-templates/07-solicitud-b2b-recibida.liquid`. Asunto:
  `Solicitud recibida · ref {{ draft_order.name }} · LedsC4 Outlet`).

- **To**: `{{ draft_order.customer.email }}`

> **Nota plan Grow**: en plan development este step queda como draft y
> no envía. Al pasar a Grow se envía efectivo. Ya documentado en
> `docs/grow-migration-checklist.md`.

## 5. Step: Send internal email (backoffice)

Tras el Send marketing mail, añadir `Send internal email`:

- **To**: `daniel.pena@creacciones.es`  
  (literal hardcoded — ver `docs/hardcoded-emails.md` para el
  procedimiento de cutover a producción.)

- **Subject**: `Nueva solicitud B2B · {{ draft_order.customer.metafields.b2b.empresa }} · {{ draft_order.name }}`

- **Email body**: pegar el contenido completo de
  `email-templates/07b-backoffice-nueva-solicitud.liquid` en el campo
  body (Flow acepta Liquid inline, sin problemas con metafields del
  customer accedidos vía `draft_order.customer.metafields.b2b.*`).

## 6. Guardar y activar

- Save workflow.
- Activate (toggle ON).
- Naming sugerido: `W5 · Solicitud B2B creada`.

## 7. Test

1. Desde storefront (tema con Fase D) con customer aprobado:
   añadir 2 productos al cart → /pages/solicitud → enviar.
2. Verificar en admin → Orders → Drafts que el draft existe con tag
   `solicitud-b2b` + `pendiente-revision`.
3. Apps → Flow → W5 → Runs → verificar ejecución sin errores.
4. El email al backoffice llega (dev plan OK).
5. El marketing mail al cliente queda como draft en
   Marketing → Messaging (se enviará al pasar a Grow).

## Gotchas conocidas de Flow (lecciones Fase A/B)

- `draft_order.customer.metafields.b2b.empresa` debe funcionar porque
  metafields está disponible en el objeto customer del trigger
  `Draft order created`. Si devuelve vacío, probar con Run code para
  debug.
- `Send internal email` NO acepta variables Liquid en el campo To —
  solo literales.
- Asunto del Send marketing mail SÍ acepta variables.
