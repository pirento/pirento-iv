import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowDownLeft,
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CreditCard,
  History,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  Receipt,
  RotateCcw,
  Trash2,
  Wallet,
  X,
} from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import {
  balanceDue,
  installmentBalances,
  money,
  paidAmount,
  PAYMENT_METHODS,
  STATUS_LABELS,
} from '../../../shared/types';
import type {
  BusinessDocument,
  InstallmentPlan,
  PaymentDetails,
  PaymentInput,
  PaymentMethod,
  PaymentRecord,
} from '../../../shared/types';
import OnlinePayments from './OnlinePayments';
import './payments.css';

interface PaymentPanelProps {
  document: BusinessDocument;
  onClose: () => void;
  onUpdated: (document: BusinessDocument) => void;
}

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const newRequestId = () => crypto.randomUUID();
const verifiedProvider = (requestId: string) =>
  requestId.startsWith('razorpay:') ? 'Razorpay' : requestId.startsWith('cashfree:') ? 'Cashfree' : '';
const amountText = (amount: number) => (amount > 0 ? amount.toFixed(2) : '');
function dateLabel(value: string, includeTime = false) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
    ...(includeTime ? ({ hour: 'numeric', minute: '2-digit' } as const) : {}),
  }).format(date);
}

export default function PaymentPanel({ document: initialDocument, onClose, onUpdated }: PaymentPanelProps) {
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineBlocking, setOnlineBlocking] = useState(true);
  const [busy, setBusy] = useState<'record' | 'void' | 'finalize' | 'refresh' | 'schedule' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [amount, setAmount] = useState(amountText(balanceDue(initialDocument)));
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [voidPayment, setVoidPayment] = useState<PaymentRecord | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [showEvents, setShowEvents] = useState(false);
  const requestId = useRef(newRequestId());
  const amountInput = useRef<HTMLInputElement>(null);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  const processing = Boolean(busy) || onlineBusy;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setNotice('');
    setDetails(null);
    setVoidPayment(null);
    setOnlineBlocking(true);
    api<PaymentDetails>(`/documents/${initialDocument.id}/payments`, { signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setDetails(result);
        setAmount(amountText(balanceDue(result.document)));
        onUpdatedRef.current(result.document);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Payment history could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialDocument.id, reload]);

  const document = details?.document || initialDocument;
  const remaining = balanceDue(document);
  const received = paidAmount(document);
  const finalized = Boolean(document.finalizedAt);
  const available = Boolean(details) && document.kind === 'invoice' && document.status !== 'cancelled';
  const canRecord = available && remaining > 0 && !finalized;
  const canRecordManual = canRecord && !onlineBlocking;
  const payments = [...(details?.payments || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const events = [...(details?.events || [])].sort((a, b) => b.at.localeCompare(a.at));
  const enteredAmount = Number(amount);
  const afterPayment = Math.max(0, Math.round(remaining * 100) - Math.round(enteredAmount * 100)) / 100;
  const validAmount =
    amount.trim() !== '' &&
    Number.isFinite(enteredAmount) &&
    enteredAmount > 0 &&
    Math.round(enteredAmount * 100) <= Math.round(remaining * 100);

  function applyResult(result: PaymentDetails) {
    setDetails(result);
    setAmount(amountText(balanceDue(result.document)));
    onUpdatedRef.current(result.document);
  }

  async function refreshPaymentHistory() {
    if (processing) return;
    setBusy('refresh');
    setError('');
    setNotice('');
    try {
      const result = await api<PaymentDetails>(`/documents/${document.id}/payments`);
      const savedAttempt = result.payments.some((payment) => payment.requestId === requestId.current);
      setDetails(result);
      onUpdatedRef.current(result.document);
      if (savedAttempt) {
        requestId.current = newRequestId();
        setAmount(amountText(balanceDue(result.document)));
        setReference('');
        setNotes('');
      }
      setNotice(
        savedAttempt
          ? 'Payment history refreshed. Your saved receipt is listed below.'
          : 'Payment history refreshed. Review the balance before retrying.',
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Payment history could not be refreshed. Please try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function recordPayment(event: FormEvent) {
    event.preventDefault();
    if (processing || !canRecordManual) return;
    setError('');
    setNotice('');
    if (!validAmount) {
      setError(`Enter an amount greater than zero and no more than ${money(remaining)}.`);
      return;
    }
    if (Math.abs(enteredAmount * 100 - Math.round(enteredAmount * 100)) > 0.00001) {
      setError('Use no more than two decimal places for the payment amount.');
      return;
    }
    if (!paidOn || paidOn > today()) {
      setError('Choose the date you received this payment, up to today.');
      return;
    }
    const input: PaymentInput = {
      amount: enteredAmount,
      paidOn,
      method,
      reference: reference.trim(),
      notes: notes.trim(),
      requestId: requestId.current,
      finalizeWhenPaid: true,
    };
    setBusy('record');
    try {
      const result = await api<PaymentDetails>(`/documents/${document.id}/payments`, sendJson('POST', input));
      applyResult(result);
      setReference('');
      setNotes('');
      requestId.current = newRequestId();
      setNotice(
        result.document.finalizedAt
          ? 'Payment recorded. This invoice is now Paid / Final and locked for editing.'
          : 'Payment recorded. The outstanding balance has been updated.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment could not be recorded. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function correctPayment(event: FormEvent) {
    event.preventDefault();
    if (!voidPayment || processing || onlineBlocking || verifiedProvider(voidPayment.requestId)) return;
    setError('');
    setNotice('');
    if (!voidReason.trim()) {
      setError('Add a reason for correcting this payment.');
      return;
    }
    setBusy('void');
    try {
      const result = await api<PaymentDetails>(
        `/payments/${voidPayment.id}/void`,
        sendJson('POST', { reason: voidReason.trim() }),
      );
      applyResult(result);
      setVoidPayment(null);
      setVoidReason('');
      requestId.current = newRequestId();
      setNotice(
        'Payment entry voided. The balance has been restored and the correction is kept in the history.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The payment could not be corrected. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function finalize() {
    if (processing || !available || remaining > 0 || finalized) return;
    setBusy('finalize');
    setError('');
    setNotice('');
    try {
      const result = await api<PaymentDetails>(`/documents/${document.id}/finalize`, sendJson('POST', {}));
      applyResult(result);
      setNotice('This invoice is now Paid / Final and locked for editing.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invoice could not be finalized. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function saveInstallments(plan: InstallmentPlan | null) {
    if (processing || !available || finalized) return false;
    setBusy('schedule');
    setError('');
    setNotice('');
    try {
      const result = await api<PaymentDetails>(
        `/documents/${document.id}/installments`,
        sendJson('PUT', { plan }),
      );
      applyResult(result);
      setNotice(
        plan
          ? 'Installment plan saved. Existing receipts apply to the earliest due installment first.'
          : 'Installment plan removed. Recorded payments and the invoice total are unchanged.',
      );
      return true;
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'The installment plan could not be saved. Please try again.',
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  function prepareInstallmentPayment(value: number, label: string) {
    if (processing || !canRecordManual) return;
    setAmount(amountText(Math.min(value, remaining)));
    setError('');
    setNotice(`Amount set for ${label}. Receipts are applied to the earliest unpaid installment first.`);
    amountInput.current?.focus({ preventScroll: true });
    amountInput.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
  }

  return (
    <section
      className="workspace-page payment-page payment-panel"
      aria-labelledby="payment-title"
      aria-busy={loading || processing}
    >
      <header className="payment-header">
        <div className="payment-header-icon">
          <Wallet size={23} />
        </div>
        <div>
          <p className="payment-eyebrow">PAYMENTS & RECEIPTS</p>
          <h1 id="payment-title">Invoice payments</h1>
          <p>{document.number}</p>
        </div>
        <button
          type="button"
          className="payment-secondary payment-page-back"
          onClick={onClose}
          disabled={processing}
        >
          <ArrowLeft size={16} /> Back
        </button>
      </header>
      <div className="payment-body">
        <div className="payment-customer">
          <div>
            <strong>{document.customerSnapshot.name}</strong>
            <span>{document.organizationSnapshot.name}</span>
          </div>
          <span className={`payment-state ${finalized ? 'payment-state-final' : ''}`}>
            {finalized ? (
              <>
                <LockKeyhole size={12} />
                Paid / Final
              </>
            ) : (
              STATUS_LABELS[document.status]
            )}
          </span>
        </div>
        <div className="payment-summary" aria-label="Invoice payment totals">
          <div>
            <span>Invoice total</span>
            <strong>{money(document.totals.total)}</strong>
          </div>
          <div>
            <span>Received</span>
            <strong>{money(received)}</strong>
          </div>
          <div className="payment-balance">
            <span>Outstanding</span>
            <strong>{money(remaining)}</strong>
          </div>
        </div>
        {error && (
          <div className="payment-error" role="alert">
            {error}
            {details ? (
              <button type="button" onClick={refreshPaymentHistory} disabled={processing}>
                Refresh payment history
              </button>
            ) : (
              !loading && (
                <button type="button" onClick={() => setReload((value) => value + 1)}>
                  Try again
                </button>
              )
            )}
          </div>
        )}
        {notice && (
          <div className="payment-success" role="status">
            <CheckCircle2 size={18} />
            <span>{notice}</span>
          </div>
        )}
        {busy === 'refresh' && (
          <div className="payment-info" role="status">
            Refreshing payment history…
          </div>
        )}
        {loading ? (
          <div className="payment-loading" role="status">
            <LoaderCircle className="payment-spin" size={23} />
            <span>Loading payment history…</span>
          </div>
        ) : (
          details && (
            <>
              {finalized && (
                <div className="payment-final-banner">
                  <div>
                    <LockKeyhole size={22} />
                  </div>
                  <p>
                    <strong>Payment complete. Invoice finalized.</strong>
                    <span>
                      The invoice number and details are locked.
                      {document.finalizedAt && ` Finalized ${dateLabel(document.finalizedAt)}.`}
                    </span>
                  </p>
                </div>
              )}
              {document.status === 'cancelled' && (
                <div className="payment-info">This invoice is cancelled. Payments cannot be added.</div>
              )}
              {document.kind === 'invoice' && (
                <OnlinePayments
                  key={`online-${document.id}`}
                  document={document}
                  disabled={Boolean(busy)}
                  onBusyChange={setOnlineBusy}
                  onBlockingChange={setOnlineBlocking}
                  onUpdated={(next, payments) => {
                    if (payments) applyResult(payments);
                    else {
                      setDetails((current) => (current ? { ...current, document: next } : null));
                      onUpdatedRef.current(next);
                    }
                  }}
                />
              )}
              {document.kind === 'invoice' &&
                (document.installmentPlan || (available && !finalized && document.totals.total > 0)) && (
                  <InstallmentSchedule
                    key={document.id}
                    document={document}
                    busy={processing}
                    manualBlocked={onlineBlocking}
                    saving={busy === 'schedule'}
                    onSave={saveInstallments}
                    onRecord={prepareInstallmentPayment}
                  />
                )}
              {canRecord && (
                <section className="payment-record-section" aria-labelledby="payment-record-title">
                  <div className="payment-section-heading">
                    <div>
                      <h3 id="payment-record-title">Record a manual payment</h3>
                      <p>Add a receipt for money already received outside the online payment link.</p>
                    </div>
                    <ArrowDownLeft size={20} />
                  </div>
                  <form onSubmit={recordPayment} noValidate>
                    {onlineBlocking && (
                      <div className="payment-info online-payment-manual-lock">
                        Manual receipts are paused until online payment status is checked and any active or
                        unresolved payment link is cancelled.
                      </div>
                    )}
                    <fieldset disabled={processing || onlineBlocking} className="payment-fieldset">
                      <div className="payment-grid">
                        <label className="payment-field">
                          Amount received <span>INR</span>
                          <input
                            ref={amountInput}
                            aria-label="Amount received"
                            className="payment-amount-input"
                            type="number"
                            min="0.01"
                            max={remaining.toFixed(2)}
                            step="0.01"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={amount}
                            onChange={(event) => setAmount(event.target.value)}
                            required
                          />
                        </label>
                        <label className="payment-field">
                          Payment date
                          <input
                            type="date"
                            value={paidOn}
                            max={today()}
                            onChange={(event) => setPaidOn(event.target.value)}
                            required
                          />
                        </label>
                      </div>
                      <div className="payment-grid">
                        <label className="payment-field">
                          Payment method
                          <select
                            value={method}
                            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
                          >
                            {Object.entries(PAYMENT_METHODS).map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="payment-field">
                          Transaction reference <span>Optional</span>
                          <input
                            value={reference}
                            onChange={(event) => setReference(event.target.value)}
                            placeholder="UTR, cheque or receipt number"
                            maxLength={120}
                          />
                        </label>
                      </div>
                      <label className="payment-field">
                        Payment note <span>Optional</span>
                        <textarea
                          rows={2}
                          value={notes}
                          onChange={(event) => setNotes(event.target.value)}
                          placeholder="Any details you want to keep with this receipt"
                          maxLength={1000}
                        />
                      </label>
                      <div className="payment-form-bottom">
                        <div>
                          <span>Balance after this payment</span>
                          <strong>{validAmount ? money(afterPayment) : '—'}</strong>
                        </div>
                        <button
                          type="submit"
                          className="payment-primary"
                          disabled={!validAmount || processing || onlineBlocking}
                        >
                          {busy === 'record' ? (
                            <LoaderCircle size={16} className="payment-spin" />
                          ) : (
                            <CheckCircle2 size={16} />
                          )}
                          Record payment
                        </button>
                      </div>
                      <p className="payment-auto-note">
                        <LockKeyhole size={13} />
                        When the balance reaches zero, this invoice becomes Paid / Final automatically.
                      </p>
                      {document.installmentPlan && (
                        <p className="payment-auto-note">
                          <CalendarDays size={13} />
                          Each receipt pays the earliest unpaid installment first, including overdue amounts.
                        </p>
                      )}
                    </fieldset>
                  </form>
                </section>
              )}
              {available && remaining === 0 && !finalized && (
                <div className="payment-finalize-prompt">
                  <div>
                    <strong>No balance outstanding</strong>
                    <p>Finalize this invoice to keep its number and details locked.</p>
                  </div>
                  <button type="button" className="payment-primary" onClick={finalize} disabled={processing}>
                    {busy === 'finalize' ? (
                      <LoaderCircle className="payment-spin" size={16} />
                    ) : (
                      <LockKeyhole size={16} />
                    )}
                    Finalize invoice
                  </button>
                </div>
              )}
              <section className="payment-history" aria-labelledby="payment-history-title">
                <div className="payment-section-heading">
                  <div>
                    <h3 id="payment-history-title">
                      Payment history <span className="payment-count">{payments.length}</span>
                    </h3>
                    <p>Every receipt and correction stays with this invoice.</p>
                  </div>
                  <History size={20} />
                </div>
                {payments.length === 0 ? (
                  <div className="payment-empty">
                    <Receipt size={27} />
                    <strong>No payments recorded yet</strong>
                    <span>Manual receipts and verified online payments will appear here.</span>
                  </div>
                ) : (
                  <div className="payment-history-list">
                    {payments.map((payment) => (
                      <article
                        key={payment.id}
                        className={`payment-entry ${payment.voidedAt ? 'payment-entry-voided' : ''}`}
                      >
                        <div className="payment-entry-top">
                          <div className="payment-entry-icon">
                            {payment.voidedAt ? <RotateCcw size={17} /> : <CreditCard size={17} />}
                          </div>
                          <div className="payment-entry-title">
                            <strong>{PAYMENT_METHODS[payment.method] || payment.method}</strong>
                            <span>
                              {dateLabel(payment.paidOn)}
                              {payment.reference ? ` · ${payment.reference}` : ''}
                            </span>
                          </div>
                          <div className="payment-entry-amount">
                            <strong>{money(payment.amount)}</strong>
                            {payment.voidedAt ? (
                              <span>Voided</span>
                            ) : (
                              <span>
                                {verifiedProvider(payment.requestId)
                                  ? `${verifiedProvider(payment.requestId)} verified`
                                  : 'Manual receipt'}
                              </span>
                            )}
                          </div>
                        </div>
                        {payment.notes && <p className="payment-entry-note">{payment.notes}</p>}
                        {payment.voidedAt ? (
                          <p className="payment-correction-note">
                            <RotateCcw size={12} />
                            <span>
                              Voided {dateLabel(payment.voidedAt)} · {payment.voidReason}
                            </span>
                          </p>
                        ) : (
                          !verifiedProvider(payment.requestId) &&
                          voidPayment?.id !== payment.id && (
                            <button
                              type="button"
                              className="payment-text-button"
                              onClick={() => {
                                setVoidPayment(payment);
                                setVoidReason('');
                                setError('');
                                setNotice('');
                              }}
                              disabled={processing || onlineBlocking}
                            >
                              <RotateCcw size={12} />
                              Correct entry
                            </button>
                          )
                        )}
                        {verifiedProvider(payment.requestId) && (
                          <p className="online-payment-verified">
                            <CheckCircle2 size={12} />
                            Verified by {verifiedProvider(payment.requestId)}. Manage any refund through the
                            provider.
                          </p>
                        )}
                        {voidPayment?.id === payment.id && (
                          <form className="payment-correction-form" onSubmit={correctPayment} noValidate>
                            <h4>Void this payment entry?</h4>
                            <p>
                              This restores {money(payment.amount)} to the balance and reopens a finalized
                              invoice. It records a correction; it does not send a refund.
                            </p>
                            <label className="payment-field">
                              Reason for correction
                              <textarea
                                autoFocus
                                rows={2}
                                value={voidReason}
                                onChange={(event) => setVoidReason(event.target.value)}
                                placeholder="For example, a duplicate entry or incorrect amount"
                                maxLength={500}
                                required
                                disabled={processing}
                              />
                            </label>
                            <div>
                              <button
                                type="button"
                                className="payment-secondary"
                                onClick={() => {
                                  setVoidPayment(null);
                                  setVoidReason('');
                                }}
                                disabled={processing}
                              >
                                Keep payment
                              </button>
                              <button
                                type="submit"
                                className="payment-danger"
                                disabled={processing || onlineBlocking || !voidReason.trim()}
                              >
                                {busy === 'void' ? (
                                  <LoaderCircle size={14} className="payment-spin" />
                                ) : (
                                  <RotateCcw size={14} />
                                )}
                                Confirm correction
                              </button>
                            </div>
                          </form>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
              <section className="payment-audit">
                <button
                  type="button"
                  className="payment-audit-toggle"
                  onClick={() => setShowEvents((value) => !value)}
                  aria-expanded={showEvents}
                  aria-controls="payment-audit-list"
                >
                  <span>
                    <Clock3 size={16} />
                    Invoice activity <small>{events.length}</small>
                  </span>
                  <ChevronDown size={16} className={showEvents ? 'payment-chevron-open' : ''} />
                </button>
                {showEvents && (
                  <div id="payment-audit-list">
                    {events.length ? (
                      <ol>
                        {events.map((event) => (
                          <li key={event.id}>
                            <span className="payment-event-dot" />
                            <div>
                              <p>{event.description}</p>
                              <time dateTime={event.at}>{dateLabel(event.at, true)}</time>
                            </div>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="payment-no-events">No activity recorded yet.</p>
                    )}
                  </div>
                )}
              </section>
            </>
          )
        )}
      </div>
      <footer className="payment-footer">
        <span>
          <Receipt size={14} />
          Manual receipts and verified online payments share one ledger.
        </span>
        <button type="button" className="payment-secondary" onClick={onClose} disabled={processing}>
          <ArrowLeft size={15} /> Back
        </button>
      </footer>
    </section>
  );
}

type InstallmentDraft = { id: string; label: string; dueDate: string; amount: string };
type ScheduleProps = {
  document: BusinessDocument;
  busy: boolean;
  saving: boolean;
  manualBlocked: boolean;
  onSave: (plan: InstallmentPlan | null) => Promise<boolean>;
  onRecord: (amount: number, label: string) => void;
};

function validScheduleDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function recurringDate(start: string, index: number, frequency: 'monthly' | 'weekly') {
  const date = new Date(`${start}T12:00:00Z`);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + index * 7);
  else {
    const anchorDay = date.getUTCDate();
    const month = date.getUTCMonth() + index;
    date.setUTCDate(1);
    date.setUTCMonth(month);
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    date.setUTCDate(Math.min(anchorDay, end.getUTCDate()));
  }
  return date.toISOString().slice(0, 10);
}

function InstallmentSchedule({ document, busy, saving, manualBlocked, onSave, onRecord }: ScheduleProps) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [name, setName] = useState('EMI payment plan');
  const [rows, setRows] = useState<InstallmentDraft[]>([]);
  const [count, setCount] = useState('3');
  const [frequency, setFrequency] = useState<'monthly' | 'weekly'>('monthly');
  const [firstDate, setFirstDate] = useState(document.dueDate || today());
  const [withDownPayment, setWithDownPayment] = useState(false);
  const [downPayment, setDownPayment] = useState('');
  const [downDate, setDownDate] = useState(today());
  const [formError, setFormError] = useState('');
  const editable = !document.finalizedAt && document.status !== 'cancelled';
  const schedule = installmentBalances(document);
  const next = schedule.find((entry) => entry.balanceDue > 0);
  const overdue =
    schedule
      .filter((entry) => entry.status === 'overdue')
      .reduce((sum, entry) => sum + Math.round(entry.balanceDue * 100), 0) / 100;
  const totalPaise = Math.round(document.totals.total * 100);
  const plannedPaise = rows.reduce(
    (sum, row) => sum + (Number.isFinite(Number(row.amount)) ? Math.round(Number(row.amount) * 100) : 0),
    0,
  );
  const matchingTotal = plannedPaise === totalPaise;
  const paidPercentage =
    totalPaise > 0 ? Math.min(100, (Math.round(paidAmount(document) * 100) / totalPaise) * 100) : 100;
  const invalidAmount = rows.some(
    (row) =>
      !row.amount.trim() ||
      !Number.isFinite(Number(row.amount)) ||
      Number(row.amount) <= 0 ||
      Math.abs(Number(row.amount) * 100 - Math.round(Number(row.amount) * 100)) > 0.00001,
  );

  function openEditor() {
    setEditing(true);
    setRemoving(false);
    setFormError('');
    setName(document.installmentPlan?.name || 'EMI payment plan');
    setRows(
      (document.installmentPlan?.installments || []).map((entry) => ({
        ...entry,
        amount: entry.amount.toFixed(2),
      })),
    );
    setCount(String(Math.min(60, Math.max(2, document.installmentPlan?.installments.length || 3))));
    setFirstDate(document.installmentPlan?.installments[0]?.dueDate || document.dueDate || today());
    setWithDownPayment(false);
    setDownPayment('');
    setDownDate(today());
  }

  function generateSchedule() {
    setFormError('');
    const installmentCount = Number(count);
    if (!Number.isInteger(installmentCount) || installmentCount < 2 || installmentCount > 60) {
      setFormError('Choose between 2 and 60 installments.');
      return;
    }
    if (!validScheduleDate(firstDate)) {
      setFormError('Choose a valid first installment date.');
      return;
    }
    const downValue = Number(downPayment);
    if (
      withDownPayment &&
      (!downPayment.trim() ||
        !Number.isFinite(downValue) ||
        downValue <= 0 ||
        Math.abs(downValue * 100 - Math.round(downValue * 100)) > 0.00001)
    ) {
      setFormError('Enter a positive down payment with no more than two decimal places.');
      return;
    }
    const downPaise = withDownPayment ? Math.round(downValue * 100) : 0;
    if (withDownPayment && (!validScheduleDate(downDate) || downDate > firstDate)) {
      setFormError('The down payment date must be on or before the first installment date.');
      return;
    }
    const splitPaise = totalPaise - downPaise;
    if (splitPaise < installmentCount) {
      setFormError('The down payment must leave at least ₹0.01 for each installment.');
      return;
    }
    const eachPaise = Math.floor(splitPaise / installmentCount);
    const remainder = splitPaise % installmentCount;
    const generated = Array.from({ length: installmentCount }, (_, index) => ({
      id: newRequestId(),
      label: `Installment ${index + 1}`,
      dueDate: recurringDate(firstDate, index, frequency),
      amount: ((eachPaise + (index < remainder ? 1 : 0)) / 100).toFixed(2),
    }));
    if (generated.some((entry) => !validScheduleDate(entry.dueDate))) {
      setFormError('Choose an earlier first installment date.');
      return;
    }
    setRows([
      ...(withDownPayment
        ? [
            {
              id: newRequestId(),
              label: 'Down payment',
              dueDate: downDate,
              amount: (downPaise / 100).toFixed(2),
            },
          ]
        : []),
      ...generated,
    ]);
  }

  function updateRow(id: string, patch: Partial<InstallmentDraft>) {
    setRows((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
    setFormError('');
  }

  async function saveSchedule(event: FormEvent) {
    event.preventDefault();
    if (busy || !editable) return;
    setFormError('');
    if (!name.trim()) {
      setFormError('Give this payment plan a name.');
      return;
    }
    if (!rows.length || rows.length > 120) {
      setFormError('Add between 1 and 120 installment entries.');
      return;
    }
    if (rows.some((row) => !row.label.trim())) {
      setFormError('Give every installment a label.');
      return;
    }
    if (rows.some((row) => !validScheduleDate(row.dueDate))) {
      setFormError('Choose a valid due date for every installment.');
      return;
    }
    if (invalidAmount) {
      setFormError('Each installment needs a positive amount with no more than two decimal places.');
      return;
    }
    if (!matchingTotal) {
      setFormError(
        `The installment total must equal the full invoice total of ${money(document.totals.total)}.`,
      );
      return;
    }
    const plan: InstallmentPlan = {
      name: name.trim(),
      installments: rows
        .map((row) => ({
          ...row,
          label: row.label.trim(),
          amount: Math.round(Number(row.amount) * 100) / 100,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    };
    if (await onSave(plan)) setEditing(false);
  }

  return (
    <section className="payment-schedule" aria-labelledby="payment-schedule-title">
      <div className="payment-section-heading">
        <div>
          <h3 id="payment-schedule-title">Installments & EMI</h3>
          <p>Split the invoice into scheduled payments.</p>
        </div>
        <CalendarDays size={20} />
      </div>
      {editing && editable ? (
        <form className="payment-plan-editor" onSubmit={saveSchedule} noValidate>
          <fieldset className="payment-fieldset" disabled={busy}>
            <label className="payment-field">
              Payment plan name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                placeholder="For example, project milestone payments"
              />
            </label>
            <div className="payment-plan-generator">
              <h4>Build equal installments</h4>
              <div className="payment-plan-generator-grid">
                <label className="payment-field">
                  Installment count
                  <input
                    type="number"
                    min="2"
                    max="60"
                    step="1"
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                  />
                </label>
                <label className="payment-field">
                  Frequency
                  <select
                    aria-label="Frequency"
                    value={frequency}
                    onChange={(event) => setFrequency(event.target.value as 'monthly' | 'weekly')}
                  >
                    <option value="monthly">Monthly</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </label>
                <label className="payment-field">
                  First installment date
                  <input
                    type="date"
                    value={firstDate}
                    onChange={(event) => setFirstDate(event.target.value)}
                  />
                </label>
              </div>
              <label className="payment-plan-check">
                <input
                  type="checkbox"
                  checked={withDownPayment}
                  onChange={(event) => setWithDownPayment(event.target.checked)}
                />
                Include a down payment
              </label>
              {withDownPayment && (
                <div className="payment-grid payment-down-payment">
                  <label className="payment-field">
                    Down payment amount
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      inputMode="decimal"
                      value={downPayment}
                      onChange={(event) => setDownPayment(event.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                  <label className="payment-field">
                    Down payment date
                    <input
                      type="date"
                      value={downDate}
                      max={firstDate || undefined}
                      onChange={(event) => setDownDate(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <div className="payment-plan-generator-bottom">
                <span>
                  {frequency === 'monthly'
                    ? 'Monthly dates keep the same day; shorter months use their last day.'
                    : 'Weekly installments fall seven days apart.'}
                </span>
                <button className="payment-secondary" type="button" onClick={generateSchedule}>
                  <RotateCcw size={13} />
                  {rows.length ? 'Rebuild schedule' : 'Build schedule'}
                </button>
              </div>
            </div>
            {rows.length > 0 && (
              <>
                <div className="payment-plan-rows-heading">
                  <h4>Review your schedule</h4>
                  <span>{rows.length} payments</span>
                </div>
                <div className="payment-plan-editor-rows">
                  {rows.map((row, index) => (
                    <div className="payment-plan-edit-row" key={row.id}>
                      <label className="payment-field">
                        Label
                        <input
                          aria-label={`Installment ${index + 1} label`}
                          value={row.label}
                          onChange={(event) => updateRow(row.id, { label: event.target.value })}
                          maxLength={200}
                        />
                      </label>
                      <label className="payment-field">
                        Due date
                        <input
                          aria-label={`Installment ${index + 1} due date`}
                          type="date"
                          value={row.dueDate}
                          onChange={(event) => updateRow(row.id, { dueDate: event.target.value })}
                        />
                      </label>
                      <label className="payment-field">
                        Amount <span>INR</span>
                        <input
                          aria-label={`Installment ${index + 1} amount`}
                          type="number"
                          min="0.01"
                          step="0.01"
                          inputMode="decimal"
                          value={row.amount}
                          onChange={(event) => updateRow(row.id, { amount: event.target.value })}
                        />
                      </label>
                      <button
                        className="payment-icon-button"
                        type="button"
                        aria-label={`Remove installment ${index + 1}`}
                        onClick={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  className="payment-plan-add"
                  type="button"
                  disabled={rows.length >= 120}
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      {
                        id: newRequestId(),
                        label: `Installment ${current.length + 1}`,
                        dueDate: current.at(-1)?.dueDate || firstDate || today(),
                        amount: '',
                      },
                    ])
                  }
                >
                  <Plus size={13} />
                  Add another payment
                </button>
              </>
            )}
            <div
              className={`payment-plan-total ${rows.length && !matchingTotal ? 'payment-plan-unmatched' : ''}`}
            >
              <div>
                <span>Scheduled total</span>
                <strong>{money(plannedPaise / 100)}</strong>
              </div>
              <div>
                <span>Invoice total</span>
                <strong>{money(document.totals.total)}</strong>
              </div>
              {rows.length > 0 && (
                <p>
                  {matchingTotal ? (
                    <>
                      <CheckCircle2 size={12} />
                      The schedule matches the invoice total.
                    </>
                  ) : plannedPaise < totalPaise ? (
                    `${money((totalPaise - plannedPaise) / 100)} still needs to be scheduled.`
                  ) : (
                    `${money((plannedPaise - totalPaise) / 100)} over the invoice total.`
                  )}
                </p>
              )}
            </div>
            <p className="payment-plan-explanation">
              Schedule the full invoice total, including payments already received. Receipts apply to the
              earliest due amount first. This plan adds no interest or extra fees.
            </p>
            {formError && (
              <div className="payment-error payment-plan-error" role="alert">
                {formError}
              </div>
            )}
            <div className="payment-plan-editor-actions">
              <button className="payment-secondary" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                className="payment-primary"
                type="submit"
                disabled={busy || !rows.length || !matchingTotal || invalidAmount}
              >
                {saving ? <LoaderCircle className="payment-spin" size={14} /> : <CheckCircle2 size={14} />}
                Save payment plan
              </button>
            </div>
          </fieldset>
        </form>
      ) : document.installmentPlan ? (
        <>
          <div className="payment-plan-heading">
            <div>
              <strong>{document.installmentPlan.name}</strong>
              <span>
                {schedule.length} scheduled payments ·{' '}
                {schedule.filter((entry) => entry.status === 'paid').length} complete
              </span>
            </div>
            {editable && (
              <button className="payment-secondary" type="button" disabled={busy} onClick={openEditor}>
                <Pencil size={12} />
                Edit plan
              </button>
            )}
          </div>
          <div
            className="payment-plan-progress"
            role="progressbar"
            aria-label="Installment plan paid"
            aria-valuenow={Math.round(paidPercentage)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${paidPercentage}%` }} />
          </div>
          {next ? (
            <div className="payment-next-installment">
              <div>
                <span>{next.dueDate < today() ? 'EARLIEST UNPAID · OVERDUE' : 'NEXT PAYMENT DUE'}</span>
                <strong>{dateLabel(next.dueDate)}</strong>
                <small>{next.label}</small>
              </div>
              <div>
                <strong>{money(next.balanceDue)}</strong>
                {overdue > 0 && <small>{money(overdue)} overdue in total</small>}
              </div>
            </div>
          ) : (
            <div className="payment-plan-complete">
              <CheckCircle2 size={16} />
              All scheduled payments are covered.
            </div>
          )}
          <p className="payment-plan-allocation">
            Receipts apply to the earliest unpaid installment first. Correcting a receipt recalculates this
            schedule.
          </p>
          <div className="payment-installment-list">
            {schedule.map((entry) => (
              <article key={entry.id} className={`payment-installment payment-installment-${entry.status}`}>
                <div className="payment-installment-heading">
                  <div>
                    <strong>{entry.label}</strong>
                    <span>{dateLabel(entry.dueDate)}</span>
                  </div>
                  <span className={`payment-installment-status payment-installment-status-${entry.status}`}>
                    {entry.status === 'paid'
                      ? 'Paid'
                      : entry.status === 'partially_paid'
                        ? 'Partially paid'
                        : entry.status === 'overdue'
                          ? `Overdue${entry.amountPaid > 0 ? ' · partial' : ''}`
                          : 'Pending'}
                  </span>
                </div>
                <div className="payment-installment-amounts">
                  <span>
                    Amount<strong>{money(entry.amount)}</strong>
                  </span>
                  <span>
                    Received<strong>{money(entry.amountPaid)}</strong>
                  </span>
                  <span>
                    Balance<strong>{money(entry.balanceDue)}</strong>
                  </span>
                  {editable && entry.balanceDue > 0 && (
                    <button
                      type="button"
                      className="payment-installment-record"
                      disabled={busy || manualBlocked}
                      aria-label={`Record ${entry.label}`}
                      onClick={() => onRecord(entry.balanceDue, entry.label)}
                    >
                      <Plus size={13} />
                      Record
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {editable &&
            (removing ? (
              <div className="payment-plan-remove">
                <strong>Remove this payment schedule?</strong>
                <p>
                  Recorded receipts and the invoice total stay unchanged. The change is saved in invoice
                  activity.
                </p>
                <div>
                  <button
                    className="payment-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoving(false)}
                  >
                    Keep plan
                  </button>
                  <button
                    className="payment-danger"
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      if (await onSave(null)) setRemoving(false);
                    }}
                  >
                    {saving ? <LoaderCircle size={13} className="payment-spin" /> : <Trash2 size={13} />}
                    Remove plan
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="payment-plan-remove-link"
                type="button"
                disabled={busy}
                onClick={() => setRemoving(true)}
              >
                <Trash2 size={12} />
                Remove payment plan
              </button>
            ))}
        </>
      ) : (
        <div className="payment-plan-empty">
          <div>
            <strong>Offer a flexible payment schedule</strong>
            <p>Add monthly, weekly or custom installments with an optional down payment.</p>
          </div>
          {editable && (
            <button type="button" className="payment-secondary" disabled={busy} onClick={openEditor}>
              <Plus size={14} />
              Add payment plan
            </button>
          )}
        </div>
      )}
    </section>
  );
}
