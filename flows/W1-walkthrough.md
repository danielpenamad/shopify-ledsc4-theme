# W1 — Walkthrough click-a-click (estado final Fase B + PENDIENTE Fase 2 completa)

Configuración real del workflow **W1 — Registro B2B** en Shopify Flow tal como
quedó tras Fase B (2026-04-19), más el rediseño de **Fase 2 completa**
(2026-07) para el carril de instalador. Sustituye a `W1-registro.md` como
fuente de verdad del "cómo está desplegado".

> **⚠️ PENDIENTE DE APLICAR (Fase 2 instalador, 2026-07)**: todo lo marcado
> "NUEVO" en este documento **todavía no está aplicado en el Admin**. Es
> edición manual — la API pública de Flow no permite crear/editar workflows
> programáticamente (ver `flows/README.md`), así que ningún cambio de código
> de este repo lo aplica solo. Aplicar a mano siguiendo estos pasos y luego
> borrar este aviso.
>
> Este documento **reemplaza** una versión anterior de la Fase 2 (diseño
> "vaciar b2b.empresa en la rama sin-whitelist") que quedó descartada antes
> de aplicarse: el discriminador de carril **no es** el resultado de la
> whitelist, es **`sector`** (ver "Regla de enrutado" abajo). Si ya habías
> empezado a aplicar la versión vieja en el Admin, deshazla antes de seguir
> esta.

## Regla de enrutado (el corazón de la Fase 2)

**El origen del alta manda; la whitelist solo actúa dentro del carril de
distribuidor.**

| Carril de entrada | ¿Email en whitelist? | Resultado |
|---|---|---|
| Landing de instalador (`/pages/acceso-instalador`, `sector` fijo `"instalador"`) | irrelevante | **Instalador** auto-aprobado, sin Company |
| Formulario de distribuidor (`main-acceso-profesional`, `sector` nunca `"instalador"`) | Sí | **Distribuidor** aprobado + Company (proceso actual, intacto) |
| Formulario de distribuidor | No | **Pendiente → backoffice** (proceso actual, intacto) |

El discriminador de carril es **`runCode.sector == "instalador"`**. Quien
entra por la landing de instalador no trae `b2b.empresa` (la landing no la
pide) y `register-b2b-customer` fuerza ese metafield a vacío para ese
sector — por eso el carril instalador **nunca** pasa por whitelist ni por
`create-company-for-customer`. El carril de distribuidor no cambia en nada.

## Piezas clave descubiertas en Fase B

- Flow Run code es sandbox puro: **sin `async`, sin `shopify.graphql`, sin `fetch`**.
- En Flow Run code, `customer.metafields` es **array plano** sin args: `metafields { namespace key value }`. Sin alias.
- `customer.email` / `customer.phone` deprecados → `defaultEmailAddress.emailAddress` / `defaultPhoneNumber.phoneNumber`.
- Flow numera Run codes como `runCode`, `runCode1`, `runCode2`… ignorando la descripción.
- Flow Liquid para metafields de customer: **`{{ customer.<keyCamelCase>.value }}`** (camelCase, sin namespace).
- `Send internal email`: **To no admite variables**. Solo literales.
- `Send marketing mail`: en plan Development requiere que la plantilla esté publicada; si es borrador, Flow **bloquea la activación** del workflow. Por eso en Fase B están desactivados (ver [docs/grow-migration-checklist.md](../docs/grow-migration-checklist.md)). Revalidar si el store ya pasó a un plan con Shopify Email/Grow — si ya se puede enviar, activar también el nuevo email de instalador (ver Paso 8).
- **`Actualizar metacampo del cliente` con value vacío HALT-ea el workflow entero, sin rama alternativa.** Confirmado en Fase B para `volumen_estimado`/`fecha_registro` (ver Paso 3). Es la causa raíz de que "la empresa vacía corte el Flow": el backfill de `empresa` (incondicional hasta ahora) intenta escribir `""` para cualquier customer sin `b2b.empresa` — exactamente el caso de un instalador — y el workflow muere ahí, antes de llegar a ninguna condición. La Fase 2 lo arregla envolviendo ese backfill (y el de `nif`, por el mismo motivo) en un `Comprobar si` — ver Paso 3.

## Estructura final del workflow (con Fase 2 aplicada)

