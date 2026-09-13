# W7 — Walkthrough click-a-click (estado real, verificado contra export .flow)

Configuración real del workflow **W7 - Registro completado (alta nativa)**
en Shopify Flow, reconstruida contra el export `.flow` real del workflow
(`W7 - Registro completado (alta nativa).flow`, 2026-09-13, aportado por
Dani). Cubre el aviso interno al backoffice y el acuse "pendiente" al
cliente en el **carril de alta nativa** (`/pages/completar-registro` →
`complete-b2b-registration`), que W1 no cubre. No existe spec conceptual
previa (`W7-*.md`): este documento es la única referencia de W7 en el repo.

> **⚠️ Copia, no código real.** Este documento copia lo configurado en
> Shopify Flow en la fecha del export (2026-09-13). El workflow y sus emails
> pueden cambiarse en el Admin sin réplica en el repo: **la verdad es
> siempre el workflow vivo en Shopify**. Contrástalo con el Admin antes de
> fiarte de lo que dice aquí (ver aviso en [README.md](README.md)).

> **✅ APLICADO.** Activo en producción desde 2026-09-13 — no hay nada
> pendiente de aplicar a mano en el Admin. Si vuelves a tocar el workflow
> en el Admin, reexporta y compara contra este documento para mantenerlo
> alineado.

## Por qué existe W7

W1 tiene trigger `Customer created`. En el carril de alta nativa, **Online
Store crea el customer antes** de que `complete-b2b-registration` escriba
los metafields `b2b.*` y los tags: cuando W1 se dispara, el customer aún
no tiene `b2b.sector` y W1 termina en su Paso 3 (rama Falso, sin acciones —
ver [W1-walkthrough.md](W1-walkthrough.md)). Cuando después el cliente
completa el registro, ya no hay ningún evento `Customer created`, así que
este carril no generaba ni aviso interno ni acuse al cliente.

Para cubrirlo, `complete-b2b-registration` añade en su `tagsAdd` los tags
`pendiente` y **`registro-completado`**
([`supabase/functions/complete-b2b-registration/index.ts`](../supabase/functions/complete-b2b-registration/index.ts),
bloque 5). W7 reacciona a ese segundo tag.

> **No eliminar ni renombrar `registro-completado`** en la edge sin tocar
> también la Condition del Paso 2 de este workflow: el aviso dejaría de
> dispararse sin ningún error visible.

## Piezas clave

- **El tag es efímero.** W7 lo quita (Paso 5) justo después de enviar el
  email interno. Si el cliente reenvía el formulario (la edge lo permite
  mientras no esté `aprobado`/`rechazado`), la edge vuelve a añadir
  `registro-completado` y W7 vuelve a avisar — comportamiento buscado.
- **Trigger compartido.** `Customer tags added` también lo usan W2 y W3, y
  se dispara con cualquier tag que se añada a cualquier customer. La
  Condition del Paso 2 es la que descarta todo lo que no sea
  `registro-completado`.
- **El Run code es el mismo que el `parseAndNormalize` de W1** (input,
  script y output schema idénticos en ambos exports). Solo se usan
  `empresa`, `nif`, `sector`, `pais`, `volumen_estimado` y
  `fecha_registro` en el email; los `needs_backfill_*` y `emailLower` son
  vestigiales aquí, como en W1.
- **Sin whitelist.** W7 no hace `whitelistCheck` ni auto-aprueba: en este
  carril la auto-aprobación por whitelist la hace el cron
  `promote-whitelist-matches` (ver Notas).

## Estructura real del workflow

```
Trigger  Customer tags added
 └→ Condition  ANY customer.tags item WHERE item == "registro-completado"  [Paso 2]
    ├─ Falso → FIN (sin pasos)
    └─ Verdadero
       └→ Run code  parseAndNormalize  (runCode)                          [Paso 3]
          └→ Send internal email → Víctor + Joan Carles                   [Paso 4]
             ("[B2B] Nuevo registro pendiente - <empresa>")
             └→ Remove customer tags  registro-completado                 [Paso 5]
                └→ Condition  customer.locale empieza por "es"            [Paso 6]
                   ├─ Verdadero → Send marketing mail  acuse pendiente ES
                   └─ Falso
                      └→ Condition  customer.locale empieza por "fr"
                         ├─ Verdadero → Send marketing mail  acuse pendiente FR
                         └─ Falso     → Send marketing mail  acuse pendiente EN
```

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**.
2. Rename a **`W7 - Registro completado (alta nativa)`** (nombre real del export).

_(Si el workflow ya existe, edítalo en el sitio — no hace falta recrearlo.)_

## Paso 1 — Trigger: Customer tags added

