# Guía de backoffice — Solicitudes de pedido B2B

_Estado a 2026-05-09 — sujeto a actualización. Para handover de cierre del proyecto._

Público: staff con rol **Backoffice Aprobaciones** o permisos equivalentes
sobre Draft Orders.

Herramientas: Shopify Admin → **Orders → Drafts**.

Ámbito: gestionar las solicitudes de pedido enviadas por clientes B2B
aprobados desde el portal `/pages/solicitud` del storefront.

---

## 1. Dónde aparecen las solicitudes

Cuando un cliente aprobado pulsa "Confirmar y enviar solicitud" desde
`/pages/solicitud`, se crea automáticamente un **Draft Order** con:

- Tags: `solicitud-b2b` + `pendiente-revision`
- Line items: los del carrito del cliente
- Note: comentario del cliente (opcional)
- Custom attributes: `fuente` (`solicitud-b2b-frontend`), `cbm_total`,
  `fecha_solicitud`.

Admin → **Orders → Drafts**. Para ver solo las solicitudes B2B:

- Filtro: **Tag** = `solicitud-b2b`
- Para ver solo las pendientes: **Tag** = `solicitud-b2b` + **Tag** =
  `pendiente-revision`.

Puedes guardar el filtro como "Saved view" para acceso rápido.

---

## 2. Revisar una solicitud

Click en la fila del draft → vista detalle. Qué revisar:

- **Customer**: cliente que envió la solicitud (debe tener tag
  `aprobado`).
- **Note** (debajo del bloque customer): comentario libre que el
  cliente pueda haber añadido.
- **Line items**: productos y cantidades solicitadas.
- **Custom attributes** (en el panel lateral "Additional details"):
  - `cbm_total`: volumen total en m³, calculado automáticamente sumando
    `cantidad × b2b.cbm_caja` de cada producto.
  - `fecha_solicitud`: timestamp ISO de cuándo se envió.
- **Subtotal**: precios orientativos (sin IVA ni portes), tal como se
  los mostramos al cliente.

---

## 3. Cambiar el estado de una solicitud

El estado se gestiona vía **tags del draft order**. El cliente ve el
estado en tiempo real en su página `/pages/mis-solicitudes`.

### Tags de estado (mutuamente excluyentes)

| Tag | Estado visible al cliente |
|---|---|
| `pendiente-revision` | ⏳ En revisión |
| `en-tramite` | 🔄 En trámite |
| `confirmada` | ✅ Confirmada |
| `cancelada` | ❌ Cancelada |

El tag `solicitud-b2b` **siempre permanece** — es el identificador de
categoría, no de estado.

### Procedimiento (2 clicks + save)

**Paso 1**: Localiza el draft en admin → Orders → Drafts → click en él.

**Paso 2**: En el panel lateral derecho busca el campo **Tags**.

**Paso 3**: Quita el tag de estado anterior y añade el nuevo:

- De "En revisión" a "En trámite":
  - Quita `pendiente-revision` (click en la × del chip).
  - Añade `en-tramite` (escribe en el input → Enter).
- De "En trámite" a "Confirmada":
  - Quita `en-tramite`.
  - Añade `confirmada`.
- De cualquier estado a "Cancelada":
  - Quita el tag de estado actual.
  - Añade `cancelada`.

**Paso 4**: **Click en Save** (botón arriba a la derecha del draft).

> Ojo: si no pulsas Save, el cambio de tag NO se persiste. Shopify UI
> a veces da la sensación de que se guardó solo porque el chip se
> actualiza en pantalla, pero hasta pulsar Save queda en borrador de
> edición.

**Paso 5**: Verifica en `/pages/mis-solicitudes` del cliente (o tú
mismo con un customer aprobado de prueba) que el badge se actualizó.

---

## 4. Convertir una solicitud en pedido real

Cuando confirmes una solicitud que se va a servir:

1. Cambia estado a `confirmada` (ver sección 3).
2. En el draft order → botón **"Send invoice"** → envía al cliente por
   email el link de pago con precio final (IVA, portes, ajustes).
3. Cliente paga → el draft se convierte en Order automáticamente.

Alternativamente, si el pago es offline (transferencia, pagaré),
marca el draft como "Paid manually" y conviértelo a Order desde el
draft directamente.

---

## 5. Notas importantes