```
Trigger  Customer created
 └→ Run code  parseAndNormalize      (runCode)                              [SIN CAMBIOS]
    └→ Condition  runCode.sector != ""                                      [NUEVO — Paso 3.5]
       ├─ Falso → FIN (alta sin sector: no vino de ninguno de los 2 forms;
       │          no se tagea ni se toca nada — ver nota de alcance)
       └─ Verdadero
          └→ Update metafield sector, pais (incondicional)                  [SIN CAMBIOS]
             └→ Update metafield empresa, SOLO SI needs_backfill_empresa    [NUEVO guard]
                └→ Update metafield nif, SOLO SI needs_backfill_nif         [NUEVO guard]
                   └→ Add tag 'pendiente'                                   [SIN CAMBIOS]
                      └→ Condition  runCode.sector == "instalador"          [NUEVO — Paso 6]
                         ├─ Verdadero (carril instalador, NUEVO)
                         │   ├─ Remove tag 'pendiente'
                         │   ├─ Add tags 'aprobado', 'instalador'
                         │   ├─ Update metafield b2b.fecha_aprobacion
                         │   └─ [PENDIENTE GROW] Send marketing mail → bienvenida instalador
                         │   (sin email interno de FYI — decisión de cierre Fase 2, evita
                         │    ruido en captación masiva; FIN, sin whitelistCheck ni HTTP a create-company)
                         └─ Falso (carril distribuidor — SIN CAMBIOS respecto a hoy)
                             └→ Run code  whitelistCheck  (runCode1)
                                └→ Condition  runCode1.whitelisted == true
                                   ├─ Verdadero (auto-aprobación distribuidor)
                                   │   ├─ Remove tag 'pendiente'
                                   │   ├─ Add tag 'aprobado'
                                   │   ├─ Update metafield b2b.fecha_aprobacion
                                   │   ├─ Send HTTP request → Supabase create-company-for-customer
                                   │   ├─ Send internal email → backoffice (FYI + datos Company)
                                   │   └─ [PENDIENTE GROW] Send marketing mail → template 01
                                   └─ Falso (pendiente)
                                       ├─ Send internal email → backoffice (nuevo pendiente)
                                       └─ [PENDIENTE GROW] Send marketing mail → template 02
```

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**.
2. Rename a **`W1 — Registro B2B`**.

_(Si el workflow ya existe de Fase B, edítalo en el sitio — no hace falta recrearlo. Los pasos de abajo indican qué insertar/modificar respecto al estado actual.)_

## Paso 1 — Trigger: Customer created

1. Select a trigger → `Customer created`.
2. Done.

## Paso 2 — Run code `parseAndNormalize` (primer Run code) — SIN CAMBIOS

Acción **Ejecutar código**. Flow lo referenciará como `runCode`. El código,
la query GraphQL y el SDL son **exactamente los mismos que en Fase B** — la
Fase 2 no toca este Run code porque los campos que necesita (`sector`,
`needs_backfill_empresa`, `needs_backfill_nif`, `fecha_registro`) **ya
existían** en su output.

**Panel GRAPHQL** (input query):

