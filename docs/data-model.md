# LedsC4 B2B — Modelo de datos

Documento de referencia del modelo de datos que soporta el portal outlet B2B de
LedsC4 en Shopify (tema Dawn, plan Grow, B2B nativo + Locksmith).

- **Fase A** (aplicada) — estructura: tags canónicos, metafields, catálogo, rol staff.
- **Fase B** (en curso) — flujo de registro y aprobación. Ver [backoffice-aprobaciones.md](backoffice-aprobaciones.md), [test-scenarios.md](test-scenarios.md) y `flows/`.
- Fase C — storefront (Locksmith).
- Fase D — solicitudes / draft orders.
- Fase E — emails transversal.

## 1. Diagrama del modelo

```
                      +--------------------------------+
                      |              SHOP              |
                      |  metafields b2b.*              |
                      |    whitelist_emails  (list)    |
                      |    email_backoffice  (string)  |
                      +--------------+-----------------+
                                     |
                                     | W1 auto-aprueba si email ∈ whitelist
                                     v
+----------------------+   tag único   +---------------+   1-a-1   +-----------------+
|      CUSTOMER        |  pendiente /  |     TAG       |           |    COMPANY      |
|  (cuenta Shopify)    +---------------+  aprobado /   |           |  (B2B nativo)   |
|                      |  rechazado    |  rechazado    |           |  1 miembro      |
|  metafields b2b.*    |               +---------------+           |                 |
|  (ver §4)            |                                           |                 |
+----------+-----------+                                           +--------+--------+
           |                                                                |
           | aprobado → Flow W1/W2 crea Company                             |
           +----------------------------------------------------------------+
                                                                            |
                                                                            v
                                           +-----------------------------------------+
                                           |  COMPANY LOCATION (1 por company)       |
                                           |    asignada a 1 CATALOG:                |
                                           |    "Outlet general"                     |
                                           +-------------------+---------------------+
                                                               |
                                                               v
                                           +-----------------------------------------+
                                           |  CATALOG "Outlet general" (ACTIVE)      |
                                           |    priceList: 0% sobre shop (EUR)       |
                                           |    publication ← 745 productos tag      |
                                           |                  Coleccion:2026         |
                                           +-----------------------------------------+
```

Lectura en 30 segundos: el cliente se da de alta → entra como `pendiente` → al
aprobarse se crea una Company de 1 miembro → la Company se asigna al único
catálogo activo (Outlet general) → ese catálogo muestra los 743 productos
taggeados como `Coleccion:2026`.

## 2. Tags canónicos (Customer)

Tres tags, **mutuamente excluyentes**. Exactamente uno por cliente en todo momento.

| Tag          | Significado                                   | Origen              |
|--------------|-----------------------------------------------|---------------------|
| `pendiente`  | Alta enviada, sin revisar                     | Set automático al registro |
| `aprobado`   | Revisado OK, Company creada, acceso B2B       | Set al aprobar (fase B)     |
| `rechazado`  | Revisado y denegado                           | Set al rechazar (fase B)    |

**Invariante**: exactamente uno de los tres. El script
`scripts/audit-customer-state.js` recorre todos los clientes y reporta:

- `no_state_tag`: clientes sin ninguno → candidatos a normalizar
- `multiple_state_tags`: clientes con dos o más → **error duro**, corregir manualmente
  (el script termina con exit code 2 y escribe CSV en `reports/`)
- `approved_without_company`: `aprobado` sin Company asociada → deuda técnica

El script se ejecuta a mano o en CI. Sobre un store vacío de B2B corre limpio.

## 3. Metafields de tienda (Shop)

| Namespace | Key                | Tipo                           | Acceso admin          | Uso |
|-----------|--------------------|--------------------------------|-----------------------|-----|
| `b2b`     | `whitelist_emails` | `list.single_line_text_field`  | `MERCHANT_READ_WRITE` | Lista blanca de emails que se auto-aprueban al registrarse. Editable por staff con permiso "Edit custom data". |
| `b2b`     | `email_backoffice` | `single_line_text_field`       | `MERCHANT_READ_WRITE` | Destinatario de avisos al backoffice cuando llega un registro pendiente (W1 rama B, email 3). |

Ejemplos de valor:

```json
// b2b.whitelist_emails
["juan@instalador.com", "compras@arquitecto.es", "pedidos@retail.com"]

// b2b.email_backoffice
"backoffice@ledsc4.com"
```

## 4. Metafields de Customer (namespace `b2b`)

