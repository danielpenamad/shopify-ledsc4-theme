# 01 · Modelo de datos

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Referencia exhaustiva de las entidades, tags, metafields, custom attributes y roles que sostienen el portal B2B. Es el doc más citado del eje: el resto referencia campos por nombre confiando en que aquí están definidos.

Lectura no lineal — usar el índice para saltar al apartado relevante.

## Índice

1. Diagrama de entidades
2. Tags canónicos del Customer
3. Metafields del Customer
4. Metafields del Shop
5. Metafields de Page
6. Metafields del Product
7. Companies y Catalogs
8. Custom attributes del Draft Order
9. Capas de publicación
10. Staff role
11. Audit invariants

---

## 1. Diagrama de entidades

```
+-----------------------------------------------------------------------+
|                            SHOP                                       |
|  metafields b2b.*                                                     |
|    whitelist_emails       (list)                                      |
|    whitelist_last_update  (date_time)                                 |
|    email_backoffice       (string)                                    |
+----------------+-------------------------+----------------------------+
                 |                         |
                 | promote-whitelist       | invocada por Flow W1/W2/W3
                 v                         v
+--------------------------+   1-a-1  +-----------------------------------+
|        CUSTOMER          |          |            COMPANY                |
|  (cuenta Shopify, login) +--------->|        (B2B nativo)               |
|                          |          |  1 miembro (CompanyContact)       |
|  metafields b2b.* (9)    |          |  1 location (CompanyLocation)     |
|  ver §3                  |          +-----------+-----------------------+
|                          |                      |
|  tag canónico:           |                      |
|    pendiente |           |                      v
|    aprobado  |           |          +-----------------------------------+
|    rechazado |           |          |  CompanyLocationCatalog           |
|    backoffice            |          |    "Outlet general" (1 activo)    |
+------+-------------------+          |    EUR · 0% sobre shop            |
       |                              +-----------+-----------------------+
       | tag aprobado                             |
       v                                          v
+--------------------------+          +-----------------------------------+
|     DRAFT ORDER          |          |  Publication del catalog          |
|  (solicitud de pedido)   |          |    745 productos publicados       |
|                          |          |    (smart collection              |
|  tags: solicitud-b2b,    |          |     coleccion-2026, sustituida    |
|        pendiente-revision|          |     progresivamente por regla     |
|  customAttributes: §8    |          |     surtido+stock+precio del      |
+--------------------------+          |     importer)                     |
                                      +-----------------------------------+

                                      +-----------------------------------+
                                      |          PRODUCT                  |
                                      |  metafields product.* (32)        |
                                      |  metafield b2b.cbm_caja (1)       |
                                      |  ver §6                           |
                                      +-----------------------------------+
```

---

## 2. Tags canónicos del Customer

Cuatro tags. Los tres primeros son **mutuamente excluyentes** — exactamente uno por Customer humano. El cuarto (`backoffice`) es ortogonal a los demás y se aplica al Customer técnico que da acceso al panel de admin.

| Tag | Significado | Quién lo aplica |
|---|---|---|
| `pendiente` | Alta enviada, sin revisar. | edge `register-b2b-customer` al crear el Customer. |
| `aprobado` | Revisado OK. Company creada. Acceso B2B activo. | edge `approve-customer` (manual desde backoffice) o edge `promote-whitelist-matches` (auto desde `pg_cron`). |
| `rechazado` | Revisado y denegado. | edge `reject-customer` (manual desde backoffice). |
| `backoffice` | Customer técnico que da acceso a `/pages/admin-backoffice`. No representa a una persona física. | script `scripts/create-backoffice-customer.mjs` (one-shot). |

**Invariante**: exactamente un tag de `{pendiente, aprobado, rechazado}` por cada Customer humano. El tag `backoffice` está fuera de esa restricción.

El script `scripts/audit-customer-state.js` valida la invariante. Modos de fallo reportados:

- `no_state_tag`: Customer humano sin ninguno de los tres tags → candidato a normalizar.
- `multiple_state_tags`: dos o más simultáneamente → error duro, exit code 2, CSV en `reports/`.
- `approved_without_company`: tag `aprobado` sin `Company` asociada → deuda técnica.

---

## 3. Metafields del Customer

9 definitions, todas `namespace: b2b`. Acceso default merchant read-write, storefront none (Shopify no acepta bloque `access` explícito en CUSTOMER en el plan actual; se aplican defaults).

