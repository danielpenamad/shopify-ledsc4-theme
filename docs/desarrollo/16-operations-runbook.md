# 16 · Operations runbook

## 1. Para qué sirve este documento

Runbook operacional del portal B2B Outlet: los procedimientos de mantenimiento, despliegue y resolución de incidencias una vez el portal está en producción. Es el documento de referencia para "algo hay que hacer/tocar/arreglar en el sistema vivo".

Cierra el eje de Desarrollo. Donde los docs 00–15 explican **cómo está construido** cada componente, este explica **cómo se opera**. Cuando un procedimiento ya está documentado en otro doc, este remite en vez de duplicar.

Lectores principales: cualquier dev o IA que tenga que desplegar un cambio, rotar un secret, diagnosticar un fallo en producción, atender una petición de reclasificación de catálogo, o preparar el traspaso al cliente.

## 2. Modelo de despliegue

### El repo deploya solo

`main` está conectada al theme live vía la integración nativa GitHub↔Shopify. Cualquier commit a `main` que toque carpetas del theme se despliega al storefront de producción en ~30-60s. No hay staging. Merge a `main` = deploy a producción. Detalle en 12-github-repo §2.

Trabajo nuevo: feature branch → PR → merge. Nunca push directo a `main` con trabajo a medias.

### Cambiar la rama conectada (operación delicada)

Shopify no permite "cambiar la rama de origen" de un theme conectado; el flujo real es desconectar y crear un theme nuevo apuntando a otra rama, lo que genera un theme ID distinto. Procedimiento:

1. (Recomendado) Online Store → Themes → theme live → Duplicate. Queda como theme unpublished — rollback gratis.
2. Disconnect del theme GitHub-conectado actual. Pasa a unpublished.
3. Add theme → Connect from GitHub → repo + rama nueva. Crea un theme entry nuevo.
4. Preview sobre `*.shopifypreview.com` para validar sin publicar (con las limitaciones de §6).
5. Publish cuando esté correcto. El theme antiguo queda unpublished y accesible.
6. Reconfirmar en las apps de theme (Locksmith) que apuntan al theme ID nuevo.
7. Esperar varios días estable antes de borrar el theme antiguo.

Lo que **no** se ve afectado por el reconnect (vive a nivel shop, no theme): customers, productos, colecciones, páginas, navegación, metafields, flows, los HMAC secrets (viajan en `config/settings_data.json`), los endpoints de Supabase, y los locks/keys de Locksmith. Pero la app Locksmith sí necesita reapuntar al theme nuevo.

## 3. Despliegue de edge functions

Tras cambios de código o de `supabase/config.toml`:

```bash
supabase functions deploy <nombre-función> --project-ref <project-ref>
```

El detalle de las 10 funciones y el flag `verify_jwt` está en 11-supabase. Lo crítico para operar:

### Cuándo redeployar

- Cambio de código en `functions/<f>/index.ts`.
- Cambio en `config.toml` (incluido el flag `verify_jwt`).
- **Rotación de un secret que lee la función.** Sin redeploy, el container caliente sigue con el valor viejo en RAM. Esta es la causa #1 de bugs falsos tipo "el token ya lo cambié pero sigue fallando" — ver 14-secrets §6.

### El flag `verify_jwt` y el deploy

`supabase functions deploy` lee `config.toml` y **sobrescribe** lo que el dashboard tenga configurado. La fuente de verdad del flag `verify_jwt` es el fichero, no el dashboard. Si una función pierde su `verify_jwt` correcto del fichero, el siguiente deploy rompe la integración (401 a nivel gateway, o función pública por error). Detalle en 11-supabase §4.

### Logs

```bash
supabase functions logs <nombre-función> --project-ref <project-ref> --limit 50
```

O Dashboard → Edge Functions → \<función\> → Logs.

## 4. Rotación de `SHOPIFY_ADMIN_TOKEN`

El procedimiento más frecuente. El inventario completo de secrets y el resto de procedimientos de rotación están en 14-secrets; aquí el del token de Shopify por ser el más habitual:

1. Shopify Admin → Settings → Apps and sales channels → Develop apps → \<app\> → Configuration. Si añades scopes, márcalos y Save — los scopes nuevos NO se aplican al token vigente, hay que regenerarlo.
2. API credentials → regenerar el token. Copia el nuevo (`shpat_…`).
3. **Verifica el token antes de propagarlo**, con un `curl` a la Admin API:
   ```bash
   curl -s -X POST \
     -H "X-Shopify-Access-Token: <nuevo_token>" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ shop { name } }"}' \
     https://<shop>.myshopify.com/admin/api/2025-10/graphql.json
   ```
   Debe devolver `{"data":{"shop":{"name":"..."}}}`. Si devuelve `Invalid API key or access token`, el token está mal copiado.
