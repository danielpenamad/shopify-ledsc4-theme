# `scripts/delete-outlet-collections.mjs`

Script one-shot, idempotente. Borra las colecciones **legacy `outlet-*`**
del shop LedsC4 B2B Outlet, después de comprobar que ninguna superficie del
theme o del admin las enlaza.

Contexto: las `outlet-*` son la jerarquía vieja que coexiste con `cat-*`
(canon, mantenida por `setup-cat-collections.mjs` y traducida por
`register-cat-translations.mjs`). Los padres `outlet-*` aún recogen
productos vía smart rules antiguas; los hijos están vacíos. Sus
translations FR/EN fueron generadas por T&A y están contaminadas
("Forlight → Pour la lumière"). Riesgo: si algo del storefront enlaza
con `/collections/outlet-*` por accidente, reaparece el bug visual que
Albert reportó. Este script elimina ese riesgo de raíz.

## Pre-requisitos

- Node ≥ 20 (usa `--env-file` nativo).
- Variables de entorno (mismo contrato que el resto de scripts/):
  - `SHOPIFY_STORE_DOMAIN` (`ledsc4-b2b-outlet.myshopify.com`)
  - `SHOPIFY_ADMIN_TOKEN`
  - `SHOPIFY_API_VERSION` (opcional, default `2025-10`)
- **Antes de correr**: tener `register-cat-translations.mjs` ya ejecutado
  contra el shop (las `cat-*` deben tener sus translations completas en
  todos los locales), de modo que si alguna superficie pasa de outlet-* a
  cat-* tras este script, lo encuentre todo bien.

## Seguridad — DRY_RUN

- **Default = dry-run**. Sigue el patrón canónico de `scripts/fix-translations.mjs`:
  ```js
  const DRY_RUN = process.env.DRY_RUN !== 'false';
  ```
  Solo `DRY_RUN=false` (literal, lowercase) dispara borrados reales.
  Cualquier otro valor (`DRY_RUN=true`, `DRY_RUN=yes`, `DRY_RUN=0`, sin
  setear) → dry-run.
- **Aviso de 5 segundos en stderr** antes de la primera mutation real,
  con cuenta atrás abortable con Ctrl+C:
  ```
  MODE: EXECUTE — about to delete N collections in 5 seconds. Ctrl+C to abort.
  ```
- **Reference scan bloqueante**. Si el script encuentra cualquier referencia
  a `outlet-` en theme o shop, **aborta con exit 1 sin borrar nada**, aunque
  estés en modo EXECUTE.

## Flujo

### Paso 1 — Inventario

Lista todas las colecciones cuyo handle empiece con `outlet-` (busca por
los 6 prefijos conocidos: forlight, architectural, decorative, diy,
outdoor, otros), paginada. Para cada una:

- `id` (GID)
- `handle`
- `title` (ES, el campo nativo)
- `productsCount`
- `kind`: `smart` si tiene rules, `custom` si no.
- `publications`: nombres de las publications (Online Store, Outlet
  general, etc.) donde está publicada.

Imprime tabla. Después un dump completo va a `delete-outlet-plan.json`.

### Paso 2 — Búsqueda de referencias

#### 2a) Theme local (este repo)

Recorre estos directorios buscando el patrón `outlet-<slug>`:

- `sections/`, `snippets/`, `templates/`, `layout/`, `config/`, `locales/`, `assets/`
- Extensiones: `.liquid`, `.json`, `.js`, `.css`, `.svg`

Cada hit incluye: path relativo al repo, número de línea, el match exacto,
y los primeros ~200 caracteres de la línea para contexto.

> Nota: el patrón es **case-insensitive** y captura cualquier cosa que
> empiece por `outlet-` y siga con letras/dígitos/guiones. Es deliberadamente
> amplio para no perder coincidencias. Falsos positivos posibles (p. ej.
> `outlet-style` en CSS no relacionado): el script los reporta igual y tú
> los descartas en la revisión.

#### 2b) Admin del shop

Vía Admin GraphQL (con paginación):

- **Shop metafields** (`shop.metafields`): valor de cada metafield se
  busca por `outlet-`.
- **Menus** (`menus`, recursivo hasta 3 niveles de profundidad — suficiente
  para el menú principal típico de Shopify): busca en `item.title` y
  `item.url` de cada nivel.
- **Pages** (`pages`): busca en `body` (HTML).
- **Articles** (`articles`): busca en `body` (HTML).
- **Product metafields (sample)**: muestrea los 100 productos
  más-recientemente-actualizados y revisa sus metafields. **No es exhaustivo
  para todo el catálogo** (700+ productos); está pensado para detectar
  contaminación sistémica, no incidentes aislados. Si te preocupa una
  cobertura completa, puedes hacer un grep manual del export del catálogo.

Cada hit incluye source (`menu`, `page`, `article`, `shop-metafield`,
`product-metafield-sample`), identificadores del recurso, el match, y un
contexto recortado.