| Key | Tipo | Pin | Nullable | Quién escribe | Uso |
|---|---|---|---|---|---|
| `empresa` | `single_line_text_field` | ✅ | No | edge `register-b2b-customer` | Razón social. |
| `nif` | `single_line_text_field` | ✅ | No | edge `register-b2b-customer` | NIF/CIF/NIE validado con dígito de control en el form y reforzado por Flow W1. |
| `sector` | `single_line_text_field` | ✅ | No | edge `register-b2b-customer` | Slug de la lista fija del form: `instalador`, `arquitecto_interiorismo`, `retail_tienda`, `distribuidor`, `empresa_final`, `otro`. |
| `pais` | `single_line_text_field` | ✅ | Sí | edge `register-b2b-customer` | ISO country code del form. Reservado para multi-tarifa. Renombrado desde `zona` al iniciar Fase B. |
| `volumen_estimado` | `single_line_text_field` | ❌ | Sí | edge `register-b2b-customer` | Slug de rango: `<5k`, `5k-25k`, `25k-100k`, `>100k`, `no_se`. Candidato a `number_decimal` cuando se active multi-tarifa. |
| `fecha_registro` | `date` | ✅ | No | edge `register-b2b-customer` | Fecha del envío del form. |
| `fecha_aprobacion` | `date` | ✅ | Sí | edge `approve-customer` o `promote-whitelist-matches` | Solo si `aprobado`. |
| `fecha_rechazo` | `date` | ✅ | Sí | edge `reject-customer` | Solo si `rechazado`. Añadido en Fase BO; no estaba en la entrega original de Fase A. |
| `motivo_rechazo` | `single_line_text_field` | ✅ | Sí | edge `reject-customer` | Texto libre. Si está vacío, el email 5 (rechazo) omite el bloque "motivo". |

### Ejemplo de payload Customer aprobado

```json
{
  "id": "gid://shopify/Customer/1234567890",
  "email": "juan@instalador.com",
  "tags": ["aprobado"],
  "metafields": {
    "b2b.empresa": "Instalaciones Luz SL",
    "b2b.nif": "B12345678",
    "b2b.sector": "instalador",
    "b2b.pais": "ES",
    "b2b.volumen_estimado": "5k-25k",
    "b2b.fecha_registro": "2026-04-17",
    "b2b.fecha_aprobacion": "2026-04-18",
    "b2b.fecha_rechazo": null,
    "b2b.motivo_rechazo": null
  },
  "companyContactProfiles": [{ "company": { "name": "Instalaciones Luz SL" } }]
}
```

---

## 4. Metafields del Shop

3 definitions, todas `namespace: b2b`, todas con `access.admin: MERCHANT_READ_WRITE`.

| Key | Tipo | Pin | Quién escribe | Uso |
|---|---|---|---|---|
| `whitelist_emails` | `list.single_line_text_field` | ✅ | edge `update-whitelist` (desde backoffice) o staff manual (permiso "Edit custom data") | Lista de emails / dominios que se auto-aprueban al registrarse. Consumida por Flow W1 (chequeo whitelist) y por edge `promote-whitelist-matches` (cron cada 30 min). |
| `whitelist_last_update` | `date_time` | ✅ | edge `update-whitelist` | Timestamp ISO de la última actualización del metafield `whitelist_emails`. Usado por `promote-whitelist-matches` para identificar entradas nuevas desde el último run. |
| `email_backoffice` | `single_line_text_field` | ✅ | Staff manual (Settings → Custom data) | Destinatario de avisos de nuevo registro pendiente. Consumido por Flow W1 rama B y por el email 3. |

### Ejemplo de valores

```json
{
  "b2b.whitelist_emails": [
    "juan@instalador.com",
    "@iluminacion.com",
    "compras@arquitecto.es"
  ],
  "b2b.whitelist_last_update": "2026-05-14T18:30:00Z",
  "b2b.email_backoffice": "backoffice@ledsc4.com"
}
```

Una entrada que empieza por `@` es un dominio (todos los emails de ese dominio quedan whitelisted). Un email completo solo whitelistea ese email.

---

## 5. Metafields de Page

2 definitions, `namespace: b2b`. Pensadas para que el staff con permiso "Edit custom data" pueda editar el mensaje sin tocar el theme.

