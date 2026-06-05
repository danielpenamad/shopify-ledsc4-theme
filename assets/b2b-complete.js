// B2B complete registration form — handler para el form de /pages/completar-registro.
//
// Carril gemelo de b2b-register-v2.js para customers que ya existen en
// Shopify (alta nativa por New Customer Accounts) y completan los datos
// B2B sobre su customer logueado. El backend es la edge function
// `complete-b2b-registration` (Supabase) que hace customerUpdate +
// tagsAdd 'pendiente' + emailMarketingConsent SUBSCRIBED + metafields b2b.*.
//
// Diferencias vs b2b-register-v2.js:
//   - No envía email (se identifica por customerId en el HMAC).
//   - No maneja EMAIL_ALREADY_EXISTS (no aplica: customer ya existe).
//   - Trata `noop:true` como éxito (customer ya estaba aprobado/rechazado:
//     no degradamos estado, pero le mostramos la misma confirmación que
//     un alta normal — la verdad del estado vive en Shopify, no aquí).
//   - Añade handling de 404 CUSTOMER_NOT_FOUND (sesión rota) y de
//     400 INVALID_PAYLOAD.
//
// Activado por: <form id="b2b-completar-form" data-endpoint="...">
// Graceful: si el form no está en la página, este script es no-op.

