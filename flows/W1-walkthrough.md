# W1 — Walkthrough click-a-click (estado real, verificado contra export .flow)

Configuración real del workflow **W1 — Registro B2B** en Shopify Flow,
verificada línea a línea contra el export `.flow` real del workflow
(`W1 — Registro B2B (5).flow`, 2026-07-21, aportado por Dani). Sustituye a
`W1-registro.md` como fuente de verdad del "cómo está desplegado".

> **✅ APLICADO.** La Fase 2 instalador (2026-07) está en producción — no
> hay nada pendiente de aplicar a mano en el Admin. Este documento ya no
> describe un diseño a implementar; describe el workflow **tal como corre
> hoy**, reconstruido a partir del JSON exportado (`···` → Export en el
> editor de Flow). Si vuelves a tocar el workflow en el Admin, reexporta y
> compara contra este documento para mantenerlo alineado.
>
> **Divergencias reales encontradas frente al diseño documentado
> originalmente** (corregidas en esta revisión, 2026-07-21):
> - La Condition `sector == "instalador"` vive **antes** de cualquier
>   backfill de metafields — no después, como decía el diseño original.
>   Cada rama escribe sus propios metafields por separado; no hay un
>   backfill compartido previo a la Condition (ver Paso 4/5/6).
> - No existe ningún `Comprobar si` (Condition) envolviendo el backfill de
>   `empresa`/`nif` como "guard" — la seguridad viene del enrutado (la rama
>   instalador nunca toca esos dos metafields), no de un guard explícito.
> - El Run code `parseAndNormalize` ya no lee `customer.createdAt` — usa
>   `new Date()` directo como fallback de `fecha_registro` (ver Paso 2).
> - El envío de marketing mail del carril distribuidor (bienvenida /
>   pendiente, templates 01/02) **está activo en producción**, ramificado
>   ES/FR/EN por locale — ya no es "[PENDIENTE GROW]" (ver Paso 6). El de
>   instalador (template 08) sigue sin crear/activar.
> - Los destinatarios de los emails internos a backoffice son
>   `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`, no
>   `daniel.pena+backoffice@creacciones.es` (placeholder del diseño
>   original).

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
`create-company-for-customer` directamente (sí puede llegar ahí vía W2, ver
Paso 5). El carril de distribuidor no cambia en nada.

## Piezas clave descubiertas en Fase B

- Flow Run code es sandbox puro: **sin `async`, sin `shopify.graphql`, sin `fetch`**.
- En Flow Run code, `customer.metafields` es **array plano** sin args: `metafields { namespace key value }`. Sin alias.
- `customer.email` / `customer.phone` deprecados → `defaultEmailAddress.emailAddress` / `defaultPhoneNumber.phoneNumber`.
- Flow numera Run codes como `runCode`, `runCode1`, `runCode2`… ignorando la descripción.
- Flow Liquid para metafields de customer: **`{{ customer.<keyCamelCase>.value }}`** (camelCase, sin namespace).
- `Send internal email`: **To no admite variables**. Solo literales.
- `Send marketing mail`: en plan Development requiere que la plantilla esté publicada; si es borrador, Flow **bloquea la activación** del workflow. Por eso en Fase B estaban desactivados (ver [docs/grow-migration-checklist.md](../docs/grow-migration-checklist.md)). **Ya no aplica al carril distribuidor** — el store pasó a un plan con envío habilitado y los templates 01/02 están activos y ramificados por locale (ver Paso 6). Sigue aplicando al carril instalador (template 08, ver Paso 5) hasta que se cree y active esa plantilla.
- **`Actualizar metacampo del cliente` con value vacío HALT-ea el workflow entero, sin rama alternativa.** Confirmado en Fase B para `volumen_estimado`/`fecha_registro` (ver Paso 3). Es la causa raíz de que "la empresa vacía corte el Flow": si se intentara escribir `b2b.empresa = ""` para un instalador, el workflow moriría ahí. La Fase 2 lo evita **por diseño de enrutado**, no con un guard: la Condition `sector == "instalador"` (Paso 4) se resuelve ANTES de tocar `empresa`/`nif`, así que la rama instalador nunca llega a ese backfill — no hace falta ningún `Comprobar si` envolviéndolo (ver Paso 5/6).

