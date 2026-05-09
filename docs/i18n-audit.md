# Theme i18n audit — W1.1.1

> Generated: 2026-05-09
> Scope: theme storefront (excludes admin-backoffice, locksmith, legal HTML pages, importer)
> Branch: chore/audit-theme-strings

## Resumen ejecutivo

- Strings (A) hardcoded encontrados: **218**
- Strings (B) Dawn-keyed `t:` (ya funcionan): **801** (462 sections + 301 snippets + 27 layout + 11 templates)
- Strings (C) LedsC4-keyed `t:`: **0** (esperado: 0) — confirmado, no hay claves `ledsc4.*` en el tema
- Archivos con strings (A): **15**
- Top 5 archivos con más (A):
  1. `sections/main-acceso-profesional.liquid` — **75** (hero, FAQ, formulario completo, footer legal, schema)
  2. `sections/b2b-portal-home.liquid` — **27** (hero anónimo, features, footer legal, link "Mi cuenta")
  3. `sections/b2b-mis-solicitudes.liquid` — **18** (loading, header, empty state, status labels en JS, columnas tabla)
  4. `sections/b2b-solicitud-form.liquid` — **20** (h1, lead, tabla, totales, formulario, errores JS)
  5. `sections/b2b-solicitud-detalle.liquid` — **15** (back, loading, errores JS, status labels, h1, encabezados tabla, totales, nota)
- Páginas legales HTML (no inventariadas, refactor wholesale): **4 archivos** en `pages/legal/`
  - `aviso-legal.html`, `canal-de-denuncias.html`, `condiciones-de-uso.html`, `politica-de-privacidad.html`

---

## Inventario por archivo

