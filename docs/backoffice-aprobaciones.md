# Guía de backoffice — Aprobaciones B2B

Público: staff con rol **Backoffice Aprobaciones**.
Herramientas: Shopify Admin (vista Customers).
Ámbito: revisar, aprobar o rechazar solicitudes de alta B2B.

## 1. Localizar pendientes de aprobación

Hay dos formas:

### Customer segment "Pendientes de aprobacion" (ya creado vía API)

El segmento ya existe en el store (creado vía `segmentCreate` Admin API).
ID: `gid://shopify/Segment/1137132536135`.

Query ShopifyQL: `customer_tags CONTAINS 'pendiente'`

- En **Customers**, click "View all segments" → seleccionar **Pendientes de aprobacion**.
- Ordena por "Created at" DESC si quieres los más recientes arriba.
- Sirve también como base para campañas de email si llega el caso.

### Saved view (opcional, solo UI)

Si prefieres un filtro guardado en la vista directa de Customers (sin ir
a Segments), crea una saved view con el mismo filtro:

- Customers → Filter → `Customer tags` CONTAINS `pendiente` → Save as "Pendientes de aprobación".

## 2. Revisar una solicitud

Click en el cliente. Mira:

| Campo | Dónde |
|---|---|
| Email, nombre, teléfono | Perfil principal |
| Empresa, NIF, sector, país, volumen estimado | Sección **Metafields → b2b** |
| Fecha de registro | `b2b.fecha_registro` |

Si hay algo raro (NIF vacío, datos incompletos), el cliente puede tener
también un tag `nif_invalido` o `datos_incompletos` — investiga antes
de aprobar.

## 3. Aprobar

> El workflow **W2** se dispara automáticamente al cambiar el tag. Fija la
> `fecha_aprobacion`, **crea la Company B2B automáticamente** (vía edge
> function de Supabase), la asigna al catálogo "Outlet general", y en Grow
> envía el email 4 de bienvenida al cliente.
>
> **No tienes que crear la Company a mano**. La infraestructura Supabase
> (`supabase/functions/create-company-for-customer/`) lo hace sola.

### 3.1 Cambiar el tag

**Importante**: haz **ambos cambios en el mismo guardado** (quitar `pendiente`
+ añadir `aprobado`, un solo click en Save). Si los haces en dos guardados
separados, W2 no disparará por la condición de tags.

1. En la vista del cliente, **Tags**:
   - Quita `pendiente`
   - Añade `aprobado`
2. **Save**. Eso dispara W2. En ≤30 segundos deberías ver:
   - Tag `pendiente` fuera, `aprobado` dentro.
   - `b2b.fecha_aprobacion` = hoy.
   - Sección **Companies** del customer con una Company nueva (nombre = `b2b.empresa`).
   - Company location asignada al catálogo "Outlet general".
   - Email 4 enviado (en Grow; en Development queda en draft, no llega).

Si algo falla, revisa:
- **Apps → Flow → W2 → Run history** — si el step "Send HTTP request" falla,
  la Company no se crea. El internal email al backoffice igualmente llega.
- **Supabase Dashboard → Edge Functions → create-company-for-customer → Logs**
  — detalle de errores (auth secret, GraphQL userErrors, etc.).

### 3.2 Caso de fallo — crear la Company a mano (plan de contingencia)

Solo aplica si el `Send HTTP request` de W2 falla y el backoffice necesita
desbloquear al cliente antes de debuggear. En condiciones normales no se usa.

1. Admin → **Customers → Companies → Add company**.
2. **Company name**: copia `b2b.empresa` del cliente.
3. **Primary location**: mismo nombre; país = España (ES); billing same as shipping.
4. **Assign customer to company**: el customer que acabas de aprobar.
5. Abre la Company Location → añadir catálogo **"Outlet general"**.

Tiempo: ~30s por aprobación. Si acabas haciéndolo con frecuencia, hay un bug
en Supabase o en los secrets — reportar.

## 4. Rechazar

> El workflow **W3** se dispara al añadir el tag `rechazado` y envía
> email al cliente. El `motivo_rechazo` (opcional) se incluye en el
> email **si lo rellenaste antes** de cambiar el tag.

Pasos manuales:

1. (Opcional pero recomendado) Edita metafield `b2b.motivo_rechazo`
   con el texto que verá el cliente. Ejemplos:
   - "No ha sido posible verificar la actividad profesional declarada."
   - "Los datos fiscales aportados no coinciden con el NIF."
   - "Por política interna, solo aceptamos B2B en España."
2. En **Tags**:
   - Quita `pendiente`
   - Añade `rechazado`
3. Guarda. Dispara W3 → email 5.

## 5. Lista blanca de emails (whitelist)

El shop metafield `b2b.whitelist_emails` contiene emails que se
auto-aprueban al registrarse.

Para editar:

1. Admin → **Settings → Custom data → Shop → Metafields → b2b.whitelist_emails**
2. Añade emails (uno por línea). Case-insensitive, se normalizan a minúsculas.
3. Guarda.

**Re-evaluación de pendientes existentes**: cada 30 minutos un
scheduled Flow (W4) revisa los clientes con tag `pendiente` y, si su
email ahora matchea la whitelist, los promueve a `aprobado`
automáticamente. Latencia máxima: 30 min.

Si quieres forzar la re-evaluación inmediata:
- Apps → Flow → W4-whitelist-reeval → botón "Run now".

## 6. Qué NO debe tocar el staff de backoffice

Tu rol solo tiene acceso a **Customers**, **Companies** y el shop metafield
`b2b.whitelist_emails`. Pero por si accidentalmente pudieras ver algo más:

- ❌ **Orders / Draft orders**: no hay visibilidad, no intervengas.
- ❌ **Products / Inventory**: gestionado por otro equipo.
- ❌ **Theme / Apps**: no instales ni edites nada.
- ❌ **Finances / Billing**: acceso bloqueado, no intentar.
- ❌ **Eliminar customers o companies**: si un alta es incorrecta, usa
  `rechazado` en vez de borrar — preservamos la auditoría.

## 7. Cosas que pueden ir mal

| Síntoma | Causa probable | Acción |
|---|---|---|
| Aprobé y el cliente no recibe email | W2 falló en "Create Company" | Mira `Flow → Run history`, reintenta |
| Email 4 llegó pero sin Company | Mismo que arriba | Igual |
| Dos tags de estado a la vez | Auditoría desalineada | Ejecuta `node scripts/audit-customer-state.js`, corrige manualmente |
| Cliente dice que no recibe email | Email del registro mal escrito / spam | Edita su email en el perfil y reenvía manualmente |
| Whitelist actualizada pero no aprueba | W4 aún no ha corrido | Espera hasta 30 min o "Run now" en W4 |

## 8. Capturas de pantalla (pendiente)

> TODO: añadir capturas al carpeta `docs/screenshots/backoffice/`:
> - `01-saved-view-pendientes.png`
> - `02-metafields-customer.png`
> - `03-tags-aprobado.png`
> - `04-motivo-rechazo.png`
> - `05-whitelist-edit.png`
> - `06-flow-run-history.png`
