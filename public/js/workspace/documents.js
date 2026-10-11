import { api, sendJson, showToast, setBusy } from '../core/api.js';
import { getPageData, workspacePath, rememberToast } from '../core/page.js';

const data = getPageData();
const filters = document.querySelector('[data-document-list-filters]');
filters
  ?.querySelectorAll('select')
  .forEach((select) => select.addEventListener('change', () => filters.requestSubmit()));
// Export uses all matching records and also respects filter edits not yet submitted.
const exportLink = document.querySelector('[data-export-documents]');
exportLink?.addEventListener('click', () => {
  const target = new URL(filters.action, location.origin);
  target.search = new URLSearchParams(new FormData(filters)).toString();
  target.searchParams.set('download', 'csv');
  exportLink.href = target.pathname + target.search;
});

function action(selector, endpoint, message, targetView) {
  document.querySelectorAll(selector).forEach((button) =>
    button.addEventListener('click', async () => {
      const id =
        button.dataset.convertDocument || button.dataset.createDelivery || button.dataset.deleteDocument;
      setBusy(button, true, 'Working…');
      try {
        const deleting = Boolean(button.dataset.deleteDocument);
        const result = await api(`/documents/${id}${endpoint}`, sendJson(deleting ? 'DELETE' : 'POST'));
        rememberToast(message);
        location.assign(
          workspacePath(targetView || data.route.view, deleting ? undefined : 'preview', result?.id),
        );
      } catch (error) {
        showToast(error.message, 'error');
        setBusy(button, false);
      }
    }),
  );
}
action('[data-convert-document]', '/convert', 'Document converted to invoice.', 'invoices');
action('[data-create-delivery]', '/delivery-note', 'Delivery challan created.', 'shipping');
action('[data-delete-document]', '', 'Draft deleted.');
document.addEventListener('click', (event) =>
  document.querySelectorAll('.document-actions[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  }),
);