### sections/main-acceso-profesional.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 47 | A | `LEDS C4 <em>Outlet</em>` | — | brand wordmark (NO traducir) |
| 53 | A | Acceso profesional | `ledsc4.acceso.eyebrow` | label |
| 54-57 | A | El Outlet B2B de LEDS C4, <em>solo para profesionales</em> | `ledsc4.acceso.heading_html` | titulo (HTML inline `<em>`) |
| 58-62 | A | Aquí explicamos qué es el portal, quién puede acceder y cómo funciona el proceso de aprobación. Si después de leerlo crees que encajas, te llevamos al formulario de solicitud. | `ledsc4.acceso.lead` | parrafo |
| 75 | A | Solicitar acceso | `ledsc4.common.cta.solicitar_acceso` | boton (duplicado L278) |
| 78 | A | Ya tengo cuenta · Iniciar sesión | `ledsc4.common.cta.login_existente` | boton (duplicado L281) |
| 82 | A | ¿Aún no lo tienes claro? Sigue leyendo ↓ | `ledsc4.acceso.keep_reading` | enlace |
| 87 | A | Qué es este portal | `ledsc4.acceso.que_es.heading` | h2 |
| 88-95 | A | LEDS C4 Outlet B2B es un portal mayorista privado para liquidar stocks excedentes y descatalogados de LEDS C4 a profesionales del sector iluminación. Es independiente de la web pública <a>ledsc4.com</a> (B2C, dirigida al consumidor final): ni el catálogo, ni los precios, ni la cuenta de usuario se comparten. | `ledsc4.acceso.que_es.body_html` | parrafo (HTML inline `<a>`) |
| 99 | A | Quién puede acceder | `ledsc4.acceso.quien.heading` | h2 |
| 101 | A | El portal está pensado para los siguientes perfiles profesionales: | `ledsc4.acceso.quien.lead` | parrafo |
| 104 | A | Instaladores eléctricos y de iluminación | `ledsc4.acceso.quien.list.instaladores` | li |
| 105 | A | Arquitectos e interioristas | `ledsc4.acceso.quien.list.arquitectos` | li |
| 106 | A | Retail y tiendas especializadas | `ledsc4.acceso.quien.list.retail` | li |
| 107 | A | Distribuidores | `ledsc4.acceso.quien.list.distribuidores` | li |
| 108 | A | Empresas finales del sector iluminación | `ledsc4.acceso.quien.list.empresas` | li |
| 109 | A | Otros profesionales del sector | `ledsc4.acceso.quien.list.otros` | li |
| 112-116 | A | Para validar tu actividad necesitamos una <strong>razón social activa</strong> y un <strong>NIF/CIF/NIE válido</strong>. El registro pide también sector, país y, opcionalmente, volumen anual estimado para ayudarnos a dimensionar el servicio. | `ledsc4.acceso.quien.note_html` | nota (HTML inline `<strong>`) |
| 120 | A | Cómo funciona el acceso | `ledsc4.acceso.como.heading` | h2 |
| 122 | A | Hay <strong>dos caminos</strong> según si LEDS C4 ya te conoce: | `ledsc4.acceso.como.intro_html` | parrafo (HTML inline) |
| 127 | A | Vía rápida | `ledsc4.acceso.como.fast_tag` | badge |
| 128 | A | Pre-aprobados | `ledsc4.acceso.como.fast_title` | h3 |
| 129-133 | A | Si tu email está en la lista de profesionales pre-aprobados de LEDS C4, al registrarte tu cuenta se activa automáticamente. Entras al catálogo en cuestión de minutos, sin esperas. | `ledsc4.acceso.como.fast_desc` | parrafo |
| 137 | A | Vía estándar | `ledsc4.acceso.como.std_tag` | badge |
| 138 | A | Aprobación manual | `ledsc4.acceso.como.std_title` | h3 |
| 139-144 | A | Si tu email no está pre-aprobado, el equipo de LEDS C4 revisa tu solicitud manualmente. Tiempo estimado de respuesta: <strong>24–48 horas hábiles</strong>. Recibirás un email cuando esté resuelta, tanto si se aprueba como si se deniega. | `ledsc4.acceso.como.std_desc_html` | parrafo (HTML inline `<strong>`) |
| 148 | A | Pasos del proceso de acceso | `ledsc4.acceso.como.steps_aria` | aria-label |
| 152 | A | Te registras | `ledsc4.acceso.como.step1_title` | h3 |
| 153-155 | A | Rellenas el formulario con tus datos de empresa, NIF y sector. | `ledsc4.acceso.como.step1_desc` | parrafo |
| 160 | A | Validamos tus datos | `ledsc4.acceso.como.step2_title` | h3 |
| 161-163 | A | Auto-aprobado en minutos o revisión manual en 24–48h hábiles. | `ledsc4.acceso.como.step2_desc` | parrafo |
| 168 | A | Acceso al catálogo | `ledsc4.acceso.como.step3_title` | h3 |
| 169-171 | A | Recibes un email de bienvenida con el link al catálogo Outlet. | `ledsc4.acceso.como.step3_desc` | parrafo |
| 177 | A | Qué encontrarás dentro | `ledsc4.acceso.dentro.heading` | h2 |
| 182 | A | Catálogo Outlet | `ledsc4.acceso.dentro.f1_title` | h3 |
| 183-186 | A | Más de <strong>745 referencias</strong> de stocks excedentes, fin de serie y descatalogados, actualizadas semanalmente. | `ledsc4.acceso.dentro.f1_desc_html` | parrafo (HTML inline + cifra hardcoded — revisar) |
| 192 | A | Solicitudes revisadas | `ledsc4.acceso.dentro.f2_title` | h3 |
| 193-198 | A | En esta fase no es compra directa: cada solicitud la valida un comercial, que confirma plazos, mínimos y posibles ajustes antes de cerrar el pedido. | `ledsc4.acceso.dentro.f2_desc` | parrafo |
| 203 | A | Histórico y estado | `ledsc4.acceso.dentro.f3_title` | h3 |
| 204-207 | A | Cada solicitud queda registrada en tu área privada con su estado actual: en revisión, en trámite, confirmada o cancelada. | `ledsc4.acceso.dentro.f3_desc` | parrafo |
| 214 | A | Preguntas frecuentes | `ledsc4.acceso.faq.heading` | h2 |
| 217 | A | ¿Tengo que pagar algo por usar el portal? | `ledsc4.acceso.faq.q1_summary` | summary |
| 218-221 | A | No. El acceso al portal es gratuito para profesionales aprobados. Pagas únicamente los productos que pidas. | `ledsc4.acceso.faq.q1_body` | parrafo |
| 225 | A | ¿Cuánto tarda la aprobación? | `ledsc4.acceso.faq.q2_summary` | summary |
| 226-230 | A | Si tu email está en la lista de pre-aprobados, minutos. Si requiere revisión manual, entre <strong>24 y 48 horas hábiles</strong>. En ambos casos te llega un email con el resultado. | `ledsc4.acceso.faq.q2_body_html` | parrafo (HTML inline) |
| 234 | A | ¿Puedo comprar directamente? | `ledsc4.acceso.faq.q3_summary` | summary |
| 235-240 | A | En esta fase, no. El portal gestiona <strong>solicitudes de pedido</strong> que un comercial revisa y confirma por email — puede ajustar plazos, mínimos o aplicar descuentos antes de cerrar el pedido. La compra directa con checkout instantáneo está prevista para fases posteriores. | `ledsc4.acceso.faq.q3_body_html` | parrafo (HTML inline) |
| 244 | A | ¿Mi cuenta sirve también en ledsc4.com? | `ledsc4.acceso.faq.q4_summary` | summary |
| 245-249 | A | No. Esta cuenta es exclusiva del Outlet B2B. La cuenta de <a>ledsc4.com</a> (B2C, abierta al público) es independiente y se gestiona desde esa misma web. | `ledsc4.acceso.faq.q4_body_html` | parrafo (HTML inline `<a>`) |
| 253 | A | ¿Qué pasa si me rechazan? | `ledsc4.acceso.faq.q5_summary` | summary |
| 254-258 | A | Recibirás un email indicando el motivo (datos incompletos, perfil fuera de criterio, etc.). Si crees que ha habido un error, puedes contactar con el equipo comercial respondiendo a ese mismo email para revisarlo. | `ledsc4.acceso.faq.q5_body` | parrafo |
| 262 | A | ¿Cómo cambio mis datos de empresa? | `ledsc4.acceso.faq.q6_summary` | summary |
| 263-267 | A | Una vez aprobado, puedes ver tus datos en el área privada del portal. Para cambios sensibles (razón social, NIF) escribe al equipo comercial y los actualizamos manualmente. | `ledsc4.acceso.faq.q6_body` | parrafo |
| 272-275 | A | ¿Te encaja? Empieza por solicitar acceso. Si ya tienes cuenta, vuelve a tu área privada. | `ledsc4.acceso.ctas_lead` | lead |
| 278 | A | Solicitar acceso | `ledsc4.common.cta.solicitar_acceso` | boton (duplicado L75) |
| 281 | A | Ya tengo cuenta · Iniciar sesión | `ledsc4.common.cta.login_existente` | boton (duplicado L78) |
| 312 | A | Solicitar acceso | `ledsc4.acceso.form.heading` | h2 (form section) |
| 314 | A | <strong>Rellena tus datos.</strong> | `ledsc4.acceso.form.step1_html` | li (HTML inline) |
| 315 | A | <strong>Te enviamos un email</strong> con un enlace para activar tu cuenta. | `ledsc4.acceso.form.step2_html` | li (HTML inline) |
| 316 | A | <strong>Validamos tu perfil profesional</strong> (24-48h hábiles) y te avisamos por email cuando esté listo. | `ledsc4.acceso.form.step3_html` | li (HTML inline) |
| 333 | A | Datos personales | `ledsc4.acceso.form.legend_personales` | legend |
| 336 | A | Nombre | `ledsc4.acceso.form.label_nombre` | label |
| 341 | A | Apellidos | `ledsc4.acceso.form.label_apellidos` | label |
| 346 | A | Email | `ledsc4.acceso.form.label_email` | label |
| 351 | A | Teléfono | `ledsc4.acceso.form.label_telefono` | label |
| 359 | A | Datos de empresa | `ledsc4.acceso.form.legend_empresa` | legend |
| 362 | A | Razón social | `ledsc4.acceso.form.label_razon_social` | label |
| 367 | A | NIF / CIF / NIE | `ledsc4.acceso.form.label_nif` | label |
| 372 | A | Sector | `ledsc4.acceso.form.label_sector` | label |
| 374 | A | Selecciona… | `ledsc4.common.form.option_select` | option (placeholder) |
| 375 | A | Instalador eléctrico | `ledsc4.acceso.form.sector.instalador` | option label |
| 376 | A | Arquitecto / Interiorismo | `ledsc4.acceso.form.sector.arquitecto` | option label |
| 377 | A | Retail / Tienda | `ledsc4.acceso.form.sector.retail` | option label |
| 378 | A | Distribuidor | `ledsc4.acceso.form.sector.distribuidor` | option label |
| 379 | A | Empresa final del sector | `ledsc4.acceso.form.sector.empresa_final` | option label |
| 380 | A | Otro profesional del sector | `ledsc4.acceso.form.sector.otro` | option label |
| 385 | A | País | `ledsc4.acceso.form.label_pais` | label |
| 387 | A | Selecciona… | `ledsc4.common.form.option_select` | option (placeholder, dup) |
| 388 | A | España | `ledsc4.common.country.es` | option label (país) |
| 389 | A | Portugal | `ledsc4.common.country.pt` | option label (país) |
| 390 | A | Francia | `ledsc4.common.country.fr` | option label (país) |
| 391 | A | Italia | `ledsc4.common.country.it` | option label (país) |
| 392 | A | Alemania | `ledsc4.common.country.de` | option label (país) |
| 393 | A | Reino Unido | `ledsc4.common.country.gb` | option label (país) |
| 394 | A | Países Bajos | `ledsc4.common.country.nl` | option label (país) |
| 395 | A | Bélgica | `ledsc4.common.country.be` | option label (país) |
| 396 | A | Andorra | `ledsc4.common.country.ad` | option label (país) |
| 397 | A | Marruecos | `ledsc4.common.country.ma` | option label (país) |
| 402 | A | Volumen anual estimado | `ledsc4.acceso.form.label_volumen` | label |
| 402 | A | (opcional) | `ledsc4.common.form.optional` | label hint |
| 404 | A | Prefiero no decirlo | `ledsc4.acceso.form.volumen.no_decir` | option label |
| 405 | A | Menos de 5.000 € | `ledsc4.acceso.form.volumen.menos_5k_html` | option label (€ hardcoded) |
| 406 | A | 5.000 - 25.000 € | `ledsc4.acceso.form.volumen.5k_25k_html` | option label (€ hardcoded) |
| 407 | A | 25.000 - 100.000 € | `ledsc4.acceso.form.volumen.25k_100k_html` | option label (€ hardcoded) |
| 408 | A | Más de 100.000 € | `ledsc4.acceso.form.volumen.mas_100k_html` | option label (€ hardcoded) |
| 409 | A | No lo sé | `ledsc4.acceso.form.volumen.no_se` | option label |
| 419-420 | A | He leído y acepto las <a>condiciones de uso</a> y la <a>política de privacidad</a>. | `ledsc4.acceso.form.terms_html` | label (HTML inline `<a>`) |
| 430 | A | Enviar solicitud | `ledsc4.acceso.form.submit` | boton |
| 437 | A | Enlaces legales | `ledsc4.common.footer.aria_legal` | aria-label |
| 438 | A | Aviso legal | `ledsc4.common.footer.aviso_legal` | enlace |
| 440 | A | Privacidad | `ledsc4.common.footer.privacidad` | enlace |
| 442 | A | Condiciones | `ledsc4.common.footer.condiciones` | enlace |
| 444 | A | Canal ético | `ledsc4.common.footer.canal_etico` | enlace |
| 447 | A | © {{year}} LEDS C4, SA · CIF A59410910 · Carretera de Rubí 88, Sant Cugat del Vallés | `ledsc4.common.footer.copyright_html` | nota (datos legales — la dirección suele NO traducirse, pero el © año sí) |
| schema 1239 | A | Acceso profesional | schema `name` | schema (UI editor) |
| schema 1250 | A | Esquema de color | schema `label` | schema (UI editor) |
| schema 1252 | A | Oscuro (coherente con home anónima) | schema `option label` | schema (UI editor) |
| schema 1253 | A | Claro (mayor legibilidad de texto largo) | schema `option label` | schema (UI editor) |
| schema 1260 | A | Mostrar logo en cabecera | schema `label` | schema (UI editor) |
| schema 1262 | A | Off por defecto: la página ya está dentro del flujo del portal y la cabecera del tema (b2b-header-simple) ya muestra el logo. | schema `info` | schema (UI editor) |
| schema 1266 | A | Apariencia | schema `header content` | schema (UI editor) |
| schema 1266 | A | Espaciado | schema `header content` | schema (UI editor) |
| schema 1275 | A | Padding superior | schema `label` | schema (UI editor, dup) |
| schema 1285 | A | Padding inferior | schema `label` | schema (UI editor, dup) |
| schema 1291 | A | Acceso profesional | schema `preset name` | schema (UI editor, dup) |

