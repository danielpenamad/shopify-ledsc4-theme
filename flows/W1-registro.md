# W1 — Registro (customer created)

## Trigger

- **Type**: `Customer created` (Shopify Flow built-in customer trigger)

## Resumen

Unifica los dos flujos de alta (auto-aprobación por whitelist vs
pendiente manual) en un solo workflow con rama condicional.

## Entradas

- `customer` — del trigger.
- `shop.metafields.b2b.whitelist_emails` — lista de emails whitelisted.
- `shop.metafields.b2b.email_backoffice` — destinatario de avisos.

## Pre-procesado (Run code action 1 — "parse_and_normalize")

Lee la `customer.note` por si los inputs `customer[metafields][b2b][...]`
fueron ignorados por Shopify, y completa los metafields faltantes.

```javascript
// Input: customer (with note, metafields, tags)
// Output: normalized record + needsMetafieldBackfill

const note = input.customer.note || '';
let parsed = {};
try {
  parsed = note.trim().startsWith('{') ? JSON.parse(note) : {};
} catch (_) { parsed = {}; }

const mf = input.customer.metafields?.b2b || {};
const record = {
  empresa: mf.empresa || parsed.empresa || '',
  nif: mf.nif || parsed.nif || '',
  sector: mf.sector || parsed.sector || '',
  pais: mf.pais || parsed.pais || '',
  volumen_estimado: mf.volumen_estimado || parsed.volumen_estimado || '',
  fecha_registro: mf.fecha_registro || new Date().toISOString().slice(0, 10),
};

const backfill = Object.entries(record).filter(
  ([k, v]) => !mf[k] && v
);

return { record, backfill, emailLower: (input.customer.email || '').trim().toLowerCase() };
```

## Acción — Backfill metafields faltantes

Para cada item en `backfill`, llamar a **Update customer metafield** con:
- namespace: `b2b`
- key: `<key>`
- value: `<value>`
- type: `single_line_text_field` (o `date` para `fecha_registro`)

Esto garantiza que los metafields queden poblados aunque Shopify haya
ignorado los inputs del form.

## Acción — Set tag inicial `pendiente`

**Add customer tags**: `pendiente` (idempotente — Flow no duplica tags).

## Acción — Set `b2b.fecha_registro` si falta

Si `record.fecha_registro` no estaba en metafields, **Update customer metafield**:
- namespace: `b2b`, key: `fecha_registro`, type: `date`, value: fecha de hoy ISO.

## Rama condicional — ¿email en whitelist?

```
IF {{shop.metafields.b2b.whitelist_emails}} contains {{emailLower}}
   (usar "Contains" action sobre la list, case-insensitive mediante
   bajada manual a lowercase en otro Run code si Flow no lo hace nativamente)
```

### Rama A — whitelist match → AUTO-APROBACIÓN

1. **Remove customer tags**: `pendiente`
2. **Add customer tags**: `aprobado`
3. **Update customer metafield** `b2b.fecha_aprobacion` (type: date) = hoy
4. **Run code — create_company**:
   ```javascript
   // Input: customer { id, metafields.b2b.empresa }
   // Usa Admin GraphQL: companyCreate, companyContactAssignRoles,
   // companyLocationCreate y catalogContextUpdate para meter la location
   // en el catálogo "Outlet general".
   // Ver flows/_helpers/create-company.js
   ```
5. **Send email** (Shopify Email) → template `01-bienvenida-auto` → to `{{customer.email}}`

### Rama B — no match → PENDIENTE

1. (el tag `pendiente` ya se puso antes, no re-añadir)
2. **Send email** → template `02-solicitud-recibida` → to `{{customer.email}}`
3. **Send email** → template `03-backoffice-nuevo-pendiente` → to `{{shop.metafields.b2b.email_backoffice}}`

## Protecciones

- Si `record.empresa` está vacío: añadir tag `datos_incompletos` y notificar al backoffice. No avanzar a auto-aprobación aunque el email esté en whitelist.
- Si `record.nif` está vacío o en Run code siguiente falla validación checksum:
  añadir tag `nif_invalido` y notificar backoffice. No auto-aprobar.

### Run code — validate_nif (opcional, recomendado)

Re-valida server-side (JS del form puede ser bypassable):

```javascript
// Retorna { valid: true|false }
const DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';
const CIF_CL = 'JABCDEFGHI';
function valid(v) {
  if (!v) return false;
  const value = String(v).toUpperCase().replace(/[\s-]/g, '');
  let m = /^([0-9]{8})([A-Z])$/.exec(value);
  if (m) return DNI[parseInt(m[1], 10) % 23] === m[2];
  m = /^([XYZ])([0-9]{7})([A-Z])$/.exec(value);
  if (m) return DNI[parseInt({X:'0',Y:'1',Z:'2'}[m[1]] + m[2], 10) % 23] === m[3];
  m = /^([ABCDEFGHJKLMNPQRSUVW])([0-9]{7})([0-9A-J])$/.exec(value);
  if (m) {
    const d = m[2];
    let se = 0, so = 0;
    for (let i = 0; i < d.length; i++) {
      const x = parseInt(d[i], 10);
      if (i % 2 === 0) { const y = x * 2; so += y > 9 ? Math.floor(y/10) + (y%10) : y; }
      else se += x;
    }
    const total = se + so;
    const control = (10 - (total % 10)) % 10;
    const p = m[3];
    return /[0-9]/.test(p) ? parseInt(p, 10) === control : CIF_CL[control] === p;
  }
  return false;
}
return { valid: valid(input.record.nif) };
```

Si `valid === false`: tag `nif_invalido` + notify backoffice + NO avanzar a auto-aprobación.

## Emails disparados

| Rama | Emails |
|---|---|
| Auto-aprobación | 1 (cliente) |
| Pendiente | 2 (cliente) + 3 (backoffice) |
| nif_invalido | 3 (backoffice) con subject modificado |
