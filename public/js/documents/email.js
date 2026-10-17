/**
 * Invoice email page (views/documents/email.ejs): send the invoice (optionally with a payment link),
 * show delivery history and retry failed messages.
 */

import { api, sendJson } from '/js/core/api.js';
import { getPageData } from '/js/core/page.js';
import { balanceDue, DOCUMENT_LABELS } from '/shared/types.js';
import { organizationSupportEmail } from '/shared/business-identity.js';
import { escape, readableDate } from './document-ui.js';

const doc = getPageData().document;
const panel = document.querySelector('#messaging-panel');
const statusLabels = {
  held: 'Setup needed',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Provider accepted',
  failed: 'Failed',
};
const kindLabels = {
  invoice: 'Invoice email',
  payment_received: 'Part payment receipt',
  payment_paid: 'Payment complete',
  payment_failed: 'Payment unsuccessful',
  payment_reminder: 'Payment reminder',
  password_reset: 'Password reset',
};
let integration = null;
let messages = [];
let loading = true;
let busy = '';
let requestId = crypto.randomUUID();
let includePaymentLink = false;
let polling = false;
let historyRevision = 0;
const recipient = (doc.customerSnapshot.email || '').trim();
const validRecipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
const canPay = doc.kind === 'invoice' && balanceDue(doc) > 0 && doc.status !== 'cancelled';
const canSend = () =>
  Boolean(integration?.email.configured) &&
  validRecipient &&
  !['draft', 'cancelled'].includes(doc.status) &&
  doc.kind !== 'delivery_note';
