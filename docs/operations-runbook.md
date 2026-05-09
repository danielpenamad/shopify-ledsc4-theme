# Runbook operacional — LedsC4 B2B Outlet

_Estado a 2026-05-09 — sujeto a actualización. Para handover de cierre del proyecto._

Documento de referencia para mantenimiento y deploy del portal B2B una vez
en producción. Recoge los procedimientos validados y los _gotchas_ vividos
en el deploy 2026-04-29 (`main` ←_merge_— `feature/b2b-storefront-gate`).

---

## 1. Estrategia de ramas y deploy del tema

### Rama de producción

`main` es la única rama de la que despliega el tema **live** vía la
integración GitHub ↔ Shopify. Cualquier cambio que el cliente vea pasa por
ahí.

Trabajo nuevo:

```
feature/<descripcion>  → PR a main → merge → push origin main
```

Shopify recoge automáticamente cada commit en `main` y aplica al tema
conectado en ~30-60s. Ver banner del tema en Online Store > Themes para
errores de validación.

### Cambiar la rama conectada (operación destructiva)

Shopify NO permite "cambiar la rama de origen" de un tema; el flujo real
es **desconectar + crear tema nuevo** apuntando a otra rama. Eso genera
un theme ID distinto. Procedimiento:

1. (Opcional pero recomendado) Online Store > Themes > tema live > **Duplicate** — queda como tema unpublished, rollback gratis.
2. **Disconnect** el tema GitHub-conectado actual. Pasa a unpublished.
3. **Add theme → Connect from GitHub** → seleccionar repo + rama nueva. Crea theme entry nuevo.
4. **Preview** sobre el dominio `*.shopifypreview.com` para validar sin publicar (limitaciones en §6).
5. **Publish** cuando esté ok. El tema antiguo queda unpublished accesible.
6. Reconfirmar en **apps de tema** (Locksmith) que apuntan al nuevo theme ID.
7. Esperar días estable antes de borrar el tema antiguo.

Lo que NO se ve afectado por el reconnect (vive a nivel shop, no theme):

- Customers, productos, colecciones, pages, navegación, metafields, flows.
- HMAC secret (vive en `config/settings_data.json`, viaja con el repo).
- Endpoints de Supabase (idem).
- Locksmith locks/keys (a nivel shop). Pero la app sí necesita reapuntar al tema nuevo.

---

## 2. Edge functions — deploy y secrets

### Deploy individual o en bloque

Tras cambios de código o de `supabase/config.toml`:

```bash
supabase functions deploy <nombre-función> --project-ref mbjvmhaglbhnxoccwyex
```

O todas a la vez:

```bash
supabase functions deploy \
  list-order-requests \
  submit-order-request \
  create-company-for-customer \
  promote-whitelist-matches \
  --project-ref mbjvmhaglbhnxoccwyex
```

### Cuándo redeployear (gotcha crítico)

El deploy lee el código y la flag `verify_jwt` de `supabase/config.toml`,
y refresca el container de la función. Hay que redeployear cuando:

- Se cambia código de una función (`functions/<f>/index.ts`).
- Se cambia su flag en `config.toml`.
- **Se rota un secret leído por la función** (env vars). Sin redeploy, el container "caliente" sigue con el valor viejo en memoria.

Olvidar el redeploy tras rotar `SHOPIFY_ADMIN_TOKEN` reproduce el bug
"Shopify HTTP 401: Invalid API key or access token" que aparenta ser un
problema de scopes (no lo es).

### `verify_jwt = false` — por qué y cuándo

Supabase Gateway por defecto exige `Authorization: Bearer <anon_jwt>` y
rechaza con 401 cualquier llamada sin él. Las 4 funciones del proyecto se
invocan SIN ese header (storefront JS, Shopify Flow webhook, pg_cron) por
diseño — el modelo de auth real es:

| Función | Auth real |
|---|---|
| list-order-requests | HMAC SHA256(customerId:timestamp) firmado por Liquid SSR + tag `aprobado` |
| submit-order-request | idem |
| create-company-for-customer | header `X-Webhook-Secret` == `CREATE_COMPANY_WEBHOOK_SECRET` |
| promote-whitelist-matches | red privada (pg_net) — TODO añadir `X-Cron-Secret` |

Por eso `supabase/config.toml` declara `verify_jwt = false` para las 4.
**No quitar esa flag de ninguna**: el redeploy CLI sobrescribe los
settings que el dashboard pueda haber tenido en `false` previamente —
así fue como se introdujo el bug que vimos en este deploy. El fichero es
la única fuente de verdad.

### Logs de las funciones

```bash
supabase functions logs <nombre-función> --project-ref mbjvmhaglbhnxoccwyex --limit 50
```

