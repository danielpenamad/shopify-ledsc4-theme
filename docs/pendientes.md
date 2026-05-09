# Pendientes — LedsC4 B2B Outlet

Tracking ligero de tareas no urgentes pero que conviene no
olvidar. Cada entrada con: prioridad, alcance estimado, contexto
mínimo, referencias.

Cuando una entrada se cierre, se mueve a la sección "Cerradas"
con fecha y commit hash. Cuando "Cerradas" pase de ~20 entradas,
se archiva en `docs/pendientes-archivo.md`.

## Activas

### [INFO] Límite de tamaño in-memory en sftp-sync
- Origen: implementación I4.1 (2026-05-07).
- Estado: la Edge Function `sftp-sync` usa `sftp.get(remotePath)` que
  devuelve el fichero en memoria (Buffer) en lugar de
  `sftp.fastGet()` que escribe a disco. Razón: `Deno.lstatSync` está
  blocklisted en Supabase Edge Runtime, lo que rompe `fastGet`.
- Implicación: si los CSVs del cliente crecen significativamente
  (>50 MB total combinado), Edge Function podría OOM. Hoy total
  ~7.4 MB, holgado.
- Acción si llega el caso: migrar a streaming chunked vía
  `sftp.get()` con stream API, escribiendo directamente a Supabase
  Storage sin buffer intermedio.
- NO actuar ahora. Solo monitor en runs reales.

### [P3] b2b.cbm_caja — definition huérfana, decidir mapping desde CSV
- Origen: diagnóstico campos vacíos SKU 05-6398-21-M1 (2026-05-07).
- Estado: la definition `b2b.cbm_caja` se creó en I1 pero ninguna
  columna del mapping la alimenta. La columna 29 "Volumen unidad
  (m3)" del CSV trae dato (`0,023` en muestra) pero está marcada
  `destination: "ignore"`.
- Misma familia que el "Hallazgo 1" del diagnóstico previo: cols
  26-48 (logística empaquetada) todas en `ignore`.
- Decisión necesaria del cliente:
  - ¿Conectamos col 29 → `b2b.cbm_caja`?
  - ¿Hay otras columnas de logística que deberían tener metafield
    destino (Peso empaquetado, etc.)?
- Cuando se cierre, requiere:
  - Cambio en `scripts/mapping.json`.
  - Re-run del importer sobre los SKUs afectados.
  - Si la decisión es "no usar", borrar la definition huérfana.
- Estimación: 30min código + decisión cliente bloqueante.

### [INFO] Dato origen incompleto — Largo/Ancho/Alto vacíos en surtido
- Origen: diagnóstico campos vacíos SKU 05-6398-21-M1 (2026-05-07).
- Estado: ~462 SKUs (63% del surtido) sin Largo en el export del
  cliente. Largo, Ancho, Alto vacíos en CSV ES/EN/FR (idénticos
  entre idiomas). No es bug nuestro, es export del cliente.
- No requiere acción de código. Es información que conviene tener
  visible para la próxima conversación con LedsC4: si quieren que
  estos campos se muestren en ficha de producto, tienen que
  completar el export.
- NO actuar desde el código. Solo informar al cliente cuando haya
  ocasión.

### [P3] Limpiar 745 productos pre-existentes con handle basado en título
- Causa: detectado en cierre I3 (2026-05-06). El shop ya contenía
  745 productos con handles tipo `bano-ip44-toilet-slim-...`
  (basados en título). El writer de I3 crea ~450 productos nuevos
  con handle = `sku.toLowerCase()` y los 745 viejos quedan huérfanos
  (mismos SKUs en algunos casos, distintos products en Shopify).
- Riesgo: confusión en admin, listados duplicados en frontend, y
  potencial colisión si los handles antiguos llegasen a re-utilizarse.
- Solución: script one-shot que lista todos los productos del shop,
  identifica los que NO están en la salida del mapper (por handle =
  sku.toLowerCase()), y los archiva o borra. Borrado solo si están
  en `status=DRAFT` o si el cliente confirma.
- Estimación: ~30 min (consulta + delete bulk vía MCP) o ~1h
  (script idempotente).
- Bloquea: cutover al cliente.

### [P4] Token Custom App sin scope `read_locations`
- Causa: detectado en I3. El writer hace fallback a "primera location
  retornada" porque el token no puede leer `Location.name` ni
  `Location.isActive`. Funciona porque el shop tiene una sola
  location, pero romperá si se añade otra.
