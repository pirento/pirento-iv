import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import { balanceDue, DOCUMENT_LABELS, type BusinessDocument } from '../../../shared/types';
import type { EmailIntegrationStatus, EmailMessage, EmailSendResult } from '../../../shared/messaging-types';
import type { OnlinePaymentConfiguration } from '../../../shared/online-payment-types';
import { organizationSupportEmail } from '../../../shared/business-identity';
import './messaging.css';

interface Props {
  document: BusinessDocument;
  onClose: () => void;
  onUpdated?: (document: BusinessDocument) => void;
}
interface IntegrationStatus {
  email: EmailIntegrationStatus;
  payment: OnlinePaymentConfiguration;
}
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
  password_reset: 'Password reset',
};
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));

export default function MessagingPanel({ document, onClose }: Props) {
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [includePaymentLink, setIncludePaymentLink] = useState(false);
  const [reload, setReload] = useState(0);
  const requestId = useRef(crypto.randomUUID());
  const busyRef = useRef(false);
  busyRef.current = Boolean(busy);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError('');
    setIntegration(null);
    setMessages([]);
    setIncludePaymentLink(false);
    Promise.all([
      api<IntegrationStatus>(
        `/integrations/status?organizationId=${encodeURIComponent(document.organizationId)}&documentId=${encodeURIComponent(document.id)}`,
        { signal: controller.signal },
      ),
      api<EmailMessage[]>(`/documents/${document.id}/messages`, { signal: controller.signal }),
    ])
      .then(([settings, history]) => {
        if (!cancelled) {
          setIntegration(settings);
          setMessages(history);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Email history could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [document.id, document.organizationId, reload]);

  useEffect(() => {
    if (!messages.some((message) => message.status === 'queued' || message.status === 'sending')) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (window.document.hidden || busyRef.current) return;
      api<EmailMessage[]>(`/documents/${document.id}/messages`)
        .then((history) => {
          if (!cancelled) setMessages(history);
        })
        .catch(() => {});
    }, 6_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [document.id, messages]);

  const configured = Boolean(integration?.email.configured);
  const paymentConfigured = Boolean(integration?.payment.configured);
  const manualOnly = integration?.payment.provider === 'none';
  const providerName =
    integration?.payment.provider === 'cashfree'
      ? 'Cashfree'
      : integration?.payment.provider === 'razorpay'
        ? 'Razorpay'
        : 'online';
  const recipient = document.customerSnapshot.email.trim();
  const validRecipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
  const canPay = document.kind === 'invoice' && balanceDue(document) > 0 && document.status !== 'cancelled';
  const canSend =
    configured &&
    validRecipient &&
    document.status !== 'cancelled' &&
    document.status !== 'draft' &&
    document.kind !== 'delivery_note';

  async function send() {
    if (busy || !canSend) return;
    setBusy('send');
    setError('');
    setNotice('');
    try {
      const result = await api<EmailSendResult>(
        `/documents/${document.id}/email`,
        sendJson('POST', {
          includePaymentLink: canPay && paymentConfigured && includePaymentLink,
          requestId: requestId.current,
        }),
      );
      requestId.current = crypto.randomUUID();
      setMessages((previous) => [
        result.message,
        ...previous.filter((message) => message.id !== result.message.id),
      ]);
      setNotice(
        result.message.status === 'held'
          ? 'The message is held. Review the setup details in the email history.'
          : 'Invoice email queued. Delivery status will update here.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The email could not be queued.');
    } finally {
      setBusy('');
    }
  }

  async function retry(message: EmailMessage) {
    if (busy) return;
    setBusy(message.id);
    setError('');
    setNotice('');
    try {
      const result = await api<EmailSendResult>(`/messages/${message.id}/retry`, sendJson('POST', {}));
      setMessages((previous) => previous.map((item) => (item.id === message.id ? result.message : item)));
      setNotice('The saved email is queued for another delivery attempt.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The message could not be retried.');
    } finally {
      setBusy('');
    }
  }

  return (
    <section
      className="workspace-page messaging-page messaging-panel"
      aria-labelledby="messaging-title"
      aria-busy={loading || Boolean(busy)}
    >
      <header className="messaging-header">
        <div className="messaging-heading-icon">
          <Mail size={24} />
        </div>
        <div>
          <p>EMAIL & NOTIFICATIONS</p>
          <h1 id="messaging-title">Send to your customer</h1>
          <span>{document.number}</span>
        </div>
        <button
          type="button"
          className="messaging-refresh messaging-page-back"
          disabled={Boolean(busy)}
          onClick={onClose}
        >
          <ArrowLeft size={16} /> Back
        </button>
      </header>
      <div className="messaging-body">
        {error && (
          <div role="alert" className="messaging-alert messaging-alert-error">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div role="status" className="messaging-alert messaging-alert-success">
            <CheckCircle2 size={18} />
            <span>{notice}</span>
          </div>
        )}
        {loading ? (
          <div className="messaging-loading" role="status">
            <LoaderCircle size={23} className="messaging-spin" />
            Loading email history…
          </div>
        ) : (
          <>
            <div className="messaging-recipient">
              <span>Customer email</span>
              <strong>{recipient || 'No email saved on this invoice'}</strong>
              <small>
                {document.customerSnapshot.name} · {document.organizationSnapshot.name}
              </small>
              <small>
                From: {integration?.email.from || 'Sender setup pending'} · Reply-to:{' '}
                {organizationSupportEmail(document.organizationSnapshot) || 'Not set'}
              </small>
            </div>
            {!configured && (
              <div className="messaging-alert">
                <AlertCircle size={19} />
                <span>
                  <strong>{document.organizationSnapshot.name} email setup is pending</strong>
                  {integration?.email.reason ||
                    'Connect an email provider and verified sender in server settings to start sending.'}{' '}
                  Saved messages stay on hold until explicitly released.
                </span>
              </div>
            )}
            {!validRecipient && (
              <div className="messaging-alert">
                <AlertCircle size={19} />
                <span>
                  Add a valid customer email and refresh the customer details on the draft invoice before
                  sending. Issued invoices keep their saved customer details.
                </span>
              </div>
            )}
            {document.status === 'draft' && (
              <div className="messaging-alert">
                <Clock3 size={19} />
                <span>
                  This is a draft. Mark the document as sent when it is ready to issue, then email it to the
                  customer.
                </span>
              </div>
            )}
            <section className="messaging-compose">
              <h3>{DOCUMENT_LABELS[document.kind]} email</h3>
              <p>
                The email includes a PDF attachment and the saved document details, item charges, taxes,
                totals and payment schedule.
              </p>
              {canPay && !manualOnly && (
                <label className="messaging-checkbox">
                  <input
                    type="checkbox"
                    checked={includePaymentLink}
                    onChange={(event) => setIncludePaymentLink(event.target.checked)}
                    disabled={!paymentConfigured || Boolean(busy)}
                  />
                  <span>
                    Include a secure {providerName} payment link
                    <small>
                      {paymentConfigured
                        ? 'The payment link uses the current outstanding invoice balance.'
                        : `Connect this business’s ${providerName} account in server settings to enable online payment links.`}
                    </small>
                  </span>
                  <ExternalLink size={16} />
                </label>
              )}
              {canPay && !includePaymentLink && (
                <p className="messaging-subtle">
                  {manualOnly
                    ? 'Online collection is disabled for this invoice. The PDF can include the saved bank details and payment QR.'
                    : 'This email will not contain an online payment link.'}
                </p>
              )}
              <button
                type="button"
                className="messaging-primary"
                disabled={Boolean(busy) || !canSend}
                onClick={send}
              >
                {busy === 'send' ? <LoaderCircle size={16} className="messaging-spin" /> : <Send size={16} />}
                Queue {DOCUMENT_LABELS[document.kind].toLowerCase()} email
              </button>
            </section>
            <div className="messaging-automation">
              <ShieldCheck size={20} />
              <div>
                <strong>
                  Payment notifications{' '}
                  {configured && integration?.email.automationEnabled ? 'enabled' : 'awaiting activation'}
                </strong>
                <p>
                  Automatic receipts follow verified online or recorded payments. A failed attempt sends an
                  unsuccessful-payment notice; the final receipt confirms full payment.{' '}
                  {configured && integration?.email.automationEnabled
                    ? ''
                    : 'An administrator can activate these messages after the business sender is ready.'}
                </p>
              </div>
            </div>
            <section className="messaging-history">
              <div className="messaging-section-heading">
                <h3>
                  Email history <span>{messages.length}</span>
                </h3>
                <button
                  type="button"
                  className="messaging-refresh"
                  disabled={Boolean(busy)}
                  onClick={() => setReload((value) => value + 1)}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
              <p className="messaging-subtle">
                “Provider accepted” confirms the sending service accepted the email. It does not confirm inbox
                delivery or that the customer opened it.
              </p>
              {!messages.length ? (
                <div className="messaging-empty">
                  <Mail size={28} />
                  <p>No email notifications yet.</p>
                </div>
              ) : (
                <ol>
                  {messages.map((message) => (
                    <li key={message.id}>
                      <div className="messaging-message-top">
                        <strong>{kindLabels[message.kind]}</strong>
                        <span className={`messaging-status messaging-status-${message.status}`}>
                          {statusLabels[message.status]}
                        </span>
                      </div>
                      <p>{message.subject}</p>
                      <small>
                        To: {message.to || 'Missing recipient'} · {dateLabel(message.createdAt)}
                      </small>
                      {message.hasPaymentLink && (
                        <span className="messaging-link-badge">
                          <ExternalLink size={12} />
                          Payment link included
                        </span>
                      )}
                      {message.lastError && <p className="messaging-message-error">{message.lastError}</p>}
                      {message.nextAttemptAt && message.attempts > 0 && (
                        <small>Next automatic attempt: {dateLabel(message.nextAttemptAt)}</small>
                      )}
                      {message.sentAt && <small>Accepted {dateLabel(message.sentAt)}</small>}
                      {message.canRetry && (
                        <button
                          type="button"
                          className="messaging-retry"
                          disabled={Boolean(busy)}
                          onClick={() => retry(message)}
                        >
                          {busy === message.id ? (
                            <LoaderCircle size={13} className="messaging-spin" />
                          ) : (
                            <RefreshCw size={13} />
                          )}
                          {message.status === 'held' ? 'Release saved email' : 'Retry delivery'}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </section>
  );
}
