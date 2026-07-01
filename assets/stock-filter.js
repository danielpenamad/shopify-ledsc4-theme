(function () {
  if (!document.querySelector('[data-index="stock-min"]')) return;

  const cardSelector = '[data-stock]';

  let currentMin = 0;
  let boundInput = null;

  const params = new URLSearchParams(window.location.search);
  const initialParam = params.get('min_stock');
  if (initialParam) currentMin = Math.max(0, parseInt(initialParam, 10) || 0);

  function getInput() {
    return document.getElementById('StockMinInput');
  }

  function getStatusEl(input) {
    const details = input ? input.closest('.js-filter') : document.querySelector('[data-index="stock-min"]');
    return details ? details.querySelector('.facets__stock-min-status') : document.querySelector('.facets__stock-min-status');
  }

  function applyFilter() {
    const cards = document.querySelectorAll(cardSelector);
    let visible = 0;
    let total = 0;

    cards.forEach((card) => {
      const stock = parseInt(card.dataset.stock, 10) || 0;
      const wrapper = card.closest('li, .grid__item') || card;
      total++;
      if (currentMin === 0 || stock >= currentMin) {
        wrapper.hidden = false;
        visible++;
      } else {
        wrapper.hidden = true;
      }
    });

    const statusEl = getStatusEl(boundInput);
    if (statusEl) {
      if (currentMin === 0) {
        statusEl.hidden = true;
      } else {
        const template = statusEl.dataset.template || '{{ visible }} / {{ total }}';
        const nextText = template.replace('{{ visible }}', visible).replace('{{ total }}', total);
        if (statusEl.textContent !== nextText) statusEl.textContent = nextText;
        statusEl.hidden = false;
      }
    }

    const url = new URL(window.location.href);
    if (currentMin === 0) url.searchParams.delete('min_stock');
    else url.searchParams.set('min_stock', currentMin);
    window.history.replaceState(history.state, '', url.toString());
  }

  function setMin(value) {
    currentMin = value;
    applyFilter();
  }

  function bindInput(input) {
    if (!input || input.dataset.stockFilterBound === '1') return;
    input.dataset.stockFilterBound = '1';
    boundInput = input;
    input.value = currentMin ? String(currentMin) : '';

    let timer = null;
    const stopBubble = (e) => e.stopPropagation();
    input.addEventListener('input', (e) => {
      e.stopPropagation();
      const raw = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(() => {
        setMin(raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0));
      }, 200);
    });
    input.addEventListener('change', stopBubble);
    input.addEventListener('keydown', stopBubble);
  }

  function init() {
    bindInput(getInput());
    applyFilter();
  }

  init();

  // Dawn re-renders facets by swapping innerHTML of #Details-stock-min-* (via
  // FacetFiltersForm.renderFilters, assets/facets.js) whenever another filter
  // changes. That destroys and recreates #StockMinInput, dropping its
  // listeners. Watch that specific node (not document.body, to avoid our own
  // status-text updates re-triggering this observer) and rebind + restore
  // state whenever a fresh, unbound input appears.
  const facetsObserver = new MutationObserver(() => {
    const input = getInput();
    if (input && input.dataset.stockFilterBound !== '1') {
      bindInput(input);
      applyFilter();
    }
  });
  document.querySelectorAll('[data-index="stock-min"]').forEach((details) => {
    facetsObserver.observe(details, { childList: true, subtree: true });
  });

  // Dawn also swaps #ProductGridContainer's innerHTML wholesale on every
  // filter/sort/page change, which resets the `hidden` state we set on
  // product cards. Reapply once the grid has been replaced.
  const gridContainer = document.getElementById('ProductGridContainer');
  if (gridContainer) {
    const gridObserver = new MutationObserver(() => applyFilter());
    gridObserver.observe(gridContainer, { childList: true });
  }

  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get('min_stock');
    currentMin = v ? Math.max(0, parseInt(v, 10) || 0) : 0;
    const input = getInput();
    if (input) input.value = currentMin ? String(currentMin) : '';
    applyFilter();
  });
})();