1. Select a trigger → `Customer tags added`.
2. Done.

## Paso 2 — Condition: ¿se ha añadido `registro-completado`?

- Acción: `Condición`.
- Campo: (picker) array `customer.tags`.
- **¿Alguno?** (ANY) sobre el array: por cada `tags_item`,
  `tags_item` `Es igual a` (`==`) `registro-completado`.

**Rama Falso**: sin pasos — FIN.

**Rama Verdadero**: continúa con el Paso 3.

## Paso 3 — Run code `parseAndNormalize` (runCode)

Acción **Ejecutar código**. Flow lo referenciará como `runCode`.

**Panel GRAPHQL** (input query):

```graphql
{
  customer {
    id
    defaultEmailAddress {
      emailAddress
    }
    firstName
    lastName
    note
    tags
    metafields {
      namespace
      key
      value
    }
  }
}
```

**Panel JAVASCRIPT**:

```javascript
export default function main(input) {
  const note = input.customer.note || "";
  let parsed = {};
  try {
    parsed = note.trim().startsWith("{") ? JSON.parse(note) : {};
  } catch {
    parsed = {};
  }

  const mfList = input.customer.metafields || [];
  const mf = {};
  for (const node of mfList) {
    if (node?.namespace === "b2b" && node?.key && node?.value) {
      mf[node.key] = node.value;
    }
  }

  const record = {
    empresa: mf.empresa || parsed.empresa || "",
    nif: mf.nif || parsed.nif || "",
    sector: mf.sector || parsed.sector || "",
    pais: mf.pais || parsed.pais || "",
    volumen_estimado: mf.volumen_estimado || parsed.volumen_estimado || "",
    fecha_registro: mf.fecha_registro || new Date().toISOString().slice(0, 10),
  };

  const emailRaw = input.customer.defaultEmailAddress?.emailAddress || "";

  return {
    empresa: record.empresa,
    nif: record.nif,
    sector: record.sector,
    pais: record.pais,
    volumen_estimado: record.volumen_estimado,
    fecha_registro: record.fecha_registro,
    needs_backfill_empresa: !mf.empresa && !!record.empresa,
    needs_backfill_nif: !mf.nif && !!record.nif,
    needs_backfill_sector: !mf.sector && !!record.sector,
    needs_backfill_pais: !mf.pais && !!record.pais,
    needs_backfill_volumen_estimado:
      !mf.volumen_estimado && !!record.volumen_estimado,
    needs_backfill_fecha_registro:
      !mf.fecha_registro && !!record.fecha_registro,
    emailLower: emailRaw.trim().toLowerCase(),
  };
}
```

**Panel SDL** (output schema):

```graphql
type Output {
  empresa: String!
  nif: String!
  sector: String!
  pais: String!
  volumen_estimado: String!
  fecha_registro: String!
  needs_backfill_empresa: Boolean!
  needs_backfill_nif: Boolean!
  needs_backfill_sector: Boolean!
  needs_backfill_pais: Boolean!
  needs_backfill_volumen_estimado: Boolean!
  needs_backfill_fecha_registro: Boolean!
  emailLower: String!
}
```

## Paso 4 — Send internal email → aviso de nuevo pendiente

- **To**: `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
  > Mismos destinatarios que los emails internos de W1 — ver
  > [W1-walkthrough.md](W1-walkthrough.md), Paso 6.
- **Subject**: `[B2B] Nuevo registro pendiente - {{ runCode.empresa }}`
- **Body** (literal, del `.flow` real):
  ```
  Nuevo cliente pendiente de aprobación:

  Nombre: {{ customer.firstName }} {{ customer.lastName }}

  Email: {{ customer.defaultEmailAddress.emailAddress }}

  Teléfono: {{ customer.defaultPhoneNumber.phoneNumber }}

  Empresa: {{ runCode.empresa }}

  NIF: {{ runCode.nif }}

  Sector: {{ runCode.sector }}

  País: {{ runCode.pais }}

  Volumen: {{ runCode.volumen_estimado }}

  Registrado: {{ runCode.fecha_registro }}

  Ver en admin: https://shop.ledsc4.com/pages/admin-backoffice
  ```
  > **Línea en blanco entre campos a propósito.** El `Send internal email`
  > de Flow pierde los saltos de línea simples y junta todos los campos en
  > una sola línea; con doble salto cada campo sale en su propio párrafo.
  > Por eso el body no replica el formato con viñetas alineadas del email
  > equivalente de W1.

## Paso 5 — Remove customer tags: `registro-completado`

- **Customer**: `customer.id` (el del trigger).
- **Tags**: `registro-completado`.

Hace el tag efímero: un reenvío posterior del formulario vuelve a añadirlo
y vuelve a avisar (ver "Piezas clave"). El tag `pendiente` **no se toca**.

## Paso 6 — Send marketing mail → acuse "pendiente", ramificado por locale

Tres Conditions/acciones encadenadas sobre `customer.locale`, operador
**`Empieza por`** (`start_with?`):

| Condition | Verdadero | Falso |
|---|---|---|
| `customer.locale` empieza por `es` | Send marketing mail → `gid://shopify/MarketingActivity/207259500871` (ES) | siguiente Condition |
| `customer.locale` empieza por `fr` | Send marketing mail → `gid://shopify/MarketingActivity/207259599175` (FR) | Send marketing mail → `gid://shopify/MarketingActivity/207259631943` (EN, fallback) |

