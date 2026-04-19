# Migración a Shopify Grow — checklist

Piezas del sistema B2B que quedaron **desactivadas en Fase B** por limitaciones del plan Development y que hay que **reactivar** al migrar a Grow.

El orden propuesto minimiza errores: primero la tienda en plan Grow, luego activar emails y últimas piezas del Flow.

---

## 1. Subir el plan de la tienda a Grow

Admin → **Settings → Plan → Change plan** → **Grow**.

Tras el cambio:
- Shopify Messaging pasa de borrador a operativo: puedes ENVIAR marketing mails.
- Los 5 templates marketing que ya tienes como borrador (`B2B · 01`…`B2B · 06`) siguen ahí.

Verifica que los templates listados en `email-templates/WALKTHROUGH.md` existen en admin → Marketing → Messaging.

---

## 2. Re-añadir los `Send marketing mail` en W1, W2, W3

En Fase B borramos 4 steps para evitar que Flow bloqueara la activación (error "correo en estado de borrador").

Para cada workflow, abrir en Apps → Flow → Edit:

### W1 — rama Falso (pendiente)

- **Dónde**: entre los steps internos tras el Check if whitelist (rama Falso). Después de `Send internal email` al backoffice.
- **Nuevo step**: **`Send marketing mail`**
- **Template**: `B2B · 02 · Solicitud recibida`
- **To**: `{{ customer.email }}` (o variable por defecto del trigger).

### W1 — rama Verdadero (auto-aprobación por whitelist)

- **Dónde**: al final de la rama Verdadero, después del `Send internal email` al backoffice.
- **Nuevo step**: **`Send marketing mail`**
- **Template**: `B2B · 01 · Bienvenida (auto)`

### W2 — rama Verdadero (aprobación manual)

- **Dónde**: al final de la rama Verdadero, después del `Send internal email` al backoffice.
- **Template**: `B2B · 04 · Cuenta aprobada (manual)`

### W3 — rama Verdadero (rechazo manual)

- **Dónde**: al final de la rama Verdadero, después del `Remove tag pendiente`.
- **Template**: `B2B · 05 · Cuenta rechazada`

Guardar y **activar** cada workflow. Si la activación sigue fallando por "correo en borrador", abre la plantilla en Shopify Messaging → **Save as active** / **Publish**.

---

## 3. Re-añadir los metafields opcionales desactivados en W1

En Fase B borramos dos `Update customer metafield` del backfill inicial de W1 porque fallaban (Shopify rechaza value vacío en `single_line_text_field`, y `customer.createdAt` llegaba como epoch 0 en runtime).

Al pasar a Grow y con el **formulario de registro del storefront** activo, ambos valores vendrán del form y no hace falta backfill. Así que:

- `volumen_estimado`: el form lo captura del usuario. **Step ya no es necesario** — no re-añadir.
- `fecha_registro`: el form lo manda como `{{ 'now' | date: '%Y-%m-%d' }}` en el hidden input. **Step ya no es necesario** — no re-añadir.

**Si por alguna razón sí quieres el backfill** (p.ej. alta por admin sin form), re-añade con wrapper `Check if` sobre `runCode.needs_backfill_<key> == true`. En todo caso, nunca ejecutar el Update con value vacío.

---

## 4. Verificar el storefront form de registro extendido

Alta pre-requisito para que los metafields `volumen_estimado` y `fecha_registro` lleguen bien sin necesidad de backfill.

- Comprueba que `templates/customers/register.json` (o el liquid del register) incluye el snippet `snippets/b2b-register-fields.liquid`.
- Asegúrate que los 5 inputs B2B + el checkbox de términos están visibles.
- Asegúrate que el hidden `customer[note]` existe (fallback JSON).
- Publica el tema en la tienda Grow (Themes → Actions → Publish).

---

## 5. Ajustar el rol staff "Backoffice Aprobaciones"

Solo aplica si ya en Fase B no estaba creado. Verificar los toggles según [docs/data-model.md §6](data-model.md#6-staff-role-backoffice-aprobaciones).

---

## 6. Supabase — migrar al proyecto del cliente (si aplica)

Ver [supabase/README.md §Setup en un proyecto nuevo](../supabase/README.md).

Resumen:
1. Crear proyecto Supabase en la cuenta del cliente.
2. `supabase link --project-ref <client-ref>`.
3. `supabase db push` (aplica migración de cron + tabla config).
4. Actualizar `private.config` con la URL del nuevo proyecto.
5. `supabase functions deploy promote-whitelist-matches`
6. `supabase functions deploy create-company-for-customer`
7. Re-setear 4 secrets: `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_API_VERSION`, `CREATE_COMPANY_WEBHOOK_SECRET`.
8. **Actualizar la URL de `Send HTTP request` en W1 rama Then y W2** al nuevo endpoint de Supabase (`https://<client-ref>.supabase.co/functions/v1/create-company-for-customer`).

---

## 7. Re-diseño visual de los 5 emails marketing

Actualmente los `.liquid` son HTML funcional pero sin identidad visual. Rediseñar con:
- Header con logo LedsC4
- Colores corporativos
- Footer con datos de contacto
- Responsive

Posiblemente vía Canva (tenemos MCP). El contenido se mantiene; solo cambia el wrapping HTML. Ver `email-templates/` para los bodies actuales.

---

## 8. Test pass completo tras activar

Ejecutar los 5 escenarios de [docs/test-scenarios.md](test-scenarios.md) de nuevo en producción para validar que todo va end-to-end con los emails marketing reales.

Entre cada escenario, ejecutar `node --env-file=.env.production scripts/audit-customer-state.js`.

---

## 9. Actualizar el rol B2B del customer approval → acceso storefront

Al entrar en Grow con B2B nativo + Locksmith:
- Configurar Locksmith para bloquear acceso al outlet a customers sin tag `aprobado`.
- Publicar la theme con el form extendido.

Fuera del alcance de Fase B — este paso lo cubre Fase C (storefront + Locksmith).

---

## Checklist rápida

- [ ] Plan subido a Grow
- [ ] `Send marketing mail` re-añadido en W1 rama Falso (template 02)
- [ ] `Send marketing mail` re-añadido en W1 rama Verdadero (template 01)
- [ ] `Send marketing mail` re-añadido en W2 (template 04)
- [ ] `Send marketing mail` re-añadido en W3 (template 05)
- [ ] Templates 01-06 de Shopify Messaging publicados (no draft)
- [ ] Storefront form de registro publicado y probado
- [ ] Rol staff "Backoffice Aprobaciones" creado y asignado
- [ ] Supabase migrado al proyecto cliente (si aplica)
- [ ] URLs de `Send HTTP request` en W1/W2 actualizadas al proyecto cliente
- [ ] Emails marketing re-diseñados con identidad visual
- [ ] 5 test scenarios verdes en producción
- [ ] `audit-customer-state.js` limpio