| Key                | Tipo                       | Pin  | Nullable | Uso |
|--------------------|----------------------------|------|----------|-----|
| `empresa`          | `single_line_text_field`   | Sí   | No       | Razón social |
| `nif`              | `single_line_text_field`   | Sí   | No       | NIF/CIF/NIE (validado con dígito de control en el registro y reforzado por Flow W1) |
| `sector`           | `single_line_text_field`   | Sí   | No       | Valor de la lista fija del formulario (instalador, arquitecto_interiorismo, retail_tienda, distribuidor, empresa_final, otro) |
| `pais`             | `single_line_text_field`   | Sí   | Sí       | ISO country code del formulario. Reservado para multi-tarifa. (Renombrado desde `zona` al iniciar Fase B.) |
| `volumen_estimado` | `single_line_text_field`   | No   | Sí       | Slug de rango: `<5k`, `5k-25k`, `25k-100k`, `>100k`, `no_se` |
| `fecha_registro`   | `date`                     | Sí   | No       | Fecha del alta (formulario enviado) |
| `fecha_aprobacion` | `date`                     | Sí   | Sí       | Solo si `aprobado` |
| `motivo_rechazo`   | `single_line_text_field`   | Sí   | Sí       | Solo si `rechazado`. Se usa en el cuerpo del email 5 si no está vacío. |

En el store Development (y previsiblemente también en Grow) el bloque `access` no
se acepta explícitamente en la creación vía API; se omite y Shopify aplica
defaults (merchant read-write, storefront none). La exposición al storefront
llega en fase C (si aplica).

### Ejemplo de payload Customer

```json
{
  "id": "gid://shopify/Customer/1234567890",
  "email": "juan@instalador.com",
  "tags": ["pendiente"],
  "metafields": {
    "b2b.empresa": "Instalaciones Luz SL",
    "b2b.nif": "B12345678",
    "b2b.sector": "instalador",
    "b2b.pais": "ES",
    "b2b.volumen_estimado": "5k-25k",
    "b2b.fecha_registro": "2026-04-17",
    "b2b.fecha_aprobacion": null,
    "b2b.motivo_rechazo": null
  }
}
```

Tras aprobación:

```json
{
  "tags": ["aprobado"],
  "metafields": {
    "b2b.fecha_aprobacion": "2026-04-18",
    "...": "..."
  },
  "companyContactProfiles": [{ "company": { "name": "Instalaciones Luz SL" } }]
}
```

## 5. Catálogo B2B

Un único catálogo al arrancar. Arquitectura multi-catalog-ready: en el futuro
cada Company puede asignarse a un catálogo distinto sin refactor.

| Campo            | Valor                                                 |
|------------------|-------------------------------------------------------|
| Título           | `Outlet general`                                      |
| Estado           | `ACTIVE`                                              |
| Contexto         | `CompanyLocationCatalog` (vacío al arrancar)          |
| Price list       | `Outlet general — precios actuales` · EUR · 0% sobre shop |
| Publicación      | Smart collection `coleccion-2026`                     |

### Smart collection

| Campo              | Valor                                   |
|--------------------|-----------------------------------------|
| Handle             | `coleccion-2026`                        |
| Título             | `Colección 2026 (Outlet B2B)`           |
| Regla              | `product_tag EQUALS "Coleccion:2026"`   |
| Productos esperados| 743                                     |

Para poblar: taggear los 743 productos con el tag literal `Coleccion:2026`
(respetar mayúscula inicial y formato `clave:valor`). La smart collection
actualiza membership automáticamente.

### Ejemplo de payload Catalog

```json
{
  "id": "gid://shopify/CompanyLocationCatalog/123",
  "title": "Outlet general",
  "status": "ACTIVE",
  "priceList": {
    "name": "Outlet general — precios actuales",
    "currency": "EUR",
    "parent": { "adjustment": { "type": "PERCENTAGE_DECREASE", "value": 0.0 } }
  },
  "publication": { "id": "gid://shopify/Publication/456" },
  "companyLocations": []
}
```

## 6. Staff role "Backoffice Aprobaciones"

Plan Grow ofrece roles custom con toggles granulares. Este rol **solo** gestiona
altas y aprobaciones B2B. Sin acceso a ventas, productos, finanzas ni analytics.

| Área               | Permisos                                                     |
|--------------------|--------------------------------------------------------------|
| Customers          | View, Edit (incluye tags y metafields). **No** delete.       |
| Companies          | View, Create, Edit. **No** delete.                           |
| Settings           | Solo "Edit custom data" (para editar `b2b.whitelist_emails`) |
| Orders             | ❌ Sin acceso                                                 |
| Draft orders       | ❌ Sin acceso                                                 |
| Products           | ❌ Sin acceso                                                 |
| Inventory          | ❌ Sin acceso                                                 |
| Discounts          | ❌ Sin acceso                                                 |
| Analytics / Reports| ❌ Sin acceso                                                 |
| Marketing          | ❌ Sin acceso                                                 |
| Apps               | ❌ Sin acceso                                                 |
| Themes             | ❌ Sin acceso                                                 |
| Finances / Billing | ❌ Sin acceso                                                 |