## Estructura real del workflow

```
Trigger  Customer created
 └→ Run code  parseAndNormalize      (runCode)
    └→ Condition  runCode.sector != ""                                      [Paso 3]
       ├─ Falso → FIN (alta sin sector: no vino de ninguno de los 2 forms;
       │          no se tagea ni se toca nada — ver nota de alcance)
       └─ Verdadero
          └→ Condition  runCode.sector == "instalador"                      [Paso 4]
             ├─ Verdadero — carril instalador                               [Paso 5]
             │   ├→ Update metafield sector    (b2b.sector = runCode.sector)
             │   ├→ Update metafield pais      (b2b.pais = runCode.pais)
             │   ├→ Update metafield fecha_aprobacion (= runCode.fecha_registro)
             │   ├→ Add tags 'aprobado', 'instalador'
             │   └→ Remove tag 'pendiente'
             │   FIN — sin email interno ni marketing mail. El tag
             │   'pendiente' ya lo puso register-b2b-customer al crear el
             │   customer (antes de que este trigger dispare); W1 solo lo
             │   quita. Bienvenida instalador (template 08) sigue sin crear.
             └─ Falso — carril distribuidor                                 [Paso 6]
                 ├→ Update metafield empresa  (b2b.empresa = runCode.empresa)
                 ├→ Update metafield nif      (b2b.nif = runCode.nif)
                 ├→ Update metafield sector   (b2b.sector = runCode.sector)
                 ├→ Update metafield pais     (b2b.pais = runCode.pais)
                 ├→ Add tag 'pendiente'
                 └→ Run code  whitelistCheck  (runCode1)
                    └→ Condition  runCode1.whitelisted == true
                       ├─ Verdadero — auto-aprobación distribuidor
                       │   ├→ Remove tag 'pendiente'
                       │   ├→ Add tag 'aprobado'
                       │   ├→ Update metafield fecha_aprobacion
                       │   ├→ Send internal email → Víctor + Joan Carles
                       │   │  ("crear Company a mano" — instrucciones manuales)
                       │   ├→ Send HTTP request → create-company-for-customer
                       │   │  (en paralelo al email — automatiza lo mismo)
                       │   └→ Send marketing mail → bienvenida, ACTIVO
                       │      (ES/FR/EN por locale, 3 Marketing Activities)
                       └─ Falso — pendiente
                           ├→ Send internal email → Víctor + Joan Carles
                           │  (nuevo registro pendiente de revisión)
                           └→ Send marketing mail → pendiente, ACTIVO
                              (ES/FR/EN por locale, 3 Marketing Activities)
```

---

## Paso 0 — Crear el workflow

1. Admin → **Apps** → **Flow** → **Create workflow**.
2. Rename a **`W1 — Registro B2B`**.

_(Si el workflow ya existe, edítalo en el sitio — no hace falta recrearlo.)_

## Paso 1 — Trigger: Customer created

1. Select a trigger → `Customer created`.
2. Done.

## Paso 2 — Run code `parseAndNormalize` (primer Run code)

Acción **Ejecutar código**. Flow lo referenciará como `runCode`.

**Panel GRAPHQL** (input query — real, sin `createdAt`):

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

> `metafields` sin args devuelve lista plana. Sin alias.

**Panel JAVASCRIPT** (código real — `fecha_registro` cae a `new Date()`
directo, ya no a `customer.createdAt`, que llegaba como epoch 0 en runtime
de Flow):

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

> Los 6 `needs_backfill_*` siguen en el output (SDL sin tocar) pero **ningún
> Condition step los usa** en la implementación real — son vestigiales de
> un diseño anterior con guards explícitos. Inofensivo dejarlos; no hace
> falta limpiarlos.

## Paso 3 — Condition: `runCode.sector != ""`

**Justo después del Run code `parseAndNormalize`.**

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

**Rama Verdadero**: continúa con el Paso 4 (Condition instalador/distribuidor).

## Paso 4 — Condition: `runCode.sector == "instalador"`

