# 15 · Scripts

## 1. Para qué sirve este documento

`scripts/` contiene los scripts Node.js del proyecto: el pipeline del importer, los scripts de setup B2B, los de categorías, branding, traducciones, auditoría y limpieza. Este doc es el **catálogo**: qué script hace qué, en qué orden se corren los que dependen entre sí, y las convenciones comunes.

No se cubre aquí el detalle interno del pipeline del importer — eso está en 02-importer (parse, map, write, fingerprint) y 02b-importer-deploy. Aquí esos scripts se listan con cross-link. El resto de scripts — setup, categorías, branding, auditoría — se documentan de primera mano.

Lectores principales: cualquier dev o IA que necesite saber qué script correr para una tarea, o entender qué hace uno antes de tocarlo.

## 2. Convenciones comunes

Casi todos los scripts comparten un contrato:

- **ES modules** (`.mjs`), Node ≥ 20. Un script legacy (`audit-customer-state.js`) es `.js` pero también ESM.
- **Sin dependencias npm** salvo el pipeline del importer con `--with-db` (ver 12-github-repo §5). Los scripts de setup usan solo APIs built-in de Node y `fetch`.
- **Variables de entorno**: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION` (default `2025-10`). Se pasan vía `--env-file=shopify-ledsc4-theme.env` o exportadas. Ver 14-secrets.
- **Idempotencia**: re-ejecutar un script no duplica nada. Los de creación hacen "buscar → si existe skip/update, si no create".
- **Helper compartido**: `_shopify.mjs` expone `gql()` (cliente GraphQL con throttling cost-aware y backoff ante 429/`THROTTLED`), `requireEnv()`, `slug()`, `chunk()`. Los scripts más nuevos lo importan; los más viejos llevan su propio `gql()` inline.

### Las tres convenciones de dry-run

Atención a esto: **no hay una sola forma de pedir dry-run**. Conviven tres, y confundirlas puede ejecutar algo destructivo:

| Convención | Default | Cómo se ejecuta de verdad | Scripts |
| --- | --- | --- | --- |
| Flag `--dry-run` | Ejecuta (apply) | Sin el flag | La mayoría: `setup-b2b-catalog`, `setup-cat-collections`, `setup-cat-menu`, `apply-metafield-definitions`, `set-shop-b2b-metafields`, `create-b2b-pages`, `publish-catalog-products`, etc. |
| Flag `--apply` | Dry-run | Con `--apply` | `create-backoffice-customer` |
| Env `DRY_RUN` | Dry-run | `DRY_RUN=false` | `delete-outlet-collections`, `fix-translations` |

Los dos scripts más destructivos (`delete-outlet-collections`, `fix-translations`) son los que tienen dry-run **por defecto** — hay que pedir explícitamente la ejecución. `delete-outlet-collections` además espera 5 segundos con un aviso antes del primer borrado, para poder abortar con Ctrl+C.

Detalle de diseño compartido: `requireEnv()` es incondicional incluso en dry-run. Un dry-run sigue ejecutando todas las **lecturas** contra la tienda real (resolver IDs, buscar colecciones); solo se saltan las **escrituras**. Si las credenciales están rotas, el dry-run falla igual que el real — es deliberado.

## 3. Pipeline del importer

Estos scripts forman el pipeline de importación. Su detalle está en 02-importer y 02b-importer-deploy; aquí solo el catálogo.

| Script | Rol |
| --- | --- |
| `import-parse.mjs` | Parsea los CSV del proveedor (`productos/`, `stock/`, `precios/`) |
| `import-map.mjs` | Mapea los datos crudos al modelo Shopify según `mapping.json` |
| `import-write.mjs` | El writer: aplica el modelo contra la Admin API. Exporta `runFullImport` / `runStockOnly`, que invoca el workflow `ledsc4-import.yml` |
| `import-report.mjs` | Genera los reports del run |
| `fingerprint.mjs` | Calcula el fingerprint por SKU para imports incrementales (ver D14) |
| `rate-limiter.mjs` | Rate limiter para las llamadas a la Admin API |
| `lib/image-upload.mjs` | Pre-upload de imágenes a Shopify Files con dedupe por sha256 (ver D11) |
| `lib/sku-overrides.mjs` | Aplica los overrides manuales de `sku-overrides.json` |

Scripts npm que los orquestan (`package.json`): `npm test`, `npm run import:dry-run`, `npm run import:apply` — ver 12-github-repo §5.

## 4. Setup B2B

Scripts que construyen la infraestructura B2B en la tienda. Algunos tienen dependencias de orden entre sí.

| Script | Qué hace |
| --- | --- |
| `apply-metafield-definitions.mjs` | Crea/actualiza las definiciones de metafields desde `metafield-definitions.json`. Clasifica cada entrada (Create / Unchanged / Update / bloqueada por dependencia / drift) y solo aplica lo seguro |
| `set-shop-b2b-metafields.mjs` | Setea los metafields a nivel shop `b2b.email_backoffice` y `b2b.whitelist_emails` |
| `setup-b2b-catalog.mjs` | Bootstrap del catálogo B2B: smart collection `coleccion-2026`, price list, catalog "Outlet general", y su publication |
| `publish-catalog-products.mjs` | Publica los productos con tag `Coleccion:2026` a la publication del catálogo B2B |
| `tag-and-publish-catalog-products.mjs` | Variante que combina el tageo de productos con el publish en un solo paso |
| `create-b2b-pages.mjs` | Crea/actualiza las páginas del storefront B2B (gate Fase C) desde `pages-manifest.json`: `cuenta-en-revision`, `cuenta-rechazada`, y las páginas legales |
| `create-backoffice-customer.mjs` | Crea el customer especial con tag `backoffice` que da acceso a `/pages/admin-backoffice` |

### Orden de ejecución

Para un bootstrap desde cero hay un orden, porque unos consumen lo que otros crean:

1. `apply-metafield-definitions.mjs` — las definiciones de metafields primero (el resto las usa).
2. `set-shop-b2b-metafields.mjs` — los metafields de shop.
3. `setup-b2b-catalog.mjs` — crea el catálogo y su publication.
4. Tagear los SKUs con `Coleccion:2026` (vía importer o `tag-and-publish-catalog-products.mjs`).
5. `publish-catalog-products.mjs` — publica los productos tageados al catálogo.
6. `create-b2b-pages.mjs` y `create-backoffice-customer.mjs` — independientes, en cualquier momento.

Detalle no obvio: las publications de catálogo B2B **no aceptan colecciones**, solo productos. Por eso el paso 5 publica productos uno a uno en vez de publicar la smart collection. `setup-b2b-catalog.mjs` lo recuerda explícitamente en su salida.

`create-backoffice-customer.mjs` deja el customer creado pero **sin contraseña** — hay que enviar el account invite desde el Admin de Shopify (Customers → Send account invite) para que el usuario la establezca.

## 5. Categorías

Scripts de la jerarquía de categorías del outlet (la reestructuración PR-CAT-RESTRUCTURE de mayo 2026).

| Script | Qué hace |
| --- | --- |
| `setup-cat-collections.mjs` | Crea/actualiza la jerarquía de colecciones `cat-*`: 5 padres SMART (Forlight, Architectural, Decorative, Outdoor, Emergency) + 33 hijos SMART (combos catálogo × tipo con ≥ 3 productos). Las publica al Online Store |
| `setup-cat-menu.mjs` | Configura el `main-menu` del storefront con la jerarquía `cat-*`. Se corre **después** de `setup-cat-collections` |
| `lib/shopify-collections.mjs` | Helper compartido por los dos: construcción de rule sets, upsert de colecciones, resolución de publications, normalización de menús |

Las colecciones `cat-*` viven en la publication del **Online Store**, no en el catálogo B2B (que solo acepta productos — ver §4). Los conteos esperados por colección están hardcodeados en `setup-cat-collections.mjs` como referencia para un WARN de tolerancia (±2): si el `productsCount` real difiere de lo esperado en más de 2, avisa pero no aborta — las smart rules de Shopify tardan segundos en indexar.

La estructura previa (colecciones `outlet-*`, con `cat-diy` y `cat-otros`) quedó retirada; su limpieza es `delete-outlet-collections.mjs` (ver §8). El detalle de la reestructuración irá en el runbook (16), que cosecha el cierre de PR-CAT-RESTRUCTURE.

## 6. Branding, traducciones, multidivisa

| Script | Qué hace | Doc relacionado |
| --- | --- | --- |
| `apply-customer-accounts-branding.mjs` | Aplica el branding de las cuentas de cliente (logo, fuentes, colores) vía la Branding API de Shopify. Requiere plan Plus/Development y el logo subido a Shopify Files como PNG (la API rechaza SVG) | — |
| `fix-translations.mjs` | Corrige traducciones contaminadas del theme. Dry-run por defecto (`DRY_RUN=false` para ejecutar) | 09-i18n |
| `activate-market-currencies.mjs` | Activa las divisas de presentación (USD, GBP) en los Markets de Shopify | 10-multicurrency |

## 7. Auditoría (read-only)

Scripts que solo leen y generan reports en `reports/` (gitignored — ver 12-github-repo §3). No mutan nada.

| Script | Qué audita |
| --- | --- |
| `audit-customer-state.mjs` | Invariantes del estado de los customers B2B: sin tag de estado, con varios tags de estado (error duro, exit ≠ 0), o `aprobado` sin Company vinculada |
| `audit-catalogo-tipo.mjs` | Cobertura y crosstab de `product.catalogo` × `product.tipo` para los productos del outlet. Marca los combos con ≥ 3 productos como candidatos a subcolección |
| `audit-catalogo-familia.mjs` | Variante del anterior, sobre `product.familia` |

`audit-customer-state` se llama hoy `audit-customer-state.js` (extensión `.js`, no `.mjs`) — es el único script con esa extensión. Es ESM igual que el resto; la diferencia es solo el nombre de archivo. Anotado en pendientes.

Los audits de catálogo (`audit-catalogo-tipo`, `audit-catalogo-familia`) son los que se corrieron para decidir la estructura de `cat-*` colecciones — sus reports alimentaron los conteos esperados de `setup-cat-collections.mjs`.

## 8. Limpieza

| Script | Qué hace |
| --- | --- |
| `delete-outlet-collections.mjs` | Borra las colecciones legacy `outlet-*`. **Antes de borrar, escanea** el theme del repo y los recursos del shop (metafields, menús, páginas, artículos, muestra de metafields de producto) buscando referencias a `outlet-*`. Si encuentra alguna, aborta sin borrar nada |

Es el script más cuidadoso del repo: dry-run por defecto, escaneo de referencias que bloquea la ejecución si algo enlaza a `outlet-*`, y 5 segundos de aviso antes del primer borrado. El borrado de colecciones es irreversible, de ahí la ceremonia.

## 9. Ficheros de datos en `scripts/`

`scripts/` contiene también ficheros JSON que no son código — son la configuración que consumen los scripts:

| Fichero | Lo consume |
| --- | --- |
| `mapping.json` | `import-map.mjs` — reglas de mapeo CSV → modelo Shopify |
| `metafield-definitions.json` | `apply-metafield-definitions.mjs` — definiciones de metafields a aplicar |
| `sku-overrides.json` | `lib/sku-overrides.mjs` — overrides manuales por SKU |
| `pages-manifest.json` | `create-b2b-pages.mjs` — manifiesto de páginas del storefront |

## 10. Tests

Varios scripts tienen suite de tests (`*.test.mjs`), corren con `npm test` (ver 12-github-repo §5). Cubren el pipeline del importer y sus librerías: `import-parse`, `import-map`, `import-write`, `rate-limiter`, `fingerprint`, `lib/image-upload`, `lib/sku-overrides`.

Los scripts de setup, categorías, branding y auditoría **no tienen tests** — son operaciones one-shot idempotentes que se validan con `--dry-run` contra la tienda real antes de ejecutar. Es una decisión razonable para scripts de un solo uso, pero implica que un cambio en uno de ellos no tiene red de seguridad automática.

## 11. Pendientes

- **`audit-customer-state.js` con extensión inconsistente**. Es el único script `.js` en un directorio de `.mjs`. Renombrar a `audit-customer-state.mjs` por consistencia (y revisar que nada lo invoque por el nombre viejo).

- **`_shopify.mjs` con header desactualizado**. El comentario de cabecera de `_shopify.mjs` menciona scripts que ya no existen con esos nombres (`setup-outlet-collections`, `tag-products-by-axis`, `setup-outlet-menu`, `audit-collection-axes`) — son los nombres pre-PR-CAT-RESTRUCTURE de los actuales `setup-cat-collections`, `tag-and-publish-catalog-products`, `setup-cat-menu`, `audit-catalogo-*`. Actualizar el comentario.

- **`gql()` duplicado entre scripts**. `_shopify.mjs` expone un `gql()` con throttling, pero varios scripts más antiguos (`setup-b2b-catalog`, `publish-catalog-products`, `audit-customer-state`, `apply-metafield-definitions`, `set-shop-b2b-metafields`, `create-b2b-pages`, `delete-outlet-collections`) llevan su propia copia inline, con manejo de throttling desigual. Conviene migrarlos todos al helper compartido.

- **Scripts de setup sin tests**. Los scripts de setup/categorías/branding/auditoría no tienen cobertura de tests. No es crítico para one-shots, pero un `shopify theme check` o un smoke test en CI reduciría el riesgo de regresiones. Cross-link a 13-github-actions (pendiente de un workflow de lint).

- **Catálogo de scripts sin índice en el repo**. No hay un `scripts/README.md`. Este doc cumple esa función, pero un README mínimo en `scripts/` que remita aquí ayudaría a quien navegue el repo directamente.
