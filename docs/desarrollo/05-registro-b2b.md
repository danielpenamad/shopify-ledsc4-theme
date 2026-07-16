# 05 · Registro B2B

!!! info "Estado del documento"
    **Versión:** 0.2 · 16-may-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## Para qué sirve este doc

Describe el flujo end-to-end de alta B2B, desde que un anónimo aterriza en la landing hasta que existe un Customer con tag `pendiente` y el invite email enviado. Cubre:

- La landing pública `/pages/acceso-profesional` con el form de registro.
- La página `/pages/registro-recibido` de confirmación post-submit.
- La edge function `register-b2b-customer` (creación del Customer + invite).
- El hook con Shopify Flow W1 (whitelist check + decisión auto vs manual).
- Validación NIF/NIE/CIF con dígito de control completo.

No cubre:

- Aprobación / rechazo del Customer pendiente → [06-backoffice](06-backoffice.md).
- Emails marketing posteriores → [08-emails-transaccionales](08-emails-transaccionales.md).
- Cómo el gate decide qué ve un anónimo → [04-storefront-gate](04-storefront-gate.md).

Decisión arquitectónica: [D5](adrs/d05-customer-accounts.md) (new customer accounts rompió el form clásico).

## 1. Resumen ejecutivo

Shopify forzó `new customer accounts` en febrero de 2026 ([D5](adrs/d05-customer-accounts.md)) — el form de registro classic dejó de funcionar para casos B2B (campos custom imposibles de inyectar en el OAuth hosteado). Solución:

1. **Landing pública** `/pages/acceso-profesional` con form B2B custom (no usa `/account/register` classic).
2. **Submit** llama a la edge `register-b2b-customer` (no a Shopify directamente).
3. La edge **crea el Customer** vía Admin API con todos los metafields `b2b.*`, le añade tag `pendiente`, y dispara el invite email.
4. **Shopify Flow W1** detecta el Customer creado y decide: si su email matchea la whitelist → auto-aprueba; si no → queda pendiente para el backoffice.
5. El usuario ve `/pages/registro-recibido` con instrucción "revisa tu email para activar la cuenta".
6. El magic link del invite (`/account/activate/<token>`) le permite establecer password y entrar.

El registro **no genera login automático** — siempre pasa por el magic link, por dos razones: (a) verifica que el email es legítimo antes de dejar pasar; (b) Shopify exige flujo OAuth para activación, no se puede saltar.

## 2. Mapa de archivos

| Pieza | Path | Notas |
|---|---|---|
| Landing + form | `sections/main-acceso-profesional.liquid` | 1199 líneas. Hero + 5 bloques informativos + form. |
| Pantalla post-submit | `sections/main-registro-recibido.liquid` | "Revisa tu email" + instrucciones. |
| Templates | `templates/page.acceso-profesional.json`, `page.registro-recibido.json` | — |
| Handler JS del form | `assets/b2b-register-v2.js` | ~360 líneas. Reemplaza al `b2b-register.js` classic eliminado en cleanup C.6 T6 (9-may-2026). |
| Edge function | `supabase/functions/register-b2b-customer/index.ts` | — |
| Setup de pages | `scripts/create-b2b-pages.mjs` + `scripts/pages-manifest.json` | Idempotente. Crea las page entries en Shopify. |
| Email cliente (auto-aprobado) | `email-templates/01-bienvenida-auto.liquid` | Marketing mail Shopify, disparado por W1 rama whitelist. |
| Email cliente (pendiente) | `email-templates/02-solicitud-recibida.liquid` | Marketing mail Shopify, rama no-whitelist. |
| Email backoffice | `email-templates/03-backoffice-nuevo-pendiente.liquid` | Internal email Flow. |
| Locales | `locales/<idioma>.json` | Namespace `ledsc4.acceso.*` y `ledsc4.common.*`. Inyectados a JS vía `window.LEDSC4_I18N.acceso_form`. |