- **Customer** en las tres acciones: `customer.id`.
- Las tres Marketing Activities son **propias de W7** — no son las de W1
  (`202276077895` / `202276208967` / `202276241735`). Editar la copia de
  una no cambia la otra.
- Mismo requisito que el resto de marketing mails: solo se entregan si el
  customer está `SUBSCRIBED`. `complete-b2b-registration` fija el consent
  antes del `tagsAdd` (bloque 4.5, best-effort).

**FIN del workflow.**

---

## Paso 7 — Guardar, activar y exportar

1. **Save**.
2. Toggle **Turn on** / Activar.
3. `···` → **Export**. El export de referencia (2026-09-13) vive en
   `Downloads` de Dani, no versionado en el repo.

## Notas

### Por qué no se cambia el trigger de W1

Pasar W1 a `Customer tags added` para que cubriera también este carril no
sale a cuenta:

- W1 añade y quita tags él mismo (`pendiente`, `aprobado`, `instalador`):
  con ese trigger se re-dispararía sobre sus propios cambios.
- W2 y W3 ya viven en `Customer tags added`; cualquier tag que añadan (o
  que añada el backoffice) volvería a pasar por el enrutado de W1, con
  riesgo de duplicar emails, backfills y llamadas a
  `create-company-for-customer`.
- El carril `register-b2b-customer` funciona hoy con `Customer created` y
  está validado en producción (Fase 2). W7 cubre el hueco del carril
  nativo sin tocarlo.

### Por qué "empieza por" y no "es igual a"

Hay clientes con `customer.locale` regional (`es-ES`, `en-GB`, `en-US`).
Con `Es igual a` un `es-ES` no casaría con `es` y caería al fallback EN.
`Empieza por` captura todas las variantes regionales. Mismo criterio que
W1 (ver [docs/desarrollo/08-emails-transaccionales.md](../docs/desarrollo/08-emails-transaccionales.md) §5).

### La whitelist en este carril la cubre `promote-whitelist-matches`, no W7

W7 no consulta `b2b.whitelist_emails`. La auto-aprobación de un email en
whitelist que entra por el carril nativo la hace el cron
[`promote-whitelist-matches`](../supabase/functions/promote-whitelist-matches/index.ts)
(pg_cron cada 30 min): promueve a `aprobado` a los customers whitelisted
que no están aprobados ni rechazados y ya tienen `b2b.empresa` — que este
carril siempre deja relleno — y eso dispara W2.

Consecuencia: un cliente whitelisted de este carril recibe primero el aviso
interno y el acuse "pendiente" de W7, y como mucho ~30 min después la
aprobación vía cron + W2.

## Verificación end-to-end

- **Alta nativa que completa `/pages/completar-registro`** (sin tag
  terminal): llega el email interno "[B2B] Nuevo registro pendiente -
  <empresa>" a Víctor + Joan Carles, el cliente recibe el acuse pendiente
  en su idioma (ES/FR/EN por `customer.locale`), y queda con `pendiente`
  pero **sin** `registro-completado`.
- **Reenvío del formulario** estando aún `pendiente`: vuelve a llegar el
  aviso interno y el acuse.
- **Cualquier otro tag añadido** (`aprobado` por W2/backoffice,
  `instalador` por W1, etc.): W7 no hace nada — la Condition del Paso 2
  corta ahí.
- **Alta por `register-b2b-customer`** (landings de distribuidor /
  instalador): W7 no interviene — esa edge no añade `registro-completado`;
  el aviso lo da W1.
- **`tagsAdd` de la edge fallido del todo** (warning
  `TAG_PENDIENTE_FAILED`): no hay aviso. La reconciliación de
  `promote-whitelist-matches` repone solo `pendiente`, no
  `registro-completado`, así que el cliente vuelve a la cola del backoffice
  sin pasar por W7.
