import { api, sendJson } from '/js/core/api.js';
import { balanceDue, money } from '/shared/types.js';
import { escape, readableDate } from '/js/documents/document-ui.js';

const stateLabels = {
  creating: 'Creating',
  created: 'Ready to pay',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
  needs_review: 'Review required',
  creation_unknown: 'Creation unconfirmed',
};
const blockingState = (state) => !['paid', 'cancelled', 'expired'].includes(state);
export function safePaymentUrl(value, provider) {
  try {
    const url = new URL(value);
    const allowed =
      provider === 'cashfree'
        ? ['payments.cashfree.com', 'sandbox.cashfree.com', 'cashfree.com', 'www.cashfree.com']
        : provider === 'razorpay'
          ? ['rzp.io', 'rzp.to', 'razorpay.com', 'pages.razorpay.com']
          : [];
    return url.protocol === 'https:' && !url.username && !url.password && allowed.includes(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function createOnlineController({ getDocument, isDisabled, onBusy, onBlocking, onUpdated }) {
  const container = document.querySelector('#online-payment-content');
  let details = null;
  let loading = true;
  let busy = '';
  let error = '';
  let notice = '';
  let cancelLink = null;
  let showHistory = false;
  const providerName = (provider) =>
    provider === 'cashfree' ? 'Cashfree' : provider === 'razorpay' ? 'Razorpay' : 'payment provider';
  const path = () => `/documents/${encodeURIComponent(getDocument().id)}`;
  const eligible = () => {
    const doc = getDocument();
    return (
      doc.kind === 'invoice' &&
      ['sent', 'partially_paid'].includes(doc.status) &&
      !doc.finalizedAt &&
      balanceDue(doc) > 0
    );
  };
  function applyDetails(result) {
    details = result;
    onBlocking(result.hasBlockingPaymentLink);
    render();
  }
  async function refreshLedger() {
    const payments = await api(`${path()}/payments`);
    onUpdated(payments.document, payments);
  }
  async function load() {
    loading = true;
    error = '';
    onBlocking(true);
    render();
    try {
      applyDetails(await api(`${path()}/online-payments`));
    } catch (cause) {
      details = null;
      onBlocking(true);
      error = cause.message || 'Online payment status could not be loaded.';
    } finally {
      loading = false;
      render();
    }
  }
  async function perform(action, link) {
    if (busy || isDisabled() || loading) return;
    if (
      action === 'create' &&
      (!details?.configuration.configured || details.hasBlockingPaymentLink || !eligible())
    )
      return;
    if (action === 'cancel' && (!link?.providerId || !blockingState(link.state))) return;
    busy = action;
    error = '';
    notice = '';
    onBusy(true);
    if (action === 'create') onBlocking(true);
    render();
    try {
      const result =
        action === 'refresh'
          ? await api(`${path()}/online-payments`)
          : await api(
              `${path()}/payment-link${action === 'create' ? '' : `/${action}`}`,
              sendJson('POST', {}),
            );
      applyDetails(result);
      await refreshLedger();
      if (action === 'create')
        notice = result.links.some((item) => item.state === 'created')
          ? 'Payment link created. Copy the link to share it with your customer.'
          : 'The existing payment link has been refreshed.';
      else if (action === 'cancel') {
        cancelLink = null;
        notice = result.links.some((item) => item.id === link?.id && item.state === 'cancelled')
          ? 'Payment link cancelled. Verified receipts remain in invoice history.'
          : 'The latest provider status was checked. Review the link and balance.';
      } else
        notice =
          action === 'sync'
            ? `${providerName(details.configuration.provider)} verification finished. The balance includes verified payments.`
            : 'Payment link status refreshed.';
    } catch (cause) {
      // A failed response may still have reserved the balance. Re-read provider and ledger
      // before enabling another payment attempt or a manual receipt.
      const recovery = await Promise.allSettled([
        api(`${path()}/online-payments`).then(applyDetails),
        refreshLedger(),
      ]);
      if (recovery[0].status === 'rejected') {
        details = null;
        onBlocking(true);
      }
      error = `${cause.message || 'The payment request could not be completed.'}${recovery.some((result) => result.status === 'rejected') ? ' Refresh payment status before retrying.' : ''}`;
    } finally {
      busy = '';
      loading = false;
      onBusy(false);
      render();
    }
  }
  function renderLink(link) {
    const provider = link.provider || details?.configuration.provider;
    const url = safePaymentUrl(link.url, provider);
    const payable = ['created', 'partially_paid'].includes(link.state);
    const locked = loading || busy || isDisabled();
    const disabled = locked ? 'disabled' : '';
    return `<article class="online-payment-link"><div class="online-payment-link-top"><div><strong>${money(link.amount)}</strong><p>${money(link.amountReceived)} verified · Created ${escape(readableDate(link.createdAt, true))}</p></div><span class="online-payment-link-status online-payment-link-status-${escape(link.state)}">${escape(stateLabels[link.state] || link.state)}</span></div>${link.reviewReason ? `<p class="online-payment-message online-payment-message-error">${escape(link.reviewReason)}</p>` : ''}${url && payable ? `<div class="online-payment-link-address"><a href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escape(providerName(provider))} payment link">${escape(url)}</a></div>` : ''}<div class="online-payment-link-actions">${url && payable ? `<button type="button" class="payment-secondary" data-online-copy="${escape(link.id)}" ${disabled}>Copy payment link</button>` : ''}${link.providerId && blockingState(link.state) ? `<button type="button" class="payment-secondary" data-online-cancel="${escape(link.id)}" ${locked || !details.configuration.configured ? 'disabled' : ''}>Cancel link</button>` : ''}</div>${cancelLink === link.id ? `<div class="online-payment-message"><strong>Cancel this payment link?</strong><p>The provider checks the latest payment status before cancellation. Verified receipts stay in the invoice history.</p><div class="doc-action-row"><button type="button" class="payment-secondary" data-online-action="keep" ${disabled}>Keep link</button><button type="button" class="payment-danger" data-online-confirm="${escape(link.id)}" ${locked || !details.configuration.configured ? 'disabled' : ''}>Confirm cancellation</button></div></div>` : ''}<p class="online-payment-note">Reference: ${escape(link.referenceId)}<br>Last checked ${escape(readableDate(link.updatedAt, true))}${link.providerId ? ` · ${escape(link.providerId)}` : ''}</p></article>`;
  }
  function render() {
    const section = document.querySelector('#online-payments');
    section.setAttribute('aria-busy', String(loading || Boolean(busy)));
    if (loading) {
      container.innerHTML = '<p class="online-payment-loading" role="status">Loading payment links…</p>';
      return;
    }
    const configuration = details?.configuration;
    const configured = Boolean(configuration?.configured);
    const manual = configuration?.provider === 'none';
    const provider = providerName(configuration?.provider);
    const activeLinks = details?.links.filter((link) => blockingState(link.state)) || [];
    const closedLinks = details?.links.filter((link) => !blockingState(link.state)) || [];
    const canSync = configured && details?.links.some((link) => link.state !== 'paid');
    const disabled = busy || isDisabled() ? 'disabled' : '';
    const doc = getDocument();
    container.innerHTML = `${error ? `<p class="online-payment-message online-payment-message-error" role="alert">${escape(error)}</p>` : ''}${notice ? `<p class="online-payment-message online-payment-message-success" role="status">${escape(notice)}</p>` : ''}<p class="online-payment-mode">${manual ? 'Manual only' : configuration?.mode === 'test' ? 'Test mode' : configuration?.mode === 'live' ? 'Live mode' : 'Not configured'}${manual ? '' : ` · ${escape(provider)}`}</p>${details && !configured ? `<p class="online-payment-message">${manual ? 'Online collection is turned off for this invoice. Record confirmed bank transfers, QR payments or other manual receipts below.' : `${escape(provider)} setup is incomplete. ${!configuration.keyConfigured ? 'An administrator must configure this business’s credentials. ' : ''}${!configuration.webhookConfigured ? 'Configure the matching webhook and verification credentials. ' : ''}Manual receipts remain available when no active link reserves this balance.`}</p>` : ''}${configured && configuration.mode === 'test' ? '<p class="online-payment-message">Test payments do not transfer real money. Use test invoices while checking this integration.</p>' : ''}${details && !eligible() && !activeLinks.length ? `<p class="online-payment-message">${doc.status === 'draft' ? 'Mark this invoice Sent before creating a payment link.' : doc.status === 'cancelled' ? 'A payment link cannot be created for a cancelled invoice.' : 'This invoice has no outstanding balance to collect online.'}</p>` : ''}${details && !manual && eligible() && !activeLinks.length ? `<div class="online-payment-create"><button type="button" class="payment-primary" data-online-action="create" ${busy || isDisabled() || !configured || details.hasBlockingPaymentLink ? 'disabled' : ''}>Create link for ${money(balanceDue(doc))}</button><p class="online-payment-note">The link covers the outstanding balance and accepts partial payments. Verified receipts update the installment schedule.</p></div>` : ''}${activeLinks.length ? `<p class="online-payment-message">This balance has an active or unresolved online link. Verify it or cancel it before adding a manual receipt.</p><div class="online-payment-list">${activeLinks.map(renderLink).join('')}</div>` : ''}<button type="button" class="payment-secondary online-payment-retry" data-online-action="${canSync ? 'sync' : 'refresh'}" ${disabled}>${busy ? 'Checking…' : canSync ? `Verify with ${escape(provider)}` : 'Refresh link status'}</button>${closedLinks.length ? `<button type="button" class="online-payment-history-toggle" data-online-action="history" aria-expanded="${showHistory}">${showHistory ? 'Hide' : 'View'} completed and closed links (${closedLinks.length})</button>${showHistory ? `<div class="online-payment-list">${closedLinks.map(renderLink).join('')}</div>` : ''}` : ''}<p class="online-payment-footer">${manual ? 'Manual receipts update the invoice balance and installment schedule. Confirm funds reached the correct organization before recording a receipt.' : `Customers pay on ${escape(provider)}. Receipts are recorded after server verification. Opening a link or returning from checkout does not mark an invoice paid.`}</p>`;
  }
  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || busy || isDisabled()) return;
    if (button.dataset.onlineCopy) {
      const link = details?.links.find((item) => item.id === button.dataset.onlineCopy);
      const url = link && safePaymentUrl(link.url, link.provider || details.configuration.provider);
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        notice = 'Payment link copied.';
        error = '';
      } catch {
        error = 'The browser could not copy the link. Select the displayed link and copy it manually.';
      }
      render();
      return;
    }
    if (button.dataset.onlineCancel) {
      cancelLink = button.dataset.onlineCancel;
      render();
      return;
    }
    if (button.dataset.onlineConfirm)
      return perform(
        'cancel',
        details?.links.find((link) => link.id === button.dataset.onlineConfirm),
      );
    const action = button.dataset.onlineAction;
    if (action === 'keep') {
      cancelLink = null;
      render();
    } else if (action === 'history') {
      showHistory = !showHistory;
      render();
    } else if (['create', 'sync', 'refresh'].includes(action)) await perform(action);
  });
  return { load, render };
}