**Justo después de la Condition del Paso 3, ANTES de cualquier backfill de
metafields.** Esta es la pieza estructural clave: el enrutado
instalador/distribuidor se decide primero, y cada rama escribe sus propios
metafields por separado — no hay backfill compartido antes de esta
Condition (ver "Piezas clave" arriba sobre por qué esto evita el halt del
workflow sin necesitar un guard explícito).

- Acción: `Condición`.
- Campo: (picker) `runCode.sector`
- Operador: `Igual a`
- Valor: `instalador`

Se generan 2 ramas. **Verdadero = carril instalador (Paso 5). Falso =
carril distribuidor (Paso 6).**

---

## Paso 5 — Rama Verdadero de Paso 4 — Carril instalador

**Sin email interno de FYI a backoffice** (decisión de cierre de Fase 2):
en captación masiva, un email por cada registro de instalador genera ruido
innecesario. El email que importa operativamente es el de la oferta (Fase
3, disparado por el draft order), no un aviso por alta.

1. **Update metafield `b2b.sector`** — Type: `single_line_text_field`, Value: `{{ runCode.sector }}`.
2. **Update metafield `b2b.pais`** — Type: `single_line_text_field`, Value: `{{ runCode.pais }}`.
   > `empresa`/`nif` **no se escriben en esta rama**: un instalador no los
   > trae (`register-b2b-customer` los deja vacíos en el create) y esta
   > rama nunca los toca, así que no hay riesgo de metafield vacío que
   > halt-ee el workflow.
3. **Update metafield `b2b.fecha_aprobacion`** — Type: `Fecha`, Value: `{{ runCode.fecha_registro }}`.
4. **Add tags al cliente**: `aprobado, instalador`.
   - **Nota de disparo cruzado**: este cambio de tags también dispara **W2**
     (`Customer tags added`, condición `NOT pendiente AND aprobado`) — W2
     invocará `create-company-for-customer` igualmente. Es intencional y
     seguro: la función es idempotente y aborta sin crear Company si
     `b2b.empresa` está vacío (confirmado en código,
     `supabase/functions/create-company-for-customer/index.ts`, guard
     `if (!empresa) return jsonResponse(..., 400)`) — y `b2b.empresa` está
     vacío por diseño para todo customer con `sector == "instalador"`. No
     hace falta excluir instaladores de la condición de W2 ni tocar W2 en
     absoluto.
5. **Remove tag `pendiente`** de la lista de tags.
   > El tag `pendiente` **no lo pone este Flow** en esta rama — lo pone
   > `register-b2b-customer` en el `customerCreate`, antes de que el
   > trigger `Customer created` dispare este workflow (ver
   > [supabase/functions/register-b2b-customer/index.ts](../supabase/functions/register-b2b-customer/index.ts)).
   > Esta rama solo lo quita al auto-aprobar.

**FIN de esta rama.** No hay `Send HTTP request` a `create-company-for-customer`
(llega igualmente vía W2, y aborta solo — ver nota del paso 4 arriba) ni
`Run code whitelistCheck`, ni ningún email (ni interno ni marketing).

### ❌ Sin activar — Send marketing mail (bienvenida instalador)

- Template: `B2B · 08 · Bienvenida instalador` (crear en Shopify Messaging;
  contenido fuente en [`email-templates/08-bienvenida-instalador.liquid`](../email-templates/08-bienvenida-instalador.liquid)).
- **Todavía no hay ningún step de marketing mail en esta rama del `.flow`
  real** — a diferencia de los templates 01/02 del carril distribuidor
  (ver Paso 6), que sí están activos. Cuando se cree/publique el template
  08 en Shopify Messaging, añadir aquí el mismo patrón de 3 ramas por
  locale (ES/FR/EN) que ya usa el carril distribuidor.
- To: auto (customer del trigger).
- **Nota "por idioma"**: el `.flow` real demuestra que los templates 01/02
  SÍ se activaron con 3 variantes de Marketing Activity por locale
  (ES/FR/EN) — no son mono-idioma como asumía una versión anterior de este
  documento. Seguir ese mismo patrón para el template 08 en vez de asumir
  mono-idioma ES.

---

## Paso 6 — Rama Falso de Paso 4 — Carril distribuidor

Backfill de metafields + tag `pendiente` + whitelist check.