4. Sobrescribe el secret en Supabase: `supabase secrets set SHOPIFY_ADMIN_TOKEN=<nuevo_token> --project-ref <project-ref>`.
5. **Redeploy de las 10 funciones** (todas leen el token — ver `supabase/README.md` para el comando completo).
6. Actualiza el valor también en `shopify-ledsc4-theme.env` local y en los GitHub Actions secrets (`SHOPIFY_ADMIN_TOKEN`) — ver 14-secrets §6.
7. Smoke: `/pages/mis-solicitudes` carga sin error 401, `/pages/solicitud` permite enviar una solicitud.

## 5. Locksmith

### Setup actual

El gate del storefront es híbrido (ver 04-storefront-gate). Locksmith cubre una de las tres reglas:

- **Lock** — scope producto + colección `all`. Redirect on lock → `/pages/cuenta-en-revision`.
- **Key** — condiciones `customer_signed_in` + `customer_tag = aprobado`. **Redirect URL vacío.**

### Gotcha — `redirect_url` en KEY vs LOCK

Locksmith permite poner `redirect_url` tanto en la lock como en la key, y hacen lo **opuesto**:

- `redirect_url` en la **lock**: se aplica a quien NO tiene la key (acceso denegado). Es el caso normal.
- `redirect_url` en la **key**: se aplica a quien SÍ abre el lock (acceso concedido).

La key tuvo por error un `redirect_url` configurado, y el resultado fue que los customers aprobados eran redirigidos a "cuenta en revisión" cada vez que abrían una ficha de producto. **Regla: la key siempre con Redirect URL vacío** — su único trabajo es abrir el lock. Si se recrea la key, revisar este punto antes de publicar.

### Si Locksmith deja de funcionar

Si la app falla (trial caducado, desinstalada, error), el gate Liquid de `layout/theme.liquid` cubre los casos importantes por sí solo — Locksmith es solo una capa redundante. Para desactivar Locksmith sin romper nada, comentar su `include` en `layout/theme.liquid` (es reversible cuando vuelva la app). Detalle del gate en 04-storefront-gate.

## 6. Limitaciones de preview

El gate del theme **no dispara** en dominios `*.shopifypreview.com` — es intencional, para poder previsualizar el theme sin que el gate redirija. Implicación: la validación funcional del gate solo se puede hacer tras publish, con el dominio real.

Relacionado: el `redirect_uri` post-OAuth de las cuentas de cliente se valida contra el dominio real de la tienda. Los dominios `*.shopifypreview.com` no están en la whitelist, así que cualquier flujo de login en preview falla con "redirect_uri no es una coincidencia válida". El login real solo se prueba en producción. Detalle en 05-registro-b2b.

## 7. Smoke test post-deploy

Checklist a validar tras cualquier deploy de theme o cambio en gate / Locksmith / edge functions. Se recorre con un customer de cada estado.

### Anónimo

- `/` → home pública, sin header B2B.
- `/products/<handle>`, `/collections/<handle>`, `/cart`, `/search`, `/pages/solicitud`, `/pages/mis-solicitudes` → redirigen a `/pages/acceso-profesional`.
- `/pages/acceso-profesional`, `/pages/cuenta-en-revision`, `/pages/cuenta-rechazada`, las páginas legales → accesibles.
- "Iniciar sesión" en `/pages/acceso-profesional` → login real. "Solicitar acceso" → form de registro B2B.

### Pendiente (logueado, sin tag aprobado/rechazado)

- Login → aterriza en `/pages/cuenta-en-revision`.
- Navegación a productos/colecciones/cart → redirige a cuenta-en-revision.
- `/pages/cuenta-en-revision` → muestra header simple + datos del customer.

### Rechazado

- Login → `/pages/cuenta-rechazada`.
- Navegación a rutas comerciales → redirige a cuenta-rechazada.

### Aprobado

- Login → aterriza en `/pages/mis-solicitudes`.
- `/` → header B2B + dashboard (no hero).
- `/products/<handle>`, `/collections/all`, `/collections/coleccion-2026`, `/cart` → cargan sin redirect.
- `/pages/solicitud` con productos en el carrito → enviar → crea draft order, redirige a `/pages/solicitud-enviada`. Verificable en Admin → Orders → Drafts (tags `solicitud-b2b` + `pendiente-revision`).
- El email transaccional de solicitud recibida llega al customer.

