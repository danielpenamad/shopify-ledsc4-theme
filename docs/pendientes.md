# Pendientes — LedsC4 B2B Outlet

Tracking ligero de tareas no urgentes pero que conviene no
olvidar. Cada entrada con: prioridad, alcance estimado, contexto
mínimo, referencias.

Cuando una entrada se cierre, se mueve a la sección "Cerradas"
con fecha y commit hash. Cuando "Cerradas" pase de ~20 entradas,
se archiva en `docs/pendientes-archivo.md`.

## Activas

### [P2] Desbloquear update de product.catalogo
- Causa: 58 smart collections del outlet usan el metafield como
  condición; bloquea description/access changes vía API.
- Estado actual: description con U+FFFD, access=NONE. Fila
  "Catálogo" de specs-table no renderiza en producción.
- Caminos posibles documentados en operations-runbook §7.
- Origen: detectado en cierre I1 (2026-05-05).

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

### [P4] Mejorar copy del feedback post-update-whitelist
- Causa: tras añadir emails a la whitelist, el mensaje
  "re-evaluación disparada" es jerga técnica y poco claro para
  staff no técnico.
- Solución propuesta: copy tipo "Whitelist actualizada.
  Verificando si hay solicitudes pendientes que coincidan." o
  similar. Editar en `assets/admin-backoffice.js` (mensaje
  post-success de update-whitelist).
- Estimación: 5 min.

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

## Cerradas

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