function feedback(text = '', isError = false) {
  const target = document.querySelector(isError ? '#messaging-error' : '#messaging-notice');
  target.textContent = text;
  target.hidden = !text;
}
function clearFeedback() {
  feedback('');
  feedback('', true);
}
function renderHistory() {
  document.querySelector('#messaging-count').textContent = String(messages.length);
  document.querySelector('#messaging-history').innerHTML = messages.length
    ? messages
        .map(
          (message) =>
            `<li><div class="messaging-message-top"><strong>${escape(kindLabels[message.kind] || message.kind)}</strong><span class="messaging-status messaging-status-${escape(message.status)}">${escape(statusLabels[message.status] || message.status)}</span></div><p>${escape(message.subject)}</p><small>To: ${escape(message.to || 'Missing recipient')} · ${escape(readableDate(message.createdAt, true))}</small>${message.hasPaymentLink ? '<span class="messaging-link-badge">Payment link included</span>' : ''}${message.lastError ? `<p class="messaging-message-error">${escape(message.lastError)}</p>` : ''}${message.nextAttemptAt && message.attempts > 0 ? `<small>Next automatic attempt: ${escape(readableDate(message.nextAttemptAt, true))}</small>` : ''}${message.sentAt ? `<small>Accepted ${escape(readableDate(message.sentAt, true))}</small>` : ''}${message.canRetry ? `<button type="button" class="messaging-retry" data-retry-message="${escape(message.id)}" ${busy ? 'disabled' : ''}>${busy === message.id ? 'Queuing…' : message.status === 'held' ? 'Release saved email' : 'Retry delivery'}</button>` : ''}</li>`,
        )
        .join('')
    : '<li class="messaging-empty">No email notifications yet.</li>';
}
function render() {
  panel.setAttribute('aria-busy', String(loading || Boolean(busy)));
  document.querySelector('#messaging-loading').hidden = !loading;
  const configured = Boolean(integration?.email.configured);
  const paymentConfigured = Boolean(integration?.payment.configured);
  const manual = integration?.payment.provider === 'none';
  const provider =
    integration?.payment.provider === 'cashfree'
      ? 'Cashfree'
      : integration?.payment.provider === 'razorpay'
        ? 'Razorpay'
        : 'online';
  document.querySelector('#messaging-sender').textContent =
    `From: ${integration?.email.from || 'Sender setup pending'} · Reply-to: ${organizationSupportEmail(doc.organizationSnapshot) || 'Not set'}`;
  const notes = [];
  if (!loading && !configured)
    notes.push(
      integration?.email.reason ||
        'Connect an email provider and verified sender in server settings. Saved held messages require explicit release.',
    );
  if (!validRecipient)
    notes.push(
      'Add a valid customer email and refresh the customer details on the draft document before sending. Issued documents keep their saved customer details.',
    );
  if (doc.status === 'draft')
    notes.push('This is a draft. Mark it Sent when it is ready to issue, then email it to the customer.');
  if (doc.status === 'cancelled') notes.push('A cancelled document cannot be emailed.');
  if (doc.kind === 'delivery_note')
    notes.push(
      'Delivery challans can be printed or downloaded from the preview. Email delivery is unavailable for this document type.',
    );
  document.querySelector('#messaging-availability').innerHTML = notes
    .map((note) => `<p class="messaging-alert">${escape(note)}</p>`)
    .join('');
  document.querySelector('#messaging-payment-option').hidden = !canPay || manual;
  const checkbox = document.querySelector('#messaging-payment-link');
  checkbox.disabled = !paymentConfigured || loading || Boolean(busy);
  checkbox.checked = includePaymentLink;
  document.querySelector('#messaging-payment-caption').textContent =
    `Include a secure ${provider} payment link`;
  document.querySelector('#messaging-payment-hint').textContent = !canPay
    ? ''
    : manual
      ? 'Online collection is disabled. The attached PDF can include the saved bank details and payment QR.'
      : includePaymentLink && paymentConfigured
        ? 'The payment link uses the current outstanding invoice balance.'
        : !paymentConfigured
          ? `Connect this business’s ${provider} payment account in server settings to enable links.`
          : 'This email will not contain an online payment link.';
  const send = document.querySelector('#messaging-send');
  send.disabled = loading || Boolean(busy) || !canSend();
  send.textContent =
    busy === 'send' ? 'Queuing email…' : `Queue ${DOCUMENT_LABELS[doc.kind].toLowerCase()} email`;
  document.querySelector('#messaging-refresh').disabled = loading || Boolean(busy);
  document.querySelector('#messaging-automation-title').textContent =
    `Payment notifications ${configured && integration?.email.automationEnabled ? 'enabled' : 'awaiting activation'}`;
  renderHistory();
}
async function load() {
  historyRevision += 1;
  loading = true;
  clearFeedback();
  render();
  const results = await Promise.allSettled([
    api(
      `/integrations/status?organizationId=${encodeURIComponent(doc.organizationId)}&documentId=${encodeURIComponent(doc.id)}`,
    ),
    api(`/documents/${encodeURIComponent(doc.id)}/messages`),
  ]);
  if (results[0].status === 'fulfilled') integration = results[0].value;
  else {
    integration = null;
    feedback(results[0].reason.message || 'Email configuration could not be loaded.', true);
  }
  if (results[1].status === 'fulfilled') messages = results[1].value;
  else feedback(results[1].reason.message || 'Email history could not be loaded.', true);
  loading = false;
  render();
}
document.querySelector('#messaging-payment-link').addEventListener('change', (event) => {
  includePaymentLink = event.target.checked;
  render();
});
document.querySelector('#messaging-refresh').addEventListener('click', () => {
  if (!loading && !busy) load();
});
document.querySelector('#messaging-send').addEventListener('click', async () => {
  if (busy || loading || !canSend()) return;
  busy = 'send';
  historyRevision += 1;
  clearFeedback();
  render();
  try {
    const result = await api(
      `/documents/${encodeURIComponent(doc.id)}/email`,
      sendJson('POST', {
        includePaymentLink: canPay && Boolean(integration?.payment.configured) && includePaymentLink,
        requestId,
      }),
    );
    requestId = crypto.randomUUID();
    messages = [result.message, ...messages.filter((message) => message.id !== result.message.id)];
    feedback(
      result.message.status === 'held'
        ? 'The email is held. Review setup details in its saved history.'
        : 'Document email queued. Delivery status will update here.',
    );
  } catch (error) {
    feedback(error.message || 'The email could not be queued.', true);
  } finally {
    busy = '';
    render();
  }
});
panel.addEventListener('click', async (event) => {
  if (busy && event.target.closest('a')) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest('[data-retry-message]');
  if (!button || busy || loading) return;
  const message = messages.find((item) => item.id === button.dataset.retryMessage);
  if (!message?.canRetry) return;
  busy = message.id;
  historyRevision += 1;
  clearFeedback();
  render();
  try {
    const result = await api(`/messages/${encodeURIComponent(message.id)}/retry`, sendJson('POST', {}));
    messages = messages.map((item) => (item.id === message.id ? result.message : item));
    feedback('The saved email is queued for another delivery attempt.');
  } catch (error) {
    feedback(error.message || 'The saved message could not be retried.', true);
  } finally {
    busy = '';
    render();
  }
});
const timer = window.setInterval(async () => {
  if (
    document.hidden ||
    busy ||
    loading ||
    polling ||
    !messages.some((message) => ['queued', 'sending'].includes(message.status))
  )
    return;
  polling = true;
  const revision = historyRevision;
  try {
    const history = await api(`/documents/${encodeURIComponent(doc.id)}/messages`);
    if (revision === historyRevision && !busy && !loading) {
      messages = history;
      renderHistory();
    }
  } catch {
    /* Keep the last known history; a user-requested refresh displays errors. */
  } finally {
    polling = false;
  }
}, 6000);
window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
await load();