## 8. Importer — operar un run

El pipeline de importación corre de forma autónoma (5 crons de `sftp-sync` + el workflow `ledsc4-import.yml`). El detalle está en 02b-importer-deploy y 13-github-actions §5. Lo relevante para operar:

### Disparar un import manual

```bash
# kind heredado de la row de import_runs:
gh workflow run ledsc4-import.yml -f run_id=<uuid>
# forzar kind:
gh workflow run ledsc4-import.yml -f run_id=<uuid> -f kind_override=stock_only
```

El `run_id` debe ser de una row de `private.import_runs` en estado `downloaded`. Reprocesar un run ya `completed`/`failed` no es posible — hay que generar un `run_id` nuevo con una invocación fresca de `sftp-sync`.

### Diagnóstico de un run

- Estado de los runs: tabla `private.import_runs` (SQL editor o Studio con el schema `private` expuesto). FSM `started → downloaded → processing → completed | failed`.
- Reports de un run: bucket Storage `ledsc4-imports`, ruta `runs/<run_id>/reports/`.
- Logs del workflow: pestaña Actions del repo → run de `ledsc4-import.yml`.

### Runs colgados en `processing`

Si el workflow muere entre "Mark run as processing" y el cierre (timeout de 60 min, cancelación), la row queda en `processing` indefinidamente. Se detectan con una query: status `processing`, `started_at` viejo, sin `completed_at` ni `failed_at`. No hay limpieza automática — hay que decidir caso por caso si el import llegó a aplicarse (mirar los reports en Storage) antes de re-disparar. Anotado como pendiente en 13-github-actions §8.

## 9. Metafield definitions bloqueadas por smart collections

Caso edge que aparece al correr `scripts/apply-metafield-definitions.mjs`.

### Síntoma

El script reporta entradas en estado `UpdateBlockedByDependency`:

```
UpdateBlockedByDependency detail:
  - PRODUCT:product.<key> (locked by smart_collection_condition)
```

### Causa

Shopify bloquea **todos** los campos de una metafield definition (description, access, pin, validations, type) mientras `capabilities.smartCollectionCondition.enabled = true` y existen smart collections que la usan como regla. La mutation `metafieldDefinitionUpdate` rechaza con `CAPABILITY_CANNOT_BE_DISABLED`. El script lo detecta a priori desde el flag de capability y reporta sin intentar el Update — por eso el dry-run refleja la realidad.

Hallazgo confirmado: el bloqueo aplica incluso a `name`/`description`, campos que no afectan a la condición. La única vía de edición conocida es el admin UI de Shopify (usa un endpoint interno distinto del Admin GraphQL público).

### Cómo desbloquear

Tres caminos, de menor a mayor riesgo:

1. **Aceptar el statu quo**: modificar el JSON para que coincida con el shop. El script reportará `Unchanged`. Apropiado si el cambio era cosmético.
2. **Cambiar el consumidor**: si el storefront necesita leer el metafield con otro `access`, modificar el snippet/sección Liquid para obtener el dato por otra vía, sin tocar el metafield ni las smart collections.
3. **Eliminar la dependencia**: quitar la condición del metafield de cada smart collection que lo use. Riesgo alto si las colecciones son user-facing — se pierde la organización del catálogo. Solo si esas colecciones también van a desaparecer.

Caso real resuelto: `product.catalogo` estaba bloqueada por las smart collections del outlet. Se editó vía admin UI (corrección de la descripción + `access.storefront = PUBLIC_READ` + pin). El detalle de la clasificación del script está en 15-scripts §4.

## 10. Reclasificación de categorías — política

El catálogo de categorías del portal (la jerarquía `cat-*`) se reorganizó en mayo 2026 (proyecto PR-CAT-RESTRUCTURE): el menú pasó de 6 a 5 categorías padre. Esa reestructuración introdujo un mecanismo de **overrides por SKU** que conviene entender antes de atender cualquier petición futura de recategorización.

### El mecanismo de overrides

`scripts/sku-overrides.json` es una tabla de excepciones que pisa el valor del ERP para los metafields `product.catalogo` y `product.tipo` de productos concretos. Durante cada import nocturno, tras transformar el CSV y antes de escribir en Shopify, el importer consulta este fichero: si el producto está listado, su valor del CSV se sustituye por el del override. El ERP nunca se ve afectado; el portal queda con los valores override. Lo aplican `scripts/lib/sku-overrides.mjs` (cargador) e `import-map.mjs` (punto de aplicación) — ver 15-scripts §3.

