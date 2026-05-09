# W3 — Rechazo manual

> **Nota — diseño superseded.**
> Este documento describe el diseño original del flow con trigger
> `Customer updated` y condición sobre `tags_previous`. La
> implementación actual usa el trigger / condición descritos en
> `W3-walkthrough.md`, que es la fuente de verdad operativa.
> Este `.md` se mantiene como histórico para trazar la evolución.

## Trigger

- **Type**: `Customer updated`

## Condición

```
'rechazado' IS IN  {{customer.tags}}
AND
'rechazado' IS NOT IN {{customer.tags_previous}}
```

## Acciones

1. **Remove customer tags**: `pendiente` (si existe)
2. **Send email** → template `05-cuenta-rechazada` → `{{customer.email}}`
   - La plantilla lee `{{customer.metafields.b2b.motivo_rechazo}}` y lo
     muestra solo si está poblado.

## Notas

- El workflow **no** borra el customer ni sus datos. El staff puede
  revertir la decisión poniendo el tag `aprobado` (se dispararía W2) o
  limpiando `rechazado` y volviendo a `pendiente`.
- El `motivo_rechazo` debe rellenarse **antes** de cambiar el tag. Si
  el staff cambia el tag primero, el email sale sin motivo. Se documenta
  en `docs/backoffice-aprobaciones.md`.
- Si el workflow no encuentra `motivo_rechazo`, el email cae a un texto
  genérico sin desvelar la razón.

## Idempotencia

Misma lógica que W2. El filtro `tags_previous NOT contains 'rechazado'`
evita disparos repetidos.