| Key | Tipo | Pin | Página objetivo |
|---|---|---|---|
| `cuenta_revision_mensaje` | `multi_line_text_field` | ✅ | `/pages/cuenta-en-revision` |
| `cuenta_rechazada_mensaje` | `multi_line_text_field` | ✅ | `/pages/cuenta-rechazada` |

El theme las consume en las sections asociadas a esas páginas.

---

## 6. Metafields del Product

33 definitions en total: 1 en `namespace: b2b` + 32 en `namespace: product`. Las 32 de `product` son la **Fase I1** del importer ([D9](adrs/d09-metafields-ampliados.md)) y todas tienen `access.storefront: PUBLIC_READ` excepto `predeterminado` (`NONE` — ver [D8](adrs/d08-predeterminado.md)).

### Namespace `b2b` (1)

| Key | Tipo | Pin | Uso |
|---|---|---|---|
| `cbm_caja` | `number_decimal` | ✅ | Volumen en m³ de la caja/unidad de venta. Consumido por edge `submit-order-request` para calcular `cbm_total` del Draft Order. |

### Namespace `product` (32)

Agrupadas por categoría para navegación. Todas tienen `access.storefront: PUBLIC_READ` salvo `predeterminado` (`NONE`).

**Identificación y clasificación (5)**

| Key | Tipo | Pin | Translatable | Uso |
|---|---|---|---|---|
| `familia` | `single_line_text_field` | ✅ | ✅ | Familia/serie LedsC4 del producto. Genera tag automático `Familia:<valor>` al importar. |
| `tipo` | `single_line_text_field` | ✅ | ✅ | Tipo del producto. |
| `catalogo` | `single_line_text_field` | ✅ | ✅ | Catálogo LedsC4 al que pertenece. |
| `version` | `single_line_text_field` | ❌ | ❌ | Versión del producto. |
| `etiqueta_vf` | `single_line_text_field` | ❌ | ✅ | Etiqueta V/f según nomenclatura interna LedsC4. |

**Características técnicas (12)**

| Key | Tipo | Pin | Translatable | Uso |
|---|---|---|---|---|
| `vatios` | `number_decimal` | ✅ | ❌ | Potencia en W. |
| `lumenes` | `number_decimal` | ✅ | ❌ | Lúmenes declarados en lm. |
| `lumenes_reales` | `number_decimal` | ❌ | ❌ | Lúmenes reales medidos. |
| `temperatura_color` | `single_line_text_field` | ✅ | ❌ | Temperatura color LED. Texto porque admite valores no numéricos (`TUNABLE WHITE`, rangos). |
| `cri` | `number_integer` | ❌ | ❌ | Índice reproducción cromática (0-100). |
| `rayo_luz` | `single_line_text_field` | ❌ | ❌ | Ángulo del haz en grados o etiqueta cualitativa (`SPOT`/`MEDIUM`/`FLOOD`). |
| `fuente_luz` | `single_line_text_field` | ✅ | ✅ | Fuente de luz. |
| `tipo_regulacion` | `single_line_text_field` | ✅ | ✅ | Tipo de regulación. |
| `incluye_bombilla` | `boolean` | ✅ | ❌ | Indica si incluye bombilla. |
| `ip` | `single_line_text_field` | ✅ | ❌ | Grado de protección IP (`IP20`, `IP54`, `IP65`). |
| `ik` | `single_line_text_field` | ❌ | ❌ | Resistencia a impactos según IEC 62262 (`IK04`, `IK10`). |
| `eficiencia_energetica` | `single_line_text_field` | ✅ | ❌ | Clase A–G según etiqueta UE. Admite `NA EPREL`. |

**Materiales y dimensiones (7)**

| Key | Tipo | Pin | Translatable | Uso |
|---|---|---|---|---|
| `material` | `single_line_text_field` | ✅ | ✅ | Material del producto. |
| `acabado` | `single_line_text_field` | ✅ | ✅ | Acabado del producto. Su primera palabra alimenta el title compuesto. |
| `dim_largo_mm` | `number_decimal` | ✅ | ❌ | Largo en mm. |
| `dim_ancho_mm` | `number_decimal` | ✅ | ❌ | Ancho en mm. |
| `dim_alto_mm` | `number_decimal` | ✅ | ❌ | Alto en mm. |
| `proyeccion_mm` | `number_decimal` | ❌ | ❌ | Proyección en mm. |
| `peso_neto_kg` | `number_decimal` | ✅ | ❌ | Peso neto en kg. |