Consecuencia: la **fuente de verdad de la categorización está dividida**. Para saber la categoría real de un producto override hay que mirar dos sitios — el feed del ERP y `sku-overrides.json`. Si difieren, gana el override. Cada SKU en ese fichero es un punto de discrepancia deliberada entre el portal y el ERP — es deuda técnica conocida.

### Las tres vías para una petición de reclasificación

Cuando el cliente pida mover productos entre categorías, fusionar categorías o crear excepciones, hay tres vías, en orden de preferencia:

**Vía 1 — Cambio en el ERP (preferida).** Modificar la columna `Catálogo` o `Tipo` del producto en el ERP del cliente. El cambio se propaga al portal en el siguiente ciclo nocturno. **No genera deuda técnica.** Requiere coordinación con el equipo que gestiona el ERP.

**Vía 2 — Añadir al fichero de overrides (aceptable para cambios pequeños).** Editar `scripts/sku-overrides.json`, desplegar, esperar al siguiente cron. **Acumula deuda técnica**: cada SKU añadido es una discrepancia más entre portal y ERP.

**Vía 3 — Edición manual en Shopify Admin (último recurso).** Cambiar el metafield del producto desde el admin de Shopify. **Esto se revierte cada noche** cuando el cron reimporta — salvo que se combine con la Vía 2. No es una solución estable por sí sola.

### Checklist al recibir una petición de reclasificación

1. ¿Cuántos productos afecta? Menos de 10 → considerar Vía 2. Más → evaluar Vía 1.
2. ¿Es permanente o temporal (campaña, estacionalidad)? Las temporales no deberían ir al override.
3. ¿El cliente puede cambiarlo en su ERP? Si es "sí pero lento", el override es aceptable como puente, con compromiso de revertir cuando el ERP esté al día.
4. ¿Afecta a la tipología, no solo al catálogo? Si sí, valorar inconsistencias visibles antes de aplicar — un producto puede acabar en una subcategoría cuyo nombre no concuerda con su título comercial.

### Mantenimiento del fichero de overrides

Revisar `sku-overrides.json` al menos una vez por trimestre. Para cada regla, comprobar si sigue siendo necesaria o si el ERP ya refleja el estado deseado. Cuando una regla deja de hacer falta, eliminarla — la salida limpia siempre es preferible a la acumulación.

### Reversión completa de PR-CAT-RESTRUCTURE

Si hubiera que deshacer la reestructuración entera (volver a las 6 categorías originales), el procedimiento es: vaciar `sku-overrides.json` a `{"rules": []}`, reactivar las categorías retiradas en `setup-cat-collections.mjs` y `setup-cat-menu.mjs` (el código exacto está en el commit `9d1dcf7`), esperar al cron de las 02:00 UTC para que el importer reescriba los metafields con los valores del ERP, y re-ejecutar los dos scripts de categorías. Tiempo estimado: ~1 hora. Riesgo: las colecciones recreadas tendrán GIDs nuevos (los borrados no se recuperan) y sus traducciones se regeneran desde cero.

## 11. Transferencia al cliente

El portal se entrega a LedsC4 por hitos, no de golpe. La clasificación de qué secret genera el cliente y qué se transfiere está en 14-secrets §7. El handover por fases:

| Fase | Cuándo | Qué se transfiere |
| --- | --- | --- |
| A | Cierre del proyecto | Documentación + acceso del cliente al repo (collaborator), al proyecto Supabase y al shop. Ownership sigue en Dani |
| B | ~3 meses tras la entrega | Transfer de ownership del repo de GitHub a la organización del cliente. Regenerar `GITHUB_DISPATCH_TOKEN` bajo el nuevo owner |
| C | Cuando el shop pase a producción | Transfer del shop de Shopify a la Partner account del cliente. Dani queda como collaborator |
| D | Cierre definitivo | Transfer del proyecto Supabase a la organización del cliente, vía la función nativa de Supabase (no se recrea) |

### Checklist de cutover

Anotado por fase. Varios pasos solo aplican si el proyecto Supabase se recrea desde cero en vez de transferirse con la función nativa.