### sections/b2b-cuenta-revision.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 12 | A | En revisión | `ledsc4.cuenta_revision.badge` | badge |
| 13-15 | A | Estamos validando tu solicitud | `ledsc4.cuenta_revision.heading` | h1 |
| 23 | A | Datos que nos diste | `ledsc4.cuenta_revision.datos_heading` | h2 |
| 26 | A | Empresa | `ledsc4.common.dato.empresa` | dt |
| 30 | A | NIF / CIF | `ledsc4.common.dato.nif_cif` | dt |
| 34 | A | Sector | `ledsc4.common.dato.sector` | dt |
| 37 | A | Email | `ledsc4.common.dato.email` | dt |
| 41-46 | A | ¿Ves un error? Escríbenos a <a>{email}</a> antes de que aprobemos. | `ledsc4.cuenta_revision.correct_html` | parrafo (HTML inline `<a mailto:>`, interpolación email) |
| 52 | A | Cerrar sesión | `ledsc4.common.cta.logout` | enlace (duplicado en varios files) |
| schema 185 | A | B2B Cuenta En Revisión | schema `name` | schema |
| schema 190 | A | Mensaje por defecto (si metafield vacío) | schema `label` | schema |
| schema 191 | A | Fallback si page.metafields.b2b.cuenta_revision_mensaje está vacío. | schema `info` | schema |
| schema 193 | A | El equipo de LedsC4 validará tu solicitud en un plazo de 24-48h hábiles. Te avisaremos por email cuando esté lista. | schema `default` (textarea fallback) | schema (USER-FACING fallback message) |
| schema 198 | A | B2B Cuenta En Revisión | schema `preset name` | schema |

### sections/b2b-cuenta-rechazada.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 9 | A | No activada | `ledsc4.cuenta_rechazada.badge` | badge |
| 10-12 | A | Tu cuenta no ha podido activarse | `ledsc4.cuenta_rechazada.heading` | h1 |
| 20 | A | Motivo | `ledsc4.cuenta_rechazada.motivo_label` | h2 (dato) |
| 28-31 | A | Si crees que es un error o quieres ampliar información, escríbenos a <a>{email}</a>. | `ledsc4.cuenta_rechazada.correct_html` | parrafo (HTML inline `<a mailto:>`, interpolación email) |
| 36 | A | Cerrar sesión | `ledsc4.common.cta.logout` | enlace (dup) |
| schema 161 | A | B2B Cuenta Rechazada | schema `name` | schema |
| schema 167 | A | Mensaje por defecto (si metafield vacío) | schema `label` | schema (dup) |
| schema 168 | A | Fallback si page.metafields.b2b.cuenta_rechazada_mensaje está vacío. | schema `info` | schema |
| schema 169 | A | Nuestro equipo ha revisado tu solicitud y no ha sido posible activar la cuenta en esta ocasión. | schema `default` (textarea fallback) | schema (USER-FACING fallback message) |
| schema 174 | A | B2B Cuenta Rechazada | schema `preset name` | schema |

### sections/b2b-mis-solicitudes.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 24 | A | Bienvenido | `ledsc4.common.greeting.fallback` | string literal (default) |
| 30 | A | Portal B2B | `ledsc4.common.eyebrow.portal_b2b` | label (dup b2b-portal-home) |
| 32-33 | A | Hola, {{ saludo }} | `ledsc4.common.greeting.hola_name_html` | h1 (interpolación variable) |
| 36 | A | Cargando solicitudes… | `ledsc4.mis_solicitudes.loading` | loader |
| 41-43 | A | Aún no has enviado ninguna solicitud. Explora el catálogo outlet de LEDS C4 y prepara tu primer pedido — aparecerá aquí en cuanto la envíes. | `ledsc4.mis_solicitudes.empty_lead` | parrafo |
| 49 | A | Tus solicitudes | `ledsc4.mis_solicitudes.subheading` | h2 |
| script 199 | A | En revisión | `ledsc4.common.status.pendiente_revision` | JS string label |
| script 200 | A | En trámite | `ledsc4.common.status.en_tramite` | JS string label |
| script 201 | A | Confirmada | `ledsc4.common.status.confirmada` | JS string label |
| script 202 | A | Cancelada | `ledsc4.common.status.cancelada` | JS string label |
| script 207 | A | locale `'es-ES'` | `ledsc4.common.locale_iso` | JS Date locale (revisar para EN/FR) |
| script 213 | A | locale `'es-ES'` (currency) | `ledsc4.common.locale_iso` | JS NumberFormat |
| script 213 | A | currency `'EUR'` | — | hardcoded EUR (revisar) |
| script 242 | A | Error cargando solicitudes: {msg} | `ledsc4.mis_solicitudes.err_loading` | error JS (interpolación) |
| script 247 | A | Error: {msg} | `ledsc4.common.error_prefix` | error JS (interpolación) |
| script 275 | A | Fecha | `ledsc4.mis_solicitudes.col_fecha` | th |
| script 276 | A | Ref | `ledsc4.mis_solicitudes.col_ref` | th |
| script 277 | A | Uds. | `ledsc4.common.col.uds` | th (dup en otros files) |
| script 278 | A | Importe est. | `ledsc4.mis_solicitudes.col_importe_est` | th |
| script 279 | A | Estado | `ledsc4.common.col.estado` | th |
| schema 295 | A | B2B Mis solicitudes | schema `name` | schema |

### sections/b2b-portal-home.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 26 | A | Bienvenido | `ledsc4.common.greeting.fallback` | string literal (dup) |
| 31 | A | Portal B2B | `ledsc4.common.eyebrow.portal_b2b` | label (dup) |
| 32-34 | A | Hola, {{ saludo }} | `ledsc4.common.greeting.hola_name_html` | h1 (dup, interpolación) |
| 35-38 | A | Explora el catálogo outlet de LEDS C4, prepara tu solicitud de pedido y consulta el estado de tus envíos. | `ledsc4.portal_home.aprobado.lead` | parrafo |
| 48 | A | Tu actividad | `ledsc4.portal_home.aprobado.solicitudes_eyebrow` | label |
| 49 | A | Mis solicitudes de pedido | `ledsc4.portal_home.aprobado.solicitudes_title` | h3 |
| 50-53 | A | Consulta el estado de tus solicitudes enviadas, descarga confirmaciones y revisa el histórico de pedidos. | `ledsc4.portal_home.aprobado.solicitudes_desc` | parrafo |
| 214 | A | `LEDS C4 <em>Outlet</em>` | — | brand wordmark (NO traducir) |
| 219 | A | Portal B2B · acceso exclusivo | `ledsc4.portal_home.anon.eyebrow` | label |
| 220-223 | A | Catálogo outlet <em>para profesionales</em> | `ledsc4.portal_home.anon.heading_html` | h1 (HTML inline `<em>`) |
| 224-227 | A | Stocks excedentes y descatalogados de LEDS C4 a precios reducidos. Acceso limitado a instaladores, arquitectos, distribuidores y retail del sector de la iluminación. | `ledsc4.portal_home.anon.lead` | parrafo |
| 235 | A | Iniciar sesión | `ledsc4.common.cta.login` | boton |
| 238 | A | Solicitar acceso | `ledsc4.common.cta.solicitar_acceso` | boton (dup) |
| 242 | A | ¿Tienes dudas sobre el acceso? Mira cómo funciona → | `ledsc4.portal_home.anon.help_link` | enlace |
| 247 | A | Más info | `ledsc4.portal_home.anon.scroll_hint` | label |
| 256 | A | Stock outlet | `ledsc4.portal_home.anon.f1_title` | h3 |
| 257 | A | Excedentes, fin de serie y descatalogados de LEDS C4 a precios reducidos. Actualizado cada semana. | `ledsc4.portal_home.anon.f1_desc` | parrafo |
| 262 | A | Alta en 24-48h | `ledsc4.portal_home.anon.f2_title` | h3 |
| 263 | A | Rellenas el formulario de solicitud y validamos tus datos profesionales. Sin mínimos en el primer pedido. | `ledsc4.portal_home.anon.f2_desc` | parrafo |
| 268 | A | Envío península 24-48h | `ledsc4.portal_home.anon.f3_title` | h3 |
| 269 | A | Almacén ibérico con stock disponible. Envío directo y sin intermediarios para pedidos profesionales. | `ledsc4.portal_home.anon.f3_desc` | parrafo |
| 275 | A | Enlaces legales | `ledsc4.common.footer.aria_legal` | aria-label (dup) |
| 276 | A | Aviso legal | `ledsc4.common.footer.aviso_legal` | enlace (dup) |
| 278 | A | Privacidad | `ledsc4.common.footer.privacidad` | enlace (dup) |
| 280 | A | Condiciones | `ledsc4.common.footer.condiciones` | enlace (dup) |
| 282 | A | Canal ético | `ledsc4.common.footer.canal_etico` | enlace (dup) |
| 285 | A | © {{year}} LEDS C4, SA · CIF A59410910 · Carretera de Rubí 88, Sant Cugat del Vallés | `ledsc4.common.footer.copyright_html` | nota (dup) |
| schema 576 | A | B2B Portal Home | schema `name` | schema |
| schema 582 | A | Branding | schema `header content` | schema |
| schema 587 | A | Logo (fallback) | schema `label` | schema |
| schema 588 | A | Se usa si Online Store > Brand > Logo está vacío. Fondo transparente; blanco sobre hero oscuro. | schema `info` | schema |
| schema 593 | A | Ancho del logo (px) | schema `label` | schema (dup) |
| schema 602 | A | B2B Portal Home | schema `preset name` | schema |

