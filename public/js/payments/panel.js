/**
 * Payments page for one invoice (views/payments/panel.ejs): record a manual receipt, void a receipt,
 * installment plan (schedule.js), online payment link (online.js) and the payment history.
 * Keeps all sections in sync and reacts to version conflicts with other tabs.
 */

import { api, sendJson } from '/js/core/api.js';
import { getPageData } from '/js/core/page.js';
import { balanceDue, money, paidAmount, PAYMENT_METHODS, STATUS_LABELS } from '/shared/types.js';
import { wholePaise } from '/shared/money.js';
import { indiaBusinessDate as indiaDate } from '/shared/business-date.js';
import { escape, readableDate } from '/js/documents/document-ui.js';
import { createOnlineController } from './online.js';
import { createScheduleController } from './schedule.js';

let invoice = getPageData().document;
let details = null;
let loading = true;
let busy = '';
let onlineBusy = false;
let onlineBlocking = true;
let requestId = crypto.randomUUID();
let voidPayment = null;
let online;
let schedule;
let scheduleVersion = null;
let scheduleAction = null;
let scheduleConflict = false;
const panel = document.querySelector('#payment-panel');
const form = document.querySelector('#payment-record-form');
const scheduleSection = document.querySelector('#payment-schedule');
const scheduleForm = document.querySelector('#payment-schedule-form');
const scheduleConflictNotice = document.createElement('div');
scheduleConflictNotice.id = 'payment-schedule-conflict';
scheduleConflictNotice.className = 'payment-error';
scheduleConflictNotice.hidden = true;
scheduleConflictNotice.tabIndex = -1;
scheduleConflictNotice.setAttribute('role', 'alert');
const scheduleConflictCopy = document.createElement('p');
const latestScheduleLink = document.createElement('a');
latestScheduleLink.className = 'payment-secondary';
latestScheduleLink.textContent = 'Open latest saved plan';
latestScheduleLink.href = `/workspace/${encodeURIComponent(invoice.organizationId)}/invoices/payments/${encodeURIComponent(invoice.id)}`;
latestScheduleLink.target = '_blank';
latestScheduleLink.rel = 'noopener';
latestScheduleLink.dataset.openLatestSchedule = '';
scheduleConflictNotice.append(scheduleConflictCopy, latestScheduleLink);
scheduleSection.insertBefore(scheduleConflictNotice, scheduleForm);
const field = (name) => form.elements.namedItem(name);
const processing = () => Boolean(busy) || onlineBusy;
const available = () => Boolean(details) && invoice.kind === 'invoice' && invoice.status !== 'cancelled';
const canRecord = () => available() && balanceDue(invoice) > 0 && !invoice.finalizedAt && !onlineBlocking;
const verifiedProvider = (id = '') =>
  id.startsWith('razorpay:') ? 'Razorpay' : id.startsWith('cashfree:') ? 'Cashfree' : '';
