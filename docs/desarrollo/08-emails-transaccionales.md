# 08 · Emails transaccionales

!!! info "Estado del documento"
    **Versión:** 1.1 · 13-sep-2026
    **Estado:** ✅ completo
    **Audiencia:** Equipo de desarrollo

## 1. Para qué sirve este documento

Las comunicaciones automáticas del portal B2B Outlet con clientes y backoffice se gobiernan desde dos componentes nativos de Shopify: **Shopify Flow** (workflows que reaccionan a eventos) y **Shopify Email** (templates HTML). Hay 6 workflows operativos con emails (W1, W2, W3, W5, W6, W7) y 19 marketing mails: 6 emails × 3 idiomas (ES/FR/EN) más el de oferta de W6, que es único y no se ramifica por idioma. Además hay 5 emails internos al backoffice. Recuentos contrastados con los exports de Flow del 13-sep-2026.

Este doc inventaría qué workflow dispara qué template, cuándo, cómo se ramifica por idioma, qué variables están disponibles, y los gaps actuales del sistema. La parte operativa (cómo aprobar/rechazar/whitelistar un cliente, dónde editar el copy) vive en el eje Administración cuando se abra; aquí se documenta solo lo necesario para que un desarrollador entienda y modifique el sistema.

Lo que **no** está aquí: los emails nativos que Shopify envía sin pasar por Flow (account invite, login code, order/shipping confirmations) — esos viven en Admin → Settings → Notifications y se documentan en su eje. El gate B2B en `<head>`, los flujos de registro/aprobación/solicitud y la edge `register-b2b-customer` viven en 04, 05, 06 y 07 respectivamente.

## 2. Inventario de workflows

Los workflows viven en Shopify Flow y **no son editables externamente**. No hay API pública (estado mayo 2026) para crear, modificar o desplegar workflows programáticamente — solo la UI del admin. El repo contiene material de apoyo en `flows/`:

- `Wx-<slug>.md` — diseño conceptual original (Fase A)
- `Wx-walkthrough.md` — guía de configuración manual paso a paso, **referencia para reconfigurar** (es una copia: contrastar antes con Shopify, ver aviso abajo)

Cualquier `.flow.json` que veas en `flows/` es un snapshot histórico de Fase B y no refleja el estado actual de los flows en producción. La fuente de verdad implementacional es el workflow vivo en Shopify Admin; el walkthrough es la guía para reconstruirlo a mano si hace falta.

!!! warning "Flows y emails del repo = copias, no código real"
    Los workflows de Flow y los emails (plantillas de marketing y emails internos) **viven y se editan en Shopify**. Lo que hay en `flows/`, en `email-templates/` y en este documento son **copias hechas a mano en una fecha concreta**: pueden cambiarse en el Admin sin réplica en el repo y, por tanto, **estar desactualizadas**. No las tomes como el código que corre en producción — **la fuente de verdad es siempre lo configurado en Shopify**. Contrasta con el Admin antes de actuar.

| Workflow | Trigger | Activo | Doc en repo |
| --- | --- | --- | --- |
| W1 — Registro B2B | `customer_created` | Sí | `W1-walkthrough.md` |
| W2 — Aprobación manual | `customer_tags_added` | Sí | `W2-walkthrough.md` |
| W3 — Rechazo manual | `customer_tags_added` | Sí | `W3-walkthrough.md` |
| W4 — Whitelist re-eval | — | **MOVIDO A SUPABASE** (no es flow) | `W4-walkthrough.md` deprecated |
| W5 — Solicitud B2B creada | `draft_order_created` | Sí | sin walkthrough aún |
| W6 — Instaladores | `draft_order_created` | Sí | `W6-walkthrough.md` |
| W7 — Registro completado (alta nativa) | `customer_tags_added` | Sí | `W7-walkthrough.md` |

W4 fue movido a Supabase (edge function `promote-whitelist-matches`) porque la re-evaluación de whitelist sobre customers existentes no encaja en triggers de Flow. Su `.md` queda como contexto histórico — no es un flow vivo.

