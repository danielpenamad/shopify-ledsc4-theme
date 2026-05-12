# `scripts/register-cat-translations.mjs`

Script one-shot, idempotente. Registra translations del campo `title` en los 6
locales del shop (es, en, fr, de, it, pt-PT) para las **44 colecciones cat-***
del outlet B2B.

Acompaña a [`PR-PIPELINE-A`](../../scripts/import-write.mjs) en el frente de
colecciones: el writer del cron diario mantiene en sincronía las translations
de los metafields `product.catalogo` y `product.tipo` de cada producto contra
los CSVs del SFTP. Este script toma esas translations como fuente de verdad
y proyecta el resultado sobre `Collection.title` en los 6 locales.

## Fuente de verdad

| Conjunto | Cantidad | Fuente del title traducido |
|---|---|---|
| Padres (cat-forlight, cat-architectural, cat-decorative, cat-diy, cat-outdoor) | 5 | Translation del metafield `product.catalogo` del primer producto de la colección (modo entre los 3 primeros para detectar inconsistencias). |
| Hijos (cat-forlight-empotrable-de-techo, …) | 38 | Concatenación `<catalogo translation> — <tipo translation>` con em-dash espaciado (mismo separador que [setup-cat-collections.mjs:115](../../scripts/setup-cat-collections.mjs)). |
| Especial (cat-otros) | 1 | Hardcoded en el script (`OTROS_TITLES`). El bucket agrupa Emergency + Ecommerce, valores que no se traducen en el CSV. |

Para el locale **es** (primario del shop) el valor se toma del campo `value`
base del metafield del producto (no hay translation porque es el locale
primario). Para los otros 5 locales, se lee de
`translatableResourcesByIds → translations(locale: …)`.

## Pre-requisitos

- Node ≥ 20 (usa el flag `--env-file` nativo).
- Variables de entorno (mismas que el resto de scripts del repo):
  - `SHOPIFY_STORE_DOMAIN` (p. ej. `ledsc4-b2b-outlet.myshopify.com`)
  - `SHOPIFY_ADMIN_TOKEN`
  - `SHOPIFY_API_VERSION` (opcional, default `2025-10`)
- Antes de ejecutar este script en su modo real, **el cron full 02:00 UTC
  debe haber corrido al menos una vez** con el writer post-PR-PIPELINE-A —
  si no, las translations de los metafields producto pueden tener valores
  contaminados de T&A y este script los propagaría a los titles de colección.

## Uso

### 1) Dry run (siempre primero)

```
node --env-file=shopify-ledsc4-theme.env scripts/register-cat-translations.mjs
```

Salida esperada:

- Descubre las 44 colecciones, las clasifica (padre / hijo / otros).
- Para cada colección no-otros: muestrea hasta 3 productos y lee sus metafields
  `product.catalogo` + `product.tipo` con sus translations en los 5 locales
  no-primarios.
- Para cat-otros: usa el override hardcoded.
- Construye el title por locale.
- Compara contra el estado actual del shop y genera un **diff por
  (colección, locale)**:

  ```
  [cat-decorative-colgante]
    es      "Decorative — Colgante"  →  "Decorative — Colgante"           (no change)
    en      "Decorative — Pendant"   →  "Decorative — Pendant"            (no change)
    fr      (vacío)                  →  "Decorative — Suspension"          (CHANGE)
    de      (vacío)                  →  "Decorative — Anhänger"            (CHANGE)
    ...
  ```

- Resumen final con totales: cambios, sin-cambio, casos sin producto, casos
  con datos faltantes por locale, inconsistencias inter-producto.
- Escribe `translations-cat-plan.json` en el directorio actual para
  inspección detallada.

### 2) Revisar el plan

Abre `translations-cat-plan.json` y mira:

- `issues.emptyCollections` — colecciones sin productos (se saltan).
- `issues.missingLocaleData` — colecciones donde algún locale no tiene
  translation en los productos muestreados (ese locale se salta).
