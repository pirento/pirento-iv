/**
 * Razorpay payment links for invoices.
 *
 * Creates a link for the invoice balance, syncs its status from Razorpay, and records a receipt
 * only after the payment is verified with Razorpay (amount, currency and invoice must match).
 * Webhooks are verified with the HMAC signature before anything is processed.
 */

import { mapAsync } from '../../async-collections.js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { balanceDue, paidAmount } from '../../../../shared/types.js';
import { indiaBusinessDate } from '../../../../shared/business-date.js';
import { discardProviderResponse, readProviderJson } from '../provider-http.js';
import { transactionForRecord } from '../../transaction-ownership.js';

/** Payment error with an HTTP status and a message safe to show the user. */
export class OnlinePaymentError extends Error {
  status;
  providerRejected;
  constructor(message, status = 400, providerRejected = false) {
    super(message);
    this.status = status;
    this.providerRejected = providerRejected;
  }
}

/** Converts any error into { status, message } for the API response. */
export function paymentErrorResponse(error, fallback) {
  if (error instanceof OnlinePaymentError) return { status: error.status, message: error.message };
  if (error?.code === 11000)
    return {
      status: 409,
      message: 'An equivalent payment request already exists. Refresh and sync its current status.',
    };
  return { status: 500, message: fallback };
}
const paise = (amount) => Math.round((amount + Number.EPSILON) * 100);
const isId = (value, prefix) =>
  typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
