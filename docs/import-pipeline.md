# Pipeline de importación — LedsC4 B2B Outlet

Reemplaza al §9 de [`docs/arquitectura.md`](arquitectura.md) (que estaba
diseñado contra un formato hipotético "Excel multi-hoja + CSV 2-col" que
el cliente ha redefinido). Esta es la arquitectura real del importador
acordada con el cliente el 2026-05-04.

Estado: **diseño cerrado, implementación pendiente** — bloqueada por
acceso SFTP. Mientras tanto trabajamos contra ficheros de muestra en
`reports/samples/`.

---

## 1. Resumen

El cliente publica desde su ERP (Microsoft Dynamics AX) **3 ficheros CSV
en SFTP**, no uno único. Cada fichero tiene su propia frecuencia y
responsabilidad, y la publicación de un producto en el catálogo "Outlet
general" es resultado del cruce de los 3.

```
SFTP del cliente
├─ /productos/listado_productos_ES.csv    (semanal, surtido completo, 79 cols)
├─ /productos/listado_productos_EN.csv    (semanal, mismo SKU set, columnas traducidas)
├─ /productos/listado_productos_IT.csv    (idem)
├─ /productos/listado_productos_DE.csv    (idem)
├─ /productos/listado_productos_FR.csv    (idem)
├─ /productos/listado_productos_PT.csv    (idem)
├─ /stock/stock_productos.csv             (cada 6h, 2 cols: SKU, INVENTARIO)
└─ /precios/precios_productos.csv         (cada 6h, 2 cols: SKU, TARIFA)
```

Política de publicación (regla de oro):

> Un producto se publica en "Outlet general" **sí y sólo sí** está en el
> fichero de surtido **AND** tiene stock > 0 en el fichero de stock
> **AND** tiene precio > 0 en el fichero de precios.
>
> Si falla alguna condición, se despublica del catalog (no se borra del
> shop) y aparece en el reporte de la ejecución.

Este criterio sustituye al actual basado en el tag `Coleccion:2026`. El
tag se conserva por compatibilidad pero deja de ser fuente de verdad.

---

## 2. Decisiones arquitectónicas

| Decisión | Resultado | Por qué |
|---|---|---|
| **Multi-idioma** | Translate & Adapt + Admin API `translationsRegister` | App oficial Shopify, gratis, soportada por Dawn. Sin Markets. |
| **Multi-divisa** | NO (Fase 1 sólo EUR) | Aparcado a Fase 2 condicionada a tracción internacional real. Ver respuesta opción A en kickoff de cambio de alcance. |
| **Idiomas cargados** | Los 6 (ES,EN,IT,DE,FR,PT) | Coste marginal cero en pipeline. Coste tuyo: 0h adicionales vs 2 idiomas. |
| **Idiomas publicados** | A confirmar con cliente (probablemente ES + EN) | Decisión de negocio, no técnica. Activar uno extra es 5 min en admin. |
| **Lectura de columnas** | Por **posición** (column_index) | Requisito explícito del cliente: los nombres de columna pueden cambiar con el tiempo aunque el orden no. |
| **Idioma fuente** | ES | Es el idioma de partida en `product.title` y `product.body_html`. Las otras 5 traducciones se cargan vía `translationsRegister`. |
| **SKUs duplicados en surtido** | first wins + log warning | El cliente ha confirmado que los duplicados son bug de su export. |
| **SKU sin stock** | despublicar + reportar | Cliente confirma "se ocultan y se informa". |
| **Frecuencia de import** | 2 cron diferentes | Surtido semanal (pesado) + stock/precios cada 6h (ligero). Reduce coste y simplifica errores. |
| **Frecuencia API tipo de cambio** | N/A en Fase 1 | Sólo EUR. Cuando se active Markets en Fase 2, ECB daily rates (gratis, oficial UE). |

Mapping completo de las 79 columnas → Shopify en
[`scripts/mapping.json`](../scripts/mapping.json).

---

## 3. Arquitectura por capas

