/** E-invoice & e-way bill page (views/einvoice/index.ejs): saves or removes the IRN and e-way bill details. */

import { api, downloadText, formValues, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast } from '../core/page.js';

const documentId = encodeURIComponent(getPageData().einvoicePage.document.id);

function reloadWithMessage(message) {
  try {
    rememberToast(message);
  } catch {
    /* Saved work is not changed by unavailable browser storage. */
  }
  location.reload();
}

for (const form of document.querySelectorAll('[data-einvoice-form]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    showError(form, '');
    setBusy(button, true, 'Saving…');
    try {
      await api(`/documents/${documentId}/${form.dataset.einvoiceForm}`, sendJson('PUT', formValues(form)));
      reloadWithMessage('Saved. It now prints on the invoice.');
    } catch (error) {
      showError(form, error.message);
      setBusy(button, false);
    }
  });
}

// Downloads the e-way bill file here, so a wrong transport detail shows as a form error.
const ewayForm = document.querySelector('[data-eway-file]');
ewayForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(ewayForm, '');
  try {
    const file = await api(
      `/documents/${documentId}/eway-bill-file?${new URLSearchParams(formValues(ewayForm))}`,
    );
    downloadText(
      `${ewayForm.dataset.ewayFile.replace(/[^A-Za-z0-9-]+/g, '-')}-eway-bill.json`,
      JSON.stringify(file, null, 2),
      'application/json',
    );
  } catch (error) {
    showError(ewayForm, error.message);
  }
});

for (const button of document.querySelectorAll('[data-einvoice-clear]')) {
  button.addEventListener('click', async () => {
    if (button.disabled || !confirm('Remove these saved details from the invoice?')) return;
    setBusy(button, true, 'Removing…');
    try {
      await api(`/documents/${documentId}/${button.dataset.einvoiceClear}`, sendJson('DELETE'));
      reloadWithMessage('Removed.');
    } catch (error) {
      showError(null, error.message);
      setBusy(button, false);
    }
  });
}