```graphql
{
  customer {
    id
    createdAt
    defaultEmailAddress { emailAddress }
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

> `metafields` sin args devuelve lista plana. Sin alias.

**Panel JAVASCRIPT** (código):

```javascript
export default function main(input) {
  const note = input.customer.note || '';
  let parsed = {};
  try {
    parsed = note.trim().startsWith('{') ? JSON.parse(note) : {};
  } catch {
    parsed = {};
  }

  const mfList = input.customer.metafields || [];
  const mf = {};
  for (const node of mfList) {
    if (node?.namespace === 'b2b' && node?.key && node?.value) {
      mf[node.key] = node.value;
    }
  }

  const todayFromCreatedAt = input.customer.createdAt
    ? input.customer.createdAt.slice(0, 10)
    : '';

  const record = {
    empresa:          mf.empresa          || parsed.empresa          || '',
    nif:              mf.nif              || parsed.nif              || '',
    sector:           mf.sector           || parsed.sector           || '',
    pais:             mf.pais             || parsed.pais             || '',
    volumen_estimado: mf.volumen_estimado || parsed.volumen_estimado || '',
    fecha_registro:   mf.fecha_registro   || parsed.fecha_registro   || todayFromCreatedAt,
  };

  const emailRaw = input.customer.defaultEmailAddress?.emailAddress || '';

  return {
    empresa: record.empresa,
    nif: record.nif,
    sector: record.sector,
    pais: record.pais,
    volumen_estimado: record.volumen_estimado,
    fecha_registro: record.fecha_registro,
    needs_backfill_empresa:          !mf.empresa          && !!record.empresa,
    needs_backfill_nif:              !mf.nif              && !!record.nif,
    needs_backfill_sector:           !mf.sector           && !!record.sector,
    needs_backfill_pais:             !mf.pais             && !!record.pais,
    needs_backfill_volumen_estimado: !mf.volumen_estimado && !!record.volumen_estimado,
    needs_backfill_fecha_registro:   !mf.fecha_registro   && !!record.fecha_registro,
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

## Paso 3 — Condition NUEVA: `runCode.sector != ""` (Fase 2)

**Insertar justo después del Run code `parseAndNormalize`, antes de
cualquier backfill.**

- Acción: `Condición`.
- Campo: (picker) `runCode.sector`
- Operador: `No es igual a` (o `No está vacío`, si el builder lo ofrece — usar el que exista)
- Valor: `` (cadena vacía)

**Rama Falso**: no añadir ninguna acción. El workflow termina ahí — el
customer no recibe tag `pendiente` ni ningún otro cambio de W1.

> **Limitación conocida (aceptada, cerrada):** los clientes creados sin
> `b2b.sector` (altas manuales en Admin, imports, u otras apps ajenas a los
> dos formularios) ya no entran a W1 ni reciben tag de estado. Es la
> operativa aceptada de LedsC4, no un fallo a corregir.

**Rama Verdadero**: continúa con el Paso 4.

## Paso 4 — Backfill de metafields (rama Verdadero de la Condition del Paso 3)

Por cada key, `Actualizar metacampo del cliente`. **`sector` y `pais` se
mantienen incondicionales** (siempre presentes en ambos formularios, sin
riesgo de value vacío). **`empresa` y `nif` pasan a estar guardados** — es
el fix concreto de Fase 2 para que un instalador (sin `b2b.empresa`, y a
veces sin `b2b.nif`) no tumbe el workflow.

| # | Key | Guard (`Comprobar si`) | Type | Value |
|---|---|---|---|---|
| 1 | `sector` | — (incondicional) | `single_line_text_field` | `{{ runCode.sector }}` |
| 2 | `pais` | — (incondicional) | `single_line_text_field` | `{{ runCode.pais }}` |
| 3 | `empresa` | **NUEVO** — `runCode.needs_backfill_empresa == true` | `single_line_text_field` | `{{ runCode.empresa }}` |
| 4 | `nif` | **NUEVO** — `runCode.needs_backfill_nif == true` | `single_line_text_field` | `{{ runCode.nif }}` |

Cómo envolver 3 y 4: acción `Condición` con criterio
`runCode.needs_backfill_<key> == true` → dentro de la rama Verdadero, el
`Actualizar metacampo del cliente` correspondiente. Rama Falso: vacía (no
hace nada, sigue el workflow).

> Por qué esto ya no hace falta para `sector`/`pais`: ambos son
> obligatorios en los dos formularios (la landing de instalador también
> exige `pais`; `sector` va fijo por hidden input) — `runCode.sector` /
> `runCode.pais` nunca llegan vacíos para un customer que pasó la Condition
> del Paso 3. `empresa`/`nif` sí pueden llegar vacíos (instalador) incluso
> habiendo pasado esa condición — de ahí el guard.

### ❌ Ya desactivados desde Fase B (sin cambios, no reactivar)

| Key | Por qué se desactivó |
|---|---|
| `volumen_estimado` | Opcional; value vacío halt-ea el workflow (mismo mecanismo que motivó el guard de arriba). El form del storefront lo captura directo; backfill innecesario. |
| `fecha_registro` | `customer.createdAt` llega como epoch 0 en runtime de Flow. El form lo manda como hidden input. |

## Paso 5 — Add customer tag `pendiente` — SIN CAMBIOS

Acción `Agregar etiquetas al cliente`. Tag: `pendiente`. Se ejecuta dentro
de la rama Verdadero de la Condition del Paso 3 (es decir, solo si
`sector` no estaba vacío).

## Paso 6 — Condition NUEVA: `runCode.sector == "instalador"` (Fase 2)

**Insertar justo después de "Add tag pendiente", antes del Run code
`whitelistCheck`.**

- Acción: `Condición`.
- Campo: (picker) `runCode.sector`
- Operador: `Igual a`
- Valor: `instalador`

Se generan 2 ramas. **Verdadero = carril instalador (nuevo, ver abajo).
Falso = carril distribuidor (sin cambios, ver "Rama distribuidor" más
abajo — es literalmente el resto del workflow de Fase B tal cual, ahora
anidado dentro de esta rama Falso).**

---

## Rama Verdadero de Paso 6 — Carril instalador (NUEVO)

**Sin email interno de FYI a backoffice** (decisión de cierre de Fase 2):
en captación masiva, un email por cada registro de instalador genera ruido
innecesario. El email que importa operativamente es el de la oferta (Fase
3, disparado por el draft order), no un aviso por alta. Este carril queda
sin ningún email hasta que se active el de bienvenida (pendiente Grow,
paso 6.4).

### 6.1 Remove tag `pendiente`

### 6.2 Add tags `aprobado` y `instalador`

- `Agregar etiquetas al cliente`. Tags: `aprobado, instalador`.
- **Nota de disparo cruzado**: este cambio de tags también dispara **W2**
  (`Customer tags added`, condición `NOT pendiente AND aprobado`) — W2
  invocará `create-company-for-customer` igualmente. Es intencional y
  seguro: la función es idempotente y aborta sin crear Company si
  `b2b.empresa` está vacío (confirmado en código,
  `supabase/functions/create-company-for-customer/index.ts`, guard
  `if (!empresa) return jsonResponse(..., 400)`) — y `b2b.empresa` está
  vacío por diseño para todo customer con `sector == "instalador"` (el
  guard del Paso 4 nunca lo backfillea, y `register-b2b-customer` ya lo
  fuerza vacío en el create). No hace falta excluir instaladores de la
  condición de W2 ni tocar W2 en absoluto.

### 6.3 Update metafield `b2b.fecha_aprobacion`

- Type: `Fecha`
- Value: `{{ runCode.fecha_registro }}` (mismo criterio que la rama de
  auto-aprobación de distribuidor: registro y aprobación son el mismo
  momento).

### 6.4 ❌ DESACTIVADO — Send marketing mail (bienvenida instalador)

**Pendiente Grow** (mismo estado que 01/02/04/05/06 — revisar si el store
ya soporta envío antes de aplicar). Cuando se active:

- Template: `B2B · 08 · Bienvenida instalador` (crear en Shopify Messaging;
  contenido fuente en [`email-templates/08-bienvenida-instalador.liquid`](../email-templates/08-bienvenida-instalador.liquid)).
- To: auto (customer del trigger).
- **Nota "por idioma"**: ninguno de los templates 01/02/04/05/06 existentes
  está localizado hoy (todos son un único template en español, Shopify
  Messaging sin variantes por idioma) — "mismo patrón que los existentes"
  es, literalmente, mono-idioma ES. Si se quiere el email de instalador
  localizado de verdad, es una pieza nueva (no un patrón ya resuelto en
  este repo): valorar el soporte de Shopify Email para plantillas
  multi-idioma (botón "Localizar", si el plan lo permite) o mantenerlo en
  español como el resto por ahora. Decisión de Dani antes de crear el
  template.

**FIN de esta rama.** No hay `Send HTTP request` a `create-company-for-customer`
(ver 6.2 — llega igualmente vía W2, y aborta solo) ni `Run code whitelistCheck`.

---

## Rama Falso de Paso 6 — Carril distribuidor (SIN CAMBIOS respecto a Fase B)

Todo lo de aquí abajo es **exactamente igual que antes de Fase 2** — la
única diferencia es que ahora vive anidado dentro de la rama Falso de la
Condition del Paso 6, en vez de ir directo tras "Add tag pendiente".

### Run code `whitelistCheck` (segundo Run code)

Flow lo referenciará como `runCode1`.

**GRAPHQL**:

```graphql
{
  shop {
    metafields {
      namespace
      key
      value
    }
  }
  customer {
    id
    defaultEmailAddress { emailAddress }
  }
}
```

**JAVASCRIPT**:

```javascript
export default function main(input) {
  const mfList = input.shop?.metafields || [];
  let rawWhitelist = '';
  for (const node of mfList) {
    if (node?.namespace === 'b2b' && node?.key === 'whitelist_emails' && node?.value) {
      rawWhitelist = node.value;
      break;
    }
  }

  let whitelist = [];
  try {
    const parsed = rawWhitelist ? JSON.parse(rawWhitelist) : [];
    whitelist = parsed.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch {
    whitelist = [];
  }

  const email = (input.customer?.defaultEmailAddress?.emailAddress || '')
    .trim()
    .toLowerCase();

  return {
    whitelisted: whitelist.includes(email),
    whitelistSize: whitelist.length,
  };
}
```

**SDL**:

```graphql
type Output {
  whitelisted: Boolean!
  whitelistSize: Int!
}
```

### Condition: `runCode1.whitelisted == true`

Un criterio simple:

- Campo: (picker) `runCode1.whitelisted`
- Operador: `Igual a`
- Valor: `true`

Se generan 2 ramas (Verdadero / Falso).

#### Rama Verdadero — Auto-aprobación distribuidor

1. Remove tag `pendiente`
2. Add tag `aprobado`
3. Update metafield `b2b.fecha_aprobacion` — Type: `Fecha`, Value: `{{ runCode.fecha_registro }}`.
4. Send HTTP request → Supabase `create-company-for-customer`:
   - **Method**: `POST`
   - **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/create-company-for-customer`
     > Al migrar al Supabase del cliente, cambiar la URL por la nueva.
   - **Headers**: `Content-Type: application/json`, `X-Webhook-Secret: <Flow secret CREATE_COMPANY_WEBHOOK_SECRET>`
   - **Body**: `{"customerId":"{{ customer.id }}"}`
   - Crea la Company B2B + Contact + Location. Idempotente. Ver [supabase/README.md](../supabase/README.md).
5. Send internal email → backoffice (FYI):
   - **To**: `daniel.pena+backoffice@creacciones.es`
   - **Subject**: `[B2B] Auto-aprobado: {{ runCode.empresa }}`
   - **Body**: ver `email-templates/03-backoffice-nuevo-pendiente.liquid` como base, adaptado a "auto-aprobado + Company creada automáticamente".
6. ❌ DESACTIVADO — Send marketing mail (template 01, `B2B · 01 · Bienvenida (auto)`). Pendiente Grow.

#### Rama Falso — Pendiente (backoffice)

1. (el tag `pendiente` ya se puso antes, no re-añadir)
2. Send internal email → backoffice (nuevo pendiente):
   - **To**: `daniel.pena+backoffice@creacciones.es`
   - **Subject**: `[B2B] Nuevo registro pendiente — {{ runCode.empresa }}`
   - **Body**: copy-paste de `email-templates/03-backoffice-nuevo-pendiente.liquid`.
3. ❌ DESACTIVADO — Send marketing mail (template 02, `B2B · 02 · Solicitud recibida`). Pendiente Grow.

---

## Paso 7 — Guardar y activar

1. **Save**.
2. Toggle **Turn on** / Activar.

## Paso 8 — Export

1. `···` → **Export** → guardar en `flows/W1-registro.flow.json` (pendiente).

## Verificación end-to-end

**Escenario 2 validado** (2026-04-19, PRE Fase 2 — sigue vigente para el
carril distribuidor): crear customer con email no-whitelist + 4 metafields
obligatorios. Al guardar:

- Tag `pendiente` añadido.
- 4 metafields backfill (value = lo que pusiste en admin).
- Email llega a `daniel.pena+backoffice@creacciones.es` con los datos.
- No se crea Company.
- Run history: todos los steps en verde.

### Pendiente de re-validar tras aplicar Fase 2

- **Alta por `/pages/acceso-instalador`** (sector `instalador`, sin
  `empresa`, NIF vacío o relleno): el Run code `parseAndNormalize` NO
  halt-ea (guards del Paso 4 funcionando); customer queda `aprobado` +
  `instalador`, **sin** `companyContactProfiles` (confirmar en Admin →
  Customer → no aparece sección Company). Sin email (ni interno ni al
  cliente — el de bienvenida sigue pendiente Grow, y ya no hay FYI a
  backoffice por decisión de cierre de Fase 2).
- **Alta por `/pages/acceso-instalador` con un email que SÍ está en la
  whitelist de distribuidor**: debe salir **igual que el caso anterior**
  (instalador, sin Company) — la whitelist no se consulta en absoluto para
  este carril. Si sale como distribuidor, la Condition del Paso 6 está mal
  configurada (revisar que compara `runCode.sector`, no algo del
  `runCode1`).
- **Alta de distribuidor en whitelist** (formulario `acceso-profesional`):
  `aprobado` + Company. Idéntico a antes de Fase 2 — **regresión crítica si
  cambia**.
- **Alta de distribuidor NO en whitelist**: queda `pendiente`, email de
  revisión, aparece en backoffice. Idéntico a antes de Fase 2 —
  **regresión crítica si cambia**.
- **Alta manual desde Admin sin `sector`** (si aplica en las pruebas): no
  recibe tag `pendiente` de W1. Limitación conocida y aceptada (ver nota
  del Paso 3), no un fallo a investigar.
- Revisar el Run history de **W2** en el caso de alta por instalador: debe
  aparecer una invocación a `create-company-for-customer` que responde 400
  (`customer has no b2b.empresa metafield`) — comportamiento esperado, no
  es un fallo a corregir.