```
┌─────────────────────────────────────────────────────────────────────┐
│                       PIPELINE COMPLETO (semanal)                   │
└─────────────────────────────────────────────────────────────────────┘

  SFTP ─────┐
            │
            ▼
       ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
       │ source  │───▶│  parser  │───▶│  mapper  │───▶│  writer  │
       └─────────┘    └──────────┘    └──────────┘    └──────────┘
            │              │               │               │
            │              │               │               ▼
            │              │               │         ┌──────────┐
            │              │               │         │ reporter │
            │              │               │         └──────────┘
            │              │               │               │
            ▼              ▼               ▼               ▼
       Lee 8 CSVs    734 records     Modelo Shopify   Admin GraphQL
       del SFTP      por idioma      (Product, Tags,  productSet
                     + 2682 stock    Metafields,      productVariantUpdate
                     + N precios     Translations)    translationsRegister
                                                      productPublish/Unpublish
                                                                │
                                                                ▼
                                                        reports/
                                                        import-YYYY-MM-DD.csv

┌─────────────────────────────────────────────────────────────────────┐
│                      PIPELINE LIGERO (cada 6h)                      │
└─────────────────────────────────────────────────────────────────────┘

  SFTP /stock/ + /precios/  ──▶  parser  ──▶  reconciler  ──▶  writer
                                                  │
                                                  ▼
                                             Sólo cambia:
                                             - inventory_levels
                                             - variants.price
                                             - product publication state
```

### 3.1 source

Adaptador único responsable de obtener los CSVs. En Fase 1 lee de
filesystem local (carpeta `samples/`); cuando se entreguen las
credenciales, se sustituye por adaptador SFTP **sin tocar el resto del
pipeline**.

Interfaz: `getFile(remotePath) → Buffer`.

### 3.2 parser

Lee cada CSV por **posición de columna**, respetando el contrato de
`mapping.json`. Devuelve registros normalizados con tipos correctos
(decimales con coma → punto, booleanos Si/No → true/false, vacíos →
null).

Errores que no detienen la ejecución sino que se loguean:

- SKU duplicado en surtido (first wins).
- Fila con menos columnas que la cabecera (skip + warning).
- Valor numérico no parseable (null + warning).

Errores que sí detienen la ejecución:

- Cabecera con número de columnas distinto al esperado (79 ± tolerancia).
- Fichero ES ausente o vacío (es el idioma fuente).
- SKU faltante en una fila.

### 3.3 mapper

Convierte los registros del parser al modelo de Shopify. Por cada SKU
genera:

- 1 `productInput` (title ES, body_html ES, vendor=LedsC4, tags…).
- N `metafieldsInput` (uno por columna con `destination=metafield`).
- M `imageInput` (Imagen web + ambientes 1-3 + detail 1-2, descartando
  URLs vacías).
- 5 `translationsInput` (EN, IT, DE, FR, PT) — uno por idioma, con
  todos los campos traducibles.

Reglas especiales del mapper:

- `Familia` → genera **también** un tag `Familia:<valor>` para que
  Shopify pueda crear smart collections automáticas por modelo si
  alguien lo pide en el futuro.
