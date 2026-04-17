# Walkthrough — bodies de email inline en Flow

El store actual (plan Development / affiliate) no tiene acceso a Shopify
Email, y "Shopify Messaging" solo cubre marketing automation. Para los
emails **transaccionales** de onboarding B2B usamos la acción nativa de
Flow **`Send internal email`**, que acepta subject + body inline con
Liquid. Los 6 `.liquid` de esta carpeta son la **fuente de verdad del
contenido** — no se cargan en ningún editor separado; se copy-paste al
bloque `Send internal email` dentro de cada Flow.

## Cómo usar cada `.liquid` en Flow

Cada `.liquid` tiene la misma estructura:

```
{% comment %}
  Metadata: email X, disparador, destinatario.
{% endcomment %}

Subject: <texto del subject>

<cuerpo del email con variables Liquid>
```

Al configurar un paso **Send internal email** en Flow:

| Campo del bloque Flow | Valor |
|---|---|
| **To**                | Indicado en la tabla siguiente |
| **From**              | El remitente del store (Shopify pone un `@shopify-notifications.com` interno si no tienes dominio verificado — es aceptable para Fase B) |
| **Subject**           | La línea `Subject: ...` del `.liquid`, **sin** el prefijo `Subject: ` |
| **Body**              | Todo lo que haya por debajo de la línea vacía que sigue al Subject (es decir, el cuerpo real). Omitir el bloque `{% comment %}...{% endcomment %}` y la línea `Subject: ...` |

Flow permite Liquid en el body de `Send internal email` con variables
del trigger (p.ej. `{{ customer.first_name }}`,
`{{ customer.metafields.b2b.empresa }}`), así que los `.liquid` se pegan
casi íntegros.

## Tabla de referencia

| # | Archivo | Flow que lo usa | To |
|---|---|---|---|
| 1 | `01-bienvenida-auto.liquid`             | W1 rama A (auto-aprobación) | `{{ customer.email }}` |
| 2 | `02-solicitud-recibida.liquid`          | W1 rama B (pendiente)       | `{{ customer.email }}` |
| 3 | `03-backoffice-nuevo-pendiente.liquid`  | W1 rama B + rama NIF inválido | `{{ shop.metafields.b2b.email_backoffice }}` |
| 4 | `04-cuenta-aprobada-manual.liquid`      | W2                           | `{{ customer.email }}` |
| 5 | `05-cuenta-rechazada.liquid`            | W3                           | `{{ customer.email }}` |
| 6 | `06-bienvenida-reevaluacion.liquid`     | W4                           | `{{ loop.item }}` (email del customer promovido) |

## Subjects extraídos (copy/paste)

Para ir rápido, los subjects de cada plantilla:

| # | Subject |
|---|---|
| 1 | `Tu cuenta B2B de LedsC4 Outlet está activa` |
| 2 | `Hemos recibido tu solicitud de alta B2B` |
| 3 | `[B2B] Nuevo registro pendiente — {{ customer.metafields.b2b.empresa }}` |
| 4 | `Tu solicitud B2B ha sido aprobada` |
| 5 | `Estado de tu solicitud B2B` |
| 6 | `Tu cuenta B2B de LedsC4 Outlet está activa` |

## Qué hacer si Flow no resuelve `customer.metafields.b2b.*`

Flow expone metafields en el body de `Send internal email` cuando la
query del trigger los incluye. Si un email llega con `{{ customer.metafields.b2b.xxx }}`
literal (sin resolver):

1. Abre el workflow → paso `Send internal email`
2. Edita la **GraphQL query** del trigger o del Run code que lo precede
   para incluir los metafields:
   ```graphql
   {
     customer {
       ...
       metafield_empresa:  metafield(namespace: "b2b", key: "empresa") { value }
       metafield_nif:      metafield(namespace: "b2b", key: "nif") { value }
       ...
     }
   }
   ```
3. En el body, usa la ruta alias: `{{ customer.metafield_empresa.value }}`
   en vez de `{{ customer.metafields.b2b.empresa }}`.

> Flow siempre puede leer metafields con ese patrón. Shopify Email es el
> que a veces no los resolvía; aquí no es problema.

## Cuando cambie un body

Edita el `.liquid` en el repo y **reaplica manualmente** el cambio al
bloque `Send internal email` del Flow correspondiente. Luego exporta de
nuevo `flows/Wx-*.flow.json` para que el repo refleje la nueva versión.

El `.liquid` es canónico; el `.flow.json` es la foto de cómo está
desplegado en este momento.

## Checklist

Al configurar cada Flow (ver `flows/W1..W4-walkthrough.md`), marcar:

- [ ] W1 rama A · body de `01-bienvenida-auto.liquid` pegado
- [ ] W1 rama B · body de `02-solicitud-recibida.liquid` pegado
- [ ] W1 rama B · body de `03-backoffice-nuevo-pendiente.liquid` pegado
- [ ] W1 rama NIF inválido · body de `03-...` con subject override pegado
- [ ] W2 · body de `04-cuenta-aprobada-manual.liquid` pegado
- [ ] W3 · body de `05-cuenta-rechazada.liquid` pegado
- [ ] W4 · body de `06-bienvenida-reevaluacion.liquid` pegado
- [ ] Test manual: crear un customer → los emails llegan a tu bandeja con
      las variables resueltas (no quedan `{{ ... }}` literales)