### Cómo crearlo (manual, la API de custom roles no está públicamente expuesta)

1. Shopify Admin → **Settings → Users and permissions → Add custom role**.
2. Nombre: `Backoffice Aprobaciones`.
3. Descripción: `Gestiona altas y aprobaciones B2B. Sin acceso comercial ni financiero.`
4. Activar toggles según la tabla superior.
5. Guardar. Asignar el rol al staff que corresponda.

> Guardar captura de pantalla de los toggles en `docs/screenshots/` al crear el rol,
> para que el setup quede reproducible en otro tenant.

## 7. Scripts incluidos

| Script                                      | Qué hace                                          |
|---------------------------------------------|---------------------------------------------------|
| `scripts/apply-metafield-definitions.mjs`   | Crea las 9 metafield definitions. Idempotente. `--dry-run` disponible. |
| `scripts/setup-b2b-catalog.mjs`             | Crea smart collection + price list + catalog + publication del catalog. Idempotente. `--dry-run`. |
| `scripts/publish-catalog-products.mjs`      | Publica al catalog publication los productos con tag `Coleccion:2026`. Idempotente (salta los ya publicados). Ejecutar tras taggear. |
| `scripts/audit-customer-state.js`           | Audita invariantes de tags y Company. Escribe CSV en `reports/`. |

**Por qué un script aparte para publicar productos**: las B2B catalog publications
no aceptan colecciones directamente. La smart collection sirve para la UI (grouping
en el storefront), pero la visibilidad dentro del catálogo B2B se controla
publicando cada producto a la publication del catalog.

### Variables de entorno

```bash
export SHOPIFY_STORE_DOMAIN=ledsc4-b2b-outlet.myshopify.com
export SHOPIFY_ADMIN_TOKEN=shpat_xxx       # Token de custom app con Admin API
export SHOPIFY_API_VERSION=2025-10         # opcional; default 2025-10
```

El token necesita scopes: `read_customers`, `write_customers`,
`read_companies`, `write_companies`, `read_products`, `write_products`,
`read_publications`, `write_publications`, `read_price_rules`, `write_price_rules`.

### Orden de ejecución recomendado

```bash
# 1. Dry-run para verificar lo que se va a crear
node --env-file=.env.local scripts/apply-metafield-definitions.mjs --dry-run
node --env-file=.env.local scripts/setup-b2b-catalog.mjs --dry-run

# 2. Aplicar estructura
node --env-file=.env.local scripts/apply-metafield-definitions.mjs
node --env-file=.env.local scripts/setup-b2b-catalog.mjs

# 3. Taggear los 743 productos con "Coleccion:2026" (manual, bulk editor o CSV)

# 4. Publicar los productos taggeados al catalog publication
node --env-file=.env.local scripts/publish-catalog-products.mjs --dry-run
node --env-file=.env.local scripts/publish-catalog-products.mjs

# 5. Auditoría (también sirve en store vacío — corre limpio)
node --env-file=.env.local scripts/audit-customer-state.js
```

## 8. Fuera de alcance en esta fase

- Flujo de aprobación / rechazo (fase B)
- Storefront, bloqueo Locksmith, UI de login (fase C)
- Draft orders, solicitudes, formularios (fase D)
- Emails transaccionales (fase E transversal)

## 9. Criterios de aceptación (Fase A)

- [x] Metafield definitions definidas en código
- [x] Metafield definitions aplicadas al store (9/9 aplicadas, idempotencia verificada)
- [ ] Shop metafield `b2b.whitelist_emails` editable por staff con `Edit custom data` (verificar al crear rol)
- [x] Smart collection `coleccion-2026` creada (tag `Coleccion:2026`)
- [x] Price list "Outlet general — precios actuales" creada (0% sobre shop, EUR)
- [x] Catálogo "Outlet general" creado (ACTIVE) con publication propia
- [x] 745 SKUs taggeados con `Coleccion:2026` (+2 respecto al plan original de 743, sin incidencia)
- [x] 745 productos publicados al catalog publication (idempotencia verificada)
- [ ] Rol staff "Backoffice Aprobaciones" creado en admin y con captura en `docs/screenshots/`
- [x] `docs/data-model.md` explica el modelo en <5 min
- [x] `audit-customer-state.js` corre limpio en store sin issues (0 customers, 0 issues)
