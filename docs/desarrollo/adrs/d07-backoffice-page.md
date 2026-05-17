# D7 · Página backoffice con Customer tag `backoffice`

!!! info "Estado del documento"
    **Versión:** 1.0 · 17-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · Fase BO (mayo 2026) · vigente. Revisión sobre uso de `customersCount(query:)`: 5-may-2026.

## Contexto

El backoffice de aprobaciones B2B necesita una interfaz para que el staff (rol "Backoffice Aprobaciones") gestione:

- Customers pendientes de aprobación (tag `b2b-pendiente`).
- Whitelist de emails / dominios pre-aprobados (tabla `public.whitelist`).
- Acciones: aprobar, rechazar, añadir a whitelist, eliminar de whitelist.

Restricciones de la solución:

- **No puede vivir en Shopify Admin nativo**. Admin permite ver y taggear customers manualmente, pero no orquesta la cascada Flow W2/W3 ni gestiona la whitelist (tabla externa en Supabase).
- **No puede ser una Custom App embedida**. Coste de desarrollo (OAuth, hosting, sesiones, App Bridge), y choca con la restricción del rol staff "Backoffice Aprobaciones" que necesita acceso restringido sin tocar Settings de la tienda.
- **No puede vivir en `admin.shopify.com`**. Las extensiones de Admin (Admin UI Extensions) están limitadas a vistas dentro de páginas existentes; no pueden alojar una UI propia para flujos completos.

## Decisión

Implementar el backoffice como **página del storefront** (`/pages/admin-backoffice`), accesible solo a Customers con tag `backoffice`. La UI vive en `sections/admin-backoffice-*.liquid` (3 archivos: dashboard, customers pendientes, whitelist) + assets JS para las interacciones.

Auth dual-layer:

1. **Gate del theme** ([D4](d04-gate-hibrido.md)): si el Customer no tiene tag `backoffice`, no llega a renderizar la página. El gate trata `/pages/admin-backoffice` como ruta protegida con condición específica (no es exempt y requiere tag distinto del flujo B2B normal).
2. **HMAC en cada request al backend**: las 4 edge functions del backoffice (`list-pending-customers`, `approve-customer`, `reject-customer`, `update-whitelist`) verifican una firma HMAC enviada desde el JS de la página. El secret vive en Supabase Vault y se inyecta en el theme vía un metafield de shop (no accesible desde el storefront público).

El Customer de backoffice se crea una vez con `scripts/create-backoffice-customer.mjs`. Es un Customer "técnico" — no representa a una persona física, sino el contenedor del tag que da acceso al panel. Las credenciales se comparten con el staff autorizado (idealmente una por persona, pero el modelo no lo fuerza).

### Revisión 5-may-2026: `customersCount(query:)`

La edge function `list-pending-customers` originalmente usaba `customersCount(query: "tag:b2b-pendiente")` para devolver el total de pendientes en el dashboard. Detectado en QA: la API GraphQL de Shopify **no respeta el filtro `query:`** en `customersCount` en la versión 2025-10 — devuelve siempre el total absoluto de customers del shop.

Solución implementada: paginar `customers(first: 250, query: "tag:b2b-pendiente")` y devolver `edges.length`. Funcional para volúmenes esperados (centenas de customers pendientes simultáneos como máximo). Si el volumen creciera a miles, habría que iterar con cursor hasta agotar resultados.

## Alternativas consideradas

**Custom App embedida en Admin.** Descartada por:
- Coste de desarrollo (OAuth, hosting de la app, App Bridge, gestión de sesiones).
- Choca con el rol staff "Backoffice Aprobaciones": las Custom Apps se instalan a nivel shop, sus permisos no se gestionan por rol staff.
- Dependencia de una pieza adicional (servidor de la app) con su propio runbook.

**Admin UI Extensions** (extensiones de Shopify Admin). Descartadas por:
- Limitadas a vistas dentro de páginas Admin existentes (customer detail, order detail, etc.). No alojan flujos completos.
- No pueden ofrecer un dashboard agregado con múltiples acciones masivas.

**Aplicación externa** (Vercel/Cloudflare con Customer Account API). Descartada por:
- Requiere implementar OAuth de Shopify desde cero o usar Customer Account API en un contexto diferente al previsto.
- Latencia añadida.
- Otra superficie de deploy y secrets.

## Consecuencias

- **El backoffice convive con el storefront público**. Cualquier cambio del theme que rompa el gate del backoffice o las sections del panel se nota en producción. Documentado en [06-backoffice](../06-backoffice.md).
- **El Customer técnico es un punto único de credenciales**. Si se compromete, el atacante tiene acceso al panel. Mitigación: las edge functions verifican HMAC además del tag, así que el solo hecho de tener la sesión no basta. El secret HMAC se rota independientemente del Customer.
- **`customersCount(query:)` bug propagado**: cualquier futura edge function que necesite contar customers filtrados debe usar paginación (`customers(first:250, query:)` + `.length`), no `customersCount(query:)`. Documentar en [06-backoffice](../06-backoffice.md) §gotchas.
- **El rol staff "Backoffice Aprobaciones" en Shopify Admin NO se usa para este panel** — el panel custom lo reemplaza. El rol existe en Admin como fallback manual (ver customers via Admin → Customers), pero la operativa real pasa por `/pages/admin-backoffice`. Documentado en [administracion/00-vision-general](../../administracion/00-vision-general.md).
- **Sin auditoría centralizada**: las acciones del panel (aprobar, rechazar, modificar whitelist) se registran en logs de las edge functions (Supabase Dashboard) y en el activity log del Customer (Shopify Admin). No hay un audit log unificado. Deuda conocida — pendiente de evaluación si el volumen lo justifica.

## Cambios

- **v1.0** (17-may-2026): cabecera de estado actualizada; el documento estaba completo pero figuraba como v0.1.
- **v0.1** (15-may-2026): primera publicación.