- Solución: añadir `read_locations` al Custom App en Shopify admin
  → Configuration → Admin API integration. Re-emitir token y
  actualizar `shopify-ledsc4-theme.env`.
- Estimación: 5 min (admin click) + redeploy de scripts que usen el
  token (ninguno aún).

### [P3] Mostrar stock disponible en ficha y listados
- Cantidad exacta (decisión Dani 2026-05-05).
- Tocar snippets/card-product.liquid (listados) y
  sections/main-product.liquid (ficha).
- Esperar a que I3 esté cerrado para evitar conflicts.
- Estimación: ~1h.

### [P4] Bulk actions múltiples para aprobación
- Aprobar/rechazar N customers a la vez desde la página
  backoffice.
- Bajada a P4: el conector MCP me permite operar bulk desde
  Claude. Esperar a tener volumen real (>20 aprobaciones/semana
  por parte del staff del cliente) para decidir si construir.

### [P4] Investigar bug de customersCount(query:)
- Causa: `customersCount(query: "tag:X")` devuelve el total
  sin filtrar por tag. Verificado contra
  ledsc4-b2b-outlet.myshopify.com en API 2025-10.
- Estado: bypass aplicado en list-pending-customers usando
  `customers(first: 250, query: "tag:X")` y contando .length.
- Pendiente: reportar a Shopify (Discussions/Forum) o probar
  con otra versión de API. Impacto: solo costo extra (3
  queries paginadas en lugar de 3 counts), no funcional.

### [P3] Endurecer auth de `promote-whitelist-matches` con `X-Cron-Secret`
- Hoy la función está abierta porque pg_cron no firma; en `update-whitelist`
  la invocamos sin secret con timeout de 5s. Cualquiera con la URL
  pública puede dispararla.
- Plan: añadir env `CRON_SECRET` y header `X-Cron-Secret` en
  `update-whitelist` y en la job de pg_cron. La función rechaza si no
  coincide.
- Referencia: operations-runbook §7 (estaba ya como TODO antes de Fase BO).
- Estimación: ~30 min.

### [P4] Limpiar HardcodedRoutes en admin-backoffice-resumen
- Causa: theme check warning preexistente en
  `sections/admin-backoffice-resumen.liquid:96`.
- Solución: cambiar `/` por `{{ routes.root_url }}`.
- Estimación: 5 min.
- Sin urgencia: solo es estilo, no funcional.

### [P4] UX de la caja "Whitelist actual" en el backoffice
- Causa: con 4 emails ya queda en una sola línea horizontal poco
  legible. Con 50+ emails será inutilizable.
- Solución propuesta (sin prescribir): lista vertical simple,
  chips/tags, o tabla con columnas (email + fecha + botón
  quitar). La opción "tabla con quitar" amplía alcance porque
  habría que añadir endpoint `remove-from-whitelist` o ampliar
  `update-whitelist` con un modo "replace".
- Decisión pendiente del staff que la use. Posible iteración
  post-cutover.
- Estimación: 30 min - 2h según opción.

### [P3] Auditoría completa de Flow + Final_integration + customer zombi
- Causa: el smoke test BO descubrió múltiples vestigios e
  inconsistencias en la infra B2B existente que no son scope BO
  pero requieren pasada dedicada.
- Bloque infra (W1-W5):
  - W2 tiene rama `Send internal email` legacy que pide al admin
    crear Company a mano (cuando ya se crea automáticamente por
    otra vía).
  - W2 tiene rama `Send HTTP request → create-company-for-customer`
    en estado `Detenido` desde fecha desconocida.
  - W2 tiene nodo `Remove customer tags: pendiente` redundante
    (no-op tras flip atómico de `approve-customer`).
  - W2 y W3 tenían condición rota (`AND` en lugar de
    `AND NOT contiene pendiente`) — corregidas manualmente
    durante smoke test 2026-05-05, sin commitear cambios al repo.