### sections/b2b-solicitud-form.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 48 | A | Solicitud de pedido | `ledsc4.solicitud.heading` | h1 |
| 49 | A | Revisa tu pedido, añade un comentario opcional y envía la solicitud. Nuestro equipo comercial revisará tu petición y confirmará disponibilidad, precios finales (IVA y portes) y fechas en las próximas 48h laborables. | `ledsc4.solicitud.lead` | parrafo |
| 53 | A | Tu carrito está vacío. <a>Ver catálogo</a>. | `ledsc4.solicitud.empty_html` | parrafo (HTML inline `<a>`) |
| 62 | A | Producto | `ledsc4.common.col.producto` | th |
| 63 | A | Uds. | `ledsc4.common.col.uds` | th (dup) |
| 64 | A | Precio unit. | `ledsc4.common.col.precio_unit` | th |
| 65 | A | Subtotal | `ledsc4.common.col.subtotal` | th |
| 77 | A | SKU: | `ledsc4.common.col.sku_label` | small (label de prefijo en JS y aquí) |
| 90 | A | Importe estimado (sin IVA ni portes) | `ledsc4.solicitud.totals.importe_est` | row label |
| 93 | A | * Los precios definitivos los confirmará el equipo comercial tras revisar disponibilidad y ajustes de volumen. | `ledsc4.solicitud.totals.warn` | nota |
| 98 | A | Comentario o propuesta (opcional) | `ledsc4.solicitud.field.comentario_label` | label |
| 99 | A | Ej: Necesito recibir el pedido antes del 15 de mayo. Pregúntame por descuento por volumen si llego a X unidades. | `ledsc4.solicitud.field.comentario_placeholder` | placeholder |
| 105 | A | He leído que el importe mostrado es orientativo y no incluye IVA ni costes de envío, que se confirmarán por el equipo comercial antes de procesar el pedido. | `ledsc4.solicitud.field.aviso_label` | label |
| 110 | A | Confirmar y enviar solicitud | `ledsc4.solicitud.submit` | boton |
| 111 | A | Volver al carrito | `ledsc4.solicitud.cancel` | enlace |
| script 132 | A | Confirmar y enviar solicitud | `ledsc4.solicitud.submit` | JS reset (dup) |
| script 141 | A | Debes marcar la casilla del aviso antes de enviar. | `ledsc4.solicitud.err.aviso_required` | error JS |
| script 146 | A | Enviando… | `ledsc4.solicitud.submitting` | JS button state |
| script 153 | A | No se pudo leer el carrito. Refresca la página e intenta de nuevo. | `ledsc4.solicitud.err.cart_read` | error JS |
| script 159 | A | Tu carrito está vacío. | `ledsc4.solicitud.err.cart_empty` | error JS |
| script 184 | A | Error de red al enviar la solicitud: {msg} | `ledsc4.solicitud.err.network` | error JS (interpolación) |
| script 196 | A | Confirmar y enviar solicitud | `ledsc4.solicitud.submit` | JS reset (dup) |
| script 202 | A | No se pudo crear la solicitud: {error}. Si persiste, contacta con el equipo comercial. | `ledsc4.solicitud.err.create_failed` | error JS (interpolación) |
| script 202 | A | error desconocido | `ledsc4.common.err.unknown` | error JS (fallback) |
| schema 228 | A | B2B Solicitud (form) | schema `name` | schema |

### sections/b2b-solicitud-detalle.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 37 | A | ← Mis solicitudes | `ledsc4.solicitud_detalle.back` | enlace |
| 39 | A | Cargando solicitud… | `ledsc4.solicitud_detalle.loading` | loader |
| script 57 | A | En revisión | `ledsc4.common.status.pendiente_revision` | JS label (dup) |
| script 58 | A | En trámite | `ledsc4.common.status.en_tramite` | JS label (dup) |
| script 59 | A | Confirmada | `ledsc4.common.status.confirmada` | JS label (dup) |
| script 60 | A | Cancelada | `ledsc4.common.status.cancelada` | JS label (dup) |
| script 65 | A | locale `'es-ES'` | `ledsc4.common.locale_iso` | JS Date locale (dup) |
| script 71 | A | locale `'es-ES'` (currency) | `ledsc4.common.locale_iso` | JS NumberFormat (dup) |
| script 71 | A | currency `'EUR'` | — | hardcoded EUR (revisar) |
| script 81 | A | Falta el parámetro ref en la URL. | `ledsc4.solicitud_detalle.err.no_ref` | error JS |
| script 95 | A | Error cargando la solicitud: {msg} | `ledsc4.solicitud_detalle.err.loading` | error JS (interpolación) |
| script 100 | A | Solicitud no encontrada o no es tuya. | `ledsc4.solicitud_detalle.err.not_found` | error JS |
| script 104 | A | Error: {msg} | `ledsc4.common.error_prefix` | error JS (dup) |
| script 119 | A | SKU: {sku} | `ledsc4.common.col.sku_label` | small (dup) |
| script 129 | A | Tu comentario | `ledsc4.solicitud_detalle.note_label` | label |
| script 133 | A | Solicitud {name} | `ledsc4.solicitud_detalle.heading_html` | h1 (interpolación nombre) |
| script 141 | A | Producto | `ledsc4.common.col.producto` | th (dup) |
| script 141 | A | Uds. | `ledsc4.common.col.uds` | th (dup) |
| script 141 | A | Precio unit. | `ledsc4.common.col.precio_unit` | th (dup) |
| script 141 | A | Subtotal | `ledsc4.common.col.subtotal` | th (dup) |
| script 147 | A | Importe estimado (sin IVA ni portes) | `ledsc4.solicitud.totals.importe_est` | row label (dup) |
| script 148 | A | CBM total | `ledsc4.solicitud_detalle.cbm_total` | row label |
| script 153 | A | Las solicitudes no se pueden editar ni cancelar desde aquí. Si necesitas hacer cambios, escribe al equipo comercial citando la referencia. | `ledsc4.solicitud_detalle.footer_note` | parrafo |
| schema 163 | A | B2B Solicitud detalle | schema `name` | schema |

### sections/b2b-solicitud-enviada.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 29 | A | Solicitud enviada | `ledsc4.solicitud_enviada.heading` | h1 |
| 30 | A | Gracias, {{ first_name \| default: 'cliente' }}. Hemos recibido tu solicitud de pedido. | `ledsc4.solicitud_enviada.lead_html` | parrafo (interpolación nombre + fallback) |
| 30 | A | cliente | `ledsc4.common.greeting.fallback_cliente` | string literal (default) |
| 35 | A | Referencia | `ledsc4.solicitud_enviada.ref_label` | label |
| 41 | A | Recibirás una confirmación por email en breve. Nuestro equipo comercial revisará tu solicitud en las próximas 48h laborables y se pondrá en contacto contigo para confirmar disponibilidad, precios finales y fechas de entrega. | `ledsc4.solicitud_enviada.next` | parrafo |
| 45 | A | Ver mis solicitudes | `ledsc4.solicitud_enviada.cta_ver_solicitudes` | boton |
| 46 | A | Volver al catálogo | `ledsc4.common.cta.volver_catalogo` | boton |
| schema 52 | A | B2B Solicitud enviada | schema `name` | schema |

### sections/b2b-account-dashboard.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 40 | A | Hola, {{ first_name \| default: ... \| default: 'bienvenido' }} | `ledsc4.common.greeting.hola_name_html` | h1 (interpolación, dup) |
| 40 | A | bienvenido | `ledsc4.common.greeting.fallback_lower` | string literal (default) |
| 41 | A | Tu portal B2B LedsC4 Outlet. | `ledsc4.account.subtitle` | parrafo |
| 50 | A | Ver catálogo | `ledsc4.account.card_catalogo_title` | h2 |
| 51 | A | Explora la colección outlet 2026 con tus precios B2B. | `ledsc4.account.card_catalogo_desc` | parrafo |
| 54 | A | Mis solicitudes | `ledsc4.account.card_solicitudes_title` | h2 |
| 55 | A | Consulta el estado de tus solicitudes de pedido. | `ledsc4.account.card_solicitudes_desc` | parrafo |
| 59 | A | Tu solicitud de acceso B2B no ha podido activarse. <a>Más información →</a> | `ledsc4.account.rechazado_html` | parrafo (HTML inline `<a>`) |
| 61 | A | Tu solicitud está siendo revisada por nuestro equipo. <a>Ver estado →</a> | `ledsc4.account.pendiente_html` | parrafo (HTML inline `<a>`) |
| 65 | A | Sesión iniciada como <strong>{email}</strong> | `ledsc4.account.footer_session_html` | span (interpolación email) |
| 66 | A | Cerrar sesión | `ledsc4.common.cta.logout` | enlace (dup) |
| 67 | A | Volver al portal | `ledsc4.account.volver_portal` | enlace |
| schema 73 | A | B2B Cuenta | schema `name` | schema |

