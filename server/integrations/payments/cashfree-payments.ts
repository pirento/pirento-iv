import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { balanceDue, paidAmount, type BusinessDocument } from '../../../shared/types.ts';
import { businessDateInIndia } from '../../../shared/business-date.ts';
import type {
  OnlinePaymentConfiguration,
  OnlinePaymentDetails,
  OnlinePaymentLink,
  OnlinePaymentLinkState,
} from '../../../shared/online-payment-types.ts';
import { OnlinePaymentError, type OnlinePaymentOptions } from './online-payments.ts';
import { discardProviderResponse, readProviderJson } from '../provider-http.ts';

/** One instance per business: credentials never come from editable invoice snapshots. */
export interface CashfreePaymentOptions extends OnlinePaymentOptions {
  organizationId: string;
}
type LinkRow = {
  id: string;
  organization_id: string;
  document_id: string;
  reference_id: string;
  provider_id: string | null;
  amount_paise: number;
  initial_paid_paise: number;
  url: string;
  state: OnlinePaymentLinkState;
  review_reason: string;
  created_at: string;
  updated_at: string;
};
type ProviderLink = {
  link_id: string;
  cf_link_id?: string;
  link_amount: unknown;
  link_amount_paid: unknown;
  link_currency: string;
  link_status: string;
  link_url: string;
};
type ProviderOrder = {
  link_id: string;
  order_id: string;
  order_amount: unknown;
  order_currency: string;
  order_status: string;
};
type ProviderPayment = {
  cf_payment_id: string | number;
  order_id: string;
  payment_status: string;
  is_captured?: boolean;
  payment_amount: unknown;
  payment_currency: string;
  payment_completion_time?: string;
  payment_time?: string;
  order_amount?: unknown;
  order_currency?: string;
};
const paise = (value: number) => Math.round((value + Number.EPSILON) * 100);
const terminal = (state: string) => ['paid', 'cancelled', 'expired'].includes(state);
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function paymentId(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : validId(value)
      ? value
      : undefined;
}
/** Cashfree amounts are rupees, unlike Razorpay's currency subunits. No silent rounding. */
export function cashfreeAmountPaise(value: unknown): number {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return NaN;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : NaN;
}
export function verifyCashfreeSignature(
  body: Buffer,
  signature: unknown,
  timestamp: unknown,
  secret: string,
) {
  if (
    !secret ||
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature) ||
    typeof timestamp !== 'string' ||
    !/^\d{10,16}$/.test(timestamp)
  )
    return false;
  const expected = createHmac('sha256', secret).update(timestamp).update(body).digest();
  const supplied = Buffer.from(signature, 'base64');
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