O en el dashboard: Supabase → Edge Functions → función → Logs.

---

## 3. Rotación de `SHOPIFY_ADMIN_TOKEN`

Procedimiento completo. Aplicar cuando se rote el token (rotación
periódica de seguridad, sospecha de compromiso, scope nuevo):

1. Shopify Admin → **Settings → Apps and sales channels → Develop apps → [tu app] → Configuration**.
2. Si añades scopes: marcarlos en **Admin API access scopes** y **Save**. Ojo — los scopes nuevos NO se aplican al token vigente; hay que regenerarlo.
3. Vuelve a **API credentials** → **Reveal token once** o regenerar. Copia el nuevo token (empieza por `shpat_`).
4. Verifica el token con `curl` antes de propagarlo:
   ```bash
   curl -s -X POST \
     -H "X-Shopify-Access-Token: <nuevo_token>" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ shop { name } }"}' \
     https://ledsc4-b2b-outlet.myshopify.com/admin/api/2025-10/graphql.json
   ```
   Debe devolver `{"data":{"shop":{"name":"..."}}}`. Si devuelve `[API] Invalid API key or access token`, el token está mal.
5. Sobrescribe el secret en Supabase:
   ```bash
   supabase secrets set SHOPIFY_ADMIN_TOKEN=<nuevo_token> --project-ref mbjvmhaglbhnxoccwyex
   ```
6. **Redeploy** las 4 funciones (ver §2).
7. Smoke: `/pages/mis-solicitudes` carga sin "HTTP 401", `/pages/solicitud` permite enviar una solicitud.

### Scopes activos del token (deploy 2026-04-29)

Configurados y validados:

```
read_customers, write_customers, read_customer_data_erasure, write_customer_data_erasure,
read_customer_events, read_companies, write_companies, read_draft_orders, write_draft_orders,
read_products, write_products, read_product_listings, write_product_listings,
read_product_feeds, write_product_feeds, read_inventory, write_inventory,
read_inventory_shipments, write_inventory_shipments, read_inventory_shipments_received_items,
write_inventory_shipments_received_items, read_inventory_transfers, write_inventory_transfers,
read_content, write_content, read_translations, write_translations,
read_publications, write_publications, read_price_rules, write_price_rules,
read_online_store_navigation, write_online_store_navigation,
read_online_store_pages, write_online_store_pages
```

Si en el futuro se añade lógica que convierta drafts → orders desde
edge function, será necesario añadir `read_orders` / `write_orders`.

---

## 4. Locksmith — configuración crítica

### Setup actual

- **Lock 806866** — scope: producto + colección `all`. Redirect on lock = `/pages/cuenta-en-revision` (no-key-holders).
- **Key 1084647** — conditions: `customer_signed_in` + `customer_tag = aprobado`. **Redirect URL = vacío**.

### Gotcha histórico (ver `docs/locksmith-rules.md`)

Antes del fix de este deploy, la key 1084647 tenía configurado
`redirect_url = /pages/cuenta-en-revision`. Locksmith aplica el redirect
de la KEY tras abrir el lock con éxito (no es lo que sugiere su nombre).
Resultado: customers aprobados eran redirigidos a en-revisión cada vez
que entraban a una ficha de producto o `/collections/all`.

**Nunca poner redirect_url en una key**. El redirect que cierra el lock
va en el LOCK ("After locking, send visitors to..."). Si en el futuro se
recrea la key o se modifica, dejar Redirect URL vacío.

### Caducidad del trial / reactivación de la app

Si Locksmith deja de funcionar (trial caducado, app desinstalada, fallo):

- El gate redundante del theme (`layout/theme.liquid:340-365`) cubre todos los casos importantes:
  - Anónimo en commercial paths → login OAuth.
  - Rechazado en cualquier ruta → cuenta-rechazada.
  - No-aprobado en commercial paths → cuenta-en-revision.
- Locksmith solo era safety net redundante con el gate. Si rompe la lógica:

```diff
  layout/theme.liquid:1-3
  - {%- comment %}<locksmith:1a7a>{% endcomment -%}
  -   {%- include 'locksmith' -%}
  - {%- comment %}</locksmith:1a7a>{% endcomment -%}
  + {%- comment %} Locksmith desactivado temporalmente — gate vive en theme.liquid {%- endcomment -%}
```

Commit + push. Reversible cuando vuelva la app.

---

## 5. Customer Accounts — new (Shopify-hosted)

