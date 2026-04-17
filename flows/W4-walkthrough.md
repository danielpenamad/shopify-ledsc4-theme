# W4 — Walkthrough click-a-click

Workflow **W4 — Re-evaluación de whitelist** (scheduled, cada 30 min).
Busca customers con tag `pendiente` cuyo email ahora matchea la whitelist,
y les añade `aprobado` + `aprobado_via_whitelist` para disparar W2 en cascada.
Complementa `W4-whitelist-reeval.md`. Tiempo: **12-18 min** (hay más Run code).

## Prerrequisitos

- [ ] **W2 configurado** (W4 depende de W2 para crear la Company)
- [ ] **Cambio pendiente en W2** (paso 6 del walkthrough W2): la condición
      "NOT contains `aprobado_via_whitelist`" debe estar ya en W2 antes de
      activar W4, si no se enviará el email 4 además del 6.
- [ ] Accesible `email-templates/06-bienvenida-reevaluacion.liquid`
      para pegar el body inline en el `Send internal email` del loop.

---

## Paso 0 — Crear el workflow

1. Admin → Apps → Flow → Create workflow
2. Rename a **`W4 — Re-evaluación whitelist`**

## Paso 1 — Trigger: Scheduled time

1. Select a trigger → `Scheduled time`
2. Config:
   - **Frequency**: `Every 30 minutes`
   - **Timezone**: Europe/Madrid (o el de tu store)
3. **Done**

## Paso 2 — Run code: `find_and_promote`

1. **+** → **Action** → **Run code**
2. Config:
   - **Name**: `find_and_promote`
   - **Input query**:
     ```graphql
     {
       shop {
         whitelist: metafield(namespace: "b2b", key: "whitelist_emails") {
           value
         }
       }
     }
     ```
   - **Code**: pega íntegro el bloque "Acción única — Run code" de
     `flows/W4-whitelist-reeval.md` (líneas 14-58).

     > Adaptación mínima para el SDK de Flow Run code: el `input.shop...`
     > viene ya como JSON; el JS de whitelist_emails es un string JSON que
     > hay que `JSON.parse()`. Añadir al principio del script:
     > ```javascript
     > const rawWl = input.shop?.whitelist?.value;
     > const parsedWl = rawWl ? JSON.parse(rawWl) : [];
     > const wl = parsedWl.map(e => String(e).trim().toLowerCase()).filter(Boolean);
     > if (wl.length === 0) return { promoted: 0, emails: [] };
     > ```

3. Output esperado: `{ promoted: <n>, emails: [<email1>, ...] }`

## Paso 3 — Check if: alguien fue promovido

1. **+** → **Condition** → **Check if**
2. Condition: `find_and_promote.promoted` **is greater than** `0`
3. **Done**

### Rama Then — hubo promociones

#### 3.1 — For each: email en `find_and_promote.emails`

1. **+** → **For each** (iterator)
2. **List**: `find_and_promote.emails`
3. Dentro del loop:

   **Action — Send internal email**:
   - **To**: `{{ loop.item }}`
   - **Subject**: `Tu cuenta B2B de LedsC4 Outlet está activa`
   - **Body**: cuerpo de `email-templates/06-bienvenida-reevaluacion.liquid`
     (omitir `{% comment %}` y la línea `Subject:`)

> Alternativa si Flow no ofrece "For each" nativo: usa un **Run code**
> adicional que itere `find_and_promote.emails` y llame a la Email API
> internamente. Menos limpio — prefiere el For each.

#### 3.2 — (Post loop) Run code: `cleanup_tags`

Después del loop, limpiar el tag `aprobado_via_whitelist` para dejar el
customer con solo `aprobado`.

1. **+** → **Run code**
2. **Name**: `cleanup_tags`
3. **Input**: `find_and_promote.emails`
4. **Code**:
   ```javascript
   // Busca customers con aprobado_via_whitelist y les quita ese tag.
   const customers = await shopify.graphql(`
     query {
       customers(first: 100, query: "tag:'aprobado_via_whitelist'") {
         edges { node { id } }
       }
     }
   `);
   for (const { node } of customers.customers.edges) {
     await shopify.graphql(`
       mutation($id: ID!, $tags: [String!]!) {
         tagsRemove(id: $id, tags: $tags) { userErrors { message } }
       }
     `, { id: node.id, tags: ['aprobado_via_whitelist'] });
   }
   return { cleaned: customers.customers.edges.length };
   ```

### Rama Else — nadie fue promovido

Dejar vacía.

## Paso 4 — Guardar y activar

1. **Save**
2. Toggle **Turn on**

## Paso 5 — Export

1. `···` → **Export** → `flows/W4-whitelist-reeval.flow.json`
2. Commit.

## Verificación rápida (no esperar 30 min)

1. Apps → Flow → Workflows → **W4 — Re-evaluación whitelist**
2. `···` → **Run now**
3. Run history debe mostrar el run. Si la whitelist tiene emails y hay
   pendientes que matcheen, deberías ver `promoted > 0`.

## Nota importante sobre el orden de activación

Activa en este orden para evitar efectos raros:

1. W1 (si no está)
2. **Modifica W2** para respetar `aprobado_via_whitelist` (paso 6 de W2-walkthrough)
3. W3
4. W4

Si activas W4 antes del cambio en W2, cuando W4 promueva un customer se
dispararán email 4 **y** 6. No es dramático pero confunde al receptor.