### sections/b2b-header-simple.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 13 | A | Inicio | `ledsc4.common.aria.home` | aria-label |
| 41 | A | Cuenta | `ledsc4.common.aria.cuenta` | aria-label |
| 48 | A | Cerrar sesión | `ledsc4.common.cta.logout` | enlace (dup) |
| 51 | A | Iniciar sesión | `ledsc4.common.cta.login` | enlace (dup) |
| schema 124 | A | B2B Header Simple | schema `name` | schema |
| schema 130 | A | Logo | schema `label` | schema |
| schema 135 | A | Ancho del logo (px) | schema `label` | schema (dup) |

### sections/main-registro-recibido.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 35 | A | Solicitud enviada | `ledsc4.registro_recibido.eyebrow` | label |
| 36-38 | A | Revisa tu email | `ledsc4.registro_recibido.heading` | h1 |
| 41-42 | A | Te hemos enviado un email con un enlace para activar tu cuenta. | `ledsc4.registro_recibido.lead_generic` | parrafo (fallback genérico) |
| 45 | A | Si no lo recibes en <strong>5 minutos</strong>, revisa la carpeta de spam o promociones. | `ledsc4.registro_recibido.note1_html` | li (HTML inline `<strong>`) |
| 46 | A | Tras activar tu cuenta, validaremos tu perfil profesional en <strong>24-48 horas hábiles</strong>. | `ledsc4.registro_recibido.note2_html` | li (HTML inline `<strong>`) |
| 47 | A | Te avisaremos por email cuando esté listo, tanto si se aprueba como si se deniega. | `ledsc4.registro_recibido.note3` | li |
| 52 | A | Volver al inicio | `ledsc4.registro_recibido.back` | boton |
| script 79-82 | A | Te hemos enviado un email a <strong>{email}</strong> con un enlace para activar tu cuenta. | `ledsc4.registro_recibido.lead_with_email_html` | parrafo JS (interpolación email + HTML inline) |
| schema 250 | A | Registro recibido | schema `name` | schema |
| schema 257 | A | Esquema de color | schema `label` | schema (dup) |
| schema 259 | A | Oscuro | schema `option label` | schema |
| schema 260 | A | Claro | schema `option label` | schema |
| schema 271 | A | Padding superior | schema `label` | schema (dup) |
| schema 281 | A | Padding inferior | schema `label` | schema (dup) |
| schema 287 | A | Registro recibido | schema `preset name` | schema (dup) |

### sections/main-product.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 701 | A | Ficha técnica | `ledsc4.product.pdf_ficha_link` | enlace (PDF) |
| 709 | A | Especificaciones | `ledsc4.product.tab_specs` | tab button |
| 710 | A | Documentos | `ledsc4.product.tab_docs` | tab button |

> Nota: el resto de strings (B+) en `main-product.liquid` están vía `t:` (Dawn). Solo los 3 hardcoded son del bloque LedsC4 custom (líneas 696-720).

### sections/contact-form.liquid

> 100% Dawn `t:` keyed (B). 0 (A), 14 (B), 0 (C). No requiere refactor a `ledsc4.*`.

### Resto de sections — Dawn estándar (todas 100% `t:` keyed)

> `announcement-bar`, `apps`, `bulk-quick-order-list`, `cart-drawer`, `cart-icon-bubble`, `cart-live-region-text`, `cart-notification-button`, `cart-notification-product`, `collage`, `collapsible-content`, `collection-list`, `custom-liquid`, `email-signup-banner`, `featured-blog`, `featured-collection`, `featured-product`, `footer`, `header`, `image-banner`, `image-with-text`, `main-404`, `main-account`, `main-activate-account`, `main-addresses`, `main-article`, `main-blog`, `main-cart-footer`, `main-cart-items`, `main-collection-banner`, `main-collection-product-grid`, `main-list-collections`, `main-login`, `main-order`, `main-page`, `main-password-footer`, `main-password-header`, `main-reset-password`, `main-search`, `multicolumn`, `multirow`, `newsletter`, `page`, `pickup-availability`, `predictive-search`, `quick-order-list`, `related-products`, `rich-text`, `slideshow`, `video` — todos usan `t:` para 100% del texto user-facing. Confirmados con grep — 0 (A), N (B), 0 (C). Ver tabla "Files scanned".

---

### snippets/b2b-dashboard-cards.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 67 | A | producto | `ledsc4.common.products_count.one` | inline plural (singular) |
| 67 | A | productos | `ledsc4.common.products_count.other` | inline plural (plural) |
| 79 | A | Ver catálogo completo | `ledsc4.dashboard_cards.fallback_title` | h3 |
| 82 | A | productos disponibles | `ledsc4.dashboard_cards.fallback_meta_count_html` | parrafo (interpolación count) |
| 84 | A | Stocks excedentes y descatalogados de LEDS C4 | `ledsc4.dashboard_cards.fallback_meta_no_count` | parrafo |

### snippets/b2b-header-aprobado.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 19 | A | LedsC4 Outlet — Inicio | `ledsc4.header_aprobado.aria_brand` | aria-label |
| 23 | A | `alt="LedsC4"` | — | brand alt (NO traducir) |
| 30 | A | Mis solicitudes | `ledsc4.header_aprobado.mis_solicitudes` | enlace |
| 33 | A | Cerrar sesión | `ledsc4.common.cta.logout` | enlace (dup) |

### snippets/product-spec-badges.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 26 | A | Potencia (W) | `ledsc4.product.spec.potencia` | label badge |
| 36 | A | Temperatura de color | `ledsc4.product.spec.temperatura` | label badge |
| 46 | A | IP | `ledsc4.product.spec.ip` | label badge (acrónimo, no se traduce, pero se mantiene en clave) |
| 56 | A | CRI | `ledsc4.product.spec.cri` | label badge (acrónimo) |
| 66 | A | Dimensiones | `ledsc4.product.spec.dimensiones` | label badge |
| 80 | A | Lúmenes reales (lm) | `ledsc4.product.spec.lumenes_reales` | label badge |

### snippets/product-specs-table.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 8 | A | Familia | `ledsc4.product.spec_full.familia` | th |
| 9 | A | Catálogo | `ledsc4.product.spec_full.catalogo` | th |
| 10 | A | Garantía | `ledsc4.product.spec_full.garantia` | th |
| 10 | A | años | `ledsc4.product.spec_full.garantia_unit` | inline (interpolación) |
| 11 | A | Material | `ledsc4.product.spec_full.material` | th |
| 12 | A | Acabado | `ledsc4.product.spec_full.acabado` | th |
| 13 | A | Voltaje | `ledsc4.product.spec_full.voltaje` | th |
| 14 | A | Ancho (mm) | `ledsc4.product.spec_full.ancho_mm` | th |
| 15 | A | Alto (mm) | `ledsc4.product.spec_full.alto_mm` | th |
| 16 | A | Largo (mm) | `ledsc4.product.spec_full.largo_mm` | th |
| 17 | A | Proyección (mm) | `ledsc4.product.spec_full.proyeccion_mm` | th |
| 18 | A | Fuente de luz | `ledsc4.product.spec_full.fuente_luz` | th |
| 19 | A | Incluye bombilla | `ledsc4.product.spec_full.incluye_bombilla` | th |
| 20 | A | Eficiencia energética | `ledsc4.product.spec_full.eficiencia_energetica` | th |
| 21 | A | Peso neto (kg) | `ledsc4.product.spec_full.peso_neto_kg` | th |
| 22 | A | Potencia (W) | `ledsc4.product.spec.potencia` | th (dup spec-badges) |
| 23 | A | Lúmenes (lm) | `ledsc4.product.spec_full.lumenes` | th |
| 24 | A | Lúmenes reales (lm) | `ledsc4.product.spec.lumenes_reales` | th (dup spec-badges) |
| 25 | A | Temperatura de color | `ledsc4.product.spec.temperatura` | th (dup spec-badges) |
| 26 | A | CRI | `ledsc4.product.spec.cri` | th (dup) |
| 27 | A | Ángulo del haz | `ledsc4.product.spec_full.angulo_haz` | th |
| 28 | A | Regulación | `ledsc4.product.spec_full.regulacion` | th |
| 29 | A | IP | `ledsc4.product.spec.ip` | th (dup) |
| 30 | A | IK | `ledsc4.product.spec_full.ik` | th |