1. **Update metafield `b2b.empresa`** — Type: `single_line_text_field`, Value: `{{ runCode.empresa }}`.
2. **Update metafield `b2b.nif`** — Type: `single_line_text_field`, Value: `{{ runCode.nif }}`.
3. **Update metafield `b2b.sector`** — Type: `single_line_text_field`, Value: `{{ runCode.sector }}`.
4. **Update metafield `b2b.pais`** — Type: `single_line_text_field`, Value: `{{ runCode.pais }}`.
   > El `.flow` real lleva un tab literal delante del valor
   > (`"\t{{ runCode.pais }}"`), heredado de una versión anterior — ver la
   > nota de "belt-and-suspenders trim" en
   > `supabase/functions/register-b2b-customer/index.ts` sobre el mismo bug
   > histórico de whitespace en este metafield. No reproducir el tab si se
   > reconfigura este step desde cero.
5. **Add tag al cliente**: `pendiente`.

`empresa`/`nif` se escriben aquí **sin ningún guard `Comprobar si`**: por
diseño de formulario, todo customer que llega a esta rama viene de
`main-acceso-profesional`, donde `empresa` es obligatorio — nunca llega
vacío. `nif` puede venir vacío sin que eso halt-ee el workflow (solo
halt-ea escribir `""` sobre un metafield que Shopify ya considera
"actualizable"; un `nif` vacío en un alta nueva no dispara ese caso).

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

1. Remove tag `pendiente`.
2. Add tag `aprobado`.
3. Update metafield `b2b.fecha_aprobacion` — Type: `Fecha`, Value: `{{ runCode.fecha_registro }}`.
4. **Dos acciones en paralelo** desde aquí (ambas cuelgan del mismo output del paso anterior, no una detrás de otra):
   - **Send internal email** → instrucciones para crear la Company a mano:
     - **To**: `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
     - **Subject**: `[B2B] Auto-aprobado — crear Company a mano: {{ runCode.empresa }}`
     - **Body** (literal, del `.flow` real):
       ```
       Nuevo cliente B2B auto-aprobado por whitelist. Crea la Company en admin:

       Cliente (recién aprobado):
       - Nombre:    {{ customer.firstName }} {{ customer.lastName }}
       - Email:     {{ customer.defaultEmailAddress.emailAddress }}
       - Teléfono:  {{ customer.defaultPhoneNumber.phoneNumber }}
       - Ver:       https://admin.shopify.com/store/ledsc4-b2b-outlet/customers/{{ customer.id | split: '/' | last }}

       Datos para la Company:
       - Company name:        {{ runCode.empresa }}
       - NIF:                 {{ runCode.nif }}
       - Sector:              {{ runCode.sector }}
       - País:                {{ runCode.pais }}
       - Volumen estimado:    {{ runCode.volumen_estimado }}
       - Fecha de aprobación: {{ runCode.fecha_registro }}

       Pasos (30 segundos — ver docs/backoffice-aprobaciones.md §3.2):
       1. Customers → Companies → Add company
       2. Primary location = mismo nombre; país ES; billing same as shipping
       3. Assign customer as contact
       4. Abrir la Company Location → añadir catálogo "Outlet general"

       — Flow: W1 rama Then (auto-aprobación vía whitelist)
       ```
     > Este email de instrucciones manuales **convive** con el `Send HTTP
     > request` automático de abajo — no es un fallback condicional, se
     > disparan los dos siempre. Si `create-company-for-customer` ya crea
     > la Company automáticamente, este email queda como aviso/duplicado;
     > no es un bug conocido, pero vale la pena confirmar con Dani si sigue
     > siendo necesario o es vestigial de antes de que la función
     > existiera.
   - **Send HTTP request** → Supabase `create-company-for-customer`:
     - **Method**: `POST`
     - **URL**: `https://mbjvmhaglbhnxoccwyex.supabase.co/functions/v1/create-company-for-customer`
       > Al migrar al Supabase del cliente, cambiar la URL por la nueva.
     - **Headers**: `Content-Type: application/json`, `X-Webhook-Secret: {{secrets.CREATE_COMPANY_WEBHOOK_SECRET}}`
     - **Body**: `{"customerId":"{{ customer.id }}"}`
     - **On client/server error**: `retry` (ambos, confirmado en el `.flow`).
     - Crea la Company B2B + Contact + Location. Idempotente. Ver [supabase/README.md](../supabase/README.md).
