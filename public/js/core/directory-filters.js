/** Contacts/catalog list filters: dropdowns submit immediately; the CSV link always uses the current filters. */

/** Directory filters use server pagination; export always includes current, even unsubmitted, filters. */
export function bindDirectoryFilters(form, exportLink, organizationId, kind) {
  if (!form) return;
  form
    .querySelectorAll('select')
    .forEach((select) => select.addEventListener('change', () => form.requestSubmit()));
  form.querySelectorAll('[data-filter]').forEach((button) =>
    button.addEventListener('click', () => {
      form.elements.namedItem('type').value = button.dataset.filter;
      form.requestSubmit();
    }),
  );
  exportLink?.addEventListener('click', () => {
    const query = new URLSearchParams(new FormData(form));
    query.set('organizationId', organizationId);
    query.delete('page');
    query.delete('returnTo');
    exportLink.href = `/api/${kind}/export?${query}`;
  });
}