### snippets/product-documents.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 12 | A | Ficha técnica | `ledsc4.product.doc.ficha` | enlace |
| 20 | A | Fotometría | `ledsc4.product.doc.fotometria` | enlace |
| 28 | A | Etiqueta energética | `ledsc4.product.doc.etiqueta_ee` | enlace |
| 36 | A | Plano comercial | `ledsc4.product.doc.plano_comercial` | enlace |
| 44 | A | Instrucciones de montaje | `ledsc4.product.doc.imc` | enlace |
| 52 | A | Modelo 3D | `ledsc4.product.doc.modelo_3d` | enlace |
| 60 | A | Archivo IES | `ledsc4.product.doc.ies` | enlace |
| 68 | A | Archivo LDT | `ledsc4.product.doc.ldt` | enlace |

### Resto de snippets — Dawn estándar (100% `t:` keyed)

> `article-card`, `buy-buttons`, `card-collection`, `card-product`, `cart-drawer`, `cart-notification`, `country-localization`, `facets`, `gift-card-recipient-form`, `header-drawer`, `header-dropdown-menu`, `header-mega-menu`, `header-search`, `icon-accordion`, `icon-with-text`, `language-localization`, `loading-spinner`, `meta-tags`, `pagination`, `price-facet`, `price`, `product-media-gallery`, `product-media-modal`, `product-media`, `product-thumbnail`, `product-variant-options`, `product-variant-picker`, `progress-bar`, `quantity-input`, `quick-order-list-row`, `quick-order-list`, `quick-order-product-row`, `share-button`, `social-icons`, `swatch-input`, `swatch`, `unit-price` — 0 (A), N (B), 0 (C).

> Excluidos por scope: `locksmith*.liquid` (3 archivos: `locksmith.liquid`, `locksmith-content-variables.liquid`, `locksmith-variables.liquid`).

---

### layout/theme.liquid

| Línea | Categoría | Texto | Clave sugerida | Tipo semántico |
|-------|-----------|-------|----------------|----------------|
| 25 | A | tagged "..." | `ledsc4.layout.title_tagged_html` | `<title>` (HTML, EN hardcoded — bug Dawn) |
| 26 | A | Page {n} | `ledsc4.layout.title_page_n` | `<title>` (EN hardcoded — bug Dawn) |

> Nota: el resto del layout es 100% `t:` (accessibility, cart, variant strings). Las dos cadenas EN son artefactos de Dawn upstream que también deberían pasar a `t:` (no son español, pero rompen i18n).

### layout/password.liquid

> 100% Dawn `t:` keyed. 0 (A), 2 (B), 0 (C).

### templates/gift_card.liquid

> 100% Dawn `t:` keyed. 0 (A), 11 (B), 0 (C).

---

## Casos especiales detectados

### Pluralización
- `snippets/b2b-dashboard-cards.liquid` L67: `producto` / `productos` — singular/plural inline `{% if products_count == 1 %} producto{% else %} productos{% endif %}`. Usar Liquid `pluralize` o claves separadas `.one` / `.other`.
- `templates/page.b2b-cuenta-en-revision.json` y `page.b2b-cuenta-rechazada.json`: settings overrides del schema `default_message` — **OJO**: estos son SETTINGS de templates JSON (fuera de scope de inventario por-string, pero el contenido es traducible y debe migrarse cuando se cierre EN/FR).

### Interpolación compleja
- `b2b-mis-solicitudes.liquid` L32 y `b2b-portal-home.liquid` L32: `Hola, {{ saludo }}` — interpolación variable (empresa o first_name).
- `b2b-account-dashboard.liquid` L40: `Hola, {{ first_name | default: customer.name | default: 'bienvenido' }}` — interpolación + cascada de defaults; cuidar que el `'bienvenido'` también sea traducible.
- `b2b-solicitud-enviada.liquid` L30: `Gracias, {{ first_name | default: 'cliente' }}. Hemos recibido tu solicitud de pedido.` — interpolación + fallback `'cliente'`.
- `b2b-cuenta-revision.liquid` L41-46 y `b2b-cuenta-rechazada.liquid` L28-31: párrafos con `<a mailto:{email}>{email}</a>` — clave `_html` con interpolación de email.
- `b2b-account-dashboard.liquid` L65: `Sesión iniciada como <strong>{email}</strong>` — interpolación email.
- `main-registro-recibido.liquid` script L79-82: la frase se reescribe vía JS innerHTML insertando un `<strong>` con el email truncado — **necesita o bien una clave `_html` con `{email}` placeholder o split en piezas**. Sugerencia: clave única con placeholder `{{email}}` y reemplazo en cliente.
- `b2b-mis-solicitudes.liquid` script: cadenas de error con interpolación (`Error cargando solicitudes: ' + e.message`). Necesitan format strings con placeholders.

### HTML inline (debe quedar UNA clave por frase, sufijo `_html`)
- `main-acceso-profesional` L54-57 (`<em>`), L112-116 (`<strong>×2`), L122 (`<strong>`), L139-144 (`<strong>`), L183-186 (`<strong>`), L226-230 (`<strong>`), L235-240 (`<strong>`), L245-249 (`<a>`), L88-95 (`<a>`), L314-316 (`<strong>`), L419-420 (`<a>×2`).
- `b2b-portal-home` L220-223 (`<em>`).
- `b2b-cuenta-revision` L41-46 (`<a mailto:>`).
- `b2b-cuenta-rechazada` L28-31 (`<a mailto:>`).
- `b2b-solicitud-form` L53 (`<a>`).
- `b2b-account-dashboard` L59 (`<a>`), L61 (`<a>`), L65 (`<strong>`).
- `main-registro-recibido` L45-46 (`<strong>`), script (innerHTML).

### Moneda/precio EUR hardcoded
- `b2b-mis-solicitudes.liquid` script L213: `currency: 'EUR'`.
- `b2b-solicitud-detalle.liquid` script L71: `currency: 'EUR'`.
- `main-acceso-profesional.liquid` L405-408: opciones del select volumen — `Menos de 5.000 €`, `5.000 - 25.000 €`, `25.000 - 100.000 €`, `Más de 100.000 €`. El símbolo € es parte del label visible, debe quedar dentro de la clave `_html` o migrarse a un componente de formateo i18n.

### Locale ISO (es-ES) hardcoded en JS
- `b2b-mis-solicitudes.liquid` script L207, L213.
- `b2b-solicitud-detalle.liquid` script L65, L71.

> Sugerencia: exponer `request.locale.iso_code` desde Liquid como variable JS y usarlo en `toLocaleDateString` / `Intl.NumberFormat`.

### Section schema labels (inventario separado)

> Estas claves NO viven en el bundle del storefront `t:` runtime, sino que las consume el Theme Editor de Shopify. La convención es claves bajo `t:sections.<name>.settings.<id>.label` etc. en el `schema_translations` (locales `*.schema.json`). Inventario separado:

| Archivo | Línea schema | Texto | Sugerencia clave schema |
|---|---|---|---|
| `main-acceso-profesional.liquid` | 1239 | Acceso profesional | `t:sections.acceso-profesional.name` |
| | 1244 | Apariencia | `t:sections.acceso-profesional.settings.header_apariencia.content` |
| | 1250 | Esquema de color | `t:sections.acceso-profesional.settings.color_scheme.label` |
| | 1252 | Oscuro (coherente con home anónima) | `t:sections.acceso-profesional.settings.color_scheme.options.dark.label` |
| | 1253 | Claro (mayor legibilidad de texto largo) | `t:sections.acceso-profesional.settings.color_scheme.options.light.label` |
| | 1260 | Mostrar logo en cabecera | `t:sections.acceso-profesional.settings.show_logo_header.label` |
| | 1262 | Off por defecto: la página ya está dentro... | `t:sections.acceso-profesional.settings.show_logo_header.info` |
| | 1266 | Espaciado | `t:sections.acceso-profesional.settings.header_espaciado.content` |
| | 1275 | Padding superior | `t:sections.all.padding.padding_top` (reusable Dawn) |
| | 1285 | Padding inferior | `t:sections.all.padding.padding_bottom` (reusable Dawn) |
| | 1291 | Acceso profesional | `t:sections.acceso-profesional.presets.name` |
| `b2b-cuenta-revision.liquid` | 185 | B2B Cuenta En Revisión | `t:sections.b2b-cuenta-revision.name` |
| | 190 | Mensaje por defecto (si metafield vacío) | `t:sections.b2b-cuenta-revision.settings.default_message.label` |
| | 191 | Fallback si page.metafields... | `t:sections.b2b-cuenta-revision.settings.default_message.info` |
| | 193 | El equipo de LedsC4 validará... (default) | `t:sections.b2b-cuenta-revision.settings.default_message.default` |
| | 198 | B2B Cuenta En Revisión (preset) | `t:sections.b2b-cuenta-revision.presets.name` |
| `b2b-cuenta-rechazada.liquid` | 161 | B2B Cuenta Rechazada | `t:sections.b2b-cuenta-rechazada.name` |
| | 167 | Mensaje por defecto (si metafield vacío) | `t:sections.b2b-cuenta-rechazada.settings.default_message.label` |
| | 168 | Fallback si page.metafields... | `t:sections.b2b-cuenta-rechazada.settings.default_message.info` |
| | 169 | Nuestro equipo ha revisado... (default) | `t:sections.b2b-cuenta-rechazada.settings.default_message.default` |
| | 174 | B2B Cuenta Rechazada (preset) | `t:sections.b2b-cuenta-rechazada.presets.name` |
| `b2b-mis-solicitudes.liquid` | 295 | B2B Mis solicitudes | `t:sections.b2b-mis-solicitudes.name` |
| `b2b-portal-home.liquid` | 576 | B2B Portal Home | `t:sections.b2b-portal-home.name` |
| | 582 | Branding | `t:sections.b2b-portal-home.settings.header_branding.content` |
| | 587 | Logo (fallback) | `t:sections.b2b-portal-home.settings.logo.label` |
| | 588 | Se usa si Online Store > Brand > Logo está vacío. Fondo transparente; blanco sobre hero oscuro. | `t:sections.b2b-portal-home.settings.logo.info` |
| | 593 | Ancho del logo (px) | `t:sections.b2b-portal-home.settings.logo_width.label` |
| | 602 | B2B Portal Home (preset) | `t:sections.b2b-portal-home.presets.name` |
| `b2b-solicitud-form.liquid` | 228 | B2B Solicitud (form) | `t:sections.b2b-solicitud-form.name` |
| `b2b-solicitud-detalle.liquid` | 163 | B2B Solicitud detalle | `t:sections.b2b-solicitud-detalle.name` |
| `b2b-solicitud-enviada.liquid` | 52 | B2B Solicitud enviada | `t:sections.b2b-solicitud-enviada.name` |
| `b2b-account-dashboard.liquid` | 73 | B2B Cuenta | `t:sections.b2b-account-dashboard.name` |
| `b2b-header-simple.liquid` | 124 | B2B Header Simple | `t:sections.b2b-header-simple.name` |
| | 130 | Logo | `t:sections.b2b-header-simple.settings.logo.label` |
| | 135 | Ancho del logo (px) | `t:sections.b2b-header-simple.settings.logo_width.label` |
| `main-registro-recibido.liquid` | 250 | Registro recibido | `t:sections.registro-recibido.name` |
| | 257 | Esquema de color | `t:sections.registro-recibido.settings.color_scheme.label` |
| | 259 | Oscuro | `t:sections.registro-recibido.settings.color_scheme.options.dark.label` |
| | 260 | Claro | `t:sections.registro-recibido.settings.color_scheme.options.light.label` |
| | 271 | Padding superior | `t:sections.all.padding.padding_top` (reusable Dawn) |
| | 281 | Padding inferior | `t:sections.all.padding.padding_bottom` (reusable Dawn) |
| | 287 | Registro recibido (preset) | `t:sections.registro-recibido.presets.name` |

### Strings duplicados (sugieren clave compartida en `ledsc4.common.*`)

| Texto | Ocurrencias | Clave compartida sugerida |
|---|---|---|
| `Cerrar sesión` | b2b-cuenta-revision (52), b2b-cuenta-rechazada (36), b2b-header-simple (48), b2b-account-dashboard (66), b2b-header-aprobado snippet (33) — **5 ocurrencias** | `ledsc4.common.cta.logout` |
| `Iniciar sesión` | b2b-portal-home (235), b2b-header-simple (51) — **2** | `ledsc4.common.cta.login` |
| `Solicitar acceso` | main-acceso-profesional (75, 278), b2b-portal-home (238) — **3** | `ledsc4.common.cta.solicitar_acceso` |
| `Ya tengo cuenta · Iniciar sesión` | main-acceso-profesional (78, 281) — **2** | `ledsc4.common.cta.login_existente` |
| `Mis solicitudes` | b2b-account-dashboard (54), b2b-header-aprobado snippet (30) — **2** | `ledsc4.common.cta.mis_solicitudes` |
| `Hola, {name}` | b2b-mis-solicitudes (32), b2b-portal-home (32), b2b-account-dashboard (40) — **3** | `ledsc4.common.greeting.hola_name_html` |
| `Bienvenido` (default saludo) | b2b-mis-solicitudes (24), b2b-portal-home (26), b2b-account-dashboard L40 (`'bienvenido'` minúsc.), b2b-solicitud-enviada L30 (`'cliente'`) — variantes | `ledsc4.common.greeting.fallback*` (3 variantes diferentes — revisar si unificar) |
| `Portal B2B` (eyebrow) | b2b-mis-solicitudes (30), b2b-portal-home (31) — **2** | `ledsc4.common.eyebrow.portal_b2b` |
| `En revisión` / `En trámite` / `Confirmada` / `Cancelada` (status labels) | b2b-mis-solicitudes script (199-202), b2b-solicitud-detalle script (57-60), también `b2b-cuenta-revision` L12 usa "En revisión" como badge — **2-3 ocurrencias cada uno** | `ledsc4.common.status.{pendiente_revision,en_tramite,confirmada,cancelada}` |
| `Producto` / `Uds.` / `Precio unit.` / `Subtotal` (column headers) | b2b-solicitud-form (62-65), b2b-solicitud-detalle script (141) — **2** | `ledsc4.common.col.{producto,uds,precio_unit,subtotal}` |
| `SKU:` (label) | b2b-solicitud-form (77), b2b-solicitud-detalle script (119) — **2** | `ledsc4.common.col.sku_label` |
| `Importe estimado (sin IVA ni portes)` | b2b-solicitud-form (90), b2b-solicitud-detalle script (147) — **2** | `ledsc4.solicitud.totals.importe_est` |
| `Confirmar y enviar solicitud` | b2b-solicitud-form (110, 132, 196) — **3 (mismo file, JS reset)** | `ledsc4.solicitud.submit` |
| `Aviso legal` / `Privacidad` / `Condiciones` / `Canal ético` (footer legal) | main-acceso-profesional (438-444), b2b-portal-home (276-282) — **2** | `ledsc4.common.footer.{aviso_legal,privacidad,condiciones,canal_etico}` |
| `Enlaces legales` (aria) | main-acceso-profesional (437), b2b-portal-home (275) — **2** | `ledsc4.common.footer.aria_legal` |
| `© {year} LEDS C4, SA · CIF A59410910 · Carretera de Rubí 88, Sant Cugat del Vallés` | main-acceso-profesional (447), b2b-portal-home (285) — **2** | `ledsc4.common.footer.copyright_html` |
| `Selecciona…` (option placeholder) | main-acceso-profesional (374, 387) — **2 dentro del mismo file** | `ledsc4.common.form.option_select` |
| `Potencia (W)` | product-spec-badges (26), product-specs-table (22) — **2** | `ledsc4.product.spec.potencia` |
| `Temperatura de color` | product-spec-badges (36), product-specs-table (25) — **2** | `ledsc4.product.spec.temperatura` |
| `IP` | product-spec-badges (46), product-specs-table (29) — **2** | `ledsc4.product.spec.ip` |
| `CRI` | product-spec-badges (56), product-specs-table (26) — **2** | `ledsc4.product.spec.cri` |
| `Lúmenes reales (lm)` | product-spec-badges (80), product-specs-table (24) — **2** | `ledsc4.product.spec.lumenes_reales` |
| `Ficha técnica` | main-product (701), product-documents (12) — **2** | `ledsc4.product.doc.ficha` |
| `Mensaje por defecto (si metafield vacío)` (schema label) | b2b-cuenta-revision (190), b2b-cuenta-rechazada (167) — **2** | `t:sections.all.metafield_fallback.label` (schema dup) |
| `Logo`/`Ancho del logo (px)` (schema) | b2b-header-simple (130, 135), b2b-portal-home (587, 593) — **2 cada uno** | reusar Dawn cuando exista |

---

## Files scanned (in scope)

> Formato: `path` — (A, B, C). Solo se inventarían los `.liquid` del scope; los `.json` y assets quedan fuera (excepto la nota sobre legal HTML).

### sections/