### Diagrama del flujo

```
+---------------+    landing pública     +-----------------------------+
| Anónimo en /  +---->/pages/acceso------|/pages/acceso-profesional    |
+---------------+    -profesional        | hero + 5 bloques + form     |
                                          +-------------+----------------+
                                                        |
                                                        | submit form
                                                        | POST { timestamp, nonce, signature,
                                                        |        nombre, apellidos, email, ... }
                                                        v
                                          +-------------+----------------+
                                          | register-b2b-customer        |
                                          | - Verifica HMAC + TTL 5min   |
                                          | - Valida NIF/NIE/CIF         |
                                          | - Sanea inputs               |
                                          | - customerCreate (metafields |
                                          |   + emailMarketingConsent)   |
                                          | - tagsAdd ['pendiente']      |
                                          | - sendAccountInviteEmail     |
                                          +-------------+----------------+
                                                        |
                                                        | éxito
                                                        v
       +------------------------------+    +------------+----------------+
       | Shopify Flow W1              |◄───| /pages/registro-recibido    |
       | trigger: Customer created    |    | "Revisa tu email..."        |
       | - Backfill metafields        |    +-----------------------------+
       | - Run code whitelistCheck    |
       +-----+------------------+-----+
             |                  |
       whitelist             no whitelist
             |                  |
             v                  v
   +-------------------+   +-------------------+
   | Auto-aprobado     |   | Pendiente         |
   | - tag aprobado    |   | - tag pendiente   |
   | - fecha_aprobacion|   |   se mantiene     |
   | - HTTP a          |   | - Internal email  |
   |   create-company  |   |   backoffice (03) |
   | - Internal email  |   | - Marketing mail  |
   |   backoffice      |   |   #02 cliente     |
   | - Marketing mail  |   +-------------------+
   |   #01 cliente     |
   +-------------------+
```

## 3. Página `/pages/acceso-profesional`

### Acceso

- **URL**: `/pages/acceso-profesional`.
- **Gate**: exempt en `theme.liquid` ([04-storefront-gate](04-storefront-gate.md) §paths exempt). Pública, no requiere auth.
- **Destino del gate para anónimos en cualquier URL no exempt**: esta página.

### Estructura

Section `main-acceso-profesional.liquid` (1199 líneas). Bloques:

1. **Hero** con título + descripción + 2 CTAs.
2. **5 bloques informativos** (qué es, quién, cómo funciona dos rutas fast/std, qué hay dentro, FAQ).
3. **Form de registro** `#b2b-registro-form`.

**Strings**: todas vienen de `locales/<idioma>.json` namespace `ledsc4.acceso.*` y `ledsc4.common.*`. Inyectados al JS vía `window.LEDSC4_I18N.acceso_form` antes del IIFE de `b2b-register-v2.js`.

**BEM**: `b2b-acceso__*` (no choca con `b2b-portal__*` ni `b2b-aprobado-home__*`).

### CTAs del hero

| CTA | Destino |
|---|---|
| "Solicitar acceso" | scroll a `#registro` (sección del form). |
| "Iniciar sesión" | `/customer_authentication/login?return_to=<encoded>&locale=<iso>`. |

### Form `#b2b-registro-form`

| Campo | Tipo | Validación |
|---|---|---|
| `nombre` | text | Requerido. |
| `apellidos` | text | Requerido. |
| `email` | email | Requerido. Regex pragmática client-side + server-side. |
| `telefono` | text | Opcional. Max 30 chars. |
| `empresa` | text | Requerido. Max 200 chars. |
| `nif` | text | Requerido. Regex DNI/NIE/CIF con **dígito de control completo** client-side; reforzado server-side. |
| `sector` | select | Requerido. Enum estricto (6 valores fijos — ver §6). |
| `pais` | select | Requerido. ISO 3166-1 alpha-2 o nombre en español/inglés (mapeo server-side). |
| `codigo_postal` | text | Requerido (Fase 2, 2026-07). Max 12 chars. Sin validación de formato por país. |
| `volumen_estimado` | select | Opcional. Slug de rango. |
| `condiciones` | checkbox | Requerido. Aceptación de términos. Es además la base legal del opt-in de marketing — ver §5. |

