# D1 · Plan Grow de Shopify

!!! info "Estado del documento"
    **Versión:** 0.1 · 15-may-2026
    **Estado:** ✅ aceptada
    **Audiencia:** Equipo de desarrollo

## Estado

Aceptada · abril 2025 (kickoff F0) · vigente. Cutover Development → Grow ejecutado el 13-may-2026.

## Contexto

El portal B2B Outlet requiere tres capacidades que el plan **Basic** de Shopify no expone:

1. **B2B nativo** — Companies, Catalogs, Price Lists per Company Location. Es el modelo de datos elegido para representar el cliente B2B (ver [D2](d02-b2b-nativo.md)).
2. **Custom staff roles** — toggles granulares por área (Customers, Companies, Settings, Orders…). Necesarios para el rol "Backoffice Aprobaciones" sin acceso a ventas, productos ni finanzas.
3. **Shopify Messaging operativo** — envío real de marketing mails desde Shopify Flow. Basic permite crear plantillas pero no enviarlas.

Sin estos tres, el modelo de negocio no se sostiene técnicamente: habría que sustituir B2B nativo con apps de pago (Wholesale Club + Customer Fields), reemplazar custom roles con permisos all-or-nothing, y mover el envío de emails a un servicio externo.

## Decisión

La tienda corre sobre **plan Grow**. El store opera en `shop.ledsc4.com` (myshopify domain de respaldo: `ledsc4-b2b-outlet.myshopify.com`). El cutover desde plan Development se ejecutó el 13-may-2026.

## Alternativas consideradas

| Plan | Por qué se descartó |
|---|---|
| **Basic** | No cubre B2B nativo. Forzaría Wholesale Club + Customer Fields (D2 lo descarta) y roles staff predefinidos sin granularidad. |
| **Plus** | Sobredimensionado. Aporta Shopify Functions, multi-store y SLA — ninguno necesario en el alcance actual. |

## Consecuencias

- **Coste mensual asumido** como parte del modelo de negocio.
- **Toda la arquitectura asume features Grow**. Bajar a Basic implicaría reescribir Fase A entera (modelo de datos).
- **Marketing mails operativos desde 13-may-2026**. Los `Send marketing mail` de Flow W1/W2/W3/W5 dejan de quedar como draft en Messaging y se envían. Cualquier referencia residual a "queda en draft en Development" en docs anteriores debe leerse como histórica.
- Lectura relacionada: [00-arquitectura](../00-arquitectura.md), [11-supabase](../11-supabase.md).

## Cambios

- **v0.1** (15-may-2026): primera publicación.
