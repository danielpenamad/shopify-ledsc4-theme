# Test scenarios — Fase B (registro y aprobación)

5 escenarios manuales que cubren los criterios de aceptación. Ejecutar
en el store de desarrollo (`ledsc4-b2b-outlet.myshopify.com`) antes de
cerrar Fase B.

**Precondiciones comunes**:
- Fase A aplicada (metafields, tags canónicos, catalog "Outlet general", 745 productos)
- Workflows W1-W4 configurados en Flow y activos
- Bodies de email internal (03, 05) pegados inline en los pasos `Send internal email` de W1-W2-W3
- Templates marketing (01, 02, 04, 05, 06) creados como **borrador** en Shopify Messaging (no envían en Development)
- Edge functions de Supabase deployadas y con secrets seteados (ver [supabase/README.md](../supabase/README.md))
- **Nota dev**: los steps `Send marketing mail` de W1/W2/W3 están **desactivados** en Fase B (ver [grow-migration-checklist.md](grow-migration-checklist.md)). Los tests validan la lógica completa menos el envío real al cliente.
- `b2b.whitelist_emails` con al menos un email de pruebas
- `b2b.email_backoffice` poblado (p.ej. tu propio email con +backoffice en el subdominio)
- Rol staff "Backoffice Aprobaciones" asignado al usuario de pruebas

Entre cada escenario, ejecutar `node --env-file=.env.local scripts/audit-customer-state.js`
para verificar que no quedan invariantes rotos.

---

## Escenario 1 — Registro con email en whitelist → aprobación automática

**Setup**: añadir `test.whitelist@example.com` a `b2b.whitelist_emails`.

**Pasos**:
1. Navegar a `/account/register` en storefront.
2. Rellenar todos los campos:
   - first_name: `Test`
   - last_name: `Whitelist`
   - email: `test.whitelist@example.com`
   - password: (válida)
   - phone: `+34600000000`
   - empresa: `Test Whitelist SL`
   - nif: `B12345678` (CIF válido con checksum)
   - sector: `instalador`
   - país: `ES`
   - volumen: `5k-25k`
   - acepta términos
3. Submit.

**Resultado esperado**:
- Customer creado con tag `aprobado` (NO `pendiente`).
- Metafields `b2b.empresa`, `b2b.nif`, `b2b.sector`, `b2b.pais` poblados (backfill de W1 paso 3 — 4 campos obligatorios).
- Metafield `b2b.fecha_aprobacion` = hoy.
- Metafields `b2b.volumen_estimado` y `b2b.fecha_registro` pueden quedar vacíos en alta vía admin (ver nota dev). El form del storefront los rellena en alta real.
- **Company** creada automáticamente vía Supabase (`create-company-for-customer`): `Test Whitelist SL` con 1 CompanyContact (el customer) y 1 location asignada al catálogo "Outlet general".
- El email 1 de bienvenida en Grow (draft en Development).
- `daniel.pena+backoffice@creacciones.es` recibe email interno "FYI: auto-aprobado, Company creada".
- **Admin timeline** muestra eventos de W1.
- **Apps → Flow → W1 → Run history** todo verde.

**Qué puede fallar**:
- Customer con tag `pendiente` y no `aprobado`: la rama de whitelist match de W1 no se ejecutó. Revisar el Run code `whitelistCheck` (runCode1).
- Company no creada pero tag sí: falló el `Send HTTP request` de W1. Revisar Supabase logs de `create-company-for-customer`.
- Internal email no llega: el step falló. Revisar Run history de W1.

---

## Escenario 2 — Registro con email fuera de whitelist → pendiente

**Pasos**:
1. Registrar con email `test.manual@example.com` (no en whitelist).
2. Resto de campos válidos.

**Resultado esperado**:
- Customer con tag `pendiente`.
- Todos los metafields B2B poblados.
- `b2b.fecha_registro` = hoy; `b2b.fecha_aprobacion` = blank.
- No hay Company creada.
- El customer recibe email 2 (Solicitud recibida).
- `{{shop.metafields.b2b.email_backoffice}}` recibe email 3 (Nuevo pendiente).

---

## Escenario 3 — Staff aprueba manualmente → email + Company

**Pre**: cliente del escenario 2 existe con tag `pendiente`.

**Pasos**:
1. Login como staff con rol "Backoffice Aprobaciones".
2. Abrir el customer.
3. Tags: quitar `pendiente`, añadir `aprobado`. Guardar.

**Resultado esperado**:
- W2 se dispara (importante: ambos cambios de tag en un solo Save).
- Tag `pendiente` fuera, `aprobado` dentro.
- `b2b.fecha_aprobacion` = hoy.
- **Company creada automáticamente** vía Supabase `create-company-for-customer` con el nombre de `b2b.empresa`. Customer linkeado como contact. Location asignada al catálogo "Outlet general".
- Customer recibe email 4 (Cuenta aprobada) en Grow; en Development queda como draft.
- `daniel.pena+backoffice@creacciones.es` recibe email interno "FYI: aprobado manual, Company creada".

---

## Escenario 4 — Staff rechaza con motivo → email de rechazo con motivo incluido

**Pre**: registrar un nuevo customer `test.rechazo@example.com` (sin whitelist), queda `pendiente`.

**Pasos**:
1. Login como staff.
2. Abrir el customer.
3. **Antes de cambiar el tag**: editar metafield `b2b.motivo_rechazo` con texto
   "No ha sido posible verificar la actividad profesional declarada.". Guardar.
4. Tags: quitar `pendiente`, añadir `rechazado`. Guardar.

**Resultado esperado**:
- W3 se dispara.
- Customer recibe email 5, incluyendo el motivo en el cuerpo.
- `pendiente` removido; tag único: `rechazado`.
- No hay Company creada.

**Variante 4b** — sin motivo:
- Mismo flujo pero sin poblar `motivo_rechazo`.
- El email 5 llega sin la línea "Motivo: ..." (condicional Liquid).

---

## Escenario 5 — Añadir email a whitelist mientras hay pendiente → re-evaluación

**Pre**: cliente `test.reeval@example.com` registrado y con tag `pendiente`.
Whitelist NO lo contiene todavía.

**Pasos**:
1. Editar `b2b.whitelist_emails` → añadir `test.reeval@example.com`. Guardar.
2. Esperar hasta 30 minutos (o ir a Apps → Flow → W4 y pulsar **Run now**).

**Resultado esperado**:
- W4 detecta el match.
- Customer promovido: tag `aprobado` (W2 se dispara en cascada).
- W2 crea Company + asigna catálogo.
- Customer recibe email 6 (bienvenida post-reevaluación), NO el 4.
- Tag `aprobado_via_whitelist` (si se usa para la decisión de email) se limpia tras el envío.

---

## Checklist global Fase B

Marcar cuando todo pase:

- [ ] Escenario 1 — auto-aprobación OK
- [ ] Escenario 2 — pendiente OK (emails 2 y 3)
- [ ] Escenario 3 — aprobación manual OK
- [ ] Escenario 4 — rechazo con motivo OK
- [ ] Escenario 4b — rechazo sin motivo OK
- [ ] Escenario 5 — re-evaluación whitelist OK
- [ ] `audit-customer-state.js` corre limpio tras todos los escenarios
- [ ] Ningún customer aprobado sin Company (check explícito del script de audit)
- [ ] Todos los customers aprobados tienen `fecha_aprobacion` y catálogo asignado
