// B2B register form v2 — handler para el form de /pages/acceso-profesional#registro.
//
// Sustituye al flujo /account/register clásico (que Shopify rompió al
// forzar new customer accounts). El form ya no envía a Shopify directo
// sino a la edge function `register-b2b-customer` (Supabase) que crea el
// customer en Admin API con metafields completos y lanza el invite por
// email.
//
// Activado por: <form id="b2b-registro-form" data-endpoint="...">
// Graceful: si el form no está en la página, este script es no-op.
//
// Validación client-side (NIF/CIF/NIE, email, requeridos) replicada
// inline aquí — el registro classic (assets/b2b-register.js) fue
// eliminado en cleanup C.6 T6 (2026-05-09).
//
// Compartido por dos landings (Fase 2 instalador, 2026-07):
// main-acceso-profesional.liquid (distribuidor, hidden sector="otro") y
// main-acceso-instalador.liquid (hidden sector="instalador", sin campo
// empresa, NIF opcional). Paridad con register-b2b-customer server-side.

(function () {
  'use strict';

  var form = document.getElementById('b2b-registro-form');
  if (!form) return;

  var submitBtn = document.getElementById('b2b-registro-submit');
  var banner = document.getElementById('b2b-registro-banner');

  // i18n: el bloque <script> de Liquid en main-acceso-profesional.liquid
  // pobla window.LEDSC4_I18N.acceso_form antes de este IIFE (defer garantiza
  // orden). Fallback ES literal por defensa si la inyección fallara.
  var I18N = (window.LEDSC4_I18N && window.LEDSC4_I18N.acceso_form) || {};
  var I18N_ERR = I18N.err || {};
  var I18N_BANNER = I18N.banner || {};
  // LOCALE_PREFIX (Sprint 3.5 + hotfix concat): viene de
  // window.LEDSC4_I18N.locale_prefix inyectado desde Liquid. Valor:
  // '' en home, '/fr' en /fr (sin trailing slash). Default '' si falta.
  // Usos: LOCALE_PREFIX + '/path/X' (con slash inicial al path).
  var LOCALE_PREFIX = (window.LEDSC4_I18N && window.LEDSC4_I18N.locale_prefix) || '';

  // --- Atribución de campaña (UTMs, Extra A 2026-07) ---
  //
  // Capturados una vez al cargar el script desde window.location.search.
  // Un único sitio porque las dos landings (distribuidor e instalador)
  // comparten este mismo asset. Todos opcionales — un alta directa sin
  // UTMs en la URL debe funcionar exactamente igual. Mismo patrón
  // defensivo que el `?dest=` de las secciones Liquid: try/catch que
  // nunca debe romper el form si algo falla al leer la URL.
  var UTM_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  function captureUtms() {
    var out = {};
    try {
      var params = new URLSearchParams(window.location.search);
      UTM_PARAMS.forEach(function (key) {
        var v = params.get(key);
        if (v) out[key] = v;
      });
    } catch (e) {
      // UTMs son atribución opcional; nunca romper el form por esto.
    }
    return out;
  }
  var UTMS = captureUtms();
  var LOCALE_ISO = (document.documentElement && document.documentElement.lang) || 'es';

  // --- NIF / NIE / CIF (port del registro classic, eliminado en C.6 T6) ---

  var DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
  var CIF_CONTROL_LETTERS = 'JABCDEFGHI';

  function isValidDNI(v) {
    var m = /^([0-9]{8})([A-Z])$/.exec(v);
    if (!m) return false;
    return DNI_LETTERS[parseInt(m[1], 10) % 23] === m[2];
  }
  function isValidNIE(v) {
    var m = /^([XYZ])([0-9]{7})([A-Z])$/.exec(v);
    if (!m) return false;
    var prefix = { X: '0', Y: '1', Z: '2' }[m[1]];
    return DNI_LETTERS[parseInt(prefix + m[2], 10) % 23] === m[3];
  }
  function isValidCIF(v) {
    var m = /^([ABCDEFGHJKLMNPQRSUVW])([0-9]{7})([0-9A-J])$/.exec(v);
    if (!m) return false;
    var d = m[2], se = 0, so = 0;
    for (var i = 0; i < d.length; i++) {
      var n = parseInt(d[i], 10);
      if (i % 2 === 0) {
        var doubled = n * 2;
        so += doubled > 9 ? Math.floor(doubled / 10) + (doubled % 10) : doubled;
      } else {
        se += n;
      }
    }
    var ctrl = (10 - ((se + so) % 10)) % 10;
    var p = m[3];
    if (/[0-9]/.test(p)) return parseInt(p, 10) === ctrl;
    return CIF_CONTROL_LETTERS[ctrl] === p;
  }
  // Normalización compartida: uppercase + strip espacios/puntos/guiones.
  // Misma transformación que aplica el backend antes de validar.
  function normalizeTaxId(raw) {
    return String(raw || '').toUpperCase().replace(/[\s.\-]/g, '');
  }

  // Validación ramificada por país. Paridad con la edge function:
  //   - country === 'ES' → DNI / NIE / CIF con dígito de control.
  //   - resto (o null) → saneo mínimo 4–20 alfanuméricos.
  function validateTaxId(raw, country) {
    var v = normalizeTaxId(raw);
    if (!v) return { ok: false, reason: country === 'ES' ? 'es' : 'format' };
    if (country === 'ES') {
      if (isValidDNI(v) || isValidNIE(v) || isValidCIF(v)) {
        return { ok: true, normalized: v };
      }
      return { ok: false, reason: 'es' };
    }
    if (/^[A-Z0-9]{4,20}$/.test(v)) return { ok: true, normalized: v };
    return { ok: false, reason: 'format' };
  }

  // --- Field error UI ---

  var ERRORS = {
    required:   I18N_ERR.required   || 'Este campo es obligatorio.',
    email:      I18N_ERR.email      || 'Email no válido.',
    nif:        I18N_ERR.nif        || 'NIF / CIF / NIE no válido (revisa formato y dígito de control).',
    nif_format: I18N_ERR.nif_format || 'Introduce un identificador fiscal válido (4–20 caracteres, sin símbolos).',
    terms:      I18N_ERR.terms      || 'Debes aceptar las condiciones para continuar.',
  };

  function findErrorNode(fieldName) {
    return form.querySelector('[data-field="' + fieldName + '"]');
  }

  function setFieldError(input, fieldName, message) {
    var node = findErrorNode(fieldName);
    if (message) {
      if (node) {
        node.textContent = message;
        node.hidden = false;
      }
      if (input) input.setAttribute('aria-invalid', 'true');
    } else {
      if (node) {
        node.textContent = '';
        node.hidden = true;
      }
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  function clearAllErrors() {
    Array.prototype.forEach.call(
      form.querySelectorAll('[data-field]'),
      function (node) {
        node.textContent = '';
        node.hidden = true;
      }
    );
    Array.prototype.forEach.call(
      form.querySelectorAll('[aria-invalid]'),
      function (input) {
        input.removeAttribute('aria-invalid');
      }
    );
    if (banner) {
      banner.hidden = true;
      banner.textContent = '';
      banner.classList.remove('b2b-acceso__form-banner--success');
    }
  }

  function setBanner(html, options) {
    if (!banner) return;
    var opts = options || {};
    banner.innerHTML = html;
    banner.hidden = false;
    if (opts.success) banner.classList.add('b2b-acceso__form-banner--success');
    else banner.classList.remove('b2b-acceso__form-banner--success');
  }

  // --- Validation ---

  // Instalador (landing dedicada, hidden sector="instalador"): sin Company
  // por decisión de negocio → empresa/nif no son obligatorios en ese form.
  // Paridad con la validación server-side de register-b2b-customer.
  function validateClient(values) {
    var errors = {};
    var isInstalador = values.sector === 'instalador';
    if (!values.nombre) errors.nombre = ERRORS.required;
    if (!values.apellidos) errors.apellidos = ERRORS.required;
    if (!values.email) {
      errors.email = ERRORS.required;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
      errors.email = ERRORS.email;
    }
    if (!values.empresa && !isInstalador) errors.empresa = ERRORS.required;
    var taxRes = { ok: true, normalized: undefined };
    if (!(isInstalador && !values.nif)) {
      taxRes = validateTaxId(values.nif, values.pais);
      if (!taxRes.ok) {
        errors.nif = taxRes.reason === 'es' ? ERRORS.nif : ERRORS.nif_format;
      }
    }
    if (!values.sector) errors.sector = ERRORS.required;
    if (!values.pais) errors.pais = ERRORS.required;
    if (!values.codigo_postal) errors.codigo_postal = ERRORS.required;
    if (!values.condiciones) errors.condiciones = ERRORS.terms;
    return { errors: errors, normalized: { nif: taxRes.normalized } };
  }

  function readFormValues() {
    var fd = new FormData(form);
    return {
      timestamp: fd.get('timestamp'),
      nonce: fd.get('nonce'),
      signature: fd.get('signature'),
      nombre: (fd.get('nombre') || '').toString().trim(),
      apellidos: (fd.get('apellidos') || '').toString().trim(),
      email: (fd.get('email') || '').toString().trim().toLowerCase(),
      telefono: (fd.get('telefono') || '').toString().trim(),
      empresa: (fd.get('empresa') || '').toString().trim(),
      nif: (fd.get('nif') || '').toString().trim(),
      sector: (fd.get('sector') || '').toString(),
      pais: (fd.get('pais') || '').toString(),
      volumen_estimado: (fd.get('volumen_estimado') || '').toString(),
      codigo_postal: (fd.get('codigo_postal') || '').toString().trim(),
      condiciones: form.querySelector('#reg-terms') ? form.querySelector('#reg-terms').checked : false,
    };
  }

  // --- NIF live validation on blur ---

  // En blur SOLO normalizamos (uppercase + strip puntuación). No validamos
  // contra reglas por país porque cuando el usuario sale del campo NIF el
  // país puede no estar elegido todavía y daríamos un falso negativo.
  // La validación dura ocurre en submit, donde ya tenemos values.pais.
  var nifInput = document.getElementById('reg-nif');
  if (nifInput) {
    nifInput.addEventListener('blur', function () {
      if (!nifInput.value) return;
      nifInput.value = normalizeTaxId(nifInput.value);
      setFieldError(nifInput, 'nif', null);
    });
  }

  // --- Submit handler ---

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    var spinner = submitBtn.querySelector('.b2b-acceso__btn-spinner');
    var label = submitBtn.querySelector('.b2b-acceso__btn-label');
    if (spinner) spinner.hidden = !isLoading;
    if (label) label.textContent = isLoading ? (I18N.submit_loading || 'Enviando…') : (I18N.submit || 'Enviar solicitud');
    Array.prototype.forEach.call(
      form.querySelectorAll('input, select, button'),
      function (el) {
        if (el !== submitBtn) el.disabled = isLoading;
      }
    );
  }

  function truncateEmail(email) {
    if (!email) return '';
    var parts = email.split('@');
    if (parts.length !== 2) return email;
    var local = parts[0];
    var domain = parts[1];
    var visible = local.slice(0, 3);
    return visible + '…@' + domain;
  }

  function focusFirstError() {
    var firstInvalid = form.querySelector('[aria-invalid="true"]');
    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstInvalid.focus({ preventScroll: true });
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearAllErrors();

    var values = readFormValues();
    var validation = validateClient(values);

    if (Object.keys(validation.errors).length > 0) {
      Object.keys(validation.errors).forEach(function (field) {
        var input = form.querySelector('[name="' + field + '"]') ||
                    form.querySelector('#reg-' + field);
        setFieldError(input, field, validation.errors[field]);
      });
      focusFirstError();
      return;
    }

    if (validation.normalized.nif) values.nif = validation.normalized.nif;

    var endpoint = form.getAttribute('data-endpoint');
    if (!endpoint) {
      setBanner(
        I18N_BANNER.config_missing ||
        'Configuración incompleta del tema. Avisa al equipo y vuelve a intentarlo más tarde.'
      );
      return;
    }

    setLoading(true);

    var payload = {
      timestamp: Number(values.timestamp),
      nonce: values.nonce,
      signature: values.signature,
      nombre: values.nombre,
      apellidos: values.apellidos,
      email: values.email,
      telefono: values.telefono || undefined,
      empresa: values.empresa,
      nif: values.nif,
      sector: values.sector,
      pais: values.pais,
      volumen_estimado: values.volumen_estimado || undefined,
      codigo_postal: values.codigo_postal,
      utm_source: UTMS.utm_source,
      utm_medium: UTMS.utm_medium,
      utm_campaign: UTMS.utm_campaign,
      utm_term: UTMS.utm_term,
      utm_content: UTMS.utm_content,
      condiciones: values.condiciones === true,
    };

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      })
      .then(function (result) {
        var s = result.status;
        var b = result.body || {};

        if (s === 200 && b.ok) {
          var redirectTo = LOCALE_PREFIX + '/pages/registro-recibido?email=' +
            encodeURIComponent(truncateEmail(values.email));
          window.location.assign(redirectTo);
          return;
        }

        if (s === 409 && b.code === 'EMAIL_ALREADY_EXISTS') {
          // Fallback hardcoded — solo se usa si I18N_BANNER.email_exists_html
          // falta. return_to → completar-registro (igual que login_url_full
          // en la sección): el 409 suele ser cuenta fantasma sin datos B2B
          // y esa página resuelve todos los estados. Eliminar `&locale=...`
          // para revert selectivo si Locksmith no respeta el query param.
          var fallbackLoginUrl = '/customer_authentication/login?return_to=' +
            encodeURIComponent((LOCALE_PREFIX || '') + '/pages/completar-registro') +
            '&locale=' + LOCALE_ISO;
          setBanner(
            I18N_BANNER.email_exists_html ||
            'Ya existe una cuenta con este email. ' +
            '<a href="' + fallbackLoginUrl + '">Iniciar sesión</a>.'
          );
          var emailInput = form.querySelector('#reg-email');
          if (emailInput) emailInput.setAttribute('aria-invalid', 'true');
          return;
        }

        if (s === 400 && b.code === 'VALIDATION_ERROR' && b.fieldErrors) {
          // Failsafe (2026-06-11): si ningún fieldError matchea un campo
          // del form (nombre de campo desconocido), enseñamos los mensajes
          // en el banner — sin esto el usuario reintenta a ciegas.
          var painted = 0;
          Object.keys(b.fieldErrors).forEach(function (field) {
            var input = form.querySelector('[name="' + field + '"]') ||
                        form.querySelector('#reg-' + field);
            if (input || findErrorNode(field)) painted++;
            setFieldError(input, field, b.fieldErrors[field]);
          });
          if (painted === 0) {
            var unmatchedMsgs = Object.keys(b.fieldErrors).map(function (k) {
              return b.fieldErrors[k];
            }).join('<br>');
            setBanner(unmatchedMsgs ||
              I18N_BANNER.generic_fallback ||
              'Algo ha ido mal al enviar la solicitud. Vuelve a intentarlo.');
          }
          focusFirstError();
          return;
        }

        if (s === 401 && (b.code === 'SIGNATURE_EXPIRED' || b.code === 'INVALID_SIGNATURE')) {
          setBanner(
            I18N_BANNER.signature_expired_html ||
            'Tu sesión en el formulario ha caducado. ' +
            '<a href="" onclick="window.location.reload(); return false;">Recarga la página</a> ' +
            'y vuelve a intentarlo.'
          );
          return;
        }

        if (s === 502) {
          // Email de soporte vive en la traducción i18n (ledsc4.acceso.form.banner.service_unavailable_html).
          // Cuando se confirme email definitivo de soporte, edición del valor en es.default.json.
          setBanner(
            I18N_BANNER.service_unavailable_html ||
            'Servicio temporalmente no disponible. Vuelve a intentarlo en unos minutos. ' +
            'Si persiste, escribe a <a href="mailto:soporte@ledsc4.com">soporte@ledsc4.com</a>.'
          );
          return;
        }

        // Fallback genérico. b.message viene del backend (en español) cuando existe;
        // si no, cae a la clave i18n.
        setBanner(
          b.message || I18N_BANNER.generic_fallback ||
          'Algo ha ido mal al enviar la solicitud. Vuelve a intentarlo.'
        );
      })
      .catch(function (err) {
        setBanner(
          I18N_BANNER.network_error ||
          'No hemos podido conectar con el servidor. Comprueba tu conexión y vuelve a intentarlo.'
        );
        // Log a consola para debugging — el banner es lo que ve el usuario.
        if (window.console && console.error) console.error('[b2b-register-v2]', err);
      })
      .then(function () {
        setLoading(false);
      });
  });
})();
