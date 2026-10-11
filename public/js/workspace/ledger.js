const filterForm = document.querySelector('[data-ledger-filters]');

function currentFilters() {
  const query = filterForm
    ? new URLSearchParams(new FormData(filterForm))
    : new URLSearchParams(window.location.search);
  for (const key of ['page', 'download', 'print']) query.delete(key);
  return query;
}

for (const [selector, key, value] of [
  ['[data-ledger-export]', 'download', 'csv'],
  ['[data-ledger-print-link]', 'print', '1'],
]) {
  document.querySelector(selector)?.addEventListener('click', (event) => {
    const query = currentFilters();
    query.set(key, value);
    event.currentTarget.href = `${window.location.pathname}?${query}`;
  });
}

document.querySelector('[data-print-statement]')?.addEventListener('click', () => window.print());