> **Landing de instalador** (`/pages/acceso-instalador`, Fase 2): mismo form,
> mismo endpoint, con 3 diferencias — `empresa` no existe en el form, `nif`
> es opcional, hidden `sector="instalador"` en vez de `"otro"`. Ver §11.

**Hidden inputs (HMAC)**:

- `timestamp` (`'now' | date: '%s'` Liquid).
- `nonce` (`crypto.randomUUID()` generado en JS al cargar la página).
- `signature` (`hmac_sha256` Liquid filter sobre `<timestamp>:<nonce>` con `settings.register_b2b_hmac_secret`).

**Submit**: `assets/b2b-register-v2.js` hace `fetch POST` a `settings.register_b2b_endpoint`. En éxito redirige a `/pages/registro-recibido`. En error muestra `fieldErrors` por campo o un mensaje global.

## 4. Página `/pages/registro-recibido`

Section `main-registro-recibido.liquid`. Pantalla simple con:

- Confirmación "Tu solicitud ha sido recibida".
- Instrucción "Revisa tu email para activar la cuenta".
- Aviso de que el email puede tardar unos minutos.

Gate-exempt ([04-storefront-gate](04-storefront-gate.md)). Accesible directa (post-submit) y por URL directa.

## 5. Contrato de `register-b2b-customer`

| Atributo | Valor |
|---|---|
| Path | `POST https://<project-ref>.supabase.co/functions/v1/register-b2b-customer` |
| Auth | HMAC-SHA256 sobre `<timestamp>:<nonce>` con `REGISTER_B2B_HMAC_SECRET`. **TTL 5 minutos** (300s — más corto que las otras edges porque el alta no necesita ventana larga). |
| Constant-time compare | Sí. |
| Métodos | POST + OPTIONS. |
| CORS | `Access-Control-Allow-Origin: <STOREFRONT_ORIGIN>` (default `*`, ver gotchas). |

### Input

```json
{
  "timestamp": 1747300000,
  "nonce": "<8-128 hex chars>",
  "signature": "<64 hex>",
  "nombre": "Juan",
  "apellidos": "Pérez García",
  "email": "juan@empresa.com",
  "telefono": "+34600000000",
  "empresa": "Instalaciones Luz SL",
  "nif": "B12345678",
  "sector": "instalador",
  "pais": "ES",
  "volumen_estimado": "5k-25k",
  "condiciones": true
}
```

### Output

**Éxito** (200):

```json
{
  "ok": true,
  "customerId": "gid://shopify/Customer/...",
  "inviteSent": true,
  "tagsAdded": true
}
```

**Éxito con warnings** (200, el Customer fue creado pero algo secundario falló):

```json
{
  "ok": true,
  "customerId": "gid://shopify/Customer/...",
  "inviteSent": false,
  "tagsAdded": true,
  "warning": "INVITE_EMAIL_FAILED"
}
```

Posibles warnings (combinables, separados por coma):

- `INVITE_EMAIL_FAILED` — el `customerSendAccountInviteEmail` falló. El Customer existe pero el usuario no recibió email. Resoluble desde Admin → Customers → Send account invite.
- `TAG_PENDIENTE_FAILED` — el `tagsAdd` falló tras el create. Crítico: sin tag `pendiente`, Flow W1 no dispara → backoffice debe taguear a mano.

