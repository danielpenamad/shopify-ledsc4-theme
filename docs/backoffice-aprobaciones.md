# Guía de backoffice — Aprobaciones B2B

Público: staff con rol **Backoffice Aprobaciones**.
Herramientas: Shopify Admin (vista Customers).
Ámbito: revisar, aprobar o rechazar solicitudes de alta B2B.

## 1. Localizar pendientes de aprobación

Hay dos formas:

### Saved view "Pendientes de aprobación"

En **Customers**, crear (una sola vez) la saved view:

- Filter: `Customer tags` CONTAINS `pendiente`
- Sort: `Created at` DESC
- Save as: **Pendientes de aprobación**

Una vez guardada, aparece en la barra superior. Click ahí = lista de
pendientes con los más recientes arriba.

### Customer segment (opcional, más potente)

También puedes crear un segmento guardado con la misma query para usarlo
en emails o reports:

```
customer_tags CONTAINS 'pendiente'
```

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

> El workflow **W2** se dispara automáticamente: crea la Company B2B, la
> asigna al catálogo "Outlet general", fija la fecha de aprobación y
> envía el email de bienvenida al cliente.

Pasos manuales:

1. En la vista del cliente, **Tags**:
   - Quita `pendiente`
   - Añade `aprobado`
2. Guarda. Eso dispara W2. En ≤30 segundos deberías ver:
   - `b2b.fecha_aprobacion` poblado con hoy
   - Sección **Companies** con una Company nueva
   - Email 4 enviado (visible en **Timeline** del customer)

Si algo falla en W2, queda registrado en **Apps → Flow → Run history**.

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