**Comercial y garantía (3)**

| Key | Tipo | Pin | Translatable | Uso |
|---|---|---|---|---|
| `garantia` | `single_line_text_field` | ✅ | ✅ | Garantía. |
| `accesorio` | `single_line_text_field` | ❌ | ✅ | Accesorio del producto. Deuda técnica — se ha mantenido por compatibilidad mientras `accesorio_url` la sustituye. |
| `tender_text` | `multi_line_text_field` | ❌ | ✅ | Texto extendido para licitaciones y pliegos públicos. |

**URLs externas a la CDN del cliente (8)**

Todas apuntan a `https://files.ledsc4.com/...`. Tipo `url`.

| Key | Pin | Translatable | Apunta a |
|---|---|---|---|
| `ficha_url` | ❌ | ❌ | PDF de la ficha técnica. |
| `ficha_comercial_url` | ❌ | ❌ | PDF de la ficha comercial. |
| `ee_url` | ❌ | ❌ | PDF de la etiqueta energética. |
| `fotometria_url` | ❌ | ❌ | PDF de fotometría. |
| `ies_url` | ❌ | ❌ | Archivo fotométrico IES. |
| `ldt_url` | ❌ | ❌ | Archivo fotométrico LDT (EULUMDAT). |
| `modelo_3d_url` | ❌ | ❌ | Archivo de modelo 3D. |
| `accesorio_url` | ❌ | ❌ | HTML técnico de accesorios (`/ft3/<locale>/<sku>.html`). Sustituye a `accesorio` (text). |

**Internos y misceláneos (2)**

| Key | Tipo | Pin | Translatable | access.storefront | Uso |
|---|---|---|---|---|---|
| `imc` | `single_line_text_field` | ❌ | ❌ | `PUBLIC_READ` | Código IMC. Semántica pendiente de confirmar con el cliente. |
| `predeterminado` | `single_line_text_field` | ❌ | ❌ | `NONE` | Columna del ERP cuya semántica el cliente aún no ha confirmado ([D8](adrs/d08-predeterminado.md)). |

### Campos translatable

11 definitions están marcadas `translatable: true` en `scripts/mapping.json` para que el importer las pase por Translate & Adapt vía `translationsRegister`:

`tipo`, `familia`, `catalogo`, `garantia`, `etiqueta_vf`, `tender_text`, `material`, `acabado`, `fuente_luz`, `tipo_regulacion`, `accesorio`.

Detalle en [09-i18n](09-i18n.md) y en [02-importer](02-importer.md) §multi-idioma.

---

## 7. Companies y Catalogs

Modelo B2B nativo. Entidades, no metafields ([D2](adrs/d02-b2b-nativo.md)).

### Company

Por cada Customer aprobado existe una `Company` con un único `CompanyContact` (el Customer) y una única `CompanyLocation`. El nombre de la Company es el valor de `customer.metafields.b2b.empresa`.

| Campo de Company | Valor |
|---|---|
| `name` | `customer.b2b.empresa` |
| `note` | NIF + sector (auto-construido por edge `create-company-for-customer`) |
| `externalId` | El `customer.id` numérico, para idempotencia (la edge consulta por externalId antes de crear). |

`CompanyContact`:
- `customer.id` ↔ Customer Shopify.
- Marcado como `mainContact: true`.

`CompanyLocation`:
- 1 sola por Company.
- Vinculada al catalog "Outlet general" vía `companyLocationUpdateCatalogs`.

### Catalog único

| Campo | Valor |
|---|---|
| `title` | `Outlet general` |
| `status` | `ACTIVE` |
| `type` | `CompanyLocationCatalog` |
| `priceList.name` | `Outlet general — precios actuales` |
| `priceList.currency` | `EUR` |
| `priceList.parent.adjustment` | `PERCENTAGE_DECREASE 0.0%` |
| Productos publicados | 745 (filtrados por smart collection `coleccion-2026`) |

Decisión arquitectónica: [D6](adrs/d06-catalogo-unico.md). El modelo soporta N catalogs sin refactor (futuro premium / sector / país).