### Errores

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `INVALID_PAYLOAD` | `timestamp` / `nonce` / `signature` mal formados o ausentes. |
| 400 | `VALIDATION_ERROR` | Validación de campos falló. Devuelve `fieldErrors: { campo: "mensaje", ... }`. |
| 401 | `INVALID_SIGNATURE` | HMAC no coincide. |
| 401 | `SIGNATURE_EXPIRED` | timestamp fuera de la ventana de 300s. UI debe refrescar la página. |
| 405 | `METHOD_NOT_ALLOWED` | Método distinto de POST/OPTIONS. |
| 409 | `EMAIL_ALREADY_EXISTS` | Customer con ese email ya existe. UI sugiere "iniciar sesión". |
| 502 | `SHOPIFY_UNAVAILABLE` | Shopify devolvió HTTP error o `userErrors` no mapeables. |

### Lógica interna (orden exacto)

1. **HMAC envelope**: valida formato de `timestamp` / `nonce` / `signature` → TTL → HMAC compare.
2. **Field validation**: sanea cada campo (`sanitizeText` con max length por campo, strip HTML, control chars), valida obligatorios, valida NIF/NIE/CIF, valida enums (`sector`, `volumen_estimado`), normaliza `pais` a ISO alpha-2.
3. **`customerCreate`** (mutation Admin API): con `email`, `firstName`, `lastName`, `phone?`, `emailMarketingConsent` (opt-in a marketing — ver más abajo) y `metafields` (los 5-6 `b2b.*` según campos rellenados + `fecha_registro: today`).
4. **`tagsAdd`** (mutation separada, ver gotcha): añade `pendiente` al Customer recién creado.
5. **`customerSendAccountInviteEmail`** (mutation separada, best-effort): dispara el invite. Si falla, devuelve warning pero no error.

#### Opt-in de marketing en el `customerCreate`

El `customerCreate` incluye `emailMarketingConsent` para suscribir al cliente a marketing en el momento del alta:

```typescript
emailMarketingConsent: {
  marketingState: "SUBSCRIBED",
  marketingOptInLevel: "CONFIRMED_OPT_IN",
  consentUpdatedAt: new Date().toISOString(),
},
```

**Por qué es necesario**: los 5 emails al cliente del flujo B2B (W1-acuse, W1-bienvenida, W2-aprobacion, W3-rechazo, W5-acuse) se envían con la acción `Send marketing email` de Shopify Flow. Esa acción **solo entrega a clientes con opt-in a marketing** — sin opt-in, Flow descarta el envío en silencio, sin error en el run history. Si el `customerCreate` no suscribiera al cliente, ninguno de esos 5 emails llegaría.

**Base legal del consentimiento**: el checkbox `condiciones` del formulario es obligatorio y se valida en la edge (rechaza el registro con `VALIDATION_ERROR` si `condiciones !== true`). Esa aceptación obligatoria constituye el opt-in bajo el régimen LOPDGDD/RGPD aplicable — no se usa un checkbox de marketing separado. Cualquier cambio que vuelva opcional el checkbox `condiciones` invalida esta base legal y debe revisarse con negocio + legal antes de mergear.

Detalle completo del sistema de emails y de la suscripción a marketing en [08-emails-transaccionales](08-emails-transaccionales.md) §7.

### Validación NIF/NIE/CIF

Port del registro classic, eliminado en cleanup C.6 T6 (9-may-2026) — el algoritmo se mantiene server-side en `register-b2b-customer/index.ts`. Cobertura:

| Tipo | Regex | Validación dígito de control |
|---|---|---|
| DNI | `^[0-9]{8}[A-Z]$` | `DNI_LETTERS[num % 23] === letter`. Tabla `TRWAGMYFPDXBNJZSQVHLCKE`. |
| NIE | `^[XYZ][0-9]{7}[A-Z]$` | Como DNI pero con prefijo numérico (`X→0`, `Y→1`, `Z→2`). |
| CIF | `^[ABCDEFGHJKLMNPQRSUVW][0-9]{7}[0-9A-J]$` | Suma de dígitos pares e impares (con doblado en impares) → módulo 10 → letra o dígito según tipo de organización. Tabla `JABCDEFGHI`. |

