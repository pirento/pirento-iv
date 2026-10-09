import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import { balanceDue, money } from '../../../shared/types';
import type { BusinessDocument, PaymentDetails } from '../../../shared/types';
import type {
  OnlinePaymentDetails,
  OnlinePaymentLink,
  OnlinePaymentLinkState,
} from '../../../shared/online-payment-types';
import './online-payments.css';

interface OnlinePaymentsProps {
  document: BusinessDocument;
  onUpdated: (document: BusinessDocument, payments?: PaymentDetails) => void;
  onBlockingChange?: (blocking: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}

const stateLabels: Record<OnlinePaymentLinkState, string> = {
  creating: 'Creating',
  created: 'Ready to pay',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  cancelled: 'Cancelled',
  expired: 'Expired',
  needs_review: 'Review required',
  creation_unknown: 'Creation unconfirmed',
};
const blockingState = (state: OnlinePaymentLinkState) => !['paid', 'cancelled', 'expired'].includes(state);
const readableDate = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Unavailable'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(parsed);
};
function safePaymentUrl(value: string, provider: 'razorpay' | 'cashfree' | 'none' | undefined) {
  try {
    const url = new URL(value);
    const allowedHosts =
      provider === 'cashfree'
        ? ['payments.cashfree.com', 'sandbox.cashfree.com', 'cashfree.com', 'www.cashfree.com']
        : provider === 'razorpay'
          ? ['rzp.io', 'rzp.to', 'razorpay.com', 'pages.razorpay.com']
          : [];
    return url.protocol === 'https:' && !url.username && !url.password && allowedHosts.includes(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export default function OnlinePayments({
  document,
  onUpdated,
  onBlockingChange,
  onBusyChange,
  disabled = false,
}: OnlinePaymentsProps) {
  const [details, setDetails] = useState<OnlinePaymentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'sync' | 'cancel' | 'refresh' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cancelLink, setCancelLink] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const callbacks = useRef({ onUpdated, onBlockingChange, onBusyChange });
  callbacks.current = { onUpdated, onBlockingChange, onBusyChange };
  const working = useRef(false);
  const mounted = useRef(true);
  const remaining = balanceDue(document);
  const eligible =
    document.kind === 'invoice' &&
    ['sent', 'partially_paid'].includes(document.status) &&
    !document.finalizedAt &&
    remaining > 0;
  const activeLinks = details?.links.filter((link) => blockingState(link.state)) || [];
  const pastLinks = details?.links.filter((link) => !blockingState(link.state)) || [];
  const configured = Boolean(details?.configuration.configured);
  const blocked = !details || details.hasBlockingPaymentLink;
  const canSync = configured && Boolean(details?.links.some((link) => link.state !== 'paid'));
  const mode = details?.configuration.mode || 'unconfigured';
  const provider = details?.configuration.provider;
  const providerName =
    provider === 'cashfree' ? 'Cashfree' : provider === 'razorpay' ? 'Razorpay' : 'payment provider';
  const manualOnly = provider === 'none';
  const locked = loading || Boolean(busy) || disabled;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callbacks.current.onBusyChange?.(false);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDetails(null);
    setError('');
    setNotice('');
    setCancelLink(null);
    callbacks.current.onBlockingChange?.(true);
    api<OnlinePaymentDetails>(`/documents/${document.id}/online-payments`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) {
          setDetails(result);
          callbacks.current.onBlockingChange?.(result.hasBlockingPaymentLink);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Online payment status could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [document.id]);

  function applyDetails(result: OnlinePaymentDetails) {
    if (!mounted.current) return;
    setDetails(result);
    callbacks.current.onBlockingChange?.(result.hasBlockingPaymentLink);
  }

  async function refreshLedger() {
    const result = await api<PaymentDetails>(`/documents/${document.id}/payments`);
    if (mounted.current) callbacks.current.onUpdated(result.document, result);
  }

  async function perform(action: 'create' | 'sync' | 'cancel' | 'refresh', link?: OnlinePaymentLink) {
    if (working.current || disabled || loading) return;
    if (action === 'create' && (!configured || blocked || !eligible)) return;
    if (action === 'cancel' && (!link || !link.providerId || !blockingState(link.state))) return;
    working.current = true;
    setBusy(action);
    setError('');
    setNotice('');
    callbacks.current.onBusyChange?.(true);
    // An in-flight creation can reserve the balance even if the response is lost.
    if (action === 'create') callbacks.current.onBlockingChange?.(true);
    try {
      const result =
        action === 'refresh'
          ? await api<OnlinePaymentDetails>(`/documents/${document.id}/online-payments`)
          : await api<OnlinePaymentDetails>(
              `/documents/${document.id}/payment-link${action === 'create' ? '' : `/${action}`}`,
              sendJson('POST', {}),
            );
      applyDetails(result);
      await refreshLedger();
      if (!mounted.current) return;
      if (action === 'create')
        setNotice(
          result.links.some((item) => item.state === 'created')
            ? 'Payment link created. Copy the link to share it with your customer.'
            : 'The existing payment link has been refreshed.',
        );
      else if (action === 'cancel') {
        setCancelLink(null);
        setNotice(
          result.links.some((item) => item.id === link?.id && item.state === 'cancelled')
            ? 'Payment link cancelled. Any verified receipts remain in the invoice history.'
            : 'The latest provider status has been checked. Review the link and invoice balance below.',
        );
      } else
        setNotice(
          action === 'sync'
            ? `${providerName} verification finished. The balance includes verified payments.`
            : 'Payment link status refreshed.',
        );
    } catch (cause) {
      // Failed or interrupted requests may still have changed provider or ledger
      // state. Re-read both before allowing a manual receipt or another link.
      const recovery = await Promise.allSettled([
        api<OnlinePaymentDetails>(`/documents/${document.id}/online-payments`).then(applyDetails),
        refreshLedger(),
      ]);
      const recoveryFailed = recovery.some((result) => result.status === 'rejected');
      if (recovery[0].status === 'rejected') {
        if (mounted.current) setDetails(null);
        callbacks.current.onBlockingChange?.(true);
      }
      if (mounted.current)
        setError(
          `${cause instanceof Error ? cause.message : 'The payment request could not be completed.'}${recoveryFailed ? ' Refresh the payment status before retrying.' : ''}`,
        );
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(null);
        setLoading(false);
        callbacks.current.onBusyChange?.(false);
      }
    }
  }

  async function copyLink(url: string) {
    setError('');
    setNotice('');
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Payment link copied.');
    } catch {
      setError('The browser could not copy the link. Select the displayed link and copy it manually.');
    }
  }

  function renderLink(link: OnlinePaymentLink) {
    const linkProviderName =
      link.provider === 'cashfree' ? 'Cashfree' : link.provider === 'razorpay' ? 'Razorpay' : providerName;
    const url = safePaymentUrl(link.url, link.provider || provider);
    const active = blockingState(link.state);
    const payable = ['created', 'partially_paid'].includes(link.state);
    return (
      <article key={link.id} className="online-payment-link">
        <div className="online-payment-link-top">
          <div>
            <strong>{money(link.amount)}</strong>
            <p>
              {money(link.amountReceived)} verified · Created {readableDate(link.createdAt)}
            </p>
          </div>
          <span className={`online-payment-link-status online-payment-link-status-${link.state}`}>
            {stateLabels[link.state]}
          </span>
        </div>
        {link.reviewReason && (
          <p className="online-payment-message online-payment-message-error">{link.reviewReason}</p>
        )}
        {url && payable && (
          <div className="online-payment-link-address">
            <Link2 size={13} />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${linkProviderName} payment link for ${document.number}`}
            >
              {url}
              <ExternalLink size={11} aria-hidden="true" style={{ marginLeft: 5 }} />
            </a>
          </div>
        )}
        <div className="online-payment-link-actions">
          {url && payable && (
            <button
              type="button"
              className="payment-secondary"
              onClick={() => copyLink(url)}
              disabled={locked}
            >
              <Copy size={12} />
              Copy payment link
            </button>
          )}
          {link.providerId && active && (
            <button
              type="button"
              className="payment-secondary"
              onClick={() => setCancelLink(link.id)}
              disabled={locked || !configured}
            >
              <XCircle size={12} />
              Cancel link
            </button>
          )}
        </div>
        {!link.providerId && active && (
          <p className="online-payment-note">
            Creation could not be confirmed. Use “Verify with {providerName}” to recover the existing request.
            If it stays unresolved, an administrator must check the reference below in {linkProviderName}{' '}
            before another link or manual receipt can be created.
          </p>
        )}
        {cancelLink === link.id && active && (
          <div className="online-payment-confirm">
            <strong>Cancel this payment link?</strong>
            <p>
              The server checks {linkProviderName} for payments before cancellation. Existing receipts remain
              recorded; cancelling the link does not refund a payment.
            </p>
            <div>
              <button
                type="button"
                className="payment-secondary"
                disabled={locked}
                onClick={() => setCancelLink(null)}
              >
                Keep link
              </button>
              <button
                type="button"
                className="payment-danger"
                disabled={locked || !configured}
                onClick={() => perform('cancel', link)}
              >
                {busy === 'cancel' ? (
                  <LoaderCircle size={13} className="payment-spin" />
                ) : (
                  <XCircle size={13} />
                )}
                Confirm cancellation
              </button>
            </div>
          </div>
        )}
        <p className="online-payment-note">
          Reference: {link.referenceId}
          <br />
          Last checked {readableDate(link.updatedAt)}
          {link.providerId ? ` · ${link.providerId}` : ''}
        </p>
      </article>
    );
  }

  return (
    <section
      className="online-payments"
      aria-labelledby="online-payment-title"
      aria-busy={loading || Boolean(busy)}
    >
      <div className="online-payment-heading">
        <div>
          <span className="online-payment-symbol">
            <ShieldCheck size={19} />
          </span>
          <div>
            <h3 id="online-payment-title">Online payments</h3>
            <p>
              {manualOnly
                ? 'Manual receipts and saved bank details'
                : provider
                  ? `Secure payment links with ${providerName}`
                  : 'Checking the saved invoice payment provider'}
            </p>
          </div>
        </div>
        <span className={`online-payment-mode online-payment-mode-${mode}`}>
          {loading
            ? 'Checking setup'
            : manualOnly
              ? 'Manual only'
              : mode === 'test'
                ? 'Test mode'
                : mode === 'live'
                  ? 'Live mode'
                  : 'Not configured'}
        </span>
      </div>
      {loading ? (
        <div className="online-payment-loading" role="status">
          <LoaderCircle size={17} className="payment-spin" />
          Loading payment links…
        </div>
      ) : (
        <>
          {error && (
            <div className="online-payment-message online-payment-message-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="online-payment-message online-payment-message-success" role="status">
              <CheckCircle2 size={13} style={{ verticalAlign: 'middle', marginRight: 6 }} />
              {notice}
            </div>
          )}
          {details && !configured && (
            <div className="online-payment-message">
              {manualOnly ? (
                <>
                  <strong>Online collection is turned off for this invoice.</strong> Record bank transfers, QR
                  payments or other manual receipts below after confirming receipt.
                </>
              ) : (
                <>
                  <strong>{providerName} setup is incomplete.</strong>{' '}
                  {!details.configuration.keyConfigured
                    ? `An administrator needs to add this organization’s ${providerName} credentials in the server settings. `
                    : ''}
                  {!details.configuration.webhookConfigured
                    ? `Configure the matching ${providerName} webhook and verification credentials. `
                    : ''}
                  Online collection is unavailable until setup is complete. Manual receipts remain available
                  when no active link reserves this balance.
                </>
              )}
            </div>
          )}
          {configured && mode === 'test' && (
            <p className="online-payment-message">
              Test mode is enabled. Test payments do not transfer real money. Use test invoices while checking
              the integration.
            </p>
          )}
          {details && !eligible && activeLinks.length === 0 && (
            <p className="online-payment-message">
              {document.status === 'draft'
                ? 'Issue this invoice by marking it Sent before creating a payment link.'
                : document.status === 'cancelled'
                  ? 'This invoice is cancelled. A new payment link cannot be created.'
                  : remaining <= 0 || document.finalizedAt
                    ? 'This invoice has no outstanding balance to collect online.'
                    : 'Payment links are available for issued invoices with an outstanding balance.'}
            </p>
          )}
          {details && !manualOnly && eligible && activeLinks.length === 0 && (
            <div className="online-payment-create">
              <button
                type="button"
                className="payment-primary"
                onClick={() => perform('create')}
                disabled={locked || !configured}
              >
                {busy === 'create' ? (
                  <LoaderCircle size={14} className="payment-spin" />
                ) : (
                  <Link2 size={14} />
                )}
                Create link for {money(remaining)}
              </button>
              <p className="online-payment-note">
                The link covers the outstanding balance and accepts partial payments. Each verified payment
                also updates the EMI schedule, when one is set.
              </p>
            </div>
          )}
          {activeLinks.length > 0 && (
            <>
              <p className="online-payment-message">
                This balance has an active or unresolved online payment link. Verify it or cancel it before
                adding a manual receipt.
              </p>
              <div className="online-payment-list">{activeLinks.map(renderLink)}</div>
            </>
          )}
          <button
            type="button"
            className="payment-secondary online-payment-retry"
            disabled={locked}
            onClick={() => perform(canSync ? 'sync' : 'refresh')}
          >
            {busy === 'sync' || busy === 'refresh' ? (
              <LoaderCircle size={13} className="payment-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {canSync ? `Verify with ${providerName}` : 'Refresh link status'}
          </button>
          {pastLinks.length > 0 && (
            <>
              <button
                type="button"
                className="online-payment-history-toggle"
                onClick={() => setShowHistory((value) => !value)}
                aria-expanded={showHistory}
                aria-controls="online-payment-history"
              >
                {showHistory ? 'Hide' : 'View'} completed and closed links ({pastLinks.length})
              </button>
              {showHistory && (
                <div id="online-payment-history" className="online-payment-list">
                  {pastLinks.map(renderLink)}
                </div>
              )}
            </>
          )}
          <p className="online-payment-footer">
            <ShieldCheck size={13} />
            <span>
              {manualOnly
                ? 'Manual receipts update the invoice balance and EMI schedule. Confirm funds have reached the correct organization before recording a receipt.'
                : `Customers pay on ${providerName}. Receipts are recorded only after server verification; opening a link or returning from checkout never marks an invoice paid.`}
            </span>
          </p>
        </>
      )}
    </section>
  );
}