- **El cliente NO puede editar una solicitud enviada**. Solo ver el
  estado. Si necesita cambios, debe contactar con el backoffice por
  email.
- **Precios orientativos**: los precios mostrados en la solicitud son
  los del catálogo B2B, pero **no incluyen IVA ni portes**. El
  backoffice debe añadirlos al convertir a Order (vía Discounts /
  Shipping / Taxes del draft order).
- **Tag `solicitud-b2b`**: no lo quites nunca. Es el filtro que
  permite identificar solicitudes B2B vs draft orders creados
  manualmente por staff.
- **Timeline de cambios**: Shopify guarda el historial de ediciones
  del draft en el panel "Timeline" del propio draft. No es una
  auditoría formal pero sirve para ver quién cambió qué.

---

## 6. Notificaciones automáticas

### Al crear la solicitud

Flow **W5 · Solicitud B2B creada** dispara automáticamente 2 emails:

- Al cliente: "Solicitud recibida · ref D1234" (marketing mail B2B · 07).
- Al backoffice: "Nueva solicitud B2B · {empresa} · D1234" (internal
  email con tabla de líneas, CBM, comentario, CTA a admin).

Ver `email-templates/WALKTHROUGH-W5.md` para la configuración.

### Al cambiar de estado

**Actualmente no hay notificación automática al cliente cuando el
backoffice cambia el estado**. El cliente debe consultar
`/pages/mis-solicitudes` manualmente.

Esto está identificado como **mejora post-MVP** (ver sección
"Mejoras futuras" en `docs/test-scenarios-fase-d.md`):

- Opción: Flow auxiliar que dispare email al cliente cuando se añaden
  tags `en-tramite`, `confirmada` o `cancelada`.
- Opción: edge function + servicio email (Resend/SES) llamada por
  Flow al detectar tag change.

---

## 7. Troubleshooting

### "No veo el cambio de estado reflejado en /pages/mis-solicitudes"

1. Verifica que pulsaste **Save** en el draft (sección 3 paso 4).
2. Refresca la página `/pages/mis-solicitudes` con hard refresh
   (Ctrl+F5) — el JS hace fetch al cargar; si tenías la pestaña
   abierta, la data está cacheada.
3. Si el problema persiste, consulta vía Admin API que los tags están
   correctos:
   ```bash
   node --env-file=.env.local -e "
   const t=process.env.SHOPIFY_ADMIN_TOKEN, d=process.env.SHOPIFY_STORE_DOMAIN;
   fetch(\`https://\${d}/admin/api/2025-10/graphql.json\`,{method:'POST',headers:{'X-Shopify-Access-Token':t,'Content-Type':'application/json'},body:JSON.stringify({query:\`{draftOrders(first:5,query:\"tag:solicitud-b2b\",sortKey:ID,reverse:true){edges{node{name tags}}}}\`})}).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)));
   "
   ```

### "El cliente no ha recibido email de confirmación"

- **En plan dev**: esperado. Los marketing mails quedan en draft en
  Messaging y no se envían. Al pasar a Grow funcionan.
- **En plan Grow**: comprueba Apps → Flow → W5 → Runs. Si el workflow
  falló, el log explica por qué. Causas típicas: Run code que no
  encuentra metafields, template de email sin publicar en Messaging.

### "Un cliente reporta que no puede enviar solicitud"

Flujo de debug:

1. ¿Tiene tag `aprobado`? (admin → Customers → buscar por email).
2. ¿El carrito tiene productos? (si intenta con cart vacío, el botón
   está disabled pero podría haber bug).
3. ¿El edge function responde? Test directo:
   ```bash
   curl -X POST https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/submit-order-request -H "Content-Type: application/json" -d '{}'
   ```
   Debería devolver 400 con `invalid_customerId` (indica que está
   respondiendo).
4. ¿HMAC correcto? Si el cliente tiene la pestaña abierta >10 min
   antes de enviar, el timestamp expira. Le dices que refresque.

---

## Ver también

- `docs/test-scenarios-fase-d.md` — escenarios de test + mejoras
  futuras.
- `email-templates/WALKTHROUGH-W5.md` — configuración del Flow W5.
- `docs/backoffice-aprobaciones.md` — guía de aprobación de clientes
  (Fase B).
- `docs/hardcoded-emails.md` — ubicaciones donde el email backoffice
  está hardcoded.
