/* ledsc4-currency-display.js — conversor de DISPLAY (cosmético).
 *
 * EUR es la única divisa real (carrito, draft, factura). Este script
 * SOLO reformatea los importes EUR ya pintados por Liquid para mostrar
 * un equivalente aproximado en USD o GBP cuando el visitante elige otra
 * divisa en el switcher. No toca Shopify, no cambia el cart, no llama
 * APIs.
 *
 * Contrato con Liquid:
 *  - Cada precio se pinta con `data-eur-amount="<centimos>"` (entero en
 *    céntimos EUR, como devuelve Shopify para line_price/cart.total_price/
 *    product.price). El conversor lee ese entero, divide entre 100,
 *    multiplica por la tasa, formatea con es-ES y reemplaza el texto.
 *  - Para precios de rango (min/max), opcionalmente
 *    `data-eur-amount-min` + `data-eur-amount-max` + un template i18n en
 *    `data-eur-range-template` con tokens {min}/{max}. Si no hay
 *    template, el conversor une "min – max".
 *
 * Tasas:
 *  - `window.LEDSC4_FX` es inyectada por layout/theme.liquid con el shop
 *    metafield `ledsc4.fx_rates` (refrescado semanalmente por la EF
 *    update-fx-rates desde Frankfurter/BCE). Forma:
 *      { base: 'EUR', USD: 1.16, GBP: 0.87, rate_date, updated_at, source }
 *  - Si LEDSC4_FX falta o no incluye la tasa pedida, el conversor cae a
 *    EUR y revela los precios (failsafe).
 *
 * Selección de divisa:
 *  - Cookie `ledsc4_currency` ∈ {EUR, USD, GBP}; default EUR.
 *  - `currency-switcher.liquid` la setea + dispara el evento
 *    `ledsc4:currency-changed`.
 *
 * Re-render del carrito (Dawn pubsub):
 *  - Se suscribe a `PUB_SUB_EVENTS.cartUpdate` para reconvertir tras
 *    cambios AJAX (cantidades, añadir/quitar). El DOM nuevo ya trae
 *    `data-eur-amount` porque Liquid lo renderiza siempre.
 *
 * Anti-flash:
 *  - Cuando cookie ≠ EUR, layout inyecta una hoja de estilo inline que
 *    oculta los `[data-eur-amount]` con visibility:hidden. Este script
 *    los revela tras la primera conversión. Failsafe: un timeout
 *    (FAILSAFE_REVEAL_MS) revela TODO pase lo que pase, y un try/catch
 *    global garantiza que un fallo de JS no deja precios ocultos.
 */
(function () {
  'use strict';

  var COOKIE_NAME = 'ledsc4_currency';
  var SUPPORTED = { EUR: 1, USD: 1, GBP: 1 };
  var SYMBOLS = { EUR: '€', USD: '$', GBP: '£' };
  var REVEAL_CLASS = 'ledsc4-fx-ready';
  var FAILSAFE_REVEAL_MS = 1500;

  function reveal() {
    document.documentElement.classList.add(REVEAL_CLASS);
  }

  // Failsafe global: pase lo que pase, los precios se revelan.
  var failsafeTimer = setTimeout(reveal, FAILSAFE_REVEAL_MS);
  window.addEventListener('error', reveal);

  function readCookie() {
    try {
      var m = document.cookie.match(/(?:^|; )ledsc4_currency=([^;]*)/);
      var v = m ? decodeURIComponent(m[1]) : null;
      return v && SUPPORTED[v] ? v : 'EUR';
    } catch (e) {
      return 'EUR';
    }
  }

  function getRate(target) {
    if (target === 'EUR') return 1;
    var fx = window.LEDSC4_FX;
    if (!fx || typeof fx[target] !== 'number' || fx[target] <= 0) return null;
    return fx[target];
  }

  // Formatea (centimosEUR, currency) → "≈ 12,34 $" o "12,34 €".
  // El símbolo ≈ NO se añade aquí; lo controla quien llama (solo va en el
  // primer precio de cada bloque), según spec.
  function formatAmount(eurCents, currency, withApprox) {
    var rate = getRate(currency);
    if (rate === null) {
      currency = 'EUR';
      rate = 1;
    }
    var value = (Number(eurCents) / 100) * rate;
    var formatted;
    try {
      formatted = value.toLocaleString('es-ES', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch (e) {
      formatted = value.toFixed(2);
    }
    var sym = SYMBOLS[currency] || '';
    var body = formatted + ' ' + sym; // 12,34 €
    return withApprox && currency !== 'EUR' ? '≈ ' + body : body;
  }

  // Para no parsear texto, reescribimos el contenido completo del nodo
  // que lleva data-eur-amount. data-fx-approx="1" marca el "primer precio
  // del bloque" donde sí va el ≈.
  function convertNode(node, currency) {
    var min = node.getAttribute('data-eur-amount-min');
    var max = node.getAttribute('data-eur-amount-max');
    var single = node.getAttribute('data-eur-amount');
    var withApprox = node.getAttribute('data-fx-approx') === '1';

    if (min !== null && max !== null) {
      var fMin = formatAmount(min, currency, false);
      var fMax = formatAmount(max, currency, withApprox);
      // Si min == max y solo había rango por seguridad, mostramos uno.
      var text;
      var tpl = node.getAttribute('data-eur-range-template');
      if (tpl) {
        text = tpl.replace('{min}', fMin).replace('{max}', fMax);
      } else {
        text = fMin + ' – ' + fMax;
      }
      node.textContent = text;
      return;
    }
    if (single !== null) {
      node.textContent = formatAmount(single, currency, withApprox);
    }
  }

  function convertAll(root) {
    var currency = readCookie();
    var scope = root || document;
    var nodes = scope.querySelectorAll('[data-eur-amount], [data-eur-amount-min]');
    for (var i = 0; i < nodes.length; i++) {
      try {
        convertNode(nodes[i], currency);
      } catch (e) {
        // un nodo roto no arrastra al resto
      }
    }
    clearTimeout(failsafeTimer);
    reveal();
  }

  // --- Bootstrapping ---

  function bootstrap() {
    convertAll(document);

    // Switcher dispara este evento (cookie ya seteada).
    window.addEventListener('ledsc4:currency-changed', function () {
      convertAll(document);
    });

    // Dawn pub/sub — el cart-drawer y main-cart-items reescriben innerHTML
    // tras update; reconvierte el DOM nuevo.
    try {
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined' && PUB_SUB_EVENTS.cartUpdate) {
        subscribe(PUB_SUB_EVENTS.cartUpdate, function () {
          // El render del cart es async; dejamos al siguiente tick.
          setTimeout(function () { convertAll(document); }, 0);
        });
      }
    } catch (e) {
      // pubsub no cargó — no es crítico.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
