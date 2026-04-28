// Progressive enhancement for Dawn's <price-range> filter:
// adds a dual-handle range slider above the existing min/max text inputs.
// The inputs remain the source of truth — the slider just edits them and
// dispatches 'input' events, which Dawn's <facet-filters-form> already
// listens to (debounced 800ms) for AJAX submission.

(function () {
  const ENHANCED_FLAG = 'data-price-slider-attached';

  class PriceSlider {
    constructor(priceRange) {
      this.host = priceRange;
      const inputs = priceRange.querySelectorAll('input');
      if (inputs.length < 2) return;
      this.minInput = inputs[0];
      this.maxInput = inputs[1];

      this.absMin = parseFloat((this.minInput.dataset.min || '0').replace(',', '.')) || 0;
      this.absMax = parseFloat((this.minInput.dataset.max || '0').replace(',', '.')) || 0;
      if (this.absMax <= this.absMin) return;

      this.build();
      this.syncFromInputs();
      this.bind();
      priceRange.setAttribute(ENHANCED_FLAG, '');
    }

    build() {
      const wrap = document.createElement('div');
      wrap.className = 'price-slider';
      wrap.innerHTML = `
        <div class="price-slider__track" data-track>
          <div class="price-slider__range" data-range></div>
          <button type="button" class="price-slider__thumb price-slider__thumb--min" data-thumb="min"
            role="slider" aria-label="Precio mínimo" aria-valuemin="${this.absMin}" aria-valuemax="${this.absMax}" aria-valuenow="${this.absMin}"></button>
          <button type="button" class="price-slider__thumb price-slider__thumb--max" data-thumb="max"
            role="slider" aria-label="Precio máximo" aria-valuemin="${this.absMin}" aria-valuemax="${this.absMax}" aria-valuenow="${this.absMax}"></button>
        </div>
      `;
      // Insert as the first child so it sits above the input fields.
      this.host.insertBefore(wrap, this.host.firstChild);
      this.track = wrap.querySelector('[data-track]');
      this.range = wrap.querySelector('[data-range]');
      this.minThumb = wrap.querySelector('[data-thumb="min"]');
      this.maxThumb = wrap.querySelector('[data-thumb="max"]');
    }

    parseInputValue(input, fallback) {
      const raw = (input.value || '').toString().replace(/\s/g, '').replace(',', '.');
      const v = parseFloat(raw);
      return Number.isFinite(v) ? v : fallback;
    }

    syncFromInputs() {
      this.minVal = this.clamp(this.parseInputValue(this.minInput, this.absMin), this.absMin, this.absMax);
      this.maxVal = this.clamp(this.parseInputValue(this.maxInput, this.absMax), this.absMin, this.absMax);
      if (this.minVal > this.maxVal) [this.minVal, this.maxVal] = [this.maxVal, this.minVal];
      this.render();
    }

    clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

    pct(v) {
      return ((v - this.absMin) / (this.absMax - this.absMin)) * 100;
    }

    render() {
      const minPct = this.pct(this.minVal);
      const maxPct = this.pct(this.maxVal);
      this.minThumb.style.left = minPct + '%';
      this.maxThumb.style.left = maxPct + '%';
      this.range.style.left = minPct + '%';
      this.range.style.right = (100 - maxPct) + '%';
      this.minThumb.setAttribute('aria-valuenow', String(Math.round(this.minVal)));
      this.maxThumb.setAttribute('aria-valuenow', String(Math.round(this.maxVal)));
    }

    bind() {
      this.minThumb.addEventListener('pointerdown', (e) => this.startDrag(e, 'min'));
      this.maxThumb.addEventListener('pointerdown', (e) => this.startDrag(e, 'max'));
      this.minThumb.addEventListener('keydown', (e) => this.onKeyNudge(e, 'min'));
      this.maxThumb.addEventListener('keydown', (e) => this.onKeyNudge(e, 'max'));
      // Re-sync slider when user types in the inputs.
      this.minInput.addEventListener('input', () => this.syncFromInputs());
      this.maxInput.addEventListener('input', () => this.syncFromInputs());
    }

    startDrag(event, which) {
      event.preventDefault();
      const thumb = which === 'min' ? this.minThumb : this.maxThumb;
      thumb.setPointerCapture(event.pointerId);
      const move = (ev) => this.onDrag(ev, which);
      const up = (ev) => {
        thumb.releasePointerCapture(event.pointerId);
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
        thumb.removeEventListener('pointercancel', up);
        this.commit(which);
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
      thumb.addEventListener('pointercancel', up);
    }

    onDrag(event, which) {
      const rect = this.track.getBoundingClientRect();
      if (rect.width === 0) return;
      const ratio = this.clamp((event.clientX - rect.left) / rect.width, 0, 1);
      let value = this.absMin + ratio * (this.absMax - this.absMin);
      value = Math.round(value);
      if (which === 'min') {
        this.minVal = this.clamp(value, this.absMin, this.maxVal);
      } else {
        this.maxVal = this.clamp(value, this.minVal, this.absMax);
      }
      this.render();
    }

    onKeyNudge(event, which) {
      const stepKeys = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
      const homeEnd = { Home: this.absMin, End: this.absMax };
      let changed = false;
      if (event.key in stepKeys) {
        if (which === 'min') {
          this.minVal = this.clamp(this.minVal + stepKeys[event.key], this.absMin, this.maxVal);
        } else {
          this.maxVal = this.clamp(this.maxVal + stepKeys[event.key], this.minVal, this.absMax);
        }
        changed = true;
      } else if (event.key in homeEnd) {
        if (which === 'min') this.minVal = this.clamp(homeEnd[event.key], this.absMin, this.maxVal);
        else this.maxVal = this.clamp(homeEnd[event.key], this.minVal, this.absMax);
        changed = true;
      }
      if (changed) {
        event.preventDefault();
        this.render();
        this.commit(which);
      }
    }

    formatValue(v) {
      // Match Dawn's input format: integer or decimal with comma/dot.
      // Use locale guess: if either input was entered with comma, use comma.
      const sample = (this.minInput.value || this.maxInput.value || '');
      const decimal = sample.includes(',') ? ',' : '.';
      const rounded = Math.round(v);
      return decimal === ',' ? String(rounded) : String(rounded);
    }

    commit(which) {
      const target = which === 'min' ? this.minInput : this.maxInput;
      const value = which === 'min' ? this.minVal : this.maxVal;
      // Clear when at the absolute boundary so the URL doesn't get polluted.
      const atBoundary = which === 'min' ? value <= this.absMin : value >= this.absMax;
      target.value = atBoundary ? '' : this.formatValue(value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function enhanceAll(root = document) {
    root.querySelectorAll(`price-range:not([${ENHANCED_FLAG}])`).forEach((el) => new PriceSlider(el));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceAll());
  } else {
    enhanceAll();
  }

  // Dawn AJAX-renders the facets after each filter change. Watch the DOM
  // and re-enhance any new <price-range> instances.
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'PRICE-RANGE' && !node.hasAttribute(ENHANCED_FLAG)) {
          new PriceSlider(node);
        } else {
          enhanceAll(node);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
