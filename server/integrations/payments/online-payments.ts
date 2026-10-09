import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Router, type RequestHandler } from 'express';
import { balanceDue, paidAmount, type BusinessDocument, type PaymentRecord } from '../../../shared/types.ts';
import type {
  OnlinePaymentConfiguration,
  OnlinePaymentDetails,
  OnlinePaymentLink,
  OnlinePaymentLinkState,
} from '../../../shared/online-payment-types.ts';
import { discardProviderResponse, readProviderJson } from '../provider-http.ts';

export interface VerifiedOnlinePayment {
  documentId: string;
  amount: number;
  paidOn: string;
  reference: string;
  requestId: string;
  notes: string;
}
export interface OnlinePaymentNotification {
  event: 'payment_received' | 'payment_failed';
  key: string;
  document: BusinessDocument;
  payment?: PaymentRecord;
  reason?: string;
  paymentUrl?: string;
}
export interface OnlinePaymentOptions {
  db: DatabaseSync;
  getDocument: (id: string) => BusinessDocument | undefined;
  /** Runs inside a SAVEPOINT: no own BEGIN; must deduplicate requestId, including on a Final invoice. */
  recordVerifiedPayment: (input: VerifiedOnlinePayment) => PaymentRecord;
  /** Queue synchronously; sending email must take place outside this callback. */
  notifyPayment?: (notification: OnlinePaymentNotification) => void;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

type LinkRow = {
  id: string;
  document_id: string;
  provider_id: string | null;
  reference_id: string;
  amount_paise: number;
  initial_paid_paise: number;
  url: string;
  state: OnlinePaymentLinkState;
  review_reason: string;
  created_at: string;
  updated_at: string;
};
type ProviderPayment = {
  id: string;
  status: string;
  captured?: boolean;
  amount: number;
  currency: string;
  order_id?: string | null;
  created_at?: number;
  error_description?: string;
  notes?: Record<string, string>;
  payment_link_id?: string;
};
type ProviderLink = {
  id: string;
  reference_id: string;
  amount: number;
  amount_paid: number;
  currency: string;
  status: string;
  short_url: string;
  order_id?: string;
  notes?: Record<string, string>;
  payments?: { payment_id: string; amount: number; status?: string; order_id?: string }[];
};
type ProviderLinkList = { payment_links?: ProviderLink[]; items?: ProviderLink[] };
export class OnlinePaymentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly providerRejected = false,
  ) {
    super(message);
  }
}
const paise = (amount: number) => Math.round((amount + Number.EPSILON) * 100);
const isId = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
// Razorpay's SDK describes both number and integer-string currency subunits.
// Reject decimals, exponents, whitespace, negatives and unsafe integers.
function providerPaise(value: unknown): number {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : NaN;
}