function message(text = '', error = false) {
  const target = document.querySelector(error ? '#payment-feedback' : '#payment-notice');
  target.textContent = text;
  target.hidden = !text;
}
function clearMessages() {
  message('');
  message('', true);
}
function showScheduleConflict() {
  const firstConflict = !scheduleConflict;
  scheduleConflict = true;
  scheduleConflictCopy.textContent =
    scheduleAction === 'remove'
      ? 'This invoice changed after you requested removal. Open the latest saved plan in another tab and review it before removing a schedule.'
      : 'This invoice changed while you were editing its schedule. Your unsaved entries remain below. Keep this tab open, then open the latest saved plan in another tab to compare and reapply the changes you want to keep.';
  scheduleConflictNotice.hidden = false;
  if (firstConflict) scheduleConflictNotice.focus();
}
function applyResult(result, resetAmount = true) {
  if (scheduleVersion !== null && (result.document.version ?? 0) !== scheduleVersion) showScheduleConflict();
  details = result;
  invoice = result.document;
  if (resetAmount) field('amount').value = balanceDue(invoice) > 0 ? balanceDue(invoice).toFixed(2) : '';
  render();
}
function renderAmountPreview() {
  const amount = Number(field('amount').value);
  const amountPaise = wholePaise(amount);
  const remaining = balanceDue(invoice);
  const valid =
    field('amount').value.trim() &&
    Number.isSafeInteger(amountPaise) &&
    amountPaise >= 1 &&
    amountPaise <= Math.round(remaining * 100);
  document.querySelector('#payment-after').textContent = valid
    ? `Balance after this payment: ${money(Math.max(0, Math.round(remaining * 100) - amountPaise) / 100)}.${amountPaise === Math.round(remaining * 100) ? ' The invoice will be marked Paid / Final and locked.' : ''}`
    : `Enter an amount of at least ₹0.01, with at most two decimal places, and no more than ${money(remaining)}.`;
  document.querySelector('#payment-record-button').disabled = processing() || !canRecord() || !valid;
}
function renderHistory() {
  const payments = [...(details?.payments || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const disabled = processing() || onlineBlocking ? 'disabled' : '';
  document.querySelector('#payment-history').innerHTML = payments.length
    ? payments
        .map(
          (payment) =>
            `<article class="payment-entry ${payment.voidedAt ? 'payment-entry-voided' : ''}"><div class="payment-entry-top"><div><strong>${escape(payment.creditNoteId ? 'Credit note' : PAYMENT_METHODS[payment.method] || payment.method)}</strong><p>${escape(readableDate(payment.paidOn))}${payment.reference ? ` · ${escape(payment.reference)}` : ''}</p><small>Recorded ${escape(readableDate(payment.createdAt, true))}</small></div><div class="payment-entry-amount"><strong>${money(payment.amount)}</strong><span>${payment.voidedAt ? 'Voided' : payment.creditNoteId ? 'Credit note' : verifiedProvider(payment.requestId) ? `${verifiedProvider(payment.requestId)} verified` : 'Manual receipt'}</span></div></div>${payment.notes ? `<p class="payment-entry-note">${escape(payment.notes)}</p>` : ''}${payment.voidedAt ? `<p class="payment-correction-note">Voided ${escape(readableDate(payment.voidedAt))} · ${escape(payment.voidReason)}</p>` : !verifiedProvider(payment.requestId) && !payment.creditNoteId && voidPayment?.id !== payment.id ? `<button type="button" class="payment-text-button" data-correct-payment="${escape(payment.id)}" ${disabled}>Correct entry</button>` : ''}${verifiedProvider(payment.requestId) ? `<p class="online-payment-verified">Verified by ${verifiedProvider(payment.requestId)}. Manage any refund through the provider.</p>` : ''}${voidPayment?.id === payment.id ? `<form class="payment-correction-form" id="payment-correction-form"><h3>Void this payment entry?</h3><p>This restores ${money(payment.amount)} to the balance and reopens a finalized invoice. It records a correction and does not send a refund.</p><label class="payment-field">Reason for correction<textarea name="reason" rows="2" maxlength="500" required ${processing() ? 'disabled' : ''}>${escape(voidPayment.reason || '')}</textarea></label><div class="doc-action-row"><button type="button" class="payment-secondary" data-payment-action="keep" ${processing() ? 'disabled' : ''}>Keep payment</button><button type="submit" class="payment-danger" ${disabled}>Confirm correction</button></div></form>` : ''}</article>`,
        )
        .join('')
    : '<p class="payment-no-events">No receipts recorded yet.</p>';
  const events = [...(details?.events || [])].sort((a, b) => b.at.localeCompare(a.at));
  document.querySelector('#payment-event-count').textContent = String(events.length);
  document.querySelector('#payment-audit-list').innerHTML = events.length
    ? `<ol>${events.map((event) => `<li><span class="payment-event-dot"></span><div><p>${escape(event.description)}</p><time datetime="${escape(event.at)}">${escape(readableDate(event.at, true))}</time></div></li>`).join('')}</ol>`
    : '<p class="payment-no-events">No activity recorded yet.</p>';
}
function render() {
  panel.setAttribute('aria-busy', String(loading || processing()));
  document.querySelector('#payment-loading').hidden = !loading;
  document.querySelector('#payment-state').textContent = invoice.finalizedAt
    ? 'Paid / Final'
    : STATUS_LABELS[invoice.status] || invoice.status;
  for (const [key, amount] of Object.entries({
    total: invoice.totals.total,
    received: paidAmount(invoice),
    remaining: balanceDue(invoice),
  }))
    document.querySelector(`[data-payment-total="${key}"]`).textContent = money(amount);
  document.querySelector('#payment-final-banner').hidden = !invoice.finalizedAt;
  document.querySelector('#payment-cancelled').hidden = invoice.status !== 'cancelled';
  document.querySelector('#payment-record-fields').disabled = processing() || !canRecord();
  document.querySelector('#payment-finalize-section').hidden =
    !available() || balanceDue(invoice) > 0 || Boolean(invoice.finalizedAt);
  const blocked = document.querySelector('#manual-payment-blocked');
  blocked.hidden = canRecord();
  blocked.textContent = !details
    ? 'Load payment history before recording receipts.'
    : invoice.finalizedAt
      ? 'This invoice is fully paid and finalized.'
      : invoice.status === 'cancelled'
        ? 'Payments cannot be added to a cancelled invoice.'
        : balanceDue(invoice) <= 0
          ? 'The invoice has no outstanding balance.'
          : onlineBlocking
            ? 'An active or unresolved online link may reserve the balance. Refresh, verify or cancel it before recording a manual receipt.'
            : '';
  for (const button of panel.querySelectorAll('[data-payment-action]')) button.disabled = processing();
  renderAmountPreview();
  renderHistory();
  schedule?.render();
  if (scheduleConflict && scheduleAction === 'edit') {
    // A later refresh/finalization must not hide the unsaved schedule used for comparison.
    scheduleForm.hidden = false;
    document.querySelector('#payment-schedule-view').hidden = true;
  }
  online?.render();
}
async function refreshHistory() {
  if (processing()) return;
  busy = 'refresh';
  clearMessages();
  render();
  try {
    const result = await api(`/documents/${encodeURIComponent(invoice.id)}/payments`);
    const savedAttempt = result.payments.some((payment) => payment.requestId === requestId);
    applyResult(result, savedAttempt);
    if (savedAttempt) {
      requestId = crypto.randomUUID();
      field('reference').value = '';
      field('notes').value = '';
    }
    message(
      savedAttempt
        ? 'Your saved receipt is listed below. Payment history refreshed.'
        : 'Payment history refreshed. Review the balance before retrying.',
    );
  } catch (error) {
    message(error.message || 'Payment history could not be refreshed.', true);
  } finally {
    busy = '';
    loading = false;
    render();
  }
}
async function saveInstallments(plan) {
  if (processing() || !available() || invoice.finalizedAt || scheduleConflict) return false;
  const version = scheduleVersion ?? invoice.version ?? 0;
  busy = 'schedule';
  clearMessages();
  render();
  try {
    const result = await api(
      `/documents/${encodeURIComponent(invoice.id)}/installments`,
      sendJson('PUT', { plan, version }),
    );
    scheduleVersion = null;
    scheduleAction = null;
    applyResult(result);
    message(
      plan
        ? 'Installment plan saved. Existing receipts apply to the earliest due installment first.'
        : 'Installment plan removed. Recorded payments and the invoice total are unchanged.',
    );
    return true;
  } catch (error) {
    if (error.code === 'DOCUMENT_VERSION_CONFLICT') showScheduleConflict();
    message(error.message || 'The installment plan could not be saved.', true);
    return false;
  } finally {
    busy = '';
    render();
  }
}
scheduleSection.addEventListener(
  'click',
  (event) => {
    if (processing() || loading || !details || scheduleConflict) return;
    const action = event.target.closest('[data-schedule-action]')?.dataset.scheduleAction;
    if (['edit', 'remove'].includes(action)) {
      // Capture before the controller opens its form; history refreshes must not rebase stale rows.
      scheduleVersion = invoice.version ?? 0;
      scheduleAction = action;
    } else if (['cancel', 'keep'].includes(action)) {
      scheduleVersion = null;
      scheduleAction = null;
    }
  },
  true,
);
schedule = createScheduleController({
  getDocument: () => invoice,
  isBusy: () => loading || !details || processing() || scheduleConflict,
  isManualBlocked: () => !canRecord(),
  onSave: saveInstallments,
  onRecord: (amount, label) => {
    if (processing() || !canRecord()) return;
    field('amount').value = Math.min(amount, balanceDue(invoice)).toFixed(2);
    renderAmountPreview();
    message(`Amount set for ${label}. Receipts apply to the earliest unpaid installment first.`);
    field('amount').focus();
    field('amount').scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
  },
});
online = createOnlineController({
  getDocument: () => invoice,
  isDisabled: () => Boolean(busy),
  onBusy: (value) => {
    onlineBusy = value;
    render();
  },
  onBlocking: (value) => {
    onlineBlocking = value;
    render();
  },
  onUpdated: (_doc, payments) => applyResult(payments),
});
form.addEventListener('input', renderAmountPreview);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (processing() || !canRecord()) return;
  clearMessages();
  const amount = Number(field('amount').value);
  const amountPaise = wholePaise(amount);
  if (
    !field('amount').value.trim() ||
    !Number.isSafeInteger(amountPaise) ||
    amountPaise < 1 ||
    amountPaise > Math.round(balanceDue(invoice) * 100)
  )
    return message(
      `Enter an amount of at least ₹0.01, with at most two decimal places, and no more than ${money(balanceDue(invoice))}.`,
      true,
    );
  if (!field('paidOn').value || field('paidOn').value > indiaDate())
    return message('Choose the date you received this payment, up to today.', true);
  const input = {
    amount: amountPaise / 100,
    paidOn: field('paidOn').value,
    method: field('method').value,
    reference: field('reference').value.trim(),
    notes: field('notes').value.trim(),
    requestId,
    finalizeWhenPaid: true,
  };
  busy = 'record';
  render();
  try {
    const result = await api(
      `/documents/${encodeURIComponent(invoice.id)}/payments`,
      sendJson('POST', input),
    );
    applyResult(result);
    field('reference').value = '';
    field('notes').value = '';
    requestId = crypto.randomUUID();
    message(
      result.document.finalizedAt
        ? 'Payment recorded. This invoice is now Paid / Final and locked for editing.'
        : 'Payment recorded. The outstanding balance has been updated.',
    );
  } catch (error) {
    message(
      error.message || 'The payment could not be recorded. Refresh payment history before retrying.',
      true,
    );
  } finally {
    busy = '';
    render();
  }
});
panel.addEventListener('input', (event) => {
  if (event.target.name === 'reason' && voidPayment) voidPayment.reason = event.target.value;
});
panel.addEventListener('submit', async (event) => {
  if (event.target.id !== 'payment-correction-form') return;
  event.preventDefault();
  if (!voidPayment || processing() || onlineBlocking || verifiedProvider(voidPayment.requestId)) return;
  const reason = event.target.elements.reason.value.trim();
  if (!reason) return message('Add a reason for correcting this payment.', true);
  busy = 'void';
  clearMessages();
  render();
  try {
    const result = await api(
      `/payments/${encodeURIComponent(voidPayment.id)}/void`,
      sendJson('POST', { reason }),
    );
    voidPayment = null;
    applyResult(result);
    requestId = crypto.randomUUID();
    message('Payment entry voided. The balance has been restored and the correction remains in the history.');
  } catch (error) {
    message(error.message || 'The payment could not be corrected.', true);
  } finally {
    busy = '';
    render();
  }
});
panel.addEventListener('click', async (event) => {
  if (processing() && event.target.closest('a')) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest('button');
  if (!button || processing()) return;
  if (button.dataset.correctPayment && !onlineBlocking) {
    const payment = details?.payments.find((item) => item.id === button.dataset.correctPayment);
    if (payment && !payment.voidedAt && !verifiedProvider(payment.requestId)) {
      voidPayment = { ...payment, reason: '' };
      clearMessages();
      renderHistory();
      document.querySelector('#payment-correction-form textarea').focus();
    }
    return;
  }
  if (button.dataset.paymentAction === 'refresh') return refreshHistory();
  if (button.dataset.paymentAction === 'keep') {
    voidPayment = null;
    renderHistory();
    return;
  }
  if (
    button.dataset.paymentAction === 'finalize' &&
    available() &&
    balanceDue(invoice) === 0 &&
    !invoice.finalizedAt
  ) {
    busy = 'finalize';
    clearMessages();
    render();
    try {
      applyResult(await api(`/documents/${encodeURIComponent(invoice.id)}/finalize`, sendJson('POST', {})));
      message('This invoice is now Paid / Final and locked for editing.');
    } catch (error) {
      message(error.message || 'The invoice could not be finalized.', true);
    } finally {
      busy = '';
      render();
    }
  }
});
render();
await Promise.allSettled([
  api(`/documents/${encodeURIComponent(invoice.id)}/payments`)
    .then((result) => applyResult(result))
    .catch((error) => message(error.message || 'Payment history could not be loaded.', true))
    .finally(() => {
      loading = false;
      render();
    }),
  online.load(),
]);