- `issues.inconsistencies` — productos de la misma colección que reportan
  translations distintas del mismo metafield. El script elige el **modo**
  (valor más frecuente, primero si hay empate). En la salida JSON se ven los
  candidatos y la elección.
- `plan[]` — la lista completa de (colección, locale, oldValue, newValue,
  changes).

### 3) Ejecutar

Si el plan pinta bien:

```
DRY_RUN=false node --env-file=shopify-ledsc4-theme.env scripts/register-cat-translations.mjs
```

Comportamiento en modo real:

- Para cada colección con cambios:
  - Si cambia `es` → `collectionUpdate(id, {title})`. Esto rota el digest del
    `translatableContent` del title.
  - Si cambian los otros 5 locales → una llamada `translationsRegister` por
    colección con las 5 (o las que sean) translations en un solo batch.
    Si el digest está stale (probablemente tras el `collectionUpdate`
    anterior), el script lo refresca y reintenta una vez antes de fallar.

- Throttling cost-aware idéntico al patrón de [fix-translations.mjs](../../scripts/fix-translations.mjs):
  espera si el `currentlyAvailable` baja de 200 puntos; reintenta con
  back-off en HTTP 429 / `THROTTLED`.

- Idempotente. Re-ejecutar el script tras una pasada exitosa no escribe
  nada: el diff debería salir todo `no change`.

## Out of scope (en este script)

- **No toca outlet-***. Esas colecciones siguen su camino (PR separado para
  despublicarlas / borrarlas).
- **No toca translations de productos ni de metafields**. La fuente de verdad
  para esas es el cron diario del writer (`scripts/import-write.mjs`).
- **No borra translations existentes**. Solo registra. Las translations
  EN curadas anteriores (`Forlight — Recessed ceiling light`, etc.) **serán
  sobrescritas** con lo que digan los metafields del producto.

## Riesgos a tener presentes

1. **Sobrescritura de EN curadas**: las EN actuales se editaron a mano en su
   día. Este script las reemplaza por las que vengan del metafield. Si el CSV
   EN tiene una traducción peor (p. ej. `Surface-mounted ceiling light` vs
   `Recessed ceiling light` para `Empotrable de techo`), eso es lo que queda.
   **Asumido por diseño** — la single source of truth es el CSV/metafield.

2. **Cobertura DE / IT / PT-PT**: el shop no publica esos locales todavía
   pero las translations se registran igual (el writer del pipeline ya lo
   hace para metafields). Cuando se publiquen, los titles ya estarán
   completos sin pasada adicional.

3. **cat-otros**: depende de la lista hardcoded en `OTROS_TITLES`. Si Albert
   quiere cambiar el copy en algún locale, hay que editarlo en el script
   y re-ejecutar.

4. **Re-ejecutar machaca**: si alguien edita manualmente una translation de
   colección desde Shopify admin después de correrlo, la próxima ejecución
   la sobrescribirá. Source of truth = código + CSV, no la UI.

## Diagnóstico de fallos

- **`Missing env vars`**: invocar con `--env-file=shopify-ledsc4-theme.env`.
- **`THROTTLED` repetido**: el throttler espera y reintenta hasta 5 veces.
  Si no es suficiente, bajar la frecuencia subiendo el `sleep` post-error o
  ejecutarlo de noche.
- **`digest stale` tras reintento**: indica que otro proceso (admin, T&A,
  otro script) está escribiendo translations a la misma colección a la vez.
  Re-ejecutar; suele ser un caso transitorio.
- **`empty collection` warnings**: revisar en admin si esa colección tiene
  smart rules vivas. Si está vacía intencionalmente, ignorar. Si no, es
  posible que las rules tengan un mismatch ES y haya que pasar
  `setup-cat-collections.mjs` antes.

## Histórico

- **2026-05-12** — Creado. Se añade tras PR-PIPELINE-A y la pasada del cron
  full del 12-may, que dejó los metafields `product.catalogo` y
  `product.tipo` limpios en todos los locales.