- Login real vive en `shopify.com/authentication/<shop_id>/login`. NO se brandea desde theme.
- Branding limitado en **Settings → Customer accounts → Edit branding** (logo, color principal, fondo, idioma).
- `redirect_uri` post-OAuth se valida contra el dominio real de la tienda. **Dominios `*.shopifypreview.com` NO están en la whitelist**: cualquier flujo de login en preview falla con "El parámetro redirect_uri no es una coincidencia válida".
- El gate del theme tiene escape hatch para preview (`layout/theme.liquid:329`):
  ```liquid
  {%- unless Shopify.designMode or request.host contains '.shopifypreview.com' or request.page_type == 'password' -%}
  ```
  Esto permite previsualizar visualmente el tema sin disparar OAuth, pero **no se puede testear el gating real en preview**. Validación funcional del gate solo tras publish con dominio real.

---

## 6. Smoke test — checklist post-deploy

Validar tras cualquier deploy de tema o cambio en gate / Locksmith / edge functions:

### Anónimo (post 2026-05-04)

- `/` → home pública con hero portal, sin header.
- `/products/<handle>` → redirect a **`/pages/acceso-profesional`** (NO a login). Cambiado 2026-05-04 — antes redirigía a `/customer_authentication/login?return_to=...`. La landing informativa actúa como contexto y filtro antes del registro.
- `/collections/<handle>`, `/cart`, `/search`, `/pages/solicitud`, `/pages/mis-solicitudes` → idem (`/pages/acceso-profesional`).
- `/pages/acceso-profesional`, `/pages/cuenta-en-revision`, `/pages/cuenta-rechazada` → accesibles (exempt).
- `/pages/aviso-legal` y otras legales → accesibles.
- Tras pulsar "Iniciar sesión" en `/pages/acceso-profesional` → `/customer_authentication/login?return_to=%2Fpages%2Fmis-solicitudes` (sin cambios respecto al login real).
- Tras pulsar "Solicitar acceso" en `/pages/acceso-profesional` → `/account/register` (form B2B).

### Pendiente (logged-in sin tag aprobado/rechazado)

- Login → aterriza en `/pages/cuenta-en-revision`.
- Navegación a `/products`, `/collections`, `/cart`, `/pages/mis-solicitudes` → redirect a en-revision.
- `/pages/cuenta-en-revision` → muestra header simple + body con datos del customer (empresa, NIF, email).

### Rechazado

- Login → `/pages/cuenta-rechazada`.
- Navegación a commercial paths → redirect a cuenta-rechazada.

### Aprobado

- Login → aterriza en `/pages/mis-solicitudes` (return_to del login).
- `/` → header `b2b-header-aprobado` + dashboard B2B (no hero).
- `/products/<handle>` → carga ficha sin redirect.
- `/collections/all`, `/collections/coleccion-2026` → listado sin redirect.
- `/cart` → carrito.
- `/pages/mis-solicitudes` → tabla con solicitudes (o empty state con dashboard cards si no hay).
- `/pages/solicitud` con productos en carrito → enviar → crea draft order, redirige a `/pages/solicitud-enviada`. Verificable en Admin → Orders → Drafts (tag `solicitud-b2b` + `pendiente-revision`).
- Email transaccional `02-solicitud-recibida` llega al customer.

---

## 7. Metafields bloqueados por dependencia (smart collections)

`scripts/apply-metafield-definitions.mjs` clasifica cada definición del JSON
en uno de cinco estados: `Create`, `Unchanged`, `Update`,
`UpdateBlockedByDependency` y `DriftBlocked`. El penúltimo es **el caso edge
relevante para mantener** y suele aparecer cuando la definición está siendo
usada como condición en una smart collection.

### Síntoma

Tras correr el script (sea `--dry-run` o real):

```
Summary: ... UpdateBlockedByDependency: N ...

UpdateBlockedByDependency detail:
  - PRODUCT:product.<key> (locked by smart_collection_condition)
      pending: <campo>: <valor_shop> → <valor_json>
```

### Por qué

Shopify bloquea **todos** los campos (description, access, pin, validations,
type) de una metafield definition mientras
`capabilities.smartCollectionCondition.enabled = true` **y** existen smart
collections que la usan como regla. La mutation `metafieldDefinitionUpdate`
rechaza con `CAPABILITY_CANNOT_BE_DISABLED`.

El script detecta esta situación a priori (no por catch del error) leyendo
la capability en la query de inventario, así que el dry-run refleja la
realidad y la idempotencia se mantiene (las definiciones bloqueadas no
aparecen como `Updated` en re-runs sucesivos).

### Cómo desbloquear

Tres caminos, en orden de menor a mayor riesgo:

1. **Aceptar el statu quo y modificar el JSON** para que coincida con el
   shop (`description` con el valor actual, `access` con el actual). El
   script reportará `Unchanged` en lugar de `UpdateBlockedByDependency`.
   Apropiado cuando el cambio que se quería era cosmético y no rompe nada
   funcional.