Normalización antes de validar: `toUpperCase()` + strip de espacios y guiones.

Devuelve `{ ok, normalized? }`. El valor `normalized` (sin espacios/guiones, en mayúsculas) es lo que se persiste en `b2b.nif`.

## 6. Enums permitidos

### `sector`

Lista cerrada en la edge (`SECTOR_ENUM`):

- `instalador`
- `arquitecto_interiorismo`
- `retail_tienda`
- `distribuidor`
- `empresa_final`
- `otro`

Cualquier valor fuera de esta lista → `VALIDATION_ERROR` con `fieldErrors.sector`.

### `volumen_estimado`

Opcional. Si se envía, debe ser uno de (`VOLUMEN_ENUM`):

- `<5k`
- `5k-25k`
- `25k-100k`
- `>100k`
- `no_se`

(El valor vacío `""` también está permitido — se trata como "no rellenado").

### `pais`

ISO 3166-1 alpha-2 (`ES`, `FR`, `PT`, `IT`, `DE`, ...). La edge acepta también nombres en español/inglés y los mapea:

| Input | Normaliza a |
|---|---|
| `SPAIN`, `ESPAÑA`, `ESPANA` | `ES` |
| `FRANCE`, `FRANCIA` | `FR` |
| `PORTUGAL` | `PT` |
| `ITALY`, `ITALIA` | `IT` |
| `GERMANY`, `ALEMANIA` | `DE` |

Otros nombres → `VALIDATION_ERROR`. Cualquier ISO alpha-2 válida pasa directamente.

## 7. Hook con Shopify Flow W1

Detalle completo del walkthrough en `flows/W1-walkthrough.md` (material crudo del repo). Resumen:

| Pieza | Valor |
|---|---|
| Trigger | `Customer created`. |
| Step 1 (Run code) | "Backfill metafields" — lee `customer.note` (campo legacy ya no usado) + los metafields recién seteados (los del form). Confirma backfill de los 4 nucleares. |
| Step 2 (Add tag) | `pendiente`. Redundante con la edge — defense in depth: si la edge falla en su `tagsAdd`, Flow lo recupera. |
| Step 3 (Run code) | `whitelistCheck` — compara `customer.email` con `shop.b2b.whitelist_emails` (match exacto o por dominio `@empresa.com`). |
| Step 4 (Condition) | ¿whitelist match? |

### Rama A — whitelist match (auto-aprobado)

| Step | Acción |
|---|---|
| 4A.1 | `tagsRemove ['pendiente']` + `tagsAdd ['aprobado']`. |
| 4A.2 | `customerUpdate metafields { b2b.fecha_aprobacion: today }`. |
| 4A.3 | `Send HTTP request` a `create-company-for-customer` (edge function, crea la Company y la asocia al catalog). |
| 4A.4 | `Send internal email` a backoffice (notifica auto-aprobación). |
| 4A.5 | `Send marketing mail #01` al cliente (`01-bienvenida-auto.liquid`). |

### Rama B — no whitelist (pendiente)

| Step | Acción |
|---|---|
| 4B.1 | (no toca tag — sigue `pendiente`). |
| 4B.2 | `Send internal email` a backoffice (`03-backoffice-nuevo-pendiente.liquid`). |
| 4B.3 | `Send marketing mail #02` al cliente (`02-solicitud-recibida.liquid`). |

Detalle de emails en [08-emails-transaccionales](08-emails-transaccionales.md).

## 8. Theme settings y secrets

### Theme settings (`config/settings_data.json`)

| Setting | Valor | Para qué |
|---|---|---|
| `register_b2b_endpoint` | `https://<project-ref>.supabase.co/functions/v1/register-b2b-customer` | URL del POST de envío. |
| `register_b2b_hmac_secret` | (64 hex) | **DEBE coincidir** con `REGISTER_B2B_HMAC_SECRET` en Supabase. |

### Supabase env vars

