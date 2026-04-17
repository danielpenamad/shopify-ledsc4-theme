# W2 — Aprobación manual

## Trigger

- **Type**: `Customer updated`

## Condición (primer paso — "Check if")

Ejecutar el resto del workflow solo si:

```
'aprobado'  IS IN  {{customer.tags}}
AND
'aprobado'  IS NOT IN  {{customer.tags_previous}}
AND
'pendiente' IS IN  {{customer.tags_previous}}
```

Esto evita re-ejecutar cuando el customer ya estaba aprobado (p.ej.
porque el staff toca otro campo) o cuando el cambio viene del flujo
automático de W1 (que también añade `aprobado`, pero venía de un
`customer_created`, no de un `customer_updated`).

> Si Flow no expone `customer.tags_previous` con un nombre distinto,
> usar el condicional "Customer attribute changed" con el campo `tags`
> y filtrar por "contiene `aprobado` ahora Y contenía `pendiente` antes".

## Acciones

1. **Remove customer tags**: `pendiente`
2. **Update customer metafield** `b2b.fecha_aprobacion` (date) = hoy
3. **Run code — create_company**:
   - Mismo snippet que W1 rama A (ver `flows/_helpers/create-company.js`)
   - Si el customer ya tiene Company (caso edge: staff aprobó dos veces),
     saltar este paso (verificar via `customer.companyContactProfiles`).
4. **Send email** → template `04-cuenta-aprobada-manual` → `{{customer.email}}`

## Notas de implementación

- El staff aprueba quitando el tag `pendiente` y añadiendo `aprobado`.
  El workflow se encarga del resto (company + fecha + email).
- Si el staff solo añade `aprobado` sin quitar `pendiente`, el workflow
  sigue disparándose (acción 1 limpia `pendiente` de forma idempotente).
- Si el staff añade `rechazado` en vez de `aprobado`, no se dispara este
  workflow — se dispara W3.

## Idempotencia

Cambiar un cliente ya `aprobado` no vuelve a disparar este workflow
gracias a la condición `tags_previous NOT contains 'aprobado'`. Si aun
así se dispara, los pasos son seguros:
- Remove tag `pendiente` — no-op si no lo tiene.
- Update metafield — sobreescribe, no duplica.
- Create company — la Run code debe comprobar existencia antes de crear.
- Send email — Flow dedupe por `(customer, workflow, trigger_event)`.
