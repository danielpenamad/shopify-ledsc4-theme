# W4 — Re-evaluación de whitelist (scheduled)

## Trigger

- **Type**: `Scheduled time`
- **Frecuencia**: cada 30 minutos (configurable en el builder)

## Motivación

Shopify Flow no tiene trigger nativo "shop metafield updated", así que
la whitelist se revalúa periódicamente. Latencia máxima: 30 min.

## Acción única — "Run code"

```javascript
// Pseudocódigo — adaptar al SDK que exponga Flow Run code en 2026.
// Requiere query customer list + shop metafield + mutate tags.

const wl = (input.shop.metafields.b2b.whitelist_emails || [])
  .map(e => String(e).trim().toLowerCase())
  .filter(Boolean);

if (wl.length === 0) return { promoted: 0 };

// Buscar customers con tag 'pendiente'
const pending = await shopify.graphql(`
  query($cursor: String) {
    customers(first: 100, after: $cursor, query: "tag:'pendiente'") {
      pageInfo { hasNextPage endCursor }
      edges { node { id email tags } }
    }
  }
`);

const toPromote = [];
let cursor = null;
do {
  const res = await shopify.graphql(/* as above with cursor */);
  for (const { node } of res.customers.edges) {
    if (wl.includes(String(node.email).trim().toLowerCase())) {
      toPromote.push(node.id);
    }
  }
  cursor = res.customers.pageInfo.hasNextPage ? res.customers.pageInfo.endCursor : null;
} while (cursor);

// Promote each match: añadir tag 'aprobado' — esto dispara W2 (aprobación
// manual) que crea Company + envía email 4. W4 mismo NO crea company ni
// envía email para evitar lógica duplicada.
for (const id of toPromote) {
  await shopify.graphql(`
    mutation($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
    }
  `, { id, tags: ['aprobado'] });
}

return { promoted: toPromote.length, emails: toPromote };
```

## Post-acción — Email específico

> **NOTA IMPORTANTE**: cuando W4 promueve un customer, W2 se dispara y
> envía email 4 ("cuenta aprobada"). Pero queremos email 6 (mismo texto
> base, plantilla distinta para permitir evolución independiente).

Dos opciones:

### Opción A (recomendada)

W4 añade **dos tags** simultáneamente: `aprobado` + `aprobado_via_whitelist`.
- W2 se dispara normalmente → email 4. **Modificamos W2** para que **no**
  envíe email si el cliente tiene también el tag `aprobado_via_whitelist`.
- W4 envía email 6 directamente tras el ciclo.

### Opción B

W4 NO toca tags. Replica toda la lógica de W2 dentro de W4 + envía email 6.
- Pro: aislado.
- Contra: duplica código de creación de Company entre W2 y W4.

**Decisión**: Opción A. Mantiene DRY y aprovecha W2.

## Cambio resultante en W2

Añadir condicional al paso `Send email 04`:

```
IF 'aprobado_via_whitelist' NOT IN customer.tags
  Send email 04
ELSE
  (skip — email 6 será enviado por W4)
```

Y tras el envío, W4 remueve el tag `aprobado_via_whitelist` (cleanup).

## Idempotencia

- Si un customer ya tiene `aprobado`, W4 lo salta (query filter `tag:'pendiente'`).
- Si W4 se ejecuta antes que W2 termine de procesar el customer anterior,
  Flow serializa los workflows por customer → sin riesgo de race.
- Si la whitelist está vacía, W4 no hace nada.