5. **Send marketing mail — ACTIVO** (bienvenida, template 01), ramificado por locale del customer, 3 Marketing Activities distintas:
   - `customer.locale start_with? "es"` → Marketing Activity `gid://shopify/MarketingActivity/202276405575`
   - si no, `customer.locale start_with? "fr"` → `gid://shopify/MarketingActivity/202276471111`
   - si no (EN u otro) → `gid://shopify/MarketingActivity/202276536647`

#### Rama Falso — Pendiente (backoffice)

1. (el tag `pendiente` ya se puso en el paso 6.5 de arriba, no se re-añade)
2. **Send internal email** → aviso de nuevo pendiente:
   - **To**: `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
   - **Subject**: `[B2B] Nuevo registro pendiente — {{ runCode.empresa }}`
   - **Body** (literal, del `.flow` real):
     ```
     Nuevo cliente pendiente de aprobación:

     - Nombre:     {{ customer.firstName }} {{ customer.lastName }}
     - Email:      {{ customer.defaultEmailAddress.emailAddress }}
     - Teléfono:   {{ customer.defaultPhoneNumber.phoneNumber }}
     - Empresa:    {{ runCode.empresa }}
     - NIF:        {{ runCode.nif }}
     - Sector:     {{ runCode.sector }}
     - País:       {{ runCode.pais }}
     - Volumen:    {{ runCode.volumen_estimado }}
     - Registrado: {{ runCode.fecha_registro }}

     Ver en admin: https://shop.ledsc4.com/pages/admin-backoffice
     ```
3. **Send marketing mail — ACTIVO** (pendiente, template 02), mismo patrón de 3 ramas por locale:
   - ES → `gid://shopify/MarketingActivity/202276077895`
   - FR → `gid://shopify/MarketingActivity/202276208967`
   - EN/otro → `gid://shopify/MarketingActivity/202276241735`

---

## Paso 7 — Guardar y activar

1. **Save**.
2. Toggle **Turn on** / Activar.

## Paso 8 — Export

1. `···` → **Export** → guardar en `flows/W1-registro.flow.json` (pendiente
   de repetir con el export real aportado 2026-07-21 — hoy vive solo en
   `Downloads` de Dani, no versionado en el repo).

## Verificación end-to-end

**Confirmado en producción** (2026-07-21, contra el `.flow` real — ya no es
un escenario pendiente de re-validar):

- **Alta por `/pages/acceso-instalador`** (sector `instalador`, sin
  `empresa`, NIF vacío o relleno): customer queda `aprobado` + `instalador`,
  **sin** `companyContactProfiles` directo desde W1 (puede llegar vía W2,
  que aborta sin crear Company — ver Paso 5). Sin email (ni interno ni al
  cliente — el de bienvenida instalador sigue sin crear, template 08).
- **Alta por `/pages/acceso-instalador` con un email que SÍ está en la
  whitelist de distribuidor**: sale **igual que el caso anterior**
  (instalador, sin Company) — la whitelist no se consulta en absoluto para
  este carril, porque la Condition del Paso 4 se resuelve antes de llegar
  al `whitelistCheck`.
- **Alta de distribuidor en whitelist** (formulario `acceso-profesional`):
  `aprobado` + Company (vía HTTP automático + email de instrucciones en
  paralelo) + marketing mail de bienvenida (ES/FR/EN según locale).
- **Alta de distribuidor NO en whitelist**: queda `pendiente`, email de
  aviso a Víctor + Joan Carles, marketing mail de "pendiente" (ES/FR/EN
  según locale).
- **Alta manual desde Admin sin `sector`**: no recibe tag `pendiente` de
  W1. Limitación conocida y aceptada (ver nota del Paso 3), no un fallo a
  investigar.
- Run history de **W2** en el caso de alta por instalador: aparece una
  invocación a `create-company-for-customer` que responde 400
  (`customer has no b2b.empresa metafield`) — comportamiento esperado, no
  es un fallo a corregir.