- [ ] (A) Compartir acceso al repo de GitHub con el cliente como collaborator.
- [ ] (A) Añadir al cliente como miembro del proyecto Supabase.
- [ ] (A) Configurar los 3 HMAC en `config/settings_data.json` y `CREATE_COMPANY_WEBHOOK_SECRET` en el step Send HTTP request del Flow W2.
- [ ] (A) Smoke test: invocar `sftp-sync` y verificar host key + listing del SFTP.
- [ ] (B) Transferir ownership del repo a la organización del cliente (GitHub Settings → Transfer ownership).
- [ ] (B) Verificar que el `repository_dispatch` de Supabase a `ledsc4-import.yml` sigue funcionando tras el transfer (GitHub redirige, pero confirmar con un `sftp-sync` manual).
- [ ] (B) Regenerar `GITHUB_DISPATCH_TOKEN` bajo el nuevo owner y actualizarlo en Supabase secrets (ver el procedimiento de rotación en 14-secrets §6).
- [ ] (B) Configurar/verificar los GitHub Actions secrets en el repo del cliente.
- [ ] (C) Transferir el shop a la Partner account del cliente. Dani queda como collaborator.
- [ ] (D) Transferir el proyecto Supabase a la organización del cliente (Project settings → Transfer project).
- [ ] (D) Si se recrea el proyecto en vez de transferirlo: aplicar las 10 migraciones (`supabase db push`), setear los ~17 secrets manuales, los 2 `UPDATE` de `private.config`, re-deployar las 10 funciones, verificar los 6 crons.
- [ ] (D) Documentar la fecha del cutover y eliminar las referencias al `project-ref` del sandbox de desarrollo.

### Qué no se transfiere

El `shopify-ledsc4-theme.env` local de Dani (el cliente reconstruye el suyo desde `.env.example`) y los tokens personales de Dani (Supabase CLI, GitHub PAT).

## 12. Pendientes conocidos

El proyecto mantiene un tracking de tareas no urgentes en `docs/pendientes.md` (material legacy, ver §13). Las que tienen relevancia operativa directa:

- **Limpiar ~745 productos pre-existentes** con handle basado en título, huérfanos tras el importer. Bloquea el cutover. Script one-shot que los identifique y archive/borre.
- **Custom App sin scope `read_locations`**: el importer hace fallback a "la primera location". Funciona con una sola location, romperá si se añade otra. Fix: añadir el scope y regenerar el token.
- **Endurecer `promote-whitelist-matches` con `X-Cron-Secret`**: hoy la función no valida auth (ver 11-supabase §9).
- **Limpiar emails de test de la whitelist** antes del cutover (`test-bo1@example.com` … `test-bo5@example.com`).

## 13. Material legacy y procedencia

Este runbook **cosecha y reorganiza** material que existía disperso antes de la estructura de documentación por ejes:

- `docs/operations-runbook.md` — el runbook plano original. Su contenido vivo (deploy, edge functions, rotación, Locksmith, smoke test, metafields bloqueados) está refundido aquí, puesto al día.
- `cierre-pr-cat-restructure.md` — el documento de cierre del proyecto de reestructuración de categorías. Su política de reclasificación (Vía 1/2/3), el mecanismo de overrides y el procedimiento de reversión están refundidos en §10.
- `docs/pendientes.md` — el tracking de tareas. Las entradas con relevancia operativa están resumidas en §12.

Estos ficheros legacy quedan pendientes de archivar en `docs/_archive/` (ver 12-github-repo §8). Hasta entonces, **este doc 16 es la fuente de verdad operativa**; los ficheros planos son histórico.

## 14. Pendientes de este documento

- **Archivar el material legacy**. Una vez confirmado que nada vivo se pierde, mover `docs/operations-runbook.md`, `docs/pendientes.md` y el resto del material plano a `docs/_archive/`. El `cierre-pr-cat-restructure.md` no está en el repo (era un documento de entrega) — valorar si se incorpora a `docs/_archive/` para trazabilidad.

- **El runbook no cubre incidencias del día a día del operador**. Este doc es el runbook técnico (deploy, secrets, importer, infra). La operativa diaria del back-office — aprobar altas, gestionar whitelist, atender una incidencia de un cliente — vive en el eje `operador/`. El doc `operador/04-resolucion-incidencias.md` está hoy en estado esqueleto; cuando se complete, este doc 16 debe cross-linkarlo.

- **Sin procedimiento de rollback de un import**. §8 explica cómo diagnosticar un run colgado, pero no hay un procedimiento para deshacer un import que aplicó datos incorrectos a producción. El importer es incremental (fingerprint), así que un import malo se corrige con otro import corregido, pero conviene documentar el caso explícitamente.

- **Branch protection en `main` (nota operativa)**. Mientras no esté activa (ver 12-github-repo §8), el modelo de despliegue de §2 depende de disciplina: un PR roto mergeado rompe producción sin que nada lo impida. Activarla es una recomendación operativa estándar para el modelo `main`→deploy de Shopify, a aplicar por quien gobierne el repo — no un entregable de cierre del proyecto.