function providerPaise(value) {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : NaN;
}
/** Checks a Razorpay webhook body against its HMAC-SHA256 signature (constant-time compare). */
export function verifyRazorpaySignature(body, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
/** Returns the Razorpay module for one credential profile (status, links, sync, webhooks). */
export function createOnlinePayments(options) {
  const { db, getDocument, recordVerifiedPayment } = options;
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const locks = new Map();
  function getStatus() {
    const keyConfigured = !!env.RAZORPAY_KEY_ID?.trim() && !!env.RAZORPAY_KEY_SECRET?.trim();
    const webhookConfigured = !!env.RAZORPAY_WEBHOOK_SECRET?.trim();
    return {
      provider: 'razorpay',
      configured: keyConfigured && webhookConfigured,
      keyConfigured,
      webhookConfigured,
      mode: keyConfigured ? (env.RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'test' : 'live') : 'unconfigured',
    };
  }
  async function requireConfiguration() {
    if (!(await getStatus()).configured)
      throw new OnlinePaymentError(
        'Configure Razorpay server keys and a webhook secret before creating or syncing payment links.',
        503,
      );
  }
  async function documentFor(id) {
    const document = await getDocument(id);
    if (!document) throw new OnlinePaymentError('Invoice not found.', 404);
    return document;
  }
  function eligible(document) {
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
  async function rowsFor(documentId) {
    return await db.models.razorpay.listLinks(documentId);
  }
  async function received(row) {
    return (await db.models.razorpay.received(row.id)).amount;
  }
  async function present(row) {
    return {
      id: row.id,
      documentId: row.document_id,
      providerId: row.provider_id,
      referenceId: row.reference_id,
      url: row.url,
      amount: row.amount_paise / 100,
      amountReceived: (await received(row)) / 100,
      currency: 'INR',
      state: row.state,
      reviewReason: row.review_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async function getDocumentPayments(documentId) {
    await documentFor(documentId);
    const links = await mapAsync(await rowsFor(documentId), present);
    return {
      configuration: await getStatus(),
      links,
      hasBlockingPaymentLink: links.some((link) => !['cancelled', 'expired', 'paid'].includes(link.state)),
    };
  }
  async function assertManualChangesAllowed(documentId) {
    if ((await getDocumentPayments(documentId)).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile the active online payment link before recording an offline payment or changing this invoice.',
        409,
      );
  }
  async function atomic(documentId, fn) {
    return await transactionForRecord(db, () => documentFor(documentId), fn);
  }
  async function update(row, state, reason = '') {
    row.state = state;
    row.review_reason = reason;
    row.updated_at = now().toISOString();
    await db.models.razorpay.setState(state, reason, row.updated_at, row.id);
  }
  async function serialized(documentId, fn) {
    const previous = locks.get(documentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    locks.set(documentId, next);
    try {
      return await next;
    } finally {
      if (locks.get(documentId) === next) locks.delete(documentId);
    }
  }
  async function api(path, method = 'GET', body) {
    await requireConfiguration();
    let response;
    try {
      response = await request(`https://api.razorpay.com/v1${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
            }),
      });
    } catch {
      throw new OnlinePaymentError(
        'Razorpay could not be reached. Check server network access and try syncing again.',
        502,
      );
    }
    if (!response.ok) {
      discardProviderResponse(response);
      throw new OnlinePaymentError(
        'Razorpay rejected the request. Check the provider dashboard and server configuration.',
        502,
        [400, 401, 403, 422].includes(response.status),
      );
    }
    try {
      return await readProviderJson(response);
    } catch {
      throw new OnlinePaymentError('Razorpay returned an invalid response.', 502);
    }
  }
  async function validateLink(row, link) {
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
      await update(
        row,
        'needs_review',
        'Provider link details do not match the saved invoice payment request.',
      );
      throw new OnlinePaymentError(row.review_reason, 409);
    }
    if (link.payments != null && !Array.isArray(link.payments))
      throw new OnlinePaymentError('Razorpay returned an invalid list of link payments.', 502);
  }
  function belongsToLink(link, payment) {
    return (
      !!link.payments?.some(
        (item) => item.payment_id === payment.id && providerPaise(item.amount) === payment.amount,
      ) ||
      (!!link.order_id && link.order_id === payment.order_id)
    );
  }
  async function staleBalance(row, document) {
    return (
      paise(paidAmount(document)) !== row.initial_paid_paise + (await received(row)) ||
      paise(document.totals.total) !== row.initial_paid_paise + row.amount_paise
    );
  }
  async function captured(row, link, paymentId) {
    const existing = await db.models.razorpay.paymentById(paymentId);
    if (existing) {
      if (existing.link_id !== row.id)
        throw new OnlinePaymentError(
          'This provider payment is already assigned to another payment link.',
          409,
        );
      return;
    }
    if (!isId(paymentId, 'pay')) throw new OnlinePaymentError('Invalid provider payment identifier.', 400);
    const payment = await api(`/payments/${paymentId}`);
    payment.amount = providerPaise(payment.amount);
    if (
      payment.id !== paymentId ||
      !belongsToLink(link, payment) ||
      payment.currency !== 'INR' ||
      !Number.isSafeInteger(payment.amount) ||
      payment.amount <= 0
    ) {
      await update(
        row,
        'needs_review',
        'A provider payment could not be matched to this invoice and currency.',
      );
      throw new OnlinePaymentError(row.review_reason, 409);
    }
    if (payment.status !== 'captured' || payment.captured !== true) return;
    const hasProviderTime = payment.created_at != null;
    const paidAt = hasProviderTime ? new Date(payment.created_at * 1000) : now();
    if (
      !Number.isFinite(paidAt.getTime()) ||
      (hasProviderTime && (!Number.isFinite(payment.created_at) || payment.created_at <= 0))
    )
      throw new OnlinePaymentError('Razorpay returned an invalid payment timestamp.', 502);
    const reviewReason = await atomic(row.document_id, async () => {
      // Recheck inside the MongoDB transaction: another process may have
      // credited the same provider receipt while its verification request ran.
      const credited = await db.models.razorpay.paymentById(payment.id);
      if (credited) {
        if (credited.link_id !== row.id)
          throw new OnlinePaymentError(
            'This provider payment is already assigned to another payment link.',
            409,
          );
        return;
      }
      const document = await documentFor(row.document_id);
      if (
        (await staleBalance(row, document)) ||
        payment.amount > paise(balanceDue(document)) ||
        (await received(row)) + payment.amount > row.amount_paise ||
        document.status === 'cancelled'
      )
        return 'Invoice balance changed or the provider payment exceeds its balance. Review the payment in Razorpay before recording or refunding it.';
      const recorded = await recordVerifiedPayment({
        documentId: document.id,
        amount: payment.amount / 100,
        paidOn: indiaBusinessDate(paidAt),
        ...(hasProviderTime ? { providerPaidAt: paidAt.toISOString() } : {}),
        reference: payment.id,
        requestId: `razorpay:${payment.id}`,
        notes: `Verified captured Razorpay payment for ${row.provider_id}.`,
      });
      await db.models.razorpay.insertPayment(
        payment.id,
        row.id,
        payment.amount,
        recorded.id,
        now().toISOString(),
      );
      await options.notifyPayment?.({
        event: 'payment_received',
        key: `razorpay:captured:${payment.id}`,
        document: await documentFor(document.id),
        payment: recorded,
        paymentUrl: row.url,
      });
    });
    if (reviewReason) {
      await update(row, 'needs_review', reviewReason);
      throw new OnlinePaymentError(reviewReason, 409);
    }
  }
  async function failed(row, link, paymentId, filteredMembership = false) {
    if (!isId(paymentId, 'pay') || (await db.models.razorpay.failedById(paymentId))) return;
    const payment = await api(`/payments/${paymentId}`);
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
    await atomic(row.document_id, async () => {
      if (await db.models.razorpay.failedById(payment.id)) return;
      const document = await documentFor(row.document_id);
      if (balanceDue(document) > 0 && document.status !== 'cancelled')
        await options.notifyPayment?.({
          event: 'payment_failed',
          key: `razorpay:failed:${payment.id}`,
          document,
          reason: 'The payment provider reported a failed attempt. No payment has been recorded.',
          paymentUrl: row.url,
        });
      await db.models.razorpay.insertFailure(payment.id, row.id, now().toISOString());
    });
  }
  async function syncRow(row, failedPaymentId, filteredMembership = false) {
    if (!row.provider_id) {
      const found = await api(`/payment_links?reference_id=${encodeURIComponent(row.reference_id)}`);
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
      await db.models.razorpay.setProviderUrl(row.provider_id, row.url, row.id);
    }
    const link = await api(`/payment_links/${row.provider_id}`);
    await validateLink(row, link);
    if (!row.url) {
      row.url = validPaymentUrl(link.short_url);
      await db.models.razorpay.setUrl(row.url, row.id);
    }
    for (const entry of link.payments ?? []) {
      if (!isId(entry.payment_id, 'pay')) continue;
      if (entry.status === 'failed') await failed(row, link, entry.payment_id);
      else await captured(row, link, entry.payment_id);
    }
    if (failedPaymentId) await failed(row, link, failedPaymentId, filteredMembership);
    await atomic(row.document_id, async () => {
      const document = await documentFor(row.document_id);
      const paid = await received(row);
      if (
        ['cancelled', 'expired'].includes(row.state) &&
        ['cancelled', 'expired'].includes(link.status) &&
        link.amount_paid === paid
      )
        return;
      if (await staleBalance(row, document)) {
        await update(
          row,
          'needs_review',
          'Offline payments or invoice changes no longer match this online payment link. Review and cancel the link in Razorpay.',
        );
        return;
      }
      if (link.amount_paid !== paid) {
        await update(
          row,
          'needs_review',
          'The provider total and verified payment entries differ. Sync again or review the payment in Razorpay.',
        );
        return;
      }
      const state =
        link.status === 'cancelled'
          ? 'cancelled'
          : link.status === 'expired'
            ? 'expired'
            : paid === row.amount_paise
              ? 'paid'
              : paid > 0
                ? 'partially_paid'
                : 'created';
      await update(row, state);
    });
  }
  async function syncDocument(documentId) {
    await requireConfiguration();
    await documentFor(documentId);
    return await serialized(documentId, async () => {
      for (const row of await rowsFor(documentId))
        if (!['paid', 'cancelled', 'expired'].includes(row.state)) await syncRow(row);
      return await getDocumentPayments(documentId);
    });
  }
  function validPaymentUrl(value) {
    if (typeof value !== 'string')
      throw new OnlinePaymentError('Razorpay returned an invalid payment URL.', 502);
    let url;
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
  async function cancelPaymentLink(documentId) {
    await requireConfiguration();
    await documentFor(documentId);
    return await serialized(documentId, async () => {
      const row = (await rowsFor(documentId)).find(
        (item) => !['cancelled', 'expired', 'paid'].includes(item.state),
      );
      if (!row) return await getDocumentPayments(documentId);
      await syncRow(row);
      if (row.state === 'needs_review') throw new OnlinePaymentError(row.review_reason, 409);
      if (!['cancelled', 'expired', 'paid'].includes(row.state)) {
        await api(`/payment_links/${row.provider_id}/cancel`, 'POST');
        await syncRow(row);
        if (!['cancelled', 'paid', 'expired'].includes(row.state))
          throw new OnlinePaymentError(
            'Razorpay has not confirmed cancellation. Keep this invoice unchanged and sync again.',
            409,
          );
      }
      return await getDocumentPayments(documentId);
    });
  }
  async function createPaymentLink(documentId) {
    await requireConfiguration();
    return await serialized(documentId, async () => {
      const document = await documentFor(documentId);
      eligible(document);
      const active = (await rowsFor(documentId)).find(
        (row) => !['cancelled', 'expired', 'paid'].includes(row.state),
      );
      if (active) {
        await syncRow(active);
        if (['needs_review', 'creation_unknown', 'creating'].includes(active.state))
          throw new OnlinePaymentError(
            active.review_reason || 'Review the existing provider link before creating another one.',
            409,
          );
        if (!['cancelled', 'expired'].includes(active.state)) return await getDocumentPayments(documentId);
      }
      const refreshed = await documentFor(documentId);
      eligible(refreshed);
      const timestamp = now().toISOString();
      const row = {
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
      await atomic(documentId, async () => {
        const latest = await documentFor(documentId);
        eligible(latest);
        if (await staleBalance(row, latest))
          throw new OnlinePaymentError(
            'Invoice balance changed. Refresh before creating a payment link.',
            409,
          );
        if (
          (await rowsFor(documentId)).some((link) => !['paid', 'cancelled', 'expired'].includes(link.state))
        )
          throw new OnlinePaymentError(
            'An online payment link already exists. Sync it before creating another request.',
            409,
          );
        await db.models.razorpay.insertLink(
          row.id,
          documentId,
          row.reference_id,
          row.amount_paise,
          row.initial_paid_paise,
          row.state,
          timestamp,
          timestamp,
        );
      });
      try {
        const link = await api('/payment_links', 'POST', {
          amount: row.amount_paise,
          currency: 'INR',
          accept_partial: true,
          reference_id: row.reference_id,
          description: `Invoice ${refreshed.number}`.slice(0, 255),
          customer: {
            name: refreshed.customerSnapshot.name.slice(0, 200),
            ...(refreshed.customerSnapshot.email
              ? {
                  email: refreshed.customerSnapshot.email,
                }
              : {}),
          },
          notify: {
            sms: false,
            email: false,
          },
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
        await db.models.razorpay.setProvider(row.provider_id, row.id);
        await validateLink(row, link);
        row.url = validPaymentUrl(link.short_url);
        await db.models.razorpay.setUrl(row.url, row.id);
        await update(row, 'created');
        if (await staleBalance(row, await documentFor(documentId)))
          await update(
            row,
            'needs_review',
            'Invoice changed while its payment link was being created. Review and cancel the link in Razorpay.',
          );
        return await getDocumentPayments(documentId);
      } catch (error) {
        if (error instanceof OnlinePaymentError && error.providerRejected && !row.provider_id)
          await update(
            row,
            'cancelled',
            'The provider rejected link creation; no payable link was confirmed.',
          );
        else if (row.state !== 'needs_review')
          await update(
            row,
            'creation_unknown',
            'Creation could not be confirmed. Check Razorpay before making another request.',
          );
        throw error;
      }
    });
  }
  async function processWebhook(body, signature, eventId) {
    if (!verifyRazorpaySignature(body, signature, env.RAZORPAY_WEBHOOK_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    let event;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string')
      throw new OnlinePaymentError('Invalid webhook event.');
    const hash = createHash('sha256').update(body).digest('hex');
    const key = eventId && /^[A-Za-z0-9_-]{1,200}$/.test(eventId) ? eventId : hash;
    const existing = await db.models.razorpay.eventByKey(key);
    if (existing && existing.payload_hash !== hash)
      throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
    if (existing?.status === 'complete')
      return {
        received: true,
        duplicate: true,
      };
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
      return {
        received: true,
        ignored: true,
      };
    const linkId = event.payload?.payment_link?.entity?.id ?? event.payload?.payment?.entity?.payment_link_id;
    const eventPaymentId = event.payload?.payment?.entity?.id;
    let filteredMembership = false;
    let row = isId(linkId, 'plink') ? await db.models.razorpay.linkByProvider(linkId) : undefined;
    if (!row) {
      const reference =
        event.payload?.payment_link?.entity?.reference_id ??
        event.payload?.payment?.entity?.notes?.reference_id;
      if (reference) row = await db.models.razorpay.linkByReference(reference);
    }
    if (isId(eventPaymentId, 'pay') && (!row || event.event === 'payment.failed')) {
      const found = await api(`/payment_links?payment_id=${encodeURIComponent(eventPaymentId)}`);
      const candidates = found.payment_links ?? found.items ?? [];
      if (candidates.length === 1 && isId(candidates[0].id, 'plink')) {
        const candidate = await db.models.razorpay.linkByProvider(candidates[0].id);
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
    if (!row)
      return {
        received: true,
        ignored: true,
      };
    if (!(await getDocument(row.document_id)))
      return {
        received: true,
        ignored: true,
      };
    const timestamp = now().toISOString();
    await db.models.razorpay.insertEvent(key, hash, event.event, timestamp, timestamp);
    await serialized(row.document_id, async () => {
      const status = await db.models.razorpay.eventByKey(key);
      if (status.payload_hash !== hash)
        throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
      if (status.status === 'complete') return;
      await syncRow(row, event.event === 'payment.failed' ? eventPaymentId : undefined, filteredMembership);
      await db.models.razorpay.completeEvent(now().toISOString(), key);
    });
    return {
      received: true,
    };
  }
  const router = Router();
  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(String(req.params.id)));
    } catch (error) {
      const { status, message } = paymentErrorResponse(error, 'Online payment operation failed.');
      res.status(status).json({ error: message });
    }
  };
  router.get('/documents/:id/online-payments', route(getDocumentPayments));
  router.post('/documents/:id/payment-link', route(createPaymentLink));
  router.post('/documents/:id/payment-link/sync', route(syncDocument));
  router.post('/documents/:id/payment-link/cancel', route(cancelPaymentLink));
  const webhookHandler = async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body))
        throw new OnlinePaymentError('Webhook requires the original request body.');
      res.json(
        await processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id')),
      );
    } catch (error) {
      const { status, message } = paymentErrorResponse(error, 'Webhook processing failed; retry delivery.');
      res.status(status).json({ error: message });
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