| Env | Para qué |
|---|---|
| `SHOPIFY_STORE_DOMAIN` | Idem otras edges. |
| `SHOPIFY_ADMIN_TOKEN` | Scopes: `write_customers`. |
| `SHOPIFY_API_VERSION` | Opcional. Default `2025-10`. |
| `REGISTER_B2B_HMAC_SECRET` | DEBE coincidir con `settings.register_b2b_hmac_secret`. |
| `STOREFRONT_ORIGIN` | Opcional. Default `*` (CORS abierto a cualquier origen). Setear al dominio de producción en cutover (ver gotchas). |

Inventario completo en [14-secrets](14-secrets.md).

## 9. Gotchas conocidos

### `tags` removido de `CustomerInput` en API 2025-10

La mutation `customerCreate` ya no acepta el campo `tags` en `CustomerInput`. La edge hace 2 mutations consecutivas:

1. `customerCreate(input: { email, firstName, lastName, phone, emailMarketingConsent, metafields })` — sin tags.
2. `tagsAdd(id: customer.id, tags: ["pendiente"])`.

**Implicación**: si `tagsAdd` falla, el Customer existe sin tag `pendiente` → Flow W1 no dispara → backoffice debe taguear a mano. La edge devuelve `warning: "TAG_PENDIENTE_FAILED"` en ese caso, no error duro.

Si en versiones futuras Shopify vuelve a aceptar `tags` en `CustomerInput`, se puede consolidar en una sola mutation. Mientras tanto, el patrón se mantiene defensivo.

### `paisIso.trim()` belt-and-suspenders

Set histórico de Customers quedó con `\tES` o `\t\tES` en `b2b.pais`. Root cause no localizada en el path actual. La edge incluye un `paisIso.trim()` explícito antes de persistir:

```typescript
{ namespace: "b2b", key: "pais", type: "single_line_text_field", value: paisIso!.trim() }
```

Aunque `sanitizeText` + `normalizeCountry` ya deberían limpiar, este trim es defensa adicional. Documentado en `docs/pendientes.md`.

### CORS por defecto `*`

`STOREFRONT_ORIGIN` por defecto es `*`. **En cutover a producción debe setearse al dominio real** (`https://shop.ledsc4.com` o lo que sea). Hoy permite POST desde cualquier origen.

### TTL HMAC 5 minutos

Más corto que las otras edges (`submit-order-request` y backoffice tienen 10 min). El alta no necesita ventana larga porque el usuario debería completar el form en una sola sesión. Si el usuario tarda > 5 min, la UI debe pedir refresh.

### Replay attack dentro del TTL

El `nonce` aporta unicidad pero **no se valida server-side contra una store de nonces vistos**. Un atacante con la signature válida podría reenviar el mismo body dentro de los 5 min. Mitigaciones existentes:

- `customerCreate` es idempotente por email → segundo intento devuelve `EMAIL_ALREADY_EXISTS`.
- Ventana corta (5 min) reduce blast radius.
- Rate limit del gateway Supabase.

**Pendiente**: dedupe de nonces en KV (Upstash o Redis-on-Supabase). Anotado como TODO en el comment header del archivo.

### Sin rate limit ni CAPTCHA

Hoy nada por IP. Si llega spam, añadir:

- Rate limit por IP a nivel edge.
- CAPTCHA en el form (Turnstile, hCaptcha).

No es prioritario porque el volumen orgánico de la landing es bajo y el daño práctico de un alta fake es bajo (queda como pendiente para que el backoffice rechace).

## 10. Pendientes y deuda

- **Dedupe de nonce en KV** para bloquear replay dentro del TTL. TODO en el header del archivo.
- **`STOREFRONT_ORIGIN` en cutover**: cambiar de `*` al dominio real antes de la entrega al cliente.
- **Rate limit + CAPTCHA**: si aparece spam.
- **`b2b.pais` whitespace**: root cause de `\tES` no localizada. Trim defensivo en su sitio; deuda pendiente.
- **Magic link en dominios reales**: el invite email solo es validable en dominio real, no en preview ([04-storefront-gate](04-storefront-gate.md) §preview hosts).