2. **Cambiar el consumidor del metafield** en lugar del metafield. Por
   ejemplo, si el storefront necesita leer un campo con `access=PUBLIC_READ`
   pero el metafield está bloqueado en `NONE`, modificar el snippet/sección
   Liquid para obtener el dato por otra vía (collections del producto,
   metaobject, etc.). No requiere tocar smart collections.

3. **Eliminar la dependencia**: para cada smart collection que use el
   metafield como condición, editar las reglas y quitar esa condición. Una
   vez no haya smart collections referenciándola, la capability
   `smartCollectionCondition.enabled` se puede desactivar y el Update
   funciona. **Riesgo alto**: si las smart collections son user-facing, se
   pierde la organización del catálogo. Sólo apropiado si las smart
   collections también van a desaparecer.

Para identificar qué smart collections bloquean un metafield concreto:

```bash
node --env-file=shopify-ledsc4-theme.env -e "
const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const TOK  = process.env.SHOPIFY_ADMIN_TOKEN;
const VER  = process.env.SHOPIFY_API_VERSION || '2025-10';
const TARGET_METAFIELD_ID = 'gid://shopify/MetafieldDefinition/<id-numérico>';
const Q = \`{ collections(first: 250, query: \\\"collection_type:smart\\\") {
  nodes { handle title ruleSet { rules { conditionObject {
    __typename ... on CollectionRuleMetafieldCondition {
      metafieldDefinition { id namespace key }
    } } } } } } }\`;
fetch(\`https://\${SHOP}/admin/api/\${VER}/graphql.json\`, {
  method:'POST',
  headers:{'Content-Type':'application/json','X-Shopify-Access-Token':TOK},
  body: JSON.stringify({query: Q})
}).then(r => r.json()).then(j => {
  const matches = (j.data?.collections?.nodes ?? []).filter(s =>
    (s.ruleSet?.rules ?? []).some(r =>
      r.conditionObject?.metafieldDefinition?.id === TARGET_METAFIELD_ID));
  for (const s of matches) console.log(s.handle, '::', s.title);
});"
```

### Caso real (resuelto 2026-05-07)

| Definition | Bloqueada por | Pending changes | Remediation |
|---|---|---|---|
| `PRODUCT:product.catalogo` (`gid://shopify/MetafieldDefinition/379919106375`) | 58 smart collections del outlet (`outlet-decorative`, `outlet-outdoor`, etc.) creadas por `scripts/setup-outlet-smart-collections.mjs` | description: `"Cat<U+FFFD>logo LedsC4..."` → `"Catálogo LedsC4..."`; `access.storefront`: `NONE` → `PUBLIC_READ`; pin activado | ✅ **Aplicado vía admin UI 2026-05-07.** La fila "Catálogo" del [snippets/product-specs-table.liquid:9](../snippets/product-specs-table.liquid:9) ya renderiza en producción. |

**Hallazgo confirmado en cierre**: el bloqueo `CAPABILITY_CANNOT_BE_DISABLED` aplica a TODOS los campos de la definition (incluyendo `name`/`description` que no afectan a la condición), no solo al toggle de la propia capability. La única vía conocida de edición es el admin UI de Shopify (probablemente con un endpoint interno distinto al expuesto por la Admin GraphQL pública). Cualquier futura definition que se use como condición de smart collection debe asumir esta restricción a la hora de planear cambios.

---

## 8. Pendientes conocidos (iteraciones futuras)

| Área | Pendiente | Donde |
|---|---|---|
| UX | Branding del login OAuth de Customer Accounts | Admin → Settings → Customer accounts → Edit branding |
| Operations | Endurecer auth de `promote-whitelist-matches` con `X-Cron-Secret` | TODO en `supabase/config.toml` |
| Tooling | ~~MCP de Supabase / Shopify para diagnóstico desde Claude~~ — hecho 2026-05-05 (MCP oficial Shopify + MCP Supabase configurados) | configuración del cliente Claude |

---

## 9. Histórico de cambios relevantes

| Fecha | Commit | Resumen |
|---|---|---|
| 2026-04-29 | a7c9af2 | fix Liquid: collapse multi-line assign en `b2b-mis-solicitudes.liquid` (no se podía deployar) |
| 2026-04-29 | 522d1df | fix Locksmith: redirect_url de key 1084647 vaciado (aprobados saltaban a en-revisión en productos) |
| 2026-04-29 | d232740 | merge feature/b2b-storefront-gate → main (Fase D + dashboard aprobado) |
| 2026-04-29 | a9ad7f5 | fix gate: bypass en preview + password mode |
| 2026-04-29 | 1fe9490 | fix supabase: `verify_jwt = false` para 3 funciones storefront-facing |
| 2026-04-29 | 23294eb | fix UI: logo asset_url fallback + tipografías legibles en header simple y status pages |