El `catalog_id` real (GID) vive en `private.config` de Supabase (clave `catalog_id`), leído por `create-company-for-customer` al asignar el catalog a la `CompanyLocation`.

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
  "companyLocations": [ /* 1 por customer aprobado */ ]
}
```

---

## 8. Custom attributes del Draft Order

Cada Draft Order creado por la edge `submit-order-request` (Fase D) lleva tags + 5 custom attributes que sirven al backoffice para filtrar, calcular y dar contexto.

### Tags del Draft Order

| Tag | Significado |
|---|---|
| `solicitud-b2b` | Identifica Draft Orders originados desde `/pages/solicitar-pedido`. Filtro estable para listados y reports. |
| `pendiente-revision` | Estado inicial. El backoffice lo cambia manualmente cuando revisa el draft. |

### Custom attributes

| Key | Tipo | Valor de ejemplo | Quién escribe | Uso |
|---|---|---|---|---|
| `fuente` | string | `solicitud-b2b-frontend` | edge `submit-order-request` | Discriminador del origen. Permite filtrar futuros Drafts creados por otros flujos. |
| `cbm_total` | string numérico (3 decimales) | `1.234` | edge `submit-order-request` | Suma de `qty × product.b2b.cbm_caja` para todos los items del carrito. Cálculo server-side a partir de las cbm_caja de las variantes. |
| `fecha_solicitud` | string ISO | `2026-05-14T18:30:45.123Z` | edge `submit-order-request` | Timestamp del envío de la solicitud. Distinto de `draftOrder.createdAt` solo si Shopify tarda en crear el draft. |
| `Moneda mostrada` | string | `EUR` / `USD` / `GBP` | edge `submit-order-request` | Divisa que el comprador veía en pantalla al enviar la solicitud. No es de confianza (client-side), informativa para el backoffice. Default `EUR` si llega inválida o ausente ([D13](adrs/d13-multicurrency.md)). |
| `Símbolo moneda` | string | `€` / `$` / `£` | edge `submit-order-request` | Símbolo correspondiente a `Moneda mostrada`. Persistido para que el backoffice lo muestre en emails sin re-derivar. |

Detalle en [07-solicitudes-pedido](07-solicitudes-pedido.md).

### Detalles operativos de la edge

- **HMAC TTL**: 10 minutos. Si el comprador tarda más en confirmar, recibe `signature_expired` y debe recargar la página.
- **Dedupe**: si el customer tiene un Draft con tag `pendiente-revision` creado en los últimos 60 min, la edge devuelve `warning: "recent_request"` con los datos del draft anterior. Para forzar, pasar `force: true` en el body.
- **CBM**: redondeado a 3 decimales. Si una variante no tiene `b2b.cbm_caja` definido, suma 0 (no error).

---

## 9. Capas de publicación

La visibilidad de productos y colecciones en el storefront B2B se gobierna por tres mecanismos independientes. Cambiar uno no altera los otros.

| Capa | Pregunta que responde | Mecanismo | Qué se publica aquí |
|---|---|---|---|
| 1 | ¿Qué puede comprar esta Company? | Catalog B2B `Outlet general` (publication) | 745 productos con tag `Coleccion:2026`. |
| 2 | ¿Qué se renderiza en el storefront? | Publication `Online Store` (sales channel) | Las 38 colecciones `cat-*` (5 padres smart + 33 hijos), la smart `coleccion-2026`, páginas, blogs. |
| 3 | ¿Quién puede ver las URLs? | Gate por tag `aprobado` en `theme.liquid` | (No publica nada; controla acceso) |

### Capa 1 — Catalog B2B

- Tipo: `CompanyLocationCatalog` (B2B nativo).
- Publication asociada: resuelta dinámicamente vía la conexión `catalogs` filtrando por `title:"Outlet general"`.
- Qué se publica aquí: los 745 productos con tag `Coleccion:2026`, vía `scripts/publish-catalog-products.mjs`.
- **Acepta productos, NO colecciones**. Intentar publicar colecciones aquí falla con `Cannot publish a collection to a publication that does not belong to a channel catalog`.

### Capa 2 — Online Store publication

- Tipo: sales channel publication. `catalog == null` + `supportsFuturePublishing == true` (capability-based identification, no por nombre).
- Helper: `scripts/lib/shopify-collections.mjs::resolveOnlineStorePublicationId()`.
- Qué se publica aquí: las 38 colecciones `cat-*` (5 padres + 33 hijos), la smart `coleccion-2026`, páginas. Sin esta publicación, `/collections/<handle>` devuelve 404.

### Capa 3 — Gate del theme

- Implementación: bloque Liquid en `layout/theme.liquid`. Detalle en [04-storefront-gate](04-storefront-gate.md).
- Redirige según tag del Customer; no usa Locksmith Rule 1/3 ([D4](adrs/d04-gate-hibrido.md)).

### Ortogonalidad

- Un producto puede estar en Capa 1 sin estar en ninguna colección de Capa 2 (sigue siendo buscable y comprable por URL directa).
- Una colección puede vivir en Capa 2 sin productos en Capa 1 (la página `/collections/<handle>` carga pero está vacía o con error de price unavailable).
- Capa 3 revoca acceso del visitante, no presencia del recurso. Un admin sí puede ver las URLs porque no pasa por el gate.

---

## 10. Staff role

Plan Grow ofrece roles custom con toggles granulares. El rol "Backoffice Aprobaciones" gestiona solo altas y aprobaciones B2B. Sin acceso a ventas, productos, finanzas ni analytics.

| Área | Permisos |
|---|---|
| Customers | View, Edit (incluye tags y metafields). **No** delete. |
| Companies | View, Create, Edit. **No** delete. |
| Settings | Solo "Edit custom data" (para editar `b2b.whitelist_emails`). |
| Orders | ❌ Sin acceso. |
| Draft orders | ❌ Sin acceso. |
| Products | ❌ Sin acceso. |
| Inventory | ❌ Sin acceso. |
| Discounts | ❌ Sin acceso. |
| Analytics / Reports | ❌ Sin acceso. |
| Marketing | ❌ Sin acceso. |
| Apps | ❌ Sin acceso. |
| Themes | ❌ Sin acceso. |
| Finances / Billing | ❌ Sin acceso. |

### Cómo crearlo

La API de custom roles no está expuesta. Procedimiento manual:

1. Shopify Admin → Settings → Users and permissions → Add custom role.
2. Nombre: `Backoffice Aprobaciones`.
3. Descripción: `Gestiona altas y aprobaciones B2B. Sin acceso comercial ni financiero.`
4. Activar toggles según tabla.
5. Asignar al staff que corresponda.

**Importante**: este rol existe como fallback manual sobre Admin (ver customers, taggear a mano). La operativa real de aprobaciones pasa por `/pages/admin-backoffice` ([D7](adrs/d07-backoffice-page.md)).

---

## 11. Audit invariants

Script: `scripts/audit-customer-state.js`. Detalle en [15-scripts](15-scripts.md).

### Invariantes que valida

1. **Tag canónico único por Customer humano**: exactamente uno de `{pendiente, aprobado, rechazado}`. Customers con tag `backoffice` excluidos del check.
2. **Customer aprobado tiene Company**: cualquier Customer con tag `aprobado` debe tener una `CompanyContact` asociada.

### Reportes generados

CSVs en `reports/audit-YYYY-MM-DD-HHMMSS/`:

- `no_state_tag.csv` — Customers sin ninguno de los 3 tags.
- `multiple_state_tags.csv` — Customers con 2 o más.
- `approved_without_company.csv` — `aprobado` sin Company.

Exit codes:
- `0` — sin issues.
- `2` — error duro (`multiple_state_tags` o `approved_without_company`).

Se ejecuta manualmente o en CI. Sobre un store vacío corre limpio.

---

## Conteo total de definitions

Total: **47 metafield definitions**.

| Owner | Namespace | Cantidad |
|---|---|---|
| Customer | `b2b` | 9 |
| Shop | `b2b` | 3 |
| Page | `b2b` | 2 |
| Product | `b2b` | 1 |
| Product | `product` | 32 |

Fuente única de verdad: `scripts/metafield-definitions.json`. Script de aplicación: `scripts/apply-metafield-definitions.mjs` ([15-scripts](15-scripts.md)).

> **Nota**: [D9](adrs/d09-metafields-ampliados.md) menciona "45 definitions" — conteo desactualizado. El total real es 47 (incluye `whitelist_last_update` Shop y `fecha_rechazo` Customer, añadidas en Fase BO posteriores al cierre del ADR).

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
