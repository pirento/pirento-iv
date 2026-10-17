/**
 * Payment reminders page (views/reminders/index.ejs): save the automatic reminder policy (admin),
 * preview a reminder in a dialog and confirm sending it.
 */

import { api, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast } from '../core/page.js';
import { money } from '/shared/types.js';

const data = getPageData();
const organizationId = data.organization.id;
const policyForm = document.querySelector('[data-reminder-policy-form]');

function reloadWithMessage(message) {
  try {
    rememberToast(message);
  } catch {
    /* Successful work is not changed by unavailable browser storage. */
  }
  location.reload();
}

policyForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = policyForm.querySelector('[type="submit"]');
  if (button.disabled) return;
  showError(policyForm, '');
  const values = new FormData(policyForm);
  const offsets = values.getAll('offsets').map(Number);
  if (!offsets.length) return showError(policyForm, 'Choose at least one reminder timing.');
  setBusy(button, true, 'Saving…');
  try {
    await api(
      '/reminders/policy',
      sendJson('PUT', {
        organizationId,
        version: data.reminders.policy.version,
        enabled: values.has('enabled'),
        offsets,
      }),
    );
    reloadWithMessage('Reminder settings saved.');
  } catch (error) {
    showError(policyForm, error.message);
  } finally {
    setBusy(button, false);
  }
});

const dialog = document.querySelector('[data-reminder-dialog]');
const confirmation = dialog.querySelector('[data-reminder-confirm-form]');
const cancel = dialog.querySelector('[data-reminder-cancel]');
const confirm = confirmation.querySelector('[type="submit"]');
let selected;
let origin;
let loading = false;
let sending = false;

function closeDialog() {
  if (sending) return;
  dialog.close();
}

for (const button of document.querySelectorAll('[data-reminder-preview]')) {
  button.addEventListener('click', async () => {
    if (loading || dialog.open || button.disabled) return;
    const item = data.reminders.items[Number(button.dataset.reminderPreview)];
    if (!item?.canSend) return;
    loading = true;
    origin = button;
    setBusy(button, true, 'Loading…');
    try {
      const query = new URLSearchParams();
      if (item.installmentId) query.set('installmentId', item.installmentId);
      const preview = await api(
        `/documents/${encodeURIComponent(item.documentId)}/reminder-preview${query.size ? '?' + query : ''}`,
      );
      if (!preview.item.canSend)
        throw new Error(preview.item.unavailableReason || 'This reminder is unavailable.');
      selected = preview.item;
      dialog.querySelector('[data-reminder-invoice]').textContent = selected.documentNumber;
      dialog.querySelector('[data-reminder-to]').textContent = selected.customerEmail;
      dialog.querySelector('[data-reminder-subject]').textContent = preview.subject;
      dialog.querySelector('[data-reminder-date]').textContent = `${selected.dueDate} · ${selected.label}`;
      dialog.querySelector('[data-reminder-amount]').textContent = money(selected.balanceDue);
      showError(confirmation, '');
      dialog.showModal();
      document.body.classList.add('reminder-dialog-open');
      cancel.focus();
    } catch (error) {
      showError(null, error.message);
    } finally {
      loading = false;
      setBusy(button, false);
    }
  });
}

cancel.addEventListener('click', closeDialog);
dialog.addEventListener('cancel', (event) => {
  if (sending) event.preventDefault();
});
dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (
    event.target === dialog &&
    (event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom)
  )
    closeDialog();
});
dialog.addEventListener('close', () => {
  selected = undefined;
  document.body.classList.remove('reminder-dialog-open');
  origin?.focus();
});
confirmation.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selected || sending) return;
  sending = true;
  cancel.disabled = true;
  setBusy(confirm, true, 'Queueing…');
  showError(confirmation, '');
  try {
    const result = await api(
      `/documents/${encodeURIComponent(selected.documentId)}/reminders`,
      sendJson('POST', {
        installmentId: selected.installmentId,
        dueDate: selected.dueDate,
      }),
    );
    reloadWithMessage(
      result.duplicate ? 'This reminder is already in today’s history.' : 'Payment reminder queued.',
    );
  } catch (error) {
    showError(confirmation, error.message);
  } finally {
    sending = false;
    cancel.disabled = false;
    setBusy(confirm, false);
  }
});