- `Incluye bombilla` → mapea texto "Si"/"No" a boolean.
- `Temperatura color` → conserva texto tal cual ("3000K", "TUNABLE
  WHITE") porque hay valores no numéricos.
- `Predeterminado` → metafield con `visible_in_storefront=false` hasta
  que el cliente confirme su semántica (ver [historia-decisiones.md
  D7](historia-decisiones.md#d7-mapping-csv-predeterminado-pendiente)).

### 3.4 writer

Aplica cambios contra Shopify Admin GraphQL en este orden:

1. **`productSet`** (mutation 2025-01) — upsert de producto + variants
   + metafields + media en una llamada. Idempotente por `handle` o
   por `sku` de la variante.
2. **`translationsRegister`** — registra traducciones EN/IT/DE/FR/PT
   para `product.title`, `product.body_html`, y los metafields
   marcados `translatable=true`.
3. **`publishablePublish`** / **`publishableUnpublish`** sobre el
   publication del catalog "Outlet general", según las reglas de §1.

Modo `--dry-run`: simula todas las llamadas, escribe el reporte, no
ejecuta mutaciones.

### 3.5 reporter

Genera 3 outputs en cada ejecución, archivados en `reports/`:

- **`import-YYYY-MM-DD-summary.txt`** — totales: nuevos, modificados,
  ocultados, errores.
- **`import-YYYY-MM-DD-changes.csv`** — detalle por SKU: estado
  anterior, estado nuevo, motivo.
- **`import-YYYY-MM-DD-hidden.csv`** — SKUs ocultos en esta ejecución
  con la causa (sin stock / sin precio / no en surtido). Este es el
  fichero que el cliente revisa.

Si hay errores duros, exit code != 0 — el cron dispara alerta a
backoffice.

---

## 4. Multi-idioma con Translate & Adapt

### 4.1 Modelo

Shopify maneja traducciones como recursos separados del producto. El
`product.title` y `product.body_html` viven en el idioma "fuente" del
shop (ES en nuestro caso). Las versiones EN/IT/DE/FR/PT se almacenan
como `Translation` registradas vía API.

### 4.2 Qué se traduce

Sólo los campos marcados `translatable=true` en `mapping.json`. En
total:

- `product.title` (cuando aplique — los CSVs no traen título de
  producto explícito; lo construimos a partir de Familia + Tipo, ver
  §5).
- `product.body_html` (← Descripción).
- 9 metafields traducibles: Tipo, Familia, Catálogo, Garantía, Etiqueta
  V/f, masterfile.tender_text, Material, Acabado, Fuente de luz, Tipo
  regulación, Accesorio.

### 4.3 Activación en storefront

La carga de traducciones es invisible al cliente final hasta que se
publica el idioma en `Settings → Store details → Languages`. Es un
toggle, no un deploy. La recomendación a documentar para el cliente
es:

- **Publicar de entrada**: ES (default), EN.
- **Cargados pero no publicados**: IT, DE, FR, PT.
- **Activación posterior** (1 toggle): cuando haya cliente B2B real en
  ese idioma.

### 4.4 SKU presente en ES pero ausente en otro idioma

El parser registra el caso. El mapper omite la traducción del campo
faltante para ese SKU/idioma — la app Translate & Adapt mostrará el
fallback al idioma fuente automáticamente. No es bloqueante.

---

## 5. Construcción del título del producto

Los CSVs **no traen un campo `title` explícito**. El nombre comercial
hay que componerlo. Propuesta de regla:

```
title = "{Familia} {Tipo} {Acabado_corto}"
```

donde `Acabado_corto` es la primera palabra de la columna Acabado (para
no inflar el título). Ejemplo:

```
Familia=Easy Square 120mm  Tipo=Empotrable de techo  Acabado=Blanco, Opal
                                  ↓
title = "Easy Square 120mm Empotrable de techo Blanco"
```

Esta regla es **tentativa** y se valida con el cliente al hacer el
primer dry-run sobre datos reales. Es trivial cambiarla — vive en el
mapper, no afecta al resto.

---

## 6. Hosting y scheduling

Decisión heredada del §9 de arquitectura.md: **Supabase edge function +
pg_cron**, mismo runtime que `promote-whitelist-matches`,
`submit-order-request`, `list-order-requests`,
`create-company-for-customer`.

Justificación: el procesamiento de 734 productos (ES) + 5 traducciones
+ stock/precios cabe en los timeouts y memoria de Deno Edge. Si en
producción aparece un cuello (probable: las imágenes), partimos en
chunks de 50 SKUs por invocación.

Cron previsto:

- `import-surtido-semanal` → domingos 03:00 UTC.
- `import-stock-precios` → cada 6h en :15 (03:15, 09:15, 15:15, 21:15
  UTC) — desfase de 15 min respecto al horario "redondo" para no
  competir con otros jobs de Shopify.

---

## 7. Pendientes antes de implementar

Bloqueantes:

- [ ] Acceso SFTP del cliente (host, user, key, paths confirmados).
- [ ] Fichero de surtido **definitivo** (el de muestra tiene 1 SKU
      duplicado que el cliente ha confirmado como bug de su export).

No bloqueantes (se pueden cerrar en paralelo):

- [ ] Cliente confirma idiomas a **publicar** en storefront.
- [ ] Cliente valida la regla de construcción del title (§5) tras
      primer dry-run.
- [ ] Cliente confirma la semántica de la columna `Predeterminado`.

---

## 8. Plan de implementación

Cuatro fases, cada una se manda a Claude Code como prompt
auto-contenido con `--dry-run` obligatorio y validación previa:

| Fase | Entregable | Bloqueante |
|---|---|---|
| **I1** | Ampliar `metafield-definitions.json` con los 30+ metafields nuevos del mapping. Aplicar con `apply-metafield-definitions.mjs`. | Ninguno — se puede ejecutar ya |
| **I2** | Implementar parser + mapper contra ficheros locales `samples/`. Sin escribir en Shopify. Genera reporter completo. | I1 |
| **I3** | Conectar writer (productSet + translationsRegister + publication). Probar con subset de 10 SKUs. | I2 + datos reales del SFTP |
| **I4** | Sustituir source local por adaptador SFTP. Configurar pg_cron Supabase. Smoke test extremo a extremo. | I3 + credenciales SFTP |

I1 e I2 se pueden empezar **ya** sin esperar al SFTP. I3 e I4 esperan
al cliente.