export function verifyRazorpaySignature(body: Buffer, signature: unknown, secret: string) {
  if (!secret || typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export function createOnlinePayments(options: OnlinePaymentOptions) {
  const { db, getDocument, recordVerifiedPayment } = options;
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS online_payment_links (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      provider_id TEXT UNIQUE,
      reference_id TEXT NOT NULL UNIQUE,
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      initial_paid_paise INTEGER NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      review_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS online_links_document ON online_payment_links(document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS online_links_one_active ON online_payment_links(document_id)
      WHERE state IN ('creating','created','partially_paid','needs_review','creation_unknown');
    CREATE TABLE IF NOT EXISTS online_verified_payments (
      provider_payment_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES online_payment_links(id),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      ledger_payment_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_webhook_events (
      event_key TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS online_failed_attempts (
      provider_payment_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL REFERENCES online_payment_links(id),
      created_at TEXT NOT NULL
    );
  `);

  function getStatus(): OnlinePaymentConfiguration {
    const keyConfigured = !!env.RAZORPAY_KEY_ID?.trim() && !!env.RAZORPAY_KEY_SECRET?.trim();
    const webhookConfigured = !!env.RAZORPAY_WEBHOOK_SECRET?.trim();
    return {
      provider: 'razorpay',
      configured: keyConfigured && webhookConfigured,
      keyConfigured,
      webhookConfigured,
      mode: keyConfigured ? (env.RAZORPAY_KEY_ID!.startsWith('rzp_test_') ? 'test' : 'live') : 'unconfigured',
    };
  }
  function requireConfiguration() {
    if (!getStatus().configured)
      throw new OnlinePaymentError(
        'Configure Razorpay server keys and a webhook secret before creating or syncing payment links.',
        503,
      );
  }
  function documentFor(id: string) {
    const document = getDocument(id);
    if (!document) throw new OnlinePaymentError('Invoice not found.', 404);
    return document;
  }
  function eligible(document: BusinessDocument) {
    if (
      document.kind !== 'invoice' ||
      !['sent', 'partially_paid'].includes(document.status) ||
      document.finalizedAt ||
      balanceDue(document) <= 0
    ) {
      throw new OnlinePaymentError(
        'Payment links are available for issued invoices with an outstanding balance.',
        409,
      );
    }
  }
  function rowsFor(documentId: string) {
    return db
      .prepare(
        'SELECT * FROM online_payment_links WHERE document_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(documentId) as LinkRow[];
  }
  function received(row: LinkRow) {
    return (
      db
        .prepare(
          'SELECT COALESCE(SUM(amount_paise),0) AS amount FROM online_verified_payments WHERE link_id = ?',
        )
        .get(row.id) as { amount: number }
    ).amount;
  }
  function present(row: LinkRow): OnlinePaymentLink {
    return {
      id: row.id,
      documentId: row.document_id,
      providerId: row.provider_id,
      referenceId: row.reference_id,
      url: row.url,
      amount: row.amount_paise / 100,
      amountReceived: received(row) / 100,
      currency: 'INR',
      state: row.state,
      reviewReason: row.review_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  function getDocumentPayments(documentId: string): OnlinePaymentDetails {
    documentFor(documentId);
    const links = rowsFor(documentId).map(present);
    return {
      configuration: getStatus(),
      links,
      hasBlockingPaymentLink: links.some((link) => !['cancelled', 'expired', 'paid'].includes(link.state)),
    };
  }
  function assertManualChangesAllowed(documentId: string) {
    if (getDocumentPayments(documentId).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile the active online payment link before recording an offline payment or changing this invoice.',
        409,
      );
  }
  function atomic<T>(fn: () => T): T {
    db.exec('SAVEPOINT online_payment_write');
    try {
      const result = fn();
      db.exec('RELEASE SAVEPOINT online_payment_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT online_payment_write; RELEASE SAVEPOINT online_payment_write');
      throw error;
    }
  }
  function update(row: LinkRow, state: OnlinePaymentLinkState, reason = '') {
    row.state = state;
    row.review_reason = reason;
    row.updated_at = now().toISOString();
    db.prepare(
      'UPDATE online_payment_links SET state = ?, review_reason = ?, updated_at = ? WHERE id = ?',
    ).run(state, reason, row.updated_at, row.id);
  }
  async function serialized<T>(documentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(documentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    locks.set(documentId, next);
    try {
      return await next;
    } finally {
      if (locks.get(documentId) === next) locks.delete(documentId);
    }
  }
  async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    requireConfiguration();
    let response: Response;
    try {
      response = await request(`https://api.razorpay.com/v1${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new OnlinePaymentError(
        'Razorpay could not be reached. Check server network access and try syncing again.',
        502,
      );
    }
    if (!response.ok) {
      discardProviderResponse(response);
      // Conflicts, request timeouts and rate limits can follow an already
      // accepted create request. Keep its reservation until reconciliation.
      throw new OnlinePaymentError(
        'Razorpay rejected the request. Check the provider dashboard and server configuration.',
        502,
        [400, 401, 403, 422].includes(response.status),
      );
    }
    try {
      return await readProviderJson<T>(response);
    } catch {
      throw new OnlinePaymentError('Razorpay returned an invalid response.', 502);
    }
  }
  function validateLink(row: LinkRow, link: ProviderLink) {
    link.amount = providerPaise(link.amount);
    link.amount_paid = providerPaise(link.amount_paid);
    if (
      link.id !== row.provider_id ||
      link.reference_id !== row.reference_id ||
      link.amount !== row.amount_paise ||
      link.currency !== 'INR' ||
      !Number.isSafeInteger(link.amount_paid) ||
      link.amount_paid < 0 ||
      link.amount_paid > row.amount_paise
    ) {
      update(row, 'needs_review', 'Provider link details do not match the saved invoice payment request.');
      throw new OnlinePaymentError(row.review_reason, 409);
    }
    if (link.payments != null && !Array.isArray(link.payments))
      throw new OnlinePaymentError('Razorpay returned an invalid list of link payments.', 502);
  }
  function belongsToLink(link: ProviderLink, payment: ProviderPayment) {
    return (
      !!link.payments?.some(
        (item) => item.payment_id === payment.id && providerPaise(item.amount) === payment.amount,
      ) ||
      (!!link.order_id && link.order_id === payment.order_id)
    );
  }
  function staleBalance(row: LinkRow, document: BusinessDocument) {
    return (
      paise(paidAmount(document)) !== row.initial_paid_paise + received(row) ||
      paise(document.totals.total) !== row.initial_paid_paise + row.amount_paise
    );
  }
  async function captured(row: LinkRow, link: ProviderLink, paymentId: string) {
    const existing = db
      .prepare('SELECT link_id FROM online_verified_payments WHERE provider_payment_id = ?')
      .get(paymentId) as { link_id: string } | undefined;
    if (existing) {
      if (existing.link_id !== row.id)
        throw new OnlinePaymentError(
          'This provider payment is already assigned to another payment link.',
          409,
        );
      return;
    }
    if (!isId(paymentId, 'pay')) throw new OnlinePaymentError('Invalid provider payment identifier.', 400);
    const payment = await api<ProviderPayment>(`/payments/${paymentId}`);
    payment.amount = providerPaise(payment.amount);
    if (
      payment.id !== paymentId ||
      !belongsToLink(link, payment) ||
      payment.currency !== 'INR' ||
      !Number.isSafeInteger(payment.amount) ||
      payment.amount <= 0
    ) {
      update(row, 'needs_review', 'A provider payment could not be matched to this invoice and currency.');
      throw new OnlinePaymentError(row.review_reason, 409);
    }
    if (payment.status !== 'captured' || payment.captured !== true) return;
    const document = documentFor(row.document_id);
    // Do not quietly credit an online payment when an offline payment or invoice
    // revision changed the amount expected by this still-payable provider link.
    if (
      staleBalance(row, document) ||
      payment.amount > paise(balanceDue(document)) ||
      received(row) + payment.amount > row.amount_paise ||
      document.status === 'cancelled'
    ) {
      update(
        row,
        'needs_review',
        'Invoice balance changed or the provider payment exceeds its balance. Review the payment in Razorpay before recording or refunding it.',
      );
      throw new OnlinePaymentError(row.review_reason, 409);
    }
    const paidAt =
      Number.isFinite(payment.created_at) && payment.created_at! > 0
        ? new Date(payment.created_at! * 1000)
        : now();
    atomic(() => {
      const recorded = recordVerifiedPayment({
        documentId: document.id,
        amount: payment.amount / 100,
        paidOn: Number.isNaN(paidAt.getTime())
          ? now().toISOString().slice(0, 10)
          : paidAt.toISOString().slice(0, 10),
        reference: payment.id,
        requestId: `razorpay:${payment.id}`,
        notes: `Verified captured Razorpay payment for ${row.provider_id}.`,
      });
      db.prepare(
        'INSERT INTO online_verified_payments (provider_payment_id,link_id,amount_paise,ledger_payment_id,created_at) VALUES (?,?,?,?,?)',
      ).run(payment.id, row.id, payment.amount, recorded.id, now().toISOString());
      options.notifyPayment?.({
        event: 'payment_received',
        key: `razorpay:captured:${payment.id}`,
        document: documentFor(document.id),
        payment: recorded,
        paymentUrl: row.url,
      });
    });
  }
  async function failed(row: LinkRow, link: ProviderLink, paymentId: string, filteredMembership = false) {
    if (
      !isId(paymentId, 'pay') ||
      db
        .prepare('SELECT provider_payment_id FROM online_failed_attempts WHERE provider_payment_id = ?')
        .get(paymentId)
    )
      return;
    const payment = await api<ProviderPayment>(`/payments/${paymentId}`);
    payment.amount = providerPaise(payment.amount);
    if (
      payment.id !== paymentId ||
      payment.status !== 'failed' ||
      payment.currency !== 'INR' ||
      !Number.isSafeInteger(payment.amount) ||
      payment.amount <= 0 ||
      (!belongsToLink(link, payment) && !filteredMembership)
    )
      return;
    atomic(() => {
      const document = documentFor(row.document_id);
      // A delayed failed-attempt delivery must not ask a customer to pay an
      // invoice that a later successful attempt already settled or cancelled.
      if (balanceDue(document) > 0 && document.status !== 'cancelled')
        options.notifyPayment?.({
          event: 'payment_failed',
          key: `razorpay:failed:${payment.id}`,
          document,
          reason: 'The payment provider reported a failed attempt. No payment has been recorded.',
          paymentUrl: row.url,
        });
      db.prepare(
        'INSERT OR IGNORE INTO online_failed_attempts (provider_payment_id,link_id,created_at) VALUES (?,?,?)',
      ).run(payment.id, row.id, now().toISOString());
    });
  }
  async function syncRow(row: LinkRow, failedPaymentId?: string, filteredMembership = false) {
    if (!row.provider_id) {
      const found = await api<ProviderLinkList>(
        `/payment_links?reference_id=${encodeURIComponent(row.reference_id)}`,
      );
      const matching = (found.payment_links ?? found.items ?? []).filter(
        (item) => item.reference_id === row.reference_id && isId(item.id, 'plink'),
      );
      if (matching.length !== 1)
        throw new OnlinePaymentError(
          'Payment link creation has an uncertain outcome. Check Razorpay by the saved reference before retrying.',
          409,
        );
      row.provider_id = matching[0].id;
      row.url = validPaymentUrl(matching[0].short_url);
      db.prepare('UPDATE online_payment_links SET provider_id = ?, url = ? WHERE id = ?').run(
        row.provider_id,
        row.url,
        row.id,
      );
    }
    const link = await api<ProviderLink>(`/payment_links/${row.provider_id}`);
    validateLink(row, link);
    if (!row.url) {
      row.url = validPaymentUrl(link.short_url);
      db.prepare('UPDATE online_payment_links SET url = ? WHERE id = ?').run(row.url, row.id);
    }
    for (const entry of link.payments ?? []) {
      if (!isId(entry.payment_id, 'pay')) continue;
      if (entry.status === 'failed') await failed(row, link, entry.payment_id);
      else await captured(row, link, entry.payment_id);
    }
    if (failedPaymentId) await failed(row, link, failedPaymentId, filteredMembership);
    const document = documentFor(row.document_id);
    const paid = received(row);
    // A delayed cancellation/expiry delivery for an earlier settled link must
    // not compare its original balance to a newer link's invoice payments.
    if (
      ['cancelled', 'expired'].includes(row.state) &&
      ['cancelled', 'expired'].includes(link.status) &&
      link.amount_paid === paid
    )
      return;
    if (staleBalance(row, document)) {
      update(
        row,
        'needs_review',
        'Offline payments or invoice changes no longer match this online payment link. Review and cancel the link in Razorpay.',
      );
      return;
    }
    if (link.amount_paid !== paid) {
      update(
        row,
        'needs_review',
        'The provider total and verified payment entries differ. Sync again or review the payment in Razorpay.',
      );
      return;
    }
    const state: OnlinePaymentLinkState =
      link.status === 'cancelled'
        ? 'cancelled'
        : link.status === 'expired'
          ? 'expired'
          : paid === row.amount_paise
            ? 'paid'
            : paid > 0
              ? 'partially_paid'
              : 'created';
    update(row, state);
  }
  async function syncDocument(documentId: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    documentFor(documentId);
    return serialized(documentId, async () => {
      for (const row of rowsFor(documentId))
        if (!['paid', 'cancelled', 'expired'].includes(row.state)) await syncRow(row);
      return getDocumentPayments(documentId);
    });
  }
  function validPaymentUrl(value: unknown) {
    if (typeof value !== 'string')
      throw new OnlinePaymentError('Razorpay returned an invalid payment URL.', 502);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new OnlinePaymentError('Razorpay returned an invalid payment URL.', 502);
    }
    if (
      url.protocol !== 'https:' ||
      (url.port && url.port !== '443') ||
      !['rzp.io', 'rzp.to', 'razorpay.com', 'pages.razorpay.com'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new OnlinePaymentError('Razorpay returned an unsupported payment URL.', 502);
    return value;
  }
  async function cancelPaymentLink(documentId: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    documentFor(documentId);
    return serialized(documentId, async () => {
      const row = rowsFor(documentId).find((item) => !['cancelled', 'expired', 'paid'].includes(item.state));
      if (!row) return getDocumentPayments(documentId);
      // Reconcile before cancellation, then fetch again after cancellation to
      // include a payment captured during the provider request.
      await syncRow(row);
      if (row.state === 'needs_review') throw new OnlinePaymentError(row.review_reason, 409);
      if (!['cancelled', 'expired', 'paid'].includes(row.state)) {
        await api<ProviderLink>(`/payment_links/${row.provider_id}/cancel`, 'POST');
        await syncRow(row);
        if (!['cancelled', 'paid', 'expired'].includes(row.state))
          throw new OnlinePaymentError(
            'Razorpay has not confirmed cancellation. Keep this invoice unchanged and sync again.',
            409,
          );
      }
      return getDocumentPayments(documentId);
    });
  }
  async function createPaymentLink(documentId: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    return serialized(documentId, async () => {
      const document = documentFor(documentId);
      eligible(document);
      const active = rowsFor(documentId).find((row) => !['cancelled', 'expired', 'paid'].includes(row.state));
      if (active) {
        await syncRow(active);
        if (['needs_review', 'creation_unknown', 'creating'].includes(active.state))
          throw new OnlinePaymentError(
            active.review_reason || 'Review the existing provider link before creating another one.',
            409,
          );
        if (!['cancelled', 'expired'].includes(active.state)) return getDocumentPayments(documentId);
      }
      const refreshed = documentFor(documentId);
      eligible(refreshed);
      const timestamp = now().toISOString();
      const row: LinkRow = {
        id: randomUUID(),
        document_id: documentId,
        provider_id: null,
        reference_id: `vc_${randomUUID().replaceAll('-', '')}`,
        amount_paise: paise(balanceDue(refreshed)),
        initial_paid_paise: paise(paidAmount(refreshed)),
        url: '',
        state: 'creating',
        review_reason: '',
        created_at: timestamp,
        updated_at: timestamp,
      };
      if (!Number.isSafeInteger(row.amount_paise) || row.amount_paise <= 0)
        throw new OnlinePaymentError('Invoice amount cannot be represented in paise.', 409);
      db.prepare(
        'INSERT INTO online_payment_links (id,document_id,reference_id,amount_paise,initial_paid_paise,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        row.id,
        documentId,
        row.reference_id,
        row.amount_paise,
        row.initial_paid_paise,
        row.state,
        timestamp,
        timestamp,
      );
      try {
        const link = await api<ProviderLink>('/payment_links', 'POST', {
          amount: row.amount_paise,
          currency: 'INR',
          accept_partial: true,
          reference_id: row.reference_id,
          description: `Invoice ${refreshed.number}`.slice(0, 255),
          customer: {
            name: refreshed.customerSnapshot.name.slice(0, 200),
            ...(refreshed.customerSnapshot.email ? { email: refreshed.customerSnapshot.email } : {}),
          },
          notify: { sms: false, email: false },
          reminder_enable: false,
          notes: {
            document_id: documentId,
            organization_id: refreshed.organizationId,
            reference_id: row.reference_id,
          },
        });
        if (!isId(link.id, 'plink'))
          throw new OnlinePaymentError('Razorpay returned an invalid payment link.', 502);
        row.provider_id = link.id;
        // Keep a valid returned provider ID even if later validation fails, so
        // an operator can recover/cancel the existing request without a duplicate.
        db.prepare('UPDATE online_payment_links SET provider_id = ? WHERE id = ?').run(
          row.provider_id,
          row.id,
        );
        validateLink(row, link);
        row.url = validPaymentUrl(link.short_url);
        db.prepare('UPDATE online_payment_links SET url = ? WHERE id = ?').run(row.url, row.id);
        update(row, 'created');
        if (staleBalance(row, documentFor(documentId)))
          update(
            row,
            'needs_review',
            'Invoice changed while its payment link was being created. Review and cancel the link in Razorpay.',
          );
        return getDocumentPayments(documentId);
      } catch (error) {
        if (error instanceof OnlinePaymentError && error.providerRejected && !row.provider_id)
          update(row, 'cancelled', 'The provider rejected link creation; no payable link was confirmed.');
        else if (row.state !== 'needs_review')
          update(
            row,
            'creation_unknown',
            'Creation could not be confirmed. Check Razorpay before making another request.',
          );
        throw error;
      }
    });
  }

  type EventPayload = {
    event?: string;
    payload?: {
      payment_link?: { entity?: Partial<ProviderLink> };
      payment?: { entity?: Partial<ProviderPayment> };
    };
  };
  async function processWebhook(body: Buffer, signature: unknown, eventId?: string) {
    if (!verifyRazorpaySignature(body, signature, env.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    let event: EventPayload;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string')
      throw new OnlinePaymentError('Invalid webhook event.');
    const hash = createHash('sha256').update(body).digest('hex');
    const key = eventId && /^[A-Za-z0-9_-]{1,200}$/.test(eventId) ? eventId : hash;
    const existing = db
      .prepare('SELECT status, payload_hash FROM online_webhook_events WHERE event_key = ?')
      .get(key) as { status: string; payload_hash: string } | undefined;
    if (existing && existing.payload_hash !== hash)
      throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
    if (existing?.status === 'complete') return { received: true, duplicate: true };
    if (
      ![
        'payment.captured',
        'payment.failed',
        'payment_link.paid',
        'payment_link.partially_paid',
        'payment_link.cancelled',
        'payment_link.expired',
      ].includes(event.event)
    )
      return { received: true, ignored: true };
    const linkId = event.payload?.payment_link?.entity?.id ?? event.payload?.payment?.entity?.payment_link_id;
    const eventPaymentId = event.payload?.payment?.entity?.id;
    let filteredMembership = false;
    let row = isId(linkId, 'plink')
      ? (db.prepare('SELECT * FROM online_payment_links WHERE provider_id = ?').get(linkId) as
          LinkRow | undefined)
      : undefined;
    if (!row) {
      // Some payment events forward the merchant's link notes instead of a link
      // entity. These only choose a candidate; fetched payment/link membership
      // below is still mandatory before money or email is recorded.
      const reference =
        event.payload?.payment_link?.entity?.reference_id ??
        event.payload?.payment?.entity?.notes?.reference_id;
      if (reference)
        row = db.prepare('SELECT * FROM online_payment_links WHERE reference_id = ?').get(reference) as
          LinkRow | undefined;
    }
    // Generic payment.failed/payment.captured payloads need not include a link
    // entity or forward notes. Razorpay documents payment_id as a link-list
    // filter; use that authenticated association, never customer email matching.
    if (isId(eventPaymentId, 'pay') && (!row || event.event === 'payment.failed')) {
      const found = await api<ProviderLinkList>(
        `/payment_links?payment_id=${encodeURIComponent(eventPaymentId)}`,
      );
      const candidates = found.payment_links ?? found.items ?? [];
      if (candidates.length === 1 && isId(candidates[0].id, 'plink')) {
        const candidate = db
          .prepare('SELECT * FROM online_payment_links WHERE provider_id = ?')
          .get(candidates[0].id) as LinkRow | undefined;
        if (
          candidate &&
          candidates[0].reference_id === candidate.reference_id &&
          (!row || row.id === candidate.id)
        ) {
          row = candidate;
          filteredMembership = true;
        }
      }
    }
    if (!row) return { received: true, ignored: true };
    // A generic payment event can discover a link owned by another division
    // using shared merchant credentials. Check the factory's document scope
    // before consuming the event or letting reconciliation mutate that link.
    if (!getDocument(row.document_id)) return { received: true, ignored: true };
    const timestamp = now().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO online_webhook_events (event_key,payload_hash,event_type,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)",
    ).run(key, hash, event.event, timestamp, timestamp);
    await serialized(row.document_id, async () => {
      const status = db.prepare('SELECT status FROM online_webhook_events WHERE event_key = ?').get(key) as {
        status: string;
      };
      if (status.status === 'complete') return;
      await syncRow(row!, event.event === 'payment.failed' ? eventPaymentId : undefined, filteredMembership);
      db.prepare(
        "UPDATE online_webhook_events SET status = 'complete', updated_at = ? WHERE event_key = ?",
      ).run(now().toISOString(), key);
    });
    return { received: true };
  }

  const router = Router();
  const route =
    (fn: (id: string) => unknown | Promise<unknown>): RequestHandler =>
    async (req, res) => {
      try {
        res.json(await fn(String(req.params.id)));
      } catch (error) {
        res.status(error instanceof OnlinePaymentError ? error.status : 500).json({
          error: error instanceof OnlinePaymentError ? error.message : 'Online payment operation failed.',
        });
      }
    };
  router.get('/documents/:id/online-payments', route(getDocumentPayments));
  router.post('/documents/:id/payment-link', route(createPaymentLink));
  router.post('/documents/:id/payment-link/sync', route(syncDocument));
  router.post('/documents/:id/payment-link/cancel', route(cancelPaymentLink));
  const webhookHandler: RequestHandler = async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body))
        throw new OnlinePaymentError('Webhook requires the original request body.');
      res.json(
        await processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id')),
      );
    } catch (error) {
      res.status(error instanceof OnlinePaymentError ? error.status : 500).json({
        error:
          error instanceof OnlinePaymentError ? error.message : 'Webhook processing failed; retry delivery.',
      });
    }
  };
  return {
    router,
    webhookHandler,
    getStatus,
    getDocumentPayments,
    createPaymentLink,
    syncDocument,
    cancelPaymentLink,
    assertManualChangesAllowed,
    processWebhook,
  };
}