- Bloque misterio Company creator — **RESUELTO 2026-05-09**:
  - Path correcto identificado: W2 → `Send HTTP request →
    create-company-for-customer`. La edge function usa el access
    token de la Custom App `Final_integration`, lo que explica la
    atribución en Events API. No hay path oculto.
  - Por qué pareció misterio: durante el smoke test 2026-05-05 la
    condición de W2 estaba rota (`contiene pendiente AND contiene
    aprobado`) — ver Bloque infra. Con el flip atómico de
    `approve-customer` esa condición nunca se cumple, así que
    asumimos que W2 no había fired y la Company venía de otro
    lado. Tras corregir la condición manualmente durante el mismo
    smoke test, W2 disparó y el path estándar produjo Company +
    fecha para `ledsc4-test2`.
  - Evidencia consistente: ledsc4-test2 (10589026910535) tiene
    Company `ddd` y `b2b.fecha_aprobacion: 2026-05-05`. Víctor,
    aprobado **antes** del fix W2, quedó sin Company ni fecha —
    consistente con W2 no firing en su caso. Ver Bloque customer
    zombi y la entrada Víctor (T3) que ahora hereda este path
    oficial.
  - Confirmación bytes-a-bytes pendiente (opcional): CLI v2.98.2
    no expone `supabase functions logs`. Si se quiere cierre con
    esa evidencia adicional, tirar logs desde Dashboard Supabase
    (Functions → create-company-for-customer → Logs).
  - Riesgo cutover original queda resuelto: la cadena
    `approve-customer` → flip tag → W2 (condición correcta) →
    `create-company-for-customer` es la oficial y funciona
    end-to-end.
