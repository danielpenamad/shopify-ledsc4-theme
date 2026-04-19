# W3 — Walkthrough click-a-click (estado final Fase B)

Workflow **W3 — Rechazo manual**. Dispara cuando staff añade el tag
`rechazado` a un customer que aún tiene `pendiente`. Sustituye a
`W3-rechazo-manual.md`.

## Estructura final

```
Trigger  Customer tags added
 └→ Condition  (customer.tags contiene 'pendiente' AND 'rechazado')
    ├─ Verdadero
    │   ├─ Remove tag 'pendiente'
    │   └─ [PENDIENTE GROW] Send marketing mail → template 05
    └─ Falso (vacío)
```

Es el workflow más corto. Sin Company, sin Supabase, sin internal email: todo lo que pasa es quitar el tag pendiente y, en producción, avisar al cliente con email 05 (que maneja el conditional del motivo).

## Paso 0 — Crear

1. Apps → Flow → Create workflow → **`W3 — Rechazo manual`**.

## Paso 1 — Trigger

`Customer tags added`.

## Paso 2 — Check if (dos criterios AND)

IF: Todos.

Criterio 1: `Al menos uno de customer / tags` → Igual a · `pendiente`.
Criterio 2: `Al menos uno de customer / tags` → Igual a · `rechazado`.

Mismo patrón que W2. Mismo caveat (ambos cambios de tag en un solo guardado).

## Paso 3 — Rama Verdadero

### 3.1 Remove tag `pendiente`

`Quitar etiquetas al cliente`. Tags: `pendiente`.

### 3.2 ❌ DESACTIVADO — Send marketing mail (template 05)

**Pendiente Grow**. Cuando reactives:

- Template: `B2B · 05 · Cuenta rechazada`
- To: auto.

El template tiene el `{% if customer.metafields.b2b.motivo_rechazo != blank %}` que respeta/omite la línea del motivo según lo que el staff haya poblado antes de cambiar el tag.

## Paso 4 — Guardar y activar

Save + Turn on.

## Export

`···` → **Export** → `flows/W3-rechazo-manual.flow.json` (pendiente).