// Contract checked against cashfree/cashfree-pg-sdk-nodejs api.ts and docs/PaymentLinksApi.md:
// API version 2026-01-01; merchant link_id; GET link/orders; GET order/payments;
// webhook signature is base64 HMAC-SHA256(timestamp + original body, client secret).
export function createCashfreePayments(options: CashfreePaymentOptions) {
  const { db, organizationId, recordVerifiedPayment } = options;
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const locks = new Map<string, Promise<unknown>>();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cashfree_payment_links (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
      reference_id TEXT NOT NULL UNIQUE, provider_id TEXT, amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
      initial_paid_paise INTEGER NOT NULL, url TEXT NOT NULL DEFAULT '', state TEXT NOT NULL,
      review_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(organization_id, provider_id)
    );
    CREATE INDEX IF NOT EXISTS cashfree_links_document ON cashfree_payment_links(document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS cashfree_links_one_active ON cashfree_payment_links(document_id)
      WHERE state IN ('creating','created','partially_paid','needs_review','creation_unknown');
    CREATE TABLE IF NOT EXISTS cashfree_verified_payments (
      organization_id TEXT NOT NULL, provider_payment_id TEXT NOT NULL, link_id TEXT NOT NULL REFERENCES cashfree_payment_links(id),
      amount_paise INTEGER NOT NULL CHECK(amount_paise > 0), ledger_payment_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, provider_payment_id)
    );
    CREATE TABLE IF NOT EXISTS cashfree_link_orders (
      organization_id TEXT NOT NULL, provider_order_id TEXT NOT NULL, link_id TEXT NOT NULL REFERENCES cashfree_payment_links(id),
      PRIMARY KEY(organization_id, provider_order_id)
    );
    CREATE TABLE IF NOT EXISTS cashfree_webhook_events (
      organization_id TEXT NOT NULL, event_key TEXT NOT NULL, payload_hash TEXT NOT NULL, event_type TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(organization_id, event_key)
    );
    CREATE TABLE IF NOT EXISTS cashfree_failed_attempts (
      organization_id TEXT NOT NULL, provider_payment_id TEXT NOT NULL, link_id TEXT NOT NULL REFERENCES cashfree_payment_links(id),
      created_at TEXT NOT NULL, PRIMARY KEY(organization_id, provider_payment_id)
    );
  `);
  function getStatus(): OnlinePaymentConfiguration {
    const keyConfigured = !!env.CASHFREE_CLIENT_ID?.trim() && !!env.CASHFREE_CLIENT_SECRET?.trim();
    const environmentValid =
      !env.CASHFREE_ENVIRONMENT || ['sandbox', 'production'].includes(env.CASHFREE_ENVIRONMENT);
    return {
      provider: 'cashfree',
      configured: keyConfigured && environmentValid,
      keyConfigured,
      webhookConfigured: keyConfigured,
      mode:
        keyConfigured && environmentValid
          ? env.CASHFREE_ENVIRONMENT === 'production'
            ? 'live'
            : 'test'
          : 'unconfigured',
    };
  }
  function requireConfiguration() {
    if (!getStatus().configured)
      throw new OnlinePaymentError(
        'Configure this business’s Cashfree client ID, secret and environment before creating or syncing links.',
        503,
      );
  }
  function documentFor(id: string) {
    const document = options.getDocument(id);
    if (!document || document.organizationId !== organizationId)
      throw new OnlinePaymentError('Invoice not found in this business.', 404);
    return document;
  }
  function eligible(document: BusinessDocument) {
    if (
      document.kind !== 'invoice' ||
      !['sent', 'partially_paid'].includes(document.status) ||
      document.finalizedAt ||
      balanceDue(document) <= 0
    )
      throw new OnlinePaymentError(
        'Payment links are available for issued invoices with an outstanding balance.',
        409,
      );
  }
  function rowsFor(id: string) {
    return db
      .prepare(
        'SELECT * FROM cashfree_payment_links WHERE document_id = ? AND organization_id = ? ORDER BY created_at DESC, rowid DESC',
      )
      .all(id, organizationId) as LinkRow[];
  }
  function received(row: LinkRow) {
    return (
      db
        .prepare(
          'SELECT COALESCE(SUM(amount_paise),0) AS amount FROM cashfree_verified_payments WHERE link_id = ?',
        )
        .get(row.id) as { amount: number }
    ).amount;
  }
  function present(row: LinkRow): OnlinePaymentLink {
    return {
      id: row.id,
      documentId: row.document_id,
      provider: 'cashfree',
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
  function getDocumentPayments(id: string): OnlinePaymentDetails {
    documentFor(id);
    const links = rowsFor(id).map(present);
    return {
      configuration: getStatus(),
      links,
      hasBlockingPaymentLink: links.some((link) => !terminal(link.state)),
    };
  }
  function assertManualChangesAllowed(id: string) {
    if (getDocumentPayments(id).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile the active Cashfree link before recording an offline payment or changing this invoice.',
        409,
      );
  }
  function update(row: LinkRow, state: OnlinePaymentLinkState, reason = '') {
    row.state = state;
    row.review_reason = reason;
    row.updated_at = now().toISOString();
    db.prepare(
      'UPDATE cashfree_payment_links SET state = ?, review_reason = ?, updated_at = ? WHERE id = ?',
    ).run(state, reason, row.updated_at, row.id);
  }
  function review(row: LinkRow, reason: string): never {
    update(row, 'needs_review', reason);
    throw new OnlinePaymentError(reason, 409);
  }
  function atomic<T>(fn: () => T): T {
    db.exec('SAVEPOINT cashfree_payment_write');
    try {
      const result = fn();
      db.exec('RELEASE SAVEPOINT cashfree_payment_write');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT cashfree_payment_write; RELEASE SAVEPOINT cashfree_payment_write');
      throw error;
    }
  }
  async function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  }
  async function api<T>(path: string, method = 'GET', body?: unknown, idempotency?: string): Promise<T> {
    requireConfiguration();
    let response: Response;
    try {
      response = await request(
        `https://${env.CASHFREE_ENVIRONMENT === 'production' ? 'api' : 'sandbox'}.cashfree.com/pg${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            'x-client-id': env.CASHFREE_CLIENT_ID!,
            'x-client-secret': env.CASHFREE_CLIENT_SECRET!,
            'x-api-version': '2026-01-01',
            'Content-Type': 'application/json',
            ...(idempotency ? { 'x-idempotency-key': idempotency } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new OnlinePaymentError(
        'Cashfree could not be reached. Check server network access and sync again.',
        502,
      );
    }
    // Conflict/timeouts/rate limits can describe a request that already created a link.
    if (!response.ok) {
      discardProviderResponse(response);
      throw new OnlinePaymentError(
        'Cashfree rejected the request. Check this business’s provider account and configuration.',
        502,
        [400, 401, 403, 422].includes(response.status),
      );
    }
    try {
      return await readProviderJson<T>(response);
    } catch {
      throw new OnlinePaymentError('Cashfree returned an invalid response.', 502);
    }
  }
  function validUrl(value: unknown) {
    let url: URL;
    try {
      url = new URL(typeof value === 'string' ? value : '');
    } catch {
      throw new OnlinePaymentError('Cashfree returned an invalid payment URL.', 502);
    }
    if (
      url.protocol !== 'https:' ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      !['payments.cashfree.com', 'sandbox.cashfree.com', 'cashfree.com', 'www.cashfree.com'].includes(
        url.hostname,
      )
    )
      throw new OnlinePaymentError('Cashfree returned an unsupported payment URL.', 502);
    return url.toString();
  }
  function validateLink(row: LinkRow, link: ProviderLink) {
    const amountPaid = cashfreeAmountPaise(link.link_amount_paid);
    if (
      link.link_id !== row.reference_id ||
      cashfreeAmountPaise(link.link_amount) !== row.amount_paise ||
      link.link_currency !== 'INR' ||
      !Number.isSafeInteger(amountPaid) ||
      amountPaid > row.amount_paise ||
      !['ACTIVE', 'PAID', 'PARTIALLY_PAID', 'CANCELLED', 'EXPIRED'].includes(link.link_status)
    )
      review(row, 'Cashfree link details do not match the saved invoice request.');
    return amountPaid;
  }
  function staleBalance(row: LinkRow, document: BusinessDocument) {
    return (
      paise(paidAmount(document)) !== row.initial_paid_paise + received(row) ||
      paise(document.totals.total) !== row.initial_paid_paise + row.amount_paise
    );
  }
  async function processOrder(row: LinkRow, order: ProviderOrder) {
    const orderPaise = cashfreeAmountPaise(order.order_amount);
    if (
      order.link_id !== row.reference_id ||
      !validId(order.order_id) ||
      order.order_currency !== 'INR' ||
      !Number.isSafeInteger(orderPaise) ||
      orderPaise <= 0 ||
      orderPaise > row.amount_paise
    )
      review(row, 'A Cashfree order could not be matched to the invoice payment link.');
    const existingOrder = db
      .prepare('SELECT link_id FROM cashfree_link_orders WHERE organization_id = ? AND provider_order_id = ?')
      .get(organizationId, order.order_id) as { link_id: string } | undefined;
    if (existingOrder && existingOrder.link_id !== row.id)
      review(row, 'This Cashfree order belongs to a different payment link.');
    db.prepare('INSERT OR IGNORE INTO cashfree_link_orders VALUES (?,?,?)').run(
      organizationId,
      order.order_id,
      row.id,
    );
    const payments = await api<ProviderPayment[]>(`/orders/${encodeURIComponent(order.order_id)}/payments`);
    if (!Array.isArray(payments))
      throw new OnlinePaymentError('Cashfree returned an invalid payment list.', 502);
    // Record successful attempts first so failed retries cannot trigger an unnecessary reminder.
    for (const payment of [...payments].sort(
      (a, b) => Number(b.payment_status === 'SUCCESS') - Number(a.payment_status === 'SUCCESS'),
    )) {
      const id = paymentId(payment.cf_payment_id);
      const amount = cashfreeAmountPaise(payment.payment_amount);
      if (
        !id ||
        payment.order_id !== order.order_id ||
        payment.payment_currency !== 'INR' ||
        amount !== orderPaise ||
        (payment.order_currency != null && payment.order_currency !== 'INR') ||
        (payment.order_amount != null && cashfreeAmountPaise(payment.order_amount) !== orderPaise)
      )
        review(row, 'A Cashfree payment could not be matched to the order, amount and currency.');
      if (
        payment.payment_status === 'SUCCESS' &&
        (payment.is_captured === undefined || payment.is_captured === true)
      ) {
        const existing = db
          .prepare(
            'SELECT link_id FROM cashfree_verified_payments WHERE organization_id = ? AND provider_payment_id = ?',
          )
          .get(organizationId, id) as { link_id: string } | undefined;
        if (existing) {
          if (existing.link_id !== row.id)
            review(row, 'This Cashfree payment was already assigned to another invoice.');
          continue;
        }
        const document = documentFor(row.document_id);
        if (
          staleBalance(row, document) ||
          document.status === 'cancelled' ||
          amount > paise(balanceDue(document)) ||
          received(row) + amount > row.amount_paise
        )
          review(
            row,
            'Invoice balance changed or Cashfree payment exceeds the balance. Review the payment before recording or refunding it.',
          );
        const receivedAt = now();
        const date = new Date(
          payment.payment_completion_time ?? payment.payment_time ?? receivedAt.toISOString(),
        );
        const paidOn = businessDateInIndia(Number.isNaN(date.getTime()) ? receivedAt : date);
        if (paidOn > businessDateInIndia(receivedAt))
          review(
            row,
            'Cashfree returned a future payment date. Review the captured payment with the provider before recording it.',
          );
        atomic(() => {
          const recorded = recordVerifiedPayment({
            documentId: document.id,
            amount: amount / 100,
            paidOn,
            reference: id,
            requestId: `cashfree:${id}`,
            notes: `Verified Cashfree payment for ${row.reference_id}.`,
          });
          db.prepare('INSERT INTO cashfree_verified_payments VALUES (?,?,?,?,?,?)').run(
            organizationId,
            id,
            row.id,
            amount,
            recorded.id,
            now().toISOString(),
          );
          options.notifyPayment?.({
            event: 'payment_received',
            key: `cashfree:${organizationId}:success:${id}`,
            document: documentFor(document.id),
            payment: recorded,
            paymentUrl: row.url,
          });
        });
      } else if (['FAILED', 'USER_DROPPED'].includes(payment.payment_status)) {
        if (
          db
            .prepare(
              'SELECT 1 FROM cashfree_failed_attempts WHERE organization_id = ? AND provider_payment_id = ?',
            )
            .get(organizationId, id)
        )
          continue;
        atomic(() => {
          const document = documentFor(row.document_id);
          if (balanceDue(document) > 0 && document.status !== 'cancelled')
            options.notifyPayment?.({
              event: 'payment_failed',
              key: `cashfree:${organizationId}:failed:${id}`,
              document,
              reason:
                'Cashfree reported an unsuccessful payment attempt. No payment was recorded for that attempt.',
              paymentUrl: row.url,
            });
          db.prepare('INSERT INTO cashfree_failed_attempts VALUES (?,?,?,?)').run(
            organizationId,
            id,
            row.id,
            now().toISOString(),
          );
        });
      }
    }
  }
  async function syncRow(row: LinkRow) {
    documentFor(row.document_id);
    // Merchant-chosen link_id is persisted before creation, so even a lost HTTP
    // response can be reconciled without creating a second payable request.
    const link = await api<ProviderLink>(`/links/${encodeURIComponent(row.reference_id)}`);
    const providerPaid = validateLink(row, link);
    if (!row.provider_id || !row.url) {
      row.provider_id = row.reference_id;
      row.url = validUrl(link.link_url);
      db.prepare('UPDATE cashfree_payment_links SET provider_id = ?, url = ? WHERE id = ?').run(
        row.provider_id,
        row.url,
        row.id,
      );
    }
    const orders = await api<ProviderOrder[]>(`/links/${encodeURIComponent(row.reference_id)}/orders`);
    if (!Array.isArray(orders)) throw new OnlinePaymentError('Cashfree returned an invalid order list.', 502);
    for (const order of [...orders].sort(
      (a, b) => Number(b.order_status === 'PAID') - Number(a.order_status === 'PAID'),
    ))
      await processOrder(row, order);
    const credited = received(row);
    if (
      ['cancelled', 'expired', 'paid'].includes(row.state) &&
      providerPaid === credited &&
      (row.state === 'paid' || ['CANCELLED', 'EXPIRED'].includes(link.link_status))
    )
      return;
    if (staleBalance(row, documentFor(row.document_id)))
      return update(
        row,
        'needs_review',
        'Invoice changes or offline payments no longer match this Cashfree link.',
      );
    if (providerPaid !== credited || (link.link_status === 'PAID' && credited !== row.amount_paise))
      return update(
        row,
        'needs_review',
        'Cashfree totals differ from independently verified payments. Sync again or review the provider account.',
      );
    update(
      row,
      link.link_status === 'CANCELLED'
        ? 'cancelled'
        : link.link_status === 'EXPIRED'
          ? 'expired'
          : credited === row.amount_paise
            ? 'paid'
            : credited > 0
              ? 'partially_paid'
              : 'created',
    );
  }
  async function syncDocument(id: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    documentFor(id);
    return serialized(id, async () => {
      for (const row of rowsFor(id)) if (!terminal(row.state)) await syncRow(row);
      return getDocumentPayments(id);
    });
  }
  async function cancelPaymentLink(id: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    documentFor(id);
    return serialized(id, async () => {
      const row = rowsFor(id).find((item) => !terminal(item.state));
      if (!row) return getDocumentPayments(id);
      await syncRow(row);
      if (row.state === 'needs_review') throw new OnlinePaymentError(row.review_reason, 409);
      if (!terminal(row.state)) {
        await api<ProviderLink>(
          `/links/${encodeURIComponent(row.reference_id)}/cancel`,
          'POST',
          undefined,
          row.id,
        );
        await syncRow(row);
        if (!terminal(row.state))
          throw new OnlinePaymentError(
            'Cashfree has not confirmed cancellation; keep this invoice unchanged and sync again.',
            409,
          );
      }
      return getDocumentPayments(id);
    });
  }
  async function createPaymentLink(id: string): Promise<OnlinePaymentDetails> {
    requireConfiguration();
    documentFor(id);
    return serialized(id, async () => {
      eligible(documentFor(id));
      const active = rowsFor(id).find((row) => !terminal(row.state));
      if (active) {
        await syncRow(active);
        if (active.state === 'needs_review') throw new OnlinePaymentError(active.review_reason, 409);
        if (!['cancelled', 'expired'].includes(active.state)) return getDocumentPayments(id);
      }
      const document = documentFor(id);
      eligible(document);
      let phone = (document.customerSnapshot.phone ?? '').replace(/[\s()+-]/g, '');
      if (/^91[6-9]\d{9}$/.test(phone)) phone = phone.slice(2);
      if (!/^[6-9]\d{9}$/.test(phone))
        throw new OnlinePaymentError(
          'Add the customer’s valid 10-digit Indian mobile number before creating a Cashfree payment link.',
        );
      const timestamp = now().toISOString();
      const row: LinkRow = {
        id: randomUUID(),
        organization_id: organizationId,
        document_id: id,
        reference_id: `vc_${randomUUID().replaceAll('-', '')}`,
        provider_id: null,
        amount_paise: paise(balanceDue(document)),
        initial_paid_paise: paise(paidAmount(document)),
        url: '',
        state: 'creating',
        review_reason: '',
        created_at: timestamp,
        updated_at: timestamp,
      };
      if (!Number.isSafeInteger(row.amount_paise) || row.amount_paise <= 0)
        throw new OnlinePaymentError('Invoice amount cannot be represented in paise.', 409);
      db.prepare(
        'INSERT INTO cashfree_payment_links (id,organization_id,document_id,reference_id,amount_paise,initial_paid_paise,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(
        row.id,
        organizationId,
        id,
        row.reference_id,
        row.amount_paise,
        row.initial_paid_paise,
        row.state,
        timestamp,
        timestamp,
      );
      try {
        const link = await api<ProviderLink>(
          '/links',
          'POST',
          {
            link_id: row.reference_id,
            link_amount: row.amount_paise / 100,
            link_currency: 'INR',
            link_purpose: `Invoice ${document.number}`.slice(0, 255),
            link_partial_payments: true,
            link_notify: { send_sms: false, send_email: false },
            link_auto_reminders: false,
            customer_details: {
              customer_name: document.customerSnapshot.name.slice(0, 200),
              customer_phone: phone,
              ...(document.customerSnapshot.email ? { customer_email: document.customerSnapshot.email } : {}),
            },
            link_notes: { document_id: id, organization_id: organizationId },
          },
          row.id,
        );
        validateLink(row, link);
        row.provider_id = row.reference_id;
        db.prepare('UPDATE cashfree_payment_links SET provider_id = ? WHERE id = ?').run(
          row.provider_id,
          row.id,
        );
        row.url = validUrl(link.link_url);
        db.prepare('UPDATE cashfree_payment_links SET url = ? WHERE id = ?').run(row.url, row.id);
        update(row, 'created');
        if (staleBalance(row, documentFor(id)))
          update(row, 'needs_review', 'Invoice changed while its Cashfree payment link was being created.');
        return getDocumentPayments(id);
      } catch (error) {
        if (error instanceof OnlinePaymentError && error.providerRejected && !row.provider_id)
          update(row, 'cancelled', 'Cashfree rejected link creation; no payable link was confirmed.');
        else if (row.state !== 'needs_review')
          update(
            row,
            'creation_unknown',
            'Creation could not be confirmed. Sync the saved Cashfree link reference before another request.',
          );
        throw error;
      }
    });
  }
  type Webhook = {
    type?: string;
    data?: {
      link_id?: string;
      link?: { link_id?: string };
      order?: { order_id?: string };
      payment?: { cf_payment_id?: string | number };
    };
  };
  async function processWebhook(body: Buffer, signature: unknown, timestamp: unknown, eventId?: string) {
    if (!verifyCashfreeSignature(body, signature, timestamp, env.CASHFREE_CLIENT_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    let event: Webhook;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
    if (!event || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object')
      throw new OnlinePaymentError('Invalid Cashfree webhook event.');
    const hash = createHash('sha256').update(body).digest('hex');
    const key = eventId && /^[A-Za-z0-9_-]{1,200}$/.test(eventId) ? eventId : hash;
    const existing = db
      .prepare(
        'SELECT payload_hash,status FROM cashfree_webhook_events WHERE organization_id = ? AND event_key = ?',
      )
      .get(organizationId, key) as { payload_hash: string; status: string } | undefined;
    if (existing && existing.payload_hash !== hash)
      throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
    if (existing?.status === 'complete') return { received: true, duplicate: true };
    const linkId = event.data.link_id ?? event.data.link?.link_id;
    let row = validId(linkId)
      ? (db
          .prepare('SELECT * FROM cashfree_payment_links WHERE organization_id = ? AND reference_id = ?')
          .get(organizationId, linkId) as LinkRow | undefined)
      : undefined;
    const orderId = event.data.order?.order_id;
    if (!row && validId(orderId)) {
      row = db
        .prepare(
          'SELECT l.* FROM cashfree_payment_links l JOIN cashfree_link_orders o ON o.link_id = l.id WHERE o.organization_id = ? AND o.provider_order_id = ?',
        )
        .get(organizationId, orderId) as LinkRow | undefined;
      // A first generic payment event may precede a payment-link event. Discover
      // its order using only authenticated per-link results, never buyer identity.
      if (!row) {
        const candidates = db
          .prepare(
            "SELECT * FROM cashfree_payment_links WHERE organization_id = ? AND state NOT IN ('paid','cancelled','expired')",
          )
          .all(organizationId) as LinkRow[];
        for (const candidate of candidates) {
          const orders = await api<ProviderOrder[]>(
            `/links/${encodeURIComponent(candidate.reference_id)}/orders`,
          );
          if (!Array.isArray(orders))
            throw new OnlinePaymentError('Cashfree returned an invalid order list.', 502);
          if (
            orders.some((order) => order.order_id === orderId && order.link_id === candidate.reference_id)
          ) {
            row = candidate;
            break;
          }
        }
      }
    }
    if (!row) return { received: true, ignored: true };
    documentFor(row.document_id);
    const receivedAt = now().toISOString();
    db.prepare("INSERT OR IGNORE INTO cashfree_webhook_events VALUES (?,?,?,?,'pending',?,?)").run(
      organizationId,
      key,
      hash,
      event.type,
      receivedAt,
      receivedAt,
    );
    await serialized(row.document_id, async () => {
      const status = db
        .prepare('SELECT status FROM cashfree_webhook_events WHERE organization_id = ? AND event_key = ?')
        .get(organizationId, key) as { status: string };
      if (status.status === 'complete') return;
      await syncRow(row!);
      db.prepare(
        "UPDATE cashfree_webhook_events SET status = 'complete', updated_at = ? WHERE organization_id = ? AND event_key = ?",
      ).run(now().toISOString(), organizationId, key);
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
          error: error instanceof OnlinePaymentError ? error.message : 'Cashfree operation failed.',
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
        await processWebhook(
          req.body,
          req.get('x-webhook-signature'),
          req.get('x-webhook-timestamp'),
          req.get('x-idempotency-header'),
        ),
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
