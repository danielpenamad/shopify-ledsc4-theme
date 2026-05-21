(function () {
  const input = document.getElementById('StockMinInput');
  if (!input) return;

  const statusEl = document.querySelector('.facets__stock-min-status');
  const cardSelector = '[data-stock]';

  function applyFilter() {
    const raw = input.value.trim();
    const min = raw === '' ? 0 : Math.max(0, parseInt(raw, 10) || 0);
    const cards = document.querySelectorAll(cardSelector);
    let visible = 0;
    let total = 0;

    cards.forEach((card) => {
      const stock = parseInt(card.dataset.stock, 10) || 0;
      const wrapper = card.closest('li, .grid__item') || card;
      total++;
      if (min === 0 || stock >= min) {
        wrapper.hidden = false;
        visible++;
      } else {
        wrapper.hidden = true;
      }
    });

    if (statusEl) {
      if (min === 0) {
        statusEl.hidden = true;
      } else {
        const template = statusEl.dataset.template || '{{ visible }} / {{ total }}';
        statusEl.textContent = template
          .replace('{{ visible }}', visible)
          .replace('{{ total }}', total);
        statusEl.hidden = false;
      }
    }

    const url = new URL(window.location.href);
    if (min === 0) url.searchParams.delete('min_stock');
    else url.searchParams.set('min_stock', min);
    window.history.replaceState({}, '', url.toString());
  }

  const params = new URLSearchParams(window.location.search);
  const initial = params.get('min_stock');
  if (initial) {
    input.value = initial;
    applyFilter();
  }

  let timer = null;
  const stopBubble = (e) => e.stopPropagation();
  input.addEventListener('input', (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    timer = setTimeout(applyFilter, 200);
  });
  input.addEventListener('change', stopBubble);
  input.addEventListener('keydown', stopBubble);

  const observer = new MutationObserver(() => {
    if (input.value.trim() !== '') applyFilter();
  });
  const grid =
    document.getElementById('product-grid') ||
    document.querySelector('.product-grid, .collection-list');
  if (grid) observer.observe(grid, { childList: true, subtree: false });
})();