| Archivo | (A) | (B) | (C) |
|---|---|---|---|
| sections/announcement-bar.liquid | 0 | 10 | 0 |
| sections/apps.liquid | 0 | 0 | 0 |
| sections/b2b-account-dashboard.liquid | 13 | 0 | 0 |
| sections/b2b-cuenta-rechazada.liquid | 10 | 0 | 0 |
| sections/b2b-cuenta-revision.liquid | 14 | 0 | 0 |
| sections/b2b-header-simple.liquid | 7 | 0 | 0 |
| sections/b2b-mis-solicitudes.liquid | 18 | 0 | 0 |
| sections/b2b-portal-home.liquid | 27 | 0 | 0 |
| sections/b2b-solicitud-detalle.liquid | 15 | 0 | 0 |
| sections/b2b-solicitud-enviada.liquid | 8 | 0 | 0 |
| sections/b2b-solicitud-form.liquid | 20 | 0 | 0 |
| sections/bulk-quick-order-list.liquid | 0 | 0 | 0 |
| sections/cart-drawer.liquid | 0 | 0 | 0 |
| sections/cart-icon-bubble.liquid | 0 | 2 | 0 |
| sections/cart-live-region-text.liquid | 0 | 1 | 0 |
| sections/cart-notification-button.liquid | 0 | 1 | 0 |
| sections/cart-notification-product.liquid | 0 | 0 | 0 |
| sections/collage.liquid | 0 | 2 | 0 |
| sections/collapsible-content.liquid | 0 | 1 | 0 |
| sections/collection-list.liquid | 0 | 5 | 0 |
| sections/contact-form.liquid | 0 | 16 | 0 |
| sections/custom-liquid.liquid | 0 | 0 | 0 |
| sections/email-signup-banner.liquid | 0 | 4 | 0 |
| sections/featured-blog.liquid | 0 | 9 | 0 |
| sections/featured-collection.liquid | 0 | 6 | 0 |
| sections/featured-product.liquid | 0 | 32 | 0 |
| sections/footer.liquid | 0 | 7 | 0 |
| sections/header.liquid | 0 | 6 | 0 |
| sections/image-banner.liquid | 0 | 0 | 0 |
| sections/image-with-text.liquid | 0 | 0 | 0 |
| sections/main-404.liquid | 0 | 3 | 0 |
| sections/main-acceso-profesional.liquid | 75 | 0 | 0 |
| sections/main-account.liquid | 0 | 23 | 0 |
| sections/main-activate-account.liquid | 0 | 9 | 0 |
| sections/main-addresses.liquid | 0 | 58 | 0 |
| sections/main-article.liquid | 0 | 18 | 0 |
| sections/main-blog.liquid | 0 | 0 | 0 |
| sections/main-cart-footer.liquid | 0 | 12 | 0 |
| sections/main-cart-items.liquid | 0 | 34 | 0 |
| sections/main-collection-banner.liquid | 0 | 1 | 0 |
| sections/main-collection-product-grid.liquid | 0 | 6 | 0 |
| sections/main-list-collections.liquid | 0 | 0 | 0 |
| sections/main-login.liquid | 0 | 20 | 0 |
| sections/main-order.liquid | 0 | 44 | 0 |
| sections/main-page.liquid | 0 | 0 | 0 |
| sections/main-password-footer.liquid | 0 | 11 | 0 |
| sections/main-password-header.liquid | 0 | 10 | 0 |
| sections/main-product.liquid | 3 | 46 | 0 |
| sections/main-registro-recibido.liquid | 14 | 0 | 0 |
| sections/main-reset-password.liquid | 0 | 9 | 0 |
| sections/main-search.liquid | 0 | 16 | 0 |
| sections/multicolumn.liquid | 0 | 3 | 0 |
| sections/multirow.liquid | 0 | 0 | 0 |
| sections/newsletter.liquid | 0 | 4 | 0 |
| sections/page.liquid | 0 | 1 | 0 |
| sections/pickup-availability.liquid | 0 | 7 | 0 |
| sections/predictive-search.liquid | 0 | 11 | 0 |
| sections/quick-order-list.liquid | 0 | 0 | 0 |
| sections/related-products.liquid | 0 | 0 | 0 |
| sections/rich-text.liquid | 0 | 0 | 0 |
| sections/slideshow.liquid | 0 | 13 | 0 |
| sections/video.liquid | 0 | 1 | 0 |

### snippets/

| Archivo | (A) | (B) | (C) |
|---|---|---|---|
| snippets/article-card.liquid | 0 | 4 | 0 |
| snippets/b2b-dashboard-cards.liquid | 5 | 0 | 0 |
| snippets/b2b-header-aprobado.liquid | 4 | 0 | 0 |
| snippets/buy-buttons.liquid | 0 | 6 | 0 |
| snippets/card-collection.liquid | 0 | 3 | 0 |
| snippets/card-product.liquid | 0 | 33 | 0 |
| snippets/cart-drawer.liquid | 0 | 43 | 0 |
| snippets/cart-notification.liquid | 0 | 5 | 0 |
| snippets/country-localization.liquid | 0 | 5 | 0 |
| snippets/facets.liquid | 0 | 55 | 0 |
| snippets/gift-card-recipient-form.liquid | 0 | 12 | 0 |
| snippets/header-drawer.liquid | 0 | 14 | 0 |
| snippets/header-dropdown-menu.liquid | 0 | 0 | 0 |
| snippets/header-mega-menu.liquid | 0 | 0 | 0 |
| snippets/header-search.liquid | 0 | 8 | 0 |
| snippets/icon-accordion.liquid | 0 | 0 | 0 |
| snippets/icon-with-text.liquid | 0 | 0 | 0 |
| snippets/language-localization.liquid | 0 | 0 | 0 |
| snippets/loading-spinner.liquid | 0 | 0 | 0 |
| snippets/meta-tags.liquid | 0 | 0 | 0 |
| snippets/pagination.liquid | 0 | 5 | 0 |
| snippets/price-facet.liquid | 0 | 2 | 0 |
| snippets/price.liquid | 0 | 9 | 0 |
| snippets/product-documents.liquid | 8 | 0 | 0 |
| snippets/product-media-gallery.liquid | 0 | 11 | 0 |
| snippets/product-media-modal.liquid | 0 | 3 | 0 |
| snippets/product-media.liquid | 0 | 2 | 0 |
| snippets/product-spec-badges.liquid | 6 | 0 | 0 |
| snippets/product-specs-table.liquid | 24 | 0 | 0 |
| snippets/product-thumbnail.liquid | 0 | 5 | 0 |
| snippets/product-variant-options.liquid | 0 | 2 | 0 |
| snippets/product-variant-picker.liquid | 0 | 0 | 0 |
| snippets/progress-bar.liquid | 0 | 0 | 0 |
| snippets/quantity-input.liquid | 0 | 3 | 0 |
| snippets/quick-order-list-row.liquid | 0 | 30 | 0 |
| snippets/quick-order-list.liquid | 0 | 27 | 0 |
| snippets/share-button.liquid | 0 | 4 | 0 |
| snippets/social-icons.liquid | 0 | 9 | 0 |
| snippets/swatch-input.liquid | 0 | 0 | 0 |
| snippets/swatch.liquid | 0 | 0 | 0 |
| snippets/unit-price.liquid | 0 | 1 | 0 |

### layout/

| Archivo | (A) | (B) | (C) |
|---|---|---|---|
| layout/theme.liquid | 2 | 25 | 0 |
| layout/password.liquid | 0 | 2 | 0 |

### templates/

| Archivo | (A) | (B) | (C) |
|---|---|---|---|
| templates/gift_card.liquid | 0 | 11 | 0 |

> Todas las demás `templates/*.json` no son `.liquid` y quedan fuera del inventario por-string. Algunas contienen overrides de schema `default_message` (ya documentados en sus respectivas secciones — `page.b2b-cuenta-en-revision.json`, `page.b2b-cuenta-rechazada.json`).

### Excluidos

- `sections/admin-backoffice-pendientes.liquid` (admin-only, queda en ES)
- `sections/admin-backoffice-resumen.liquid` (admin-only)
- `sections/admin-backoffice-whitelist.liquid` (admin-only)
- `snippets/locksmith.liquid` (auto-Locksmith)
- `snippets/locksmith-content-variables.liquid` (auto-Locksmith)
- `snippets/locksmith-variables.liquid` (auto-Locksmith)
- `pages/legal/aviso-legal.html` (HTML estático; refactor wholesale)
- `pages/legal/canal-de-denuncias.html` (HTML estático)
- `pages/legal/condiciones-de-uso.html` (HTML estático)
- `pages/legal/politica-de-privacidad.html` (HTML estático)

### Footer/header groups (JSON config)

- `sections/footer-group.json`, `sections/header-group.json` — solo configuración, sin strings inventariables (los strings viven en `footer.liquid`/`header.liquid` que ya son 100% B).

---

## Resumen final de números

- (A) = **218** strings hardcoded en 15 ficheros
- (B) = **801** strings ya `t:` keyed (Dawn) en 65 ficheros
- (C) = **0** strings ya `t:` keyed con namespace `ledsc4.*` (esperado: 0) ✅
- Schema labels (subset de A, en bloques `{% schema %}`) = **44 entradas** repartidas en 11 secciones — requieren su propio fichero `*.schema.json` para EN/FR.
- Templates JSON con strings traducibles vivos (no contados arriba): 2 (`page.b2b-cuenta-en-revision.json`, `page.b2b-cuenta-rechazada.json`).
- Páginas legales HTML: 4 (refactor wholesale, no por-string).