## 11. Fase 2 — Landing de instalador (2026-07)

Segunda landing de registro, `/pages/acceso-instalador` (section
`sections/main-acceso-instalador.liquid`, template
`templates/page.acceso-instalador.json`), pensada para captación masiva de
instaladores con mínima fricción. Comparte backend 100% con la landing de
distribuidor (misma edge `register-b2b-customer`, mismo asset
`assets/b2b-register-v2.js`) — las diferencias son solo de formulario:

| Diferencia | Landing distribuidor | Landing instalador |
|---|---|---|
| Hidden `sector` | `"otro"` | `"instalador"` |
| Campo `empresa` (razón social) | Obligatorio | **No existe en el form** |
| Campo `nif` | Obligatorio | Opcional (se valida formato si se rellena) |
| Campo `codigo_postal` | Obligatorio (nuevo, Fase 2) | Obligatorio (nuevo, Fase 2) |

`register-b2b-customer` relaja `empresa`/`nif` a opcionales cuando
`sector === "instalador"` — forzando `empresa` a vacío en ese carril aunque
el body la traiga rellena — y omite sus metafields del `customerCreate` si
quedan vacíos (Shopify rechaza `single_line_text_field` con value "").
`b2b.sector` se persiste **siempre**, sin excepción: es el discriminador de
carril. `codigo_postal` es obligatorio en los tres formularios de alta
(distribuidor, instalador y alta nativa OAuth vía `complete-b2b-registration`)
y se persiste siempre como `b2b.codigo_postal` (metafield nuevo, ver
[01-data-model §3](01-data-model.md)).

**El enrutado real de rol vive en Shopify Flow W1, no en las edge
functions.** `register-b2b-customer` crea el Customer igual sea cual sea la
landing (tag `pendiente`, con `b2b.sector` ya fijado) y deja que W1 decida:
una condición nueva justo tras el parseo comprueba `sector == "instalador"`
**antes** de la lógica de whitelist. Si es instalador, auto-aprueba
(`aprobado`+`instalador`) sin tocar la whitelist ni crear Company; si no,
el carril de distribuidor sigue exactamente igual que hoy (whitelist match
→ distribuidor + Company; sin match → pendiente/backoffice). Esta
bifurcación por `sector` requiere una edición manual pendiente de aplicar
en el Admin. Detalle completo, incluyendo por qué `create-company-for-customer`
necesita que `b2b.empresa` quede vacío para no crear Company, en
[flows/W1-walkthrough.md](../../flows/W1-walkthrough.md).

Gate-exempt: `/pages/acceso-instalador` está en `gate_exempt_paths` de
`layout/theme.liquid`, igual que `/pages/acceso-profesional`.

Copy editorial de la landing (hero, FAQ, etc.) va en placeholders bajo el
namespace i18n `ledsc4.acceso_instalador.*` (es/en/fr) — pendiente del
texto definitivo del cliente.

## Cambios

- **v0.4** (2026-07, Fase 2 completa): §11 corregida — el discriminador de carril es `b2b.sector`, comprobado en Flow W1 antes de la whitelist (no un resultado de whitelist-miss). `codigo_postal` extendido a `complete-b2b-registration`.
- **v0.3** (2026-07, Fase 2): añadida §11 (landing de instalador, campo código postal, empresa/nif opcionales para sector instalador).
- **v0.2** (16-may-2026): documentado el `emailMarketingConsent` del `customerCreate` (§5) — el doc no mencionaba el opt-in de marketing que la edge ya aplica. Sin este opt-in los 5 emails al cliente del flujo B2B no se entregarían. Coherente con 08-emails-transaccionales §7.
- **v0.1** (15-may-2026): primera publicación.