- Bloque customer zombi:
  - `daniel.pena+test-pending1@creacciones.es`
    (gid://shopify/Customer/10510009467207) tiene tag `aprobado`
    pero sin Company ni `b2b.fecha_aprobacion`. Aprobado durante
    BO-7 antes del fix de W2 — quedó a medias.
  - Limpieza: o crear Company manual, o re-pendientar y
    re-aprobar.
- Estimación: 2-4h para auditoría completa + cleanup.
- Bloquea: cutover al cliente.

### [P3] Customer rechazado mantiene metafields semánticamente residuales
- Causa: tras rechazar un customer previamente aprobado, los
  metafields `b2b.fecha_aprobacion` (y potencialmente otros) se
  conservan con el valor antiguo. Lo mismo aplica a otras
  transiciones de estado.
- Detectado durante BO-8 (2026-05-05): customer 2 quedó con
  `tag rechazado + fecha_rechazo + motivo_rechazo +
  fecha_aprobacion previa intacta`.
- Decisión pendiente: ¿qué semántica queremos para
  `fecha_aprobacion`? ¿Última fecha en que estuvo aprobado, o
  fecha de aprobación actualmente vigente?
- Si optamos por "fecha vigente": en `reject-customer` limpiar
  `b2b.fecha_aprobacion` antes del flip. En `approve-customer`,
  limpiar `b2b.fecha_rechazo` y `b2b.motivo_rechazo` antes del
  flip.
- Si optamos por "histórico": dejar todo como está y documentar.
- Estimación: 30 min.

### [P4] Limpiar emails de test en whitelist antes del cutover
- Causa: durante BO-4/5/6 se añadieron 5 emails dummy a
  `b2b.whitelist_emails`: `test-bo1@example.com`,
  `test-bo2@example.com`, `test-bo3@example.com`,
  `test-bo4@example.com`, `test-bo5@example.com`.
- Solución: editar el metafield desde admin de Shopify
  (Settings → Custom data → Shop → b2b.whitelist_emails) o
  desde la propia página backoffice (cuando exista la
  funcionalidad de quitar emails — ver entrada P4 más abajo).
- Estimación: 5 min.

### [P4] Regex de validación de email en update-whitelist es laxo
- Causa: el regex actual acepta cualquier `algo@algo.algo`,
  incluyendo dominios sin TLD válido o emails con typos comunes.
- Estado actual: decisión consciente del prompt original
  ("regex razonable, no perfecto").
- Vigilancia: revisar tras el cutover si se ven entradas
  inválidas en la whitelist real.
- Endurecimiento opcional: validación contra MX records o regex
  más estricto.
- Estimación: 30 min - 2h.

## Cerradas

### [Cerrada] C.6 T5 — semántica de transiciones de estado
- Cerrada: 2026-05-09
- `approve-customer`: tras flip atómico, set `b2b.fecha_aprobacion`
  (date) + delete `b2b.fecha_rechazo` y `b2b.motivo_rechazo`. Mutation
  combinada `metafieldsSet` + `metafieldsDelete` (PR #41, merge `bbc3483`).
- `reject-customer`: análogo simétrico antes del flip (W3 lee
  metafields al disparar). Set `b2b.fecha_rechazo` + `b2b.motivo_rechazo`
  (si hay) + delete `b2b.fecha_aprobacion`.
- Builders puros exportados (`buildApprovalSemanticsInput`,
  `buildRejectionSemanticsInput`) + tests Deno en
  `tests/edge-functions/`.
- Redeploy: `approve-customer` v12, `reject-customer` v12 (ambas
  desde v11) — `2026-05-09 12:29:11/12 UTC`.
- Re-pendientar: fuera de alcance (sin UI ni edge function dedicada;
  solo se hace manualmente vía MCP).

### [Cerrada] C.6 T6 — bug tab en b2b.pais
- Cerrada: 2026-05-09
- Trim defensivo en `register-b2b-customer:409` (PR #34, merge `2c2052d`).
- Cadena legacy `/account/register` eliminada (PR #40, merge `75030be`):
  - `templates/customers/register.json`
  - `sections/main-register.liquid`
  - `snippets/b2b-register-fields.liquid`
  - `assets/b2b-register.js`
- Primer test del proyecto:
  `tests/edge-functions/register-b2b-customer.test.ts` + workflow CI
  `.github/workflows/test-edge-functions.yml`.
- Causa raíz: helper Liquid `{{ all_country_option_tags }}` producía
  whitespace en values, en path alternativo de registro que no pasaba
  por la edge function (no tenía sanitización custom).
- Contexto eliminación: shop en draft, sin clientes reales, sin
  customers legacy migrados — sin riesgo.

### [Cerrada] Desbloquear update de product.catalogo
- Cerrada: 2026-05-07
- Resumen: arreglado vía admin UI de Shopify. Aplicado: name +
  description (corrupción U+FFFD limpiada),
  `access.storefront = PUBLIC_READ`, pin activado. La fila "Catálogo"
  de specs-table ya renderiza en producción.
- **Hallazgo persistente derivado** (importante para futuras tareas
  de I3/I4): las metafield definitions usadas como condición en
  smart collections **NO son editables vía API**.
  `metafieldDefinitionUpdate` devuelve `CAPABILITY_CANNOT_BE_DISABLED`
  incluso para cambios en `name`/`description` que no afectan a la
  condición. El admin UI sí permite la edición (probablemente con un
  path interno distinto).
- **Implicación para los scripts**: ya está cubierto en
  `scripts/apply-metafield-definitions.mjs` con la clasificación
  `UpdateBlockedByDependency` — el script lo detecta a priori desde
  el flag `capabilities.smartCollectionCondition.enabled` y reporta
  sin intentar el Update. El fix vía admin UI es la única vía hoy.
- **Implicación para I3/I4**: el writer (`import-write.mjs`) NO
  toca definitions, solo metafield values + translations. Esta
  limitación no le afecta. Para I4 (cron) tampoco aplica si
  mantenemos esa separación (definitions cambian pocas veces y se
  gestionan vía `apply-metafield-definitions.mjs` con conocimiento
  manual del operador para los casos blocked).
- Origen: detectado en cierre I1 (2026-05-05).

### [Cerrada] Habilitar traducciones de metafields desde CSVs por locale
- Cerrada: 2026-05-07 (Fase I3.5)
- Hipótesis original (2026-05-06): hacía falta habilitar
  `capabilities.translatable.enabled = true` en cada definition vía
  `metafieldDefinitionUpdate`.
- Hallazgo real (2026-05-07): la capability `translatable` **no
  existe** en `MetafieldCapabilities` ni en
  `MetafieldCapability(Create|Update)Input` del schema Admin GraphQL
  2025-10 — confirmado por inspección de schema y por el ejemplo
  oficial de `translationsRegister` para metafields. Cada metafield
  es un recurso traducible directo: tiene su propio GID y su digest
  vía `translatableResource(resourceId: <metafieldGid>)`. No hay
  toggle que activar.
- Solución implementada en I3.5: extender el writer para tras
  `productSet`, hacer bulk-fetch de digests con
  `translatableResourcesByIds` y un `translationsRegister` por
  metafield con todos los locales batched. Optimización: skip
  silencioso cuando el valor del locale es vacío o igual al ES
  (Shopify ya hace fallback al primario sin registrar).
- 8 metafields traducibles activos: tipo, familia, catalogo,
  material, acabado, tipo_regulacion, fuente_luz, tender_text.
- Resultados validación end-to-end documentados en commit feat I3.5.

### [Cerrada] Mejorar copy del feedback post-update-whitelist
- Cerrada: 2026-05-06
- Resumen: jerga técnica ("re-evaluación disparada", "W4 lo
  recogerá en ≤30 min") sustituida por copy claro ("Whitelist
  actualizada. Comprobando si hay solicitudes pendientes que
  coincidan…"). Resuelto junto al cleanup cosmético previo al
  cutover.

### [Cerrada] Cap de 250 pendientes en backoffice
- Cerrada: 2026-05-05
- Origen: Fase BO (2026-05-05).
- Resumen: la entrada original lo planteaba como decisión de
  diseño ("lista plana, sin paginación"). Tras detectar el bug
  de `customersCount(query:)` y aplicar el bypass con
  `customers(first: 250, query: "tag:X")`, el cap pasa a tener
  también motivación técnica (Shopify limita la página a 250).
  El follow-up funcional pasa a la entrada activa "Investigar
  bug de customersCount(query:)".
- Referencias: `supabase/functions/list-pending-customers/index.ts`,
  `docs/backoffice-page.md §9`.

### [Cerrada] Página backoffice de whitelist + aprobaciones
- Cerrada: 2026-05-05
- Commit: 1d5aed3
- Branch: `feature/backoffice-page` (5 commits + 1 docs)
- Resumen: página `/pages/admin-backoffice` con 3 secciones
  (resumen, whitelist, pendientes); 4 edge functions
  (list-pending-customers, update-whitelist, approve-customer,
  reject-customer); customer backoffice
  `daniel.pena+backoffice@creacciones.es`; 2 metafield
  definitions nuevas (`customer.b2b.fecha_rechazo`,
  `shop.b2b.whitelist_last_update`); ADR D7.

### [Cerrada] Tratamiento de duplicados en `stock.csv` — suma de unidades
- Cerrada: 2026-05-05
- **Decisión cliente** (2026-05-05): *"En el caso que en
  stock_productos.csv aparezca duplicado, sumemos las unidades de
  stock que indique (en este caso de ejemplo seria 53+1)."*
- Implementado en `parseStock` ([scripts/import-parse.mjs](../scripts/import-parse.mjs)):
  cuando un SKU aparece N veces, las unidades se suman y el warning
  reporta la fórmula explícita (`53+1=54`) más el conteo de
  ocurrencias. Edge case defensivo: si alguna fila trae valor no
  numérico/decimal/negativo se cancela la suma, first-wins +
  warning de severidad alta.
- Caso ejemplo verificado: `AH12-12V8W1OUWT` (rows 1823+1824, valores
  53+1) → resultado `inventario=54`. Documentado en
  [`docs/import-pipeline.md` §11.1](import-pipeline.md).

### [Cerrada] Tratamiento de valores no numéricos en columnas dimensionales
- Cerrada: 2026-05-05
- **Hallazgo I2** (2026-05-05): 54 valores no parseables como número
  en columnas `dim_*_mm`, `proyeccion_mm`, `peso_neto_kg`, `vatios`,
  `lumenes`, `lumenes_reales`, `cri` afectando 52 SKUs (~7% del
  surtido). Patrones: rangos (`Min 30 - Max 415`) y diámetros (`∅78`).
- **Decisión cliente** (2026-05-05): *"Hagamos que los 52 productos
  no carguen esa dimensión concreta. Si necesitan esa información,
  ya tienen nuestra página web (ledsc4.com) y la ficha técnica."*
- Implementado en mapper ([scripts/import-map.mjs](../scripts/import-map.mjs)):
  el metafield numérico se escribe `null`, el resto del producto se
  carga normalmente, warning emitido con SKU + valor literal +
  columna afectada. Sin heurística de extracción del rango/diámetro
  (cliente prefiere preservar integridad numérica del tipo Shopify).
- Documentado en [`docs/import-pipeline.md` §11.3](import-pipeline.md).

### [Cerrada] Tratamiento de duplicados en surtido (`listado_productos_*.csv`) — first-wins
- Cerrada: 2026-05-06
- **Decisión cliente** (2026-05-06): *"Coge la primera aparición."*
- Sin cambio de código: el parser ya implementaba first-wins +
  warning como comportamiento por defecto. Solo se promociona la
  decisión de "vigente hasta confirmación" a "confirmada".
- Caso real en muestras: `05-6424-81-81` aparece 2 veces en los 6
  ficheros de idioma (mismo bug en cada locale, indicando export
  inconsistente del ERP). Resultado en el modelo Shopify: una
  sola entrada por SKU, la primera ocurrencia. Warning preservado
  como canario de calidad del export.
- Documentado en [`docs/import-pipeline.md` §11.2](import-pipeline.md).