!!! note "Comportamiento del cron — candidatos sin `b2b.empresa`"
    Si un email whitelisted aún **no tiene `b2b.empresa` setteado** (porque el cliente no ha completado el formulario de registro, o lo completó parcialmente), el cron **lo salta con log `skip (no b2b.empresa): <email>`** y espera a la siguiente pasada cuando el cliente complete el formulario. **Esto no es un fallo del cron**, es comportamiento esperado desde [PR #145](https://github.com/danielpenamad/shopify-ledsc4-theme/pull/145) (01-jun-2026). Antes de ese PR, el cron intentaba ejecutar el paso W2 → `create-company-for-customer` para esos candidatos y recibía HTTP 400 en bucle, ensuciando los logs sin avanzar.

W5 está operativo en producción pero falta su `W5-walkthrough.md`. Es deuda menor.

Patrón común a los workflows activos (W6 no tiene la Condition de idioma: envía una sola Marketing Activity):

```
Evento → Condition de negocio → [acciones de backoffice] → Condition de idioma → Send marketing email
```

### W1 — Registro B2B

Trigger: `customer_created`. Se dispara cuando la edge `register-b2b-customer` (ver 05-registro-b2b §4) crea el customer en Shopify.

Estructura:

1. Run code — parsea `customer.note` y rellena metafields `b2b.*` (empresa, NIF, sector, país, volumen, fecha de registro)
2. Aplica tag `pendiente`
3. Run code — comprueba si el email está en `shop.metafields.b2b.whitelist_emails`
4. Condition: ¿whitelisted?
   - **VERDADERO** (rama auto-aprobado):
     - Quita tag `pendiente`, aplica `aprobado`
     - Setea `b2b.fecha_aprobacion`
     - Send internal email backoffice "auto-aprobado, crear Company a mano"
     - Send HTTP a edge `create-company-for-customer`
     - Ramificado i18n → envía template `W1-bienvenida-{ES/FR/EN}`
   - **FALSO** (rama estándar):
     - Send internal email backoffice "nuevo registro pendiente"
     - Ramificado i18n → envía template `W1-acuse-{ES/FR/EN}`

Nota sobre el `Run code` del paso 1: el customer llega con campos B2B serializados en `customer.note` por la edge — no en metafields directos. La edge sería más limpia si los pusiera ya como metafields y W1 solo gestionara whitelist + emails, pero esa refactor implica cambiar contrato edge↔flow y queda fuera del scope actual. Documentado en pendientes.

### W2 — Aprobación manual

Trigger: `customer_tags_added`. Se dispara cuando un admin cambia el tag de un cliente desde `pendiente` a `aprobado` en Shopify Admin (o cuando el backoffice lo hace vía edge `approve-customer`, ver 06-backoffice §4).

Estructura:

1. Condition: ¿tags contiene `aprobado` Y no contiene `pendiente`?
   - **VERDADERO**:
     - Send HTTP a edge `create-company-for-customer`
     - Ramificado i18n → envía template `W2-aprobacion-{ES/FR/EN}`
   - **FALSO**: fin sin acción

La doble condición (`aprobado` Y no `pendiente`) evita que el workflow se dispare en estados intermedios o si un admin añade `aprobado` sin quitar `pendiente`.

### W3 — Rechazo manual

Trigger: `customer_tags_added`. Espejo de W2 para el caso de rechazo.

Estructura:

1. Condition: ¿tags contiene `rechazado` Y no contiene `pendiente`?
   - **VERDADERO**:
     - Ramificado i18n → envía template `W3-rechazo-{ES/FR/EN}`
   - **FALSO**: fin sin acción

No se borra el customer al rechazar — queda en BD con tag `rechazado` por si se reabre el caso. No se llama a `create-company-for-customer`.

### W5 — Solicitud B2B creada

Trigger: `draft_order_created`. Se dispara cuando un cliente aprobado envía una solicitud de pedido vía la edge `submit-order-request` (ver 07-solicitudes-pedido §4), que crea un Draft Order con tag `solicitud-b2b`.

Estructura:

1. Condition: ¿draftOrder.tags contiene `solicitud-b2b`?
   - **VERDADERO**:
     - Run code — extrae empresa, CBM total y datos del draft order
     - Send internal email backoffice con resumen de la solicitud
     - Ramificado i18n (sobre `draftOrder.customer.locale`) → envía template `W5-acuse-{ES/FR/EN}`
   - **FALSO**: fin sin acción

La condición de tag filtra solicitudes B2B de cualquier otro Draft Order que Shopify pudiera crear (e.g. admin creando draft manual para un cliente final futuro).

### W6 — Instaladores

Trigger: `draft_order_created`. Solo actúa sobre solicitudes B2B (`solicitud-b2b`) de customers con tag `instalador`; las de distribuidor siguen el flujo de W5 y la revisión manual.

Estructura:

1. Condition: ¿draftOrder.tags contiene `solicitud-b2b`? → Condition: ¿el customer del draft tiene tag `instalador`?
   - **VERDADERO**:
     - Send HTTP a edge `generate-offer-pdf` (genera el PDF de la oferta)
     - Run code — parsea la respuesta de la edge
     - Send internal email "Solicitud SLOBs" (a Víctor + Josep Sans, ver §8)
     - Send marketing email con la oferta — **una sola Marketing Activity, sin ramificar por idioma**
   - **FALSO** (en cualquiera de las dos Conditions): fin sin acción

Detalle en `flows/W6-walkthrough.md`.

### W7 — Registro completado (alta nativa)

Trigger: `customer_tags_added`. Cubre el carril de alta nativa (`complete-b2b-registration`, ver 05-registro-b2b §7.1), que W1 no dispara.

Estructura:

1. Condition: ¿tags contiene `registro-completado`?
   - **VERDADERO**:
     - Run code — lee los metafields `b2b.*` (mismo código que el primer Run code de W1)
     - Send internal email backoffice "nuevo registro pendiente"
     - Quita el tag `registro-completado` (efímero: un reenvío del formulario vuelve a avisar)
     - Ramificado i18n → acuse pendiente {ES/FR/EN}, con Marketing Activities propias de W7
   - **FALSO**: fin sin acción

Detalle en `flows/W7-walkthrough.md`.

## 3. Inventario de templates

19 marketing mails (Marketing Activities) en Shopify, distribuidos por workflow e idioma. La fila "Aviso interno" de W7 no es un template: es su `Send internal email` inline, listado aquí junto a sus acuses.

| Template | Idioma | Asunto | Workflow / rama |
| --- | --- | --- | --- |
| `W1-acuse-ES` | ES | Hemos recibido tu solicitud · LedsC4 B2B Outlet | W1 rama estándar |
| `W1-acuse-EN` | EN | We have received your application · LedsC4 B2B Outlet | W1 rama estándar |
| `W1-acuse-FR` | FR | Nous avons reçu votre demande · LedsC4 B2B Outlet | W1 rama estándar |
| `W1-bienvenida-ES` | ES | Tu acceso al portal LedsC4 B2B Outlet está activo | W1 rama auto-aprobado |
| `W1-bienvenida-EN` | EN | Your access to the LedsC4 B2B Outlet portal is active | W1 rama auto-aprobado |
| `W1-bienvenida-FR` | FR | Votre accès au portail LedsC4 B2B Outlet est activé | W1 rama auto-aprobado |
| `W2-aprobacion-ES` | ES | Tu acceso al portal LedsC4 B2B Outlet está activo | W2 |
| `W2-aprobacion-EN` | EN | Your access to the LedsC4 B2B Outlet portal is active | W2 |
| `W2-aprobacion-FR` | FR | Votre accès au portail LedsC4 B2B Outlet est activé | W2 |
| `W3-rechazo-ES` | ES | Sobre tu solicitud en LedsC4 B2B Outlet | W3 |
| `W3-rechazo-EN` | EN | About your application to LedsC4 B2B Outlet | W3 |
| `W3-rechazo-FR` | FR | À propos de votre demande LedsC4 B2B Outlet | W3 |
| `W5-acuse-ES` | ES | Hemos recibido tu solicitud `{{ draftOrder.name }}` | W5 |
| `W5-acuse-EN` | EN | We have received your request `{{ draftOrder.name }}` | W5 |
| `W5-acuse-FR` | FR | Nous avons reçu votre demande `{{ draftOrder.name }}` | W5 |
| Oferta lista (instalador) — `MarketingActivity/204733972807` | Única (sin ramificar por idioma) | Definido en la plantilla (no figura en el export de W6) | W6 |
| Aviso interno "nuevo registro pendiente" (`Send internal email`, inline, a backoffice) | ES | `[B2B] Nuevo registro pendiente - {{ runCode.empresa }}` | W7 (carril alta nativa) |
| Acuse pendiente ES — `MarketingActivity/207259500871` | ES | Definido en la plantilla (no figura en el export de W7) | W7 (carril alta nativa) |
| Acuse pendiente FR — `MarketingActivity/207259599175` | FR | Definido en la plantilla (no figura en el export de W7) | W7 (carril alta nativa) |
| Acuse pendiente EN — `MarketingActivity/207259631943` | EN | Definido en la plantilla (no figura en el export de W7) | W7 (carril alta nativa) |

Las filas de W7 cubren el carril de alta nativa (`complete-b2b-registration`), que W1 no dispara: W7 reacciona al tag `registro-completado`. Sus tres acuses son Marketing Activities **propias de W7**, distintas de las de `W1-acuse-*`. Detalle en [flows/W7-walkthrough.md](../../flows/W7-walkthrough.md).

Los 15 templates de W1, W2, W3 y W5 comparten estructura HTML (header con logo, body, footer con dirección legal y unsubscribe). Logo apunta a `https://shop.ledsc4.com/cdn/shop/files/logo-ledsc4.png`. Solo el body y el footer cambian por idioma. Los de W6 y W7 no están inventariados en el repo: su contenido solo vive en Shopify.

W1-bienvenida-* y W2-aprobacion-* comparten asunto idéntico por idioma. Esto es deliberado: el cliente percibe lo mismo (acceso activo) tanto si fue auto-aprobado por whitelist como si fue revisado a mano. Los cuerpos pueden divergir en contenido específico.

## 4. Migración desde `Send internal email` a `Send marketing email`

Contexto histórico relevante para entender el repo: en Fase B (abril 2026) los emails al cliente se enviaban con la acción **`Send internal email`** de Flow, copy-pasteando inline el body y subject desde liquid templates en `/email-templates/`. El store no tenía Shopify Email habilitado entonces.

El sistema actual (mayo 2026) migra los 5 emails al cliente a **`Send marketing email`** apuntando a templates de Shopify Email. Cambio principal:

| Aspecto | Antes (`Send internal email`) | Ahora (`Send marketing email`) |
| --- | --- | --- |
| Origen del copy | Inline en el workflow (copy-paste) | Template gestionado en Shopify Email |
| Editable sin tocar Flow | No | Sí, vía Marketing → Email → Templates |
| Branding y logo | Inline HTML por flow | Centralizado en el template |
| Tracking de aperturas/clicks | No | Sí (`{{ open_tracking_block }}`) |
| Requiere opt-in del cliente | No | **Sí** (ver §7) |
| Idioma | Conditions con liquid `if` inline | Conditions de Flow encadenadas eligiendo template |

Los emails al backoffice **siguen usando `Send internal email`** (5 sitios: 2 en W1 + 1 en W5 + 1 en W6 + 1 en W7), porque el destinatario es interno y no hay requisito de marketing opt-in.

Los `email-templates/*.liquid` antiguos quedaron en el repo como referencia histórica. No son la fuente de verdad actual — Shopify Email lo es.

## 5. Patrón de ramificación por idioma

W1, W2, W3, W5 y W7 usan este patrón para decidir qué template enviar (W6 no ramifica por idioma; W2 compara con `==`, ver abajo):

```
Condition 1: customer.locale start_with? "es"
    VERDADERO → send template ES
    FALSO →
        Condition 2: customer.locale start_with? "fr"
            VERDADERO → send template FR
            FALSO → send template EN (fallback)
```

EN es el fallback implícito (sin condition explícita) porque cubre cualquier locale no reconocido sin necesidad de un tercer nivel anidado.

Dos detalles técnicos no obvios:

1. **`start_with?` en vez de igualdad**. `customer.locale` puede incluir sufijos regionales (`es-ES`, `en-GB`, `fr-CA`). Usar `==` exacto fallaría con `es-ES` y mandaría a EN. `start_with?` captura todas las variantes. **Excepción real: W2** compara `customer.locale == "es"` / `== "fr"` (export del 13-sep-2026), así que un cliente con locale `es-ES` o `fr-FR` recibe el email de aprobación en EN. W1, W3, W5 y W7 sí usan `start_with?`.

2. **Variable distinta en W5**. El trigger `draft_order_created` cuelga el customer del draft order: la variable es `draftOrder.customer.locale`, no `customer.locale`. Misma lógica, distinto path. Cualquier copia-pega entre W1/W2/W3 y W5 debe ajustar la variable.

## 6. Variables liquid disponibles en los templates

Variables que se pueden usar dentro del HTML de cada template:

| Variable | Disponibilidad | Uso |
| --- | --- | --- |
| `{{ customer.first_name }}` | Todos | Nombre del cliente para el saludo |
| `{{ customer.last_name }}` | Todos | Apellido. No se usa actualmente |
| `{{ draftOrder.name }}` | Solo W5 | Referencia de la solicitud (e.g. `#D1234`) |
| `{{ unsubscribe_link }}` | **Obligatorio** | Link de baja del canal marketing |
| `{{ open_tracking_block }}` | **Obligatorio** | Píxel de tracking de aperturas |

Shopify Email **rechaza al guardar** cualquier template marketing sin `{{ unsubscribe_link }}` y `{{ open_tracking_block }}`. Es bloqueo a nivel UI, no error en runtime — imposible publicar un template sin ellos.

Otras variables del customer (metafields B2B, tags, fecha de registro) **no están disponibles** en el contexto de Shopify Email — solo first/last name. Si el copy del email necesitase el nombre de la empresa o el sector, habría que pasarlo desde el workflow a un metafield del customer que Shopify Email sí pueda interpolar, o aceptar que ese dato no aparece en el email.

## 7. Suscripción a marketing

Los 19 marketing mails al cliente se envían con la acción `Send marketing email`. Esta action **solo entrega el email a clientes con opt-in a marketing**. Sin opt-in, Shopify silenciosamente descarta el envío — no hay error en el run history del flow, el email simplemente no llega.

**Estado actual: la edge `register-b2b-customer` suscribe al cliente a marketing en el momento de crearlo.** El input de la mutación `customerCreate` (`supabase/functions/register-b2b-customer/index.ts`) incluye:

```typescript
emailMarketingConsent: {
  marketingState: "SUBSCRIBED",
  marketingOptInLevel: "CONFIRMED_OPT_IN",
  consentUpdatedAt: new Date().toISOString(),
},
```

Resultado: todo registro nuevo por `register-b2b-customer` queda en `Marketing → Subscribed` con nivel `CONFIRMED_OPT_IN`, y los marketing mails (W1-acuse, W1-bienvenida, W2-aprobacion, W3-rechazo, W5-acuse, oferta de W6) se entregan sin intervención manual del backoffice. En el carril de alta nativa, `complete-b2b-registration` fija el consent (`SUBSCRIBED` / `SINGLE_OPT_IN`, best-effort) antes de añadir los tags, para que lleguen los acuses de W7. Los emails al backoffice (W1 ×2, W5, W6, W7) llegan por otra vía (`Send internal email`), independiente del opt-in.

**Base legal del consentimiento**: el checkbox `condiciones` del formulario `/pages/acceso-profesional#registro` es obligatorio y se valida en la edge (`index.ts`, bloque de validación: rechaza el registro con `VALIDATION_ERROR` si `condiciones !== true`). Esa aceptación obligatoria de las condiciones constituye el opt-in documentado bajo el régimen LOPDGDD/RGPD aplicable — no se usa un checkbox de marketing separado. Cualquier cambio que vuelva opcional el checkbox `condiciones` invalida esta base legal y debe revisarse con negocio + legal antes de mergear.

## 8. Inventario de elementos hardcoded

Elementos cuyo valor está fijado dentro del workflow en Shopify Flow y requieren editar el workflow para cambiarse:

### Emails de backoffice (5 sitios)

**No todos van a los mismos destinatarios** (export del 13-sep-2026). Si cambia el destinatario, hay que revisar los 5 uno a uno:

- **W1 rama estándar**: `Send internal email` "nuevo registro pendiente" → `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
- **W1 rama auto-aprobado**: `Send internal email` "auto-aprobado, crear Company a mano" → `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
- **W5**: `Send internal email` "nueva solicitud B2B" → `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`
- **W6**: `Send internal email` "Solicitud SLOBs" → `victorrojas@ledsc4.com, josepsans@ledsc4.com`
- **W7**: `Send internal email` "nuevo registro pendiente" (carril alta nativa) → `victorrojas@ledsc4.com, joancarlesporta@ledsc4.com`

Motivo del hardcoded: el campo `address` de `Send internal email` no acepta variables ni liquid (documentación oficial Shopify). Posible alternativa para hacerlo dinámico: usar `Send HTTP request` a un endpoint propio que reciba el destinatario por payload — sobreingeniería para el volumen actual.

`shop.metafields.b2b.email_backoffice` se mantiene como destinatario de referencia por convención, pero el metafield no se lee desde el flow — es solo referencia para humanos, y los 5 sitios no tienen por qué coincidir con él (hoy W6 no coincide con los demás).

### Marketing activity IDs (19 sitios)

Cada `Send marketing email` referencia un `marketing_activity_id` con formato `gid://shopify/MarketingActivity/...`. Estos IDs apuntan al template concreto en Shopify Email. Si se elimina y recrea un template, su ID cambia y hay que reasignarlo en el `Send marketing email` correspondiente.

Implicación práctica: **no eliminar templates** — editar el existente. Eliminarlo rompe silenciosamente el envío en el workflow asociado (el `Send marketing email` queda apuntando a un GID inexistente; Shopify lo marca como error en el run history pero no avisa proactivamente).

### Subject del email backoffice

El subject inline en cada `Send internal email` está hardcoded en el workflow. Aceptan liquid y variables (a diferencia del `address`), pero hoy son strings fijos. Cambiar el subject requiere editar el workflow.

## 9. Limitaciones conocidas de Shopify Flow

Lista exhaustiva de límites técnicos que afectan al diseño:

- **Campo `address` de `Send internal email` no acepta variables ni liquid**. Único motivo del hardcoded de emails backoffice.
- **`Send marketing email` solo entrega a clientes suscritos**. Sin opt-in → fallo silencioso, sin error en run history. Ver §7.
- **No hay forma de editar workflows desde fuera de la UI** (estado mayo 2026). Sin API pública, sin formato editable. Cualquier cambio se hace a mano en Shopify Admin → Apps → Flow. Esto convierte a los walkthroughs en `flows/` en la única vía documental para reconstruir un workflow desde cero.
- **Conditions de Flow son binarias**. No hay if/elif/else en un nodo. El ramificado por idioma requiere conditions encadenadas (§5).
- **`customer.locale` incluye sufijos regionales**. `es-ES`, `en-GB`, `fr-CA`. Por eso `start_with?` y no `==`.
- **Marketing activity IDs no son portables entre tiendas**. Reconstruir un workflow en otra tienda requiere recrear los 19 marketing mails en Shopify Email destino y reasignar los GIDs a mano en cada `Send marketing email`.
- **`Run code` tiene timeout corto** (segundos). Llamadas síncronas a APIs externas pesadas no encajan — para eso `Send HTTP request` y procesado asíncrono en la edge destino (ej. `create-company-for-customer`).
- **Variables del customer en Shopify Email son limitadas**. Solo first/last name interpolables (§6).
- **No hay reintentos automáticos** en `Send HTTP request` ante 5xx transitorios. La edge destino debe ser idempotente y el flow asume entrega; fallos quedan en run history sin alerta.

## 10. Procedimientos técnicos

### Modificar el copy de un template

1. Shopify Admin → Marketing → Email → Templates
2. Localizar el template por nombre (e.g. `W1-acuse-ES`)
3. Editar el HTML en el editor de código
4. Mantener intactos: estructura de tablas, `{{ unsubscribe_link }}`, `{{ open_tracking_block }}`, logo URL
5. Guardar
6. Lanzar `Test campaign` para verificar render antes de dar por bueno el cambio

No se toca el workflow. El workflow apunta al template por GID y los cambios en el template se aplican al siguiente envío.

### Cambiar el destinatario backoffice

1. Shopify Admin → Apps → Shopify Flow → cada workflow afectado (W1 con 2 sitios; W5, W6 y W7 con 1 cada uno)
2. En cada `Send internal email`, editar el campo `Dirección de correo electrónico`
3. Guardar y activar el workflow

El campo acepta varias direcciones separadas por comas, todas fijas. Si se necesita multi-destinatario dinámico, sobreingeniería con `Send HTTP request` a un endpoint propio.

Mantener `shop.metafields.b2b.email_backoffice` sincronizado a mano con el valor real (no se lee desde el flow pero es referencia documental).

### Añadir un idioma nuevo

1. Crear el template en Shopify Email con el patrón `Wx-tipo-XX` (e.g. `W1-acuse-DE`)
2. Editar cada workflow afectado:
   - Añadir una nueva Condition de idioma en cascada, antes del fallback EN
   - Crear un nuevo `Send marketing email` apuntando al template nuevo
   - Conectar la rama VERDADERO de la nueva Condition al nuevo Send
   - Conectar la rama FALSO al siguiente nivel (otra Condition o el fallback EN)

Recordatorio: si añades `de` como idioma, el currency switcher y el resto del theme deben soportar `de` antes (ver D11 cuando exista, 09-i18n y 10-multicurrency).

### Cambiar el copy de un email backoffice

1. Abrir el workflow correspondiente en Shopify Flow
2. Click en el `Send internal email` a modificar
3. Editar el campo `Asunto` y/o `Cuerpo del mensaje`
4. Estos campos sí aceptan liquid y variables (a diferencia del `address`)
5. Guardar

### Reconstruir un workflow en otra tienda

No hay export/import operativo entre tiendas: el formato no se preserva ni es editable, y los GIDs de templates y customer fields son específicos por tenant. Reconstrucción siempre manual:

1. Crear los 19 marketing mails en Shopify Email destino (anotar los GIDs nuevos)
2. Recrear las customer metafield definitions desde `scripts/metafield-definitions.json` antes (ver 01-data-model)
3. Configurar las edge function URLs en `settings_data.json` y los HMAC secrets
4. Construir cada workflow a mano siguiendo el `Wx-walkthrough.md` correspondiente, asignando los GIDs de los nuevos templates en cada `Send marketing email`
5. Activar workflow uno por uno y testear con un customer dummy

## 11. Pendientes

- ~~**`register-b2b-customer` no suscribe al cliente a marketing — bloqueante**~~. **Resuelto**: el `customerCreate` ya incluye `emailMarketingConsent` (`SUBSCRIBED` / `CONFIRMED_OPT_IN`). Base legal: checkbox `condiciones` obligatorio. Ver §7.

- **W5 sin walkthrough en repo**. W5 está operativo en producción pero `flows/` no tiene `W5-walkthrough.md`. Documentar a mano siguiendo la configuración viva en Shopify Admin. Deuda menor.

- **Refactor del contrato edge↔W1**. La edge `register-b2b-customer` deja los datos B2B en `customer.note` y el paso 1 de W1 los parsea para volcarlos a metafields. Más limpio: edge escribe metafields directos y W1 solo gestiona whitelist + emails. Cambio implica versionar contrato edge↔flow.

- **Re-emisión manual de emails**. No hay mecanismo para re-enviar un email a un cliente cuyo opt-in se reparó tarde. Hoy requiere disparar el evento que dispara el flow (cambiar tag → quitar → re-poner), con efectos colaterales. Posible mejora: workflow ad-hoc con trigger manual (`Manual trigger` action existe en Flow desde 2024).

- **Sin alertas en fallos del flow**. Si `Send HTTP request` a `create-company-for-customer` falla, el customer queda como `aprobado` sin Company asignada — visible solo entrando al run history de Flow. Falta una alerta proactiva (Sentry, email, Slack). Tratado como deuda operacional, no del sistema de emails per se.

- **Templates antiguos en `email-templates/*.liquid`**. Quedaron como referencia tras la migración de `Send internal email` a `Send marketing email` (§4). Verificar si pueden eliminarse del repo sin perder valor histórico (probablemente sí, la config viva en Shopify Email es la verdad).

- **Limpiar `.flow.json` viejos en `flows/`**. Hay snapshots de Fase B (`W2-aprobacion-manual.flow.json`, `W3-rechazo-manual.flow.json`) que no reflejan el estado actual. No tienen valor documental — los walkthroughs son la guía actual y el formato no es replayable. PR de limpieza pendiente.

## Cambios

- **v1.1** (13-sep-2026): recuentos actualizados con W6 y W7 contra los exports de Flow del 13-sep-2026 (6 workflows con emails, 19 marketing mails, 5 emails internos). W6 y W7 añadidos al inventario de workflows y templates. Documentado que W2 compara el locale con `==` y que el email interno de W6 va a Víctor + Josep Sans. Aviso de que flows y emails del repo son copias.
- **v1.0** (17-may-2026): cabecera de estado añadida; documento ya estaba completo. Primera publicación del contenido: 16-may-2026.
