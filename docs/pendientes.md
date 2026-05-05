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

### [P3] Cap de 250 pendientes en backoffice
- `list-pending-customers` trae como máximo 250 (sortKey CREATED_AT
  reverse). Si pasan de ese número se muestra el warning
  ⚠️ "Mostrando los 250 pendientes más recientes" en la UI.
- Decisión cerrada: lista plana, sin paginación. Si esto duele se
  rediseña en otra fase (filtros por sector/fecha o paginación).
- Origen: Fase BO (2026-05-05).
- Referencias: `supabase/functions/list-pending-customers/index.ts`,
  `docs/backoffice-page.md §9`.

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

## Cerradas

(vacío)
