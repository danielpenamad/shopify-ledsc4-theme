// B2B register form client-side logic.
//
// Responsibilities:
//   1. Validate NIF/NIE/CIF (format + control digit/letter) on blur + submit.
//   2. On submit, pack all B2B fields into customer[note] as JSON
//      (defensive fallback if customer[metafields][...] inputs were ignored).
//
// Activated by: <form data-b2b-register>
// Graceful: if no such form on the page, this script is a no-op.

(function () {
  'use strict';

  // --- NIF / NIE / CIF validators --------------------------------------------

  const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
  const CIF_CONTROL_LETTERS = 'JABCDEFGHI';

  function isValidDNI(value) {
    const m = /^([0-9]{8})([A-Z])$/.exec(value);
    if (!m) return false;
    const number = parseInt(m[1], 10);
    return DNI_LETTERS[number % 23] === m[2];
  }

  function isValidNIE(value) {
    const m = /^([XYZ])([0-9]{7})([A-Z])$/.exec(value);
    if (!m) return false;
    const prefixDigit = { X: '0', Y: '1', Z: '2' }[m[1]];
    const number = parseInt(prefixDigit + m[2], 10);
    return DNI_LETTERS[number % 23] === m[3];
  }

  function isValidCIF(value) {
    const m = /^([ABCDEFGHJKLMNPQRSUVW])([0-9]{7})([0-9A-J])$/.exec(value);
    if (!m) return false;
    const digits = m[2];
    let sumEven = 0; // digits at positions 2,4,6 (0-indexed: 1,3,5)
    let sumOdd = 0;  // digits at positions 1,3,5,7 (0-indexed: 0,2,4,6) doubled + digit-summed
    for (let i = 0; i < digits.length; i++) {
      const d = parseInt(digits[i], 10);
      if (i % 2 === 0) {
        const doubled = d * 2;
        sumOdd += doubled > 9 ? Math.floor(doubled / 10) + (doubled % 10) : doubled;
      } else {
        sumEven += d;
      }
    }
    const total = sumEven + sumOdd;
    const controlDigit = (10 - (total % 10)) % 10;
    const provided = m[3];
    // Organizations whose first letter is P/Q/R/S/N/W require a letter as control;
    // others allow either digit or letter. Accept both forms when the numeric
    // check matches.
    if (/[0-9]/.test(provided)) return parseInt(provided, 10) === controlDigit;
    return CIF_CONTROL_LETTERS[controlDigit] === provided;
  }

  function validateSpanishTaxId(raw) {
    if (!raw) return { ok: false, reason: 'vacio' };
    const value = String(raw).toUpperCase().replace(/[\s-]/g, '');
    if (isValidDNI(value)) return { ok: true, kind: 'DNI', normalized: value };
    if (isValidNIE(value)) return { ok: true, kind: 'NIE', normalized: value };
    if (isValidCIF(value)) return { ok: true, kind: 'CIF', normalized: value };
    return { ok: false, reason: 'formato_invalido' };
  }

  // --- Error messaging -------------------------------------------------------

  const ERRORS = {
    vacio: 'El NIF / CIF es obligatorio.',
    formato_invalido: 'El NIF / CIF no es válido (revisa formato y dígito de control).',
    terms: 'Debes aceptar las condiciones para continuar.',
    required: 'Este campo es obligatorio.',
  };

  function setFieldError(input, message) {
    const errorNode = document.getElementById(input.getAttribute('aria-describedby') || '');
    if (!errorNode) return;
    const textSpan = errorNode.querySelector('[data-b2b-error-text]');
    if (message) {
      errorNode.hidden = false;
      if (textSpan) textSpan.textContent = message;
      else errorNode.appendChild(document.createTextNode(message));
      input.setAttribute('aria-invalid', 'true');
    } else {
      errorNode.hidden = true;
      if (textSpan) textSpan.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  }

  // --- Form wiring -----------------------------------------------------------

  function wireForm(form) {
    const nifInput = form.querySelector('[data-b2b-validate="nif"]');
    const noteInput = form.querySelector('[data-b2b-note]');
    const termsInput = form.querySelector('[data-b2b-field="terms"]');

    if (nifInput) {
      nifInput.addEventListener('blur', function () {
        const res = validateSpanishTaxId(nifInput.value);
        setFieldError(nifInput, res.ok ? null : ERRORS[res.reason]);
        if (res.ok) nifInput.value = res.normalized;
      });
    }

    form.addEventListener('submit', function (event) {
      let ok = true;

      if (nifInput) {
        const res = validateSpanishTaxId(nifInput.value);
        if (!res.ok) {
          setFieldError(nifInput, ERRORS[res.reason]);
          ok = false;
        } else {
          nifInput.value = res.normalized;
          setFieldError(nifInput, null);
        }
      }

      if (termsInput && !termsInput.checked) {
        termsInput.setCustomValidity(ERRORS.terms);
        termsInput.reportValidity();
        ok = false;
      } else if (termsInput) {
        termsInput.setCustomValidity('');
      }

      if (noteInput) {
        const payload = {};
        form.querySelectorAll('[data-b2b-field]').forEach(function (el) {
          const key = el.getAttribute('data-b2b-field');
          if (key === 'terms') return;
          payload[key] = el.value;
        });
        payload.phone = (form.querySelector('input[name="customer[phone]"]') || {}).value || '';
        payload.source = 'b2b_register_form';
        payload.v = 1;
        noteInput.value = JSON.stringify(payload);
      }

      if (!ok) {
        event.preventDefault();
      }
    });
  }

  function init() {
    // Select any form that contains B2B fields. Avoids dependency on a
    // custom form attribute (Liquid's {% form %} tag makes that awkward).
    const nifInputs = document.querySelectorAll('[data-b2b-validate="nif"]');
    const seen = new Set();
    nifInputs.forEach(function (input) {
      const form = input.closest('form');
      if (form && !seen.has(form)) {
        seen.add(form);
        wireForm(form);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
