# Fase D · Test scenarios

Tests manuales para validar el flujo de solicitudes de pedido B2B.

**Pre-requisitos**:
- Tema staging conectado a `feature/b2b-order-request` (crear vía
  admin → Themes → Add theme → Connect from GitHub → branch
  feature/b2b-order-request).
- Secret `ORDER_REQUEST_HMAC_SECRET` seteado en Supabase env
  (valor: `0d9a1540f4a3d2418427a4cd09075accc1bdb9b25cf77c7fdd833f8475b1de47`).
- Metafield `product.b2b.cbm_caja` definido y con valor en algunos
  productos para poder verificar el cálculo de CBM total.
- Flow W5 creado y activo (ver `email-templates/WALKTHROUGH-W5.md`).
- Template `B2B · 07 · Solicitud recibida` existe en Messaging
  (draft en dev plan).
- Al menos 2 customers con estado distinto en la tienda:
  - `daniel.pena+test-d-aprobado@creacciones.es` con tag `aprobado`.
  - Un customer con tag `pendiente` o sin tags.

Ejecutar desde la URL preview del tema staging (NO del live).

---

## D1 — Flujo feliz: cliente aprobado envía solicitud

**Setup**: customer aprobado logueado.

1. Login en preview con el aprobado.
2. Navegar a `/collections/coleccion-2026` (debe cargar sin redirect).
3. Añadir 3 productos distintos al cart (cantidades variadas, al
   menos 1 producto con `b2b.cbm_caja` seteado para validar cálculo).
4. Ir a `/cart` (o abrir cart drawer).
5. **Verificar**: botón "Enviar solicitud de pedido" visible en lugar
   de "Checkout". NO aparecen Apple Pay, Google Pay ni otros dynamic
   checkout buttons.
6. Click "Enviar solicitud de pedido" → redirige a `/pages/solicitud`.
7. **Verificar**: ves el resumen del cart con productos, cantidades,
   precios unitarios, subtotales, total estimado.
8. Escribir comentario: "Este es un test D1 — si ves esto en admin
   fue correctamente transmitido".
9. Marcar el checkbox del aviso IVA/portes.
10. Click "Confirmar y enviar solicitud".
11. **Verificar**: redirige a `/pages/solicitud-enviada?ref=DXXXX`
    con mensaje de confirmación y referencia.
12. Volver a `/cart` → carrito vacío.
13. Ir a admin → Orders → Drafts:
    - Existe un draft `#DXXXX` con tag `solicitud-b2b` +
      `pendiente-revision`.
    - Customer = el test-d-aprobado.
    - Note = "Este es un test D1..."
    - Line items correctos (3 productos con cantidades).
    - Custom attributes presentes: `fuente`, `cbm_total`,
      `fecha_solicitud`.
14. Admin → Apps → Flow → W5 → Runs → **verificar** ejecución sin
    errores.
15. **Verificar email backoffice**: llega a
    `daniel.pena@creacciones.es` con subject `Nueva solicitud B2B · ...`.
    Cuerpo tiene datos cliente + tabla de líneas + CBM + comentario +
    CTA "Abrir en admin".
16. **Verificar email cliente**: en Messaging debería haberse
    disparado el `B2B · 07 · Solicitud recibida` (queda en cola draft
    en dev plan; en Grow se envía).
17. Admin → Customers → test-d-aprobado → verificar sección
    "Recent orders" no debería incluir el draft (es draft, no order).

**Acceptance**: todas las verificaciones pasan.

---

## D2 — Acceso directo a /checkout es bloqueado

**Setup**: customer aprobado logueado, con productos en cart.

1. Con cart no-vacío, escribir manualmente en el address bar
   `/checkout` (o `https://<preview>/checkout`).
2. **Verificar**: gate redirige a `/cart` antes de renderizar nada
   del flujo checkout. No llega a ver `/checkouts/...` ni nada.

**Acceptance**: imposible alcanzar el checkout nativo de Shopify.

---

## D3 — Customer pendiente NO puede acceder al flujo solicitud

**Setup**: customer con tag `pendiente` (o sin tags) logueado.

1. Login.
2. Intentar abrir directamente `/pages/solicitud`.
3. **Verificar**: gate redirige a `/pages/cuenta-en-revision`.
4. Intentar abrir `/pages/mis-solicitudes` y
   `/pages/solicitud-detalle?ref=D1000`.
5. **Verificar**: ambos redirigen a `/pages/cuenta-en-revision`.
6. Intentar hacer un POST manual al edge function
   `submit-order-request` con customerId del pendiente + una
   signature válida (se puede forjar desde browser dev tools si el
   usuario es técnico).
7. **Verificar**: endpoint devuelve `403 customer_not_approved`.

**Acceptance**: el pendiente queda cercado tanto en UI como en
backend.

---

## D4 — Historial de solicitudes funciona

**Setup**: customer aprobado que ya hizo al menos 1 solicitud en D1.

1. Ir a `/pages/mis-solicitudes`.
2. **Verificar**: tabla con columnas Fecha, Ref, Uds., Importe est.,
   Estado. La solicitud de D1 aparece con estado "En revisión".
3. Click en la fila → redirige a `/pages/solicitud-detalle?ref=DXXXX`.
4. **Verificar**: detalle muestra productos, cantidades, precios,
   CBM total, comentario ("Este es un test D1..."), estado badge.
5. En admin, editar el draft: añadir tag `en-tramite`. Refresh
   `/pages/mis-solicitudes`.
6. **Verificar**: estado cambia a "En trámite".
7. En admin editar tag: quitar `pendiente-revision`, añadir
   `confirmada`. Refresh.
8. **Verificar**: estado "Confirmada".
9. Enviar una 2a solicitud en menos de 60 min desde la primera.
10. **Verificar**: tras click en "Confirmar y enviar", aparece
    confirm() con el mensaje "Tienes una solicitud muy reciente...".
11. Cancel el confirm → no se crea nada, botón vuelve a estar
    disponible.
12. Repetir y aceptar el confirm → se crea la 2a solicitud (force:
    true se envía).

**Acceptance**: historial refleja correctamente todos los estados y
el aviso de duplicado funciona en ambas direcciones.

---

## Bugs / edge cases a reportar

Documentar aquí cualquier comportamiento raro durante el testing:

- [ ] ___
- [ ] ___
- [ ] ___

## Post-test

Si los 4 escenarios pasan:
1. Merge `feature/b2b-order-request` → `feature/b2b-storefront-gate`
   (no conflicts previstos — branch solo añade).
2. Tema live recibe automáticamente los cambios vía GitHub Connection.
3. Borrar el tema staging.
4. Marcar Fase D como done.
