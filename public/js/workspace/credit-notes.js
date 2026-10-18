/**
 * Credit notes pages (views/credit-notes/index.ejs and print.ejs): shows the GST split while
 * typing, issues a credit note against the invoice, records a refund, cancels one with a reason
 * and prints one.
 */

import { api, formValues, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast, workspacePath } from '../core/page.js';
import { gstAmounts, money } from '/shared/types.js';

const page = getPageData().creditNotePage;
const form = document.querySelector('[data-credit-note-form]');
// One ID per page load: a retried submit returns the same credit note instead of a second one.
const requestId = crypto.randomUUID();

function goTo(message, path) {
  try {
    rememberToast(message);
  } catch {
    /* Saved work is not changed by unavailable browser storage. */
  }
  location.assign(path);
}

function readForm() {
  const values = formValues(form);
  return { ...values, taxable: Number(values.taxable), gstRate: Number(values.gstRate), requestId };
}

function showPreview() {
  const preview = form.querySelector('[data-credit-note-preview]');
  const values = readForm();
  if (!(values.taxable > 0)) return (preview.textContent = '');
  const amounts = gstAmounts({ ...values, interstate: form.dataset.interstate === 'true' });
  const balance = Number(form.dataset.balance);
  const refund = Math.max(0, Math.round((amounts.total - balance) * 100) / 100);
  preview.textContent = `GST ${money(amounts.tax)} · Credit note total ${money(amounts.total)} · ${
    amounts.total > Number(form.dataset.creditable)
      ? 'More than can still be credited'
      : refund
        ? `Balance after credit ${money(0)} · Refund due ${money(refund)}`
        : `Balance after credit ${money(balance - amounts.total)}`
  }`;
}

if (form) {
  form.addEventListener('input', showPreview);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    showError(form, '');
    setBusy(button, true, 'Issuing…');
    try {
      const note = await api(
        `/documents/${encodeURIComponent(form.dataset.invoiceId)}/credit-notes`,
        sendJson('POST', readForm()),
      );
      goTo(`Credit note ${note.number} issued.`, workspacePath('credit_notes', 'preview', note.id));
    } catch (error) {
      showError(form, error.message);
      setBusy(button, false);
    }
  });
}

for (const button of document.querySelectorAll('[data-credit-note-cancel]')) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const reason = prompt(
      `Why is credit note ${button.dataset.creditNoteNumber} being cancelled? Its amount goes back to the invoice balance.`,
    )?.trim();
    if (!reason) return;
    setBusy(button, true, 'Cancelling…');
    try {
      await api(
        `/credit-notes/${encodeURIComponent(button.dataset.creditNoteCancel)}/cancel`,
        sendJson('POST', { reason }),
      );
      goTo('Credit note cancelled.', workspacePath('credit_notes', '', '', { month: page.month }));
    } catch (error) {
      showError(null, error.message);
      setBusy(button, false);
    }
  });
}

for (const refundForm of document.querySelectorAll('[data-credit-note-refund]')) {
  refundForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = refundForm.querySelector('[type="submit"]');
    if (button.disabled) return;
    showError(refundForm, '');
    setBusy(button, true, 'Saving…');
    try {
      await api(
        `/credit-notes/${encodeURIComponent(refundForm.dataset.creditNoteRefund)}/refund`,
        sendJson('POST', formValues(refundForm)),
      );
      goTo('Refund recorded.', workspacePath('credit_notes', '', '', { month: page.month }));
    } catch (error) {
      showError(refundForm, error.message);
      setBusy(button, false);
    }
  });
}

document.querySelector('[data-print-credit-note]')?.addEventListener('click', () => window.print());
