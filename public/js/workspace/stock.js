/** Stock page (views/stock/index.ejs): saves a stock entry and deletes one after confirmation. */

import { api, formValues, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast } from '../core/page.js';

const organizationId = getPageData().organization.id;

function reloadWithMessage(message) {
  try {
    rememberToast(message);
  } catch {
    /* Saved work is not changed by unavailable browser storage. */
  }
  location.reload();
}

const form = document.querySelector('[data-stock-form]');
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  showError(form, '');
  const { direction, quantity, ...values } = formValues(form);
  setBusy(button, true, 'Saving…');
  try {
    await api(
      '/stock-adjustments',
      sendJson('POST', { ...values, organizationId, quantity: Number(direction) * Number(quantity) }),
    );
    reloadWithMessage('Stock entry saved.');
  } catch (error) {
    showError(form, error.message);
    setBusy(button, false);
  }
});

for (const button of document.querySelectorAll('[data-stock-delete]')) {
  button.addEventListener('click', async () => {
    if (button.disabled || !confirm('Delete this stock entry?')) return;
    setBusy(button, true, 'Deleting…');
    try {
      await api(`/stock-adjustments/${encodeURIComponent(button.dataset.stockDelete)}`, sendJson('DELETE'));
      reloadWithMessage('Stock entry deleted.');
    } catch (error) {
      showError(null, error.message);
      setBusy(button, false);
    }
  });
}