### Paso 3 — Decisión

- **Si `referencias > 0`**: el script imprime el listado, escribe el plan
  a JSON, y sale con `exit 1`. NO borra. Mensaje:
  ```
  References found. Manual review required. No collections deleted.
  ```
  Decisión humana: revisar cada referencia, decidir si renombrar a `cat-*`
  o eliminar la referencia. Después re-correr el script.
- **Si `referencias == 0`**: continúa al Paso 4.

### Paso 4 — Ejecución

#### DRY_RUN (default)

Imprime el plan línea a línea:
```
[outlet-forlight] would delete (productCount=172, smart)
[outlet-decorative-bano] would delete (productCount=0, smart)
...
```
Resumen final + `delete-outlet-plan.json` listo para inspección.

#### EXECUTE (`DRY_RUN=false`)

1. Stderr warning de 5 segundos (abortable con Ctrl+C).
2. `collectionDelete` por colección, secuencial.
3. Throttling cost-aware igual que los otros scripts del repo.
4. Progress cada 5 colecciones.
5. Errores por colección → log + continúa con la siguiente.
6. Resumen final: `Deleted M of N collections. Errors: E.`

Exit code 1 si hay errores.

## Uso

```bash
# 1) Dry run — SIEMPRE primero
node --env-file=shopify-ledsc4-theme.env scripts/delete-outlet-collections.mjs

# 2) Inspecciona delete-outlet-plan.json
#    - Verifica que las colecciones listadas son las que esperas (~20-44 outlet-*).
#    - Verifica que references = [] vacío.

# 3) Si todo OK, ejecuta:
DRY_RUN=false node --env-file=shopify-ledsc4-theme.env scripts/delete-outlet-collections.mjs
```

## Qué hace este script

- Lista colecciones `outlet-*`.
- Escanea theme + shop buscando enlaces a esas colecciones.
- Si hay enlaces: aborta sin tocar nada.
- Si no hay: muestra plan (dry-run) o borra (`collectionDelete`).

## Qué NO hace este script

- **No toca `cat-*`**. Son el canon de navegación tras los PRs del 11-may.
- **No borra productos**. `collectionDelete` desliga productos
  automáticamente (comportamiento estándar de Shopify); los productos en sí
  no se eliminan.
- **No borra metafields** ni metafield definitions.
- **No toca translations** (ni de productos, ni de metafields, ni de
  colecciones cat-*).
- **No toca publications**. La colección sale de sus publications al
  borrarse, pero las publications en sí no se modifican.
- **No hace backup**. Las colecciones borradas son permanentes — Shopify
  no ofrece undo. Si alguna outlet-* tuviera valor histórico, hay que
  exportarla antes manualmente. Como su única función era listar productos
  por smart rule, no hay datos únicos que perder.

## Riesgos y limitaciones

1. **Sample de product metafields no es exhaustivo**. 100 productos de 700+.
   Riesgo bajo: las outlet-* nacieron de scripts de importación, no de
   metafields manuales. Pero si Albert metió manualmente un link a
   `outlet-X` en un metafield raro, el script puede no encontrarlo.

2. **El patrón `outlet-` es amplio**. Falsos positivos posibles (CSS,
   marketing copy). Mejor sobrereportar que perder un enlace real — tú
   decides en la revisión qué descartar.

3. **Theme deployed ≠ local repo**. El scan de theme es **local** (repo
   en disco). Si el theme deployado en Shopify tiene cambios que no
   están en main, no se detectarán. Asumimos que el workflow de Dani
   mantiene main como fuente de verdad. Si no, hacer un `shopify theme
   pull` antes de correr el script.

4. **collectionDelete es destructivo y no reversible**. Las colecciones
   borradas se pierden con todas sus translations T&A asociadas. Esto es
   intencional: el objetivo del PR es eliminar la contaminación.

## Diagnóstico de fallos

- **`Missing env vars`**: invocar con `--env-file=shopify-ledsc4-theme.env`.
- **`References found. Manual review required. No collections deleted.`**:
  el script encontró referencias. Revisa `delete-outlet-plan.json` → bloque
  `references[]`. Decide qué hacer con cada una (renombrar a `cat-*`,
  borrar la referencia, etc.) y re-corre cuando esté limpio.
- **`No references found` pero algo en el storefront sigue mostrando
  outlet-***: el sample de product metafields no es exhaustivo. Hacer un
  grep manual del export del catálogo o aumentar `PRODUCT_METAFIELD_SAMPLE`
  en el script.
- **`THROTTLED` repetido**: el throttler espera y reintenta hasta 5 veces.
  Si no es suficiente, ejecutar fuera del horario de la sync (evitar
  ventanas alrededor de las :00 UTC en horarios cron).

## Histórico

- **2026-05-12** — Creado. Acompaña a `register-cat-translations.mjs` para
  cerrar el frente de migración outlet-* → cat-*.