(function () {
  'use strict';

  var form = document.getElementById('b2b-completar-form');
  if (!form) return;

  var submitBtn = document.getElementById('b2b-completar-submit');
  var banner = document.getElementById('b2b-completar-banner');

  // i18n: reutiliza window.LEDSC4_I18N.acceso_form (mismas claves de err
  // y banner para los casos comunes) + window.LEDSC4_I18N.completar para
  // claves específicas. Liquid en main-completar-registro inyecta ambos.
  var I18N = (window.LEDSC4_I18N && window.LEDSC4_I18N.acceso_form) || {};
  var I18N_ERR = I18N.err || {};
  var I18N_BANNER = I18N.banner || {};
  var I18N_COMPLETAR = (window.LEDSC4_I18N && window.LEDSC4_I18N.completar) || {};
  var I18N_COMPLETAR_BANNER = I18N_COMPLETAR.banner || {};
  var LOCALE_PREFIX = (window.LEDSC4_I18N && window.LEDSC4_I18N.locale_prefix) || '';

  // --- NIF / NIE / CIF (port del registro classic) -----------------------

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
  function normalizeTaxId(raw) {
    return String(raw || '').toUpperCase().replace(/[\s.\-]/g, '');
  }

  // Validación ramificada por país. Paridad con register-v2.
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

  // --- Field error UI ----------------------------------------------------

  var ERRORS = {
    required:   I18N_ERR.required   || 'Este campo es obligatorio.',
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
      if (node) { node.textContent = message; node.hidden = false; }
      if (input) input.setAttribute('aria-invalid', 'true');
    } else {
      if (node) { node.textContent = ''; node.hidden = true; }
      if (input) input.removeAttribute('aria-invalid');
    }
  }

  function clearAllErrors() {
    Array.prototype.forEach.call(
      form.querySelectorAll('[data-field]'),
      function (node) { node.textContent = ''; node.hidden = true; }
    );
    Array.prototype.forEach.call(
      form.querySelectorAll('[aria-invalid]'),
      function (input) { input.removeAttribute('aria-invalid'); }
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

  // --- Validation --------------------------------------------------------

  function validateClient(values) {
    var errors = {};
    if (!values.nombre) errors.nombre = ERRORS.required;
    if (!values.apellidos) errors.apellidos = ERRORS.required;
    if (!values.empresa) errors.empresa = ERRORS.required;
    var taxRes = validateTaxId(values.nif, values.pais);
    if (!taxRes.ok) {
      errors.nif = taxRes.reason === 'es' ? ERRORS.nif : ERRORS.nif_format;
    }
    if (!values.sector) errors.sector = ERRORS.required;
    if (!values.pais) errors.pais = ERRORS.required;
    if (!values.condiciones) errors.condiciones = ERRORS.terms;
    return { errors: errors, normalized: { nif: taxRes.normalized } };
  }

  function readFormValues() {
    var fd = new FormData(form);
    return {
      timestamp: fd.get('timestamp'),
      nonce: fd.get('nonce'),
      signature: fd.get('signature'),
      customerId: (fd.get('customerId') || '').toString(),
      nombre: (fd.get('nombre') || '').toString().trim(),
      apellidos: (fd.get('apellidos') || '').toString().trim(),
      telefono: (fd.get('telefono') || '').toString().trim(),
      empresa: (fd.get('empresa') || '').toString().trim(),
      nif: (fd.get('nif') || '').toString().trim(),
      sector: (fd.get('sector') || '').toString(),
      pais: (fd.get('pais') || '').toString(),
      volumen_estimado: (fd.get('volumen_estimado') || '').toString(),
      condiciones: form.querySelector('#comp-terms') ? form.querySelector('#comp-terms').checked : false,
    };
  }

  // --- NIF live validation on blur ---------------------------------------

  // En blur SOLO normalizamos (uppercase + strip puntuación). El país puede
  // no estar elegido cuando el usuario sale del campo NIF, así que la
  // validación dura por país se queda en submit.
  var nifInput = document.getElementById('comp-nif');
  if (nifInput) {
    nifInput.addEventListener('blur', function () {
      if (!nifInput.value) return;
      nifInput.value = normalizeTaxId(nifInput.value);
      setFieldError(nifInput, 'nif', null);
    });
  }

  // --- Submit ------------------------------------------------------------

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = isLoading;
    var spinner = submitBtn.querySelector('.b2b-acceso__btn-spinner');
    var label = submitBtn.querySelector('.b2b-acceso__btn-label');
    if (spinner) spinner.hidden = !isLoading;
    if (label) label.textContent = isLoading ? (I18N.submit_loading || 'Enviando…') : ((I18N_COMPLETAR.form && I18N_COMPLETAR.form.submit) || I18N.submit || 'Enviar solicitud');
    Array.prototype.forEach.call(
      form.querySelectorAll('input, select, button'),
      function (el) { if (el !== submitBtn) el.disabled = isLoading; }
    );
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
                    form.querySelector('#comp-' + field);
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
      customerId: values.customerId,
      nombre: values.nombre,
      apellidos: values.apellidos,
      telefono: values.telefono || undefined,
      empresa: values.empresa,
      nif: values.nif,
      sector: values.sector,
      pais: values.pais,
      volumen_estimado: values.volumen_estimado || undefined,
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

        // 200 ok (incluye noop:true — customer ya gestionado; le mostramos
        // la misma página de "solicitud recibida" porque su estado real ya
        // estará reflejado en su próximo refresh del portal).
        if (s === 200 && b.ok) {
          window.location.assign(LOCALE_PREFIX + '/pages/registro-recibido');
          return;
        }

        if (s === 400 && b.code === 'VALIDATION_ERROR' && b.fieldErrors) {
          Object.keys(b.fieldErrors).forEach(function (field) {
            var input = form.querySelector('[name="' + field + '"]') ||
                        form.querySelector('#comp-' + field);
            setFieldError(input, field, b.fieldErrors[field]);
          });
          focusFirstError();
          return;
        }

        if (s === 400 && b.code === 'INVALID_PAYLOAD') {
          setBanner(
            I18N_COMPLETAR_BANNER.invalid_payload ||
            'Faltan datos requeridos o son incorrectos. Revisa el formulario y vuelve a enviar.'
          );
          return;
        }

        if (s === 401 && (b.code === 'SIGNATURE_EXPIRED' || b.code === 'INVALID_SIGNATURE')) {
          setBanner(
            I18N_BANNER.signature_expired_html ||
            'Tu sesión en el formulario ha caducado. <a href="" onclick="window.location.reload(); return false;">Recarga la página</a> y vuelve a intentarlo.'
          );
          return;
        }

        if (s === 404 && b.code === 'CUSTOMER_NOT_FOUND') {
          setBanner(
            I18N_COMPLETAR_BANNER.session_error ||
            'No hemos podido identificar tu sesión. <a href="" onclick="window.location.reload(); return false;">Recarga la página</a> y vuelve a intentarlo.'
          );
          return;
        }

        if (s === 502) {
          setBanner(
            I18N_BANNER.service_unavailable_html ||
            'Servicio temporalmente no disponible. Vuelve a intentarlo en unos minutos. Si persiste, escribe a <a href="mailto:soporte@ledsc4.com">soporte@ledsc4.com</a>.'
          );
          return;
        }

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
        if (window.console && console.error) console.error('[b2b-complete]', err);
      })
      .then(function () {
        setLoading(false);
      });
  });
})();
