/**
 * Cashfree payment links for invoices (one module per business).
 *
 * Same flow as online-payments.js (Razorpay): create link -> sync / webhook -> verify the order
 * with Cashfree -> record a receipt. Webhooks are verified with the client secret.
 */

import { mapAsync } from '../../async-collections.js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { balanceDue, paidAmount } from '../../../../shared/types.js';
import { indiaBusinessDate } from '../../../../shared/business-date.js';
import { OnlinePaymentError, paymentErrorResponse } from './online-payments.js';
import { discardProviderResponse, readProviderJson } from '../provider-http.js';
const paise = (value) => Math.round((value + Number.EPSILON) * 100);
const terminal = (state) => ['paid', 'cancelled', 'expired'].includes(state);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function paymentId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : validId(value)
      ? value
      : undefined;
}
/** Converts a Cashfree rupee amount (max 2 decimals) to whole paise; returns NaN for anything invalid. */
export function cashfreeAmountPaise(value) {
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
/** Checks a Cashfree webhook signature (timestamp + body, HMAC-SHA256 with the client secret). */
export function verifyCashfreeSignature(body, signature, timestamp, secret) {
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
/** Returns the Cashfree module for one business (status, links, sync, webhooks). */
export function createCashfreePayments(options) {
  const { db, organizationId, recordVerifiedPayment } = options;
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const locks = new Map();
  function getStatus() {
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
  async function requireConfiguration() {
    if (!(await getStatus()).configured)
      throw new OnlinePaymentError(
        'Configure this business’s Cashfree client ID, secret and environment before creating or syncing links.',
        503,
      );
  }
  async function documentFor(id) {
    const document = await options.getDocument(id);
    if (!document || document.organizationId !== organizationId)
      throw new OnlinePaymentError('Invoice not found in this business.', 404);
    return document;
  }
  function eligible(document) {
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
  async function rowsFor(id) {
    return await db.models.cashfree.listLinks(id, organizationId);
  }
  async function received(row) {
    return (await db.models.cashfree.received(row.id)).amount;
  }
  async function present(row) {
    return {
      id: row.id,
      documentId: row.document_id,
      provider: 'cashfree',
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
  async function getDocumentPayments(id) {
    await documentFor(id);
    const links = await mapAsync(await rowsFor(id), present);
    return {
      configuration: await getStatus(),
      links,
      hasBlockingPaymentLink: links.some((link) => !terminal(link.state)),
    };
  }
  async function assertManualChangesAllowed(id) {
    if ((await getDocumentPayments(id)).hasBlockingPaymentLink)
      throw new OnlinePaymentError(
        'Cancel or reconcile the active Cashfree link before recording an offline payment or changing this invoice.',
        409,
      );
  }
  async function update(row, state, reason = '') {
    row.state = state;
    row.review_reason = reason;
    row.updated_at = now().toISOString();
    await db.models.cashfree.setState(state, reason, row.updated_at, row.id);
  }
  async function review(row, reason) {
    await update(row, 'needs_review', reason);
    throw new OnlinePaymentError(reason, 409);
  }
  async function atomic(fn) {
    return await db.transaction(fn, { organizationId });
  }
  async function serialized(id, fn) {
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    locks.set(id, next);
    try {
      return await next;
    } finally {
      if (locks.get(id) === next) locks.delete(id);
    }
  }
  async function api(path, method = 'GET', body, idempotency) {
    await requireConfiguration();
    let response;
    try {
      response = await request(
        `https://${env.CASHFREE_ENVIRONMENT === 'production' ? 'api' : 'sandbox'}.cashfree.com/pg${path}`,
        {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: {
            'x-client-id': env.CASHFREE_CLIENT_ID,
            'x-client-secret': env.CASHFREE_CLIENT_SECRET,
            'x-api-version': '2026-01-01',
            'Content-Type': 'application/json',
            ...(idempotency
              ? {
                  'x-idempotency-key': idempotency,
                }
              : {}),
          },
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
              }),
        },
      );
    } catch {
      throw new OnlinePaymentError(
        'Cashfree could not be reached. Check server network access and sync again.',
        502,
      );
    }
    if (!response.ok) {
      discardProviderResponse(response);
      throw new OnlinePaymentError(
        'Cashfree rejected the request. Check this business’s provider account and configuration.',
        502,
        [400, 401, 403, 422].includes(response.status),
      );
    }
    try {
      return await readProviderJson(response);
    } catch {
      throw new OnlinePaymentError('Cashfree returned an invalid response.', 502);
    }
  }
  function validUrl(value) {
    let url;
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
  async function validateLink(row, link) {
    const amountPaid = cashfreeAmountPaise(link.link_amount_paid);
    if (
      link.link_id !== row.reference_id ||
      cashfreeAmountPaise(link.link_amount) !== row.amount_paise ||
      link.link_currency !== 'INR' ||
      !Number.isSafeInteger(amountPaid) ||
      amountPaid > row.amount_paise ||
      !['ACTIVE', 'PAID', 'PARTIALLY_PAID', 'CANCELLED', 'EXPIRED'].includes(link.link_status)
    )
      await review(row, 'Cashfree link details do not match the saved invoice request.');
    return amountPaid;
  }
  async function staleBalance(row, document) {
    return (
      paise(paidAmount(document)) !== row.initial_paid_paise + (await received(row)) ||
      paise(document.totals.total) !== row.initial_paid_paise + row.amount_paise
    );
  }
  async function processOrder(row, order) {
    const orderPaise = cashfreeAmountPaise(order.order_amount);
    if (
      order.link_id !== row.reference_id ||
      !validId(order.order_id) ||
      order.order_currency !== 'INR' ||
      !Number.isSafeInteger(orderPaise) ||
      orderPaise <= 0 ||
      orderPaise > row.amount_paise
    )
      await review(row, 'A Cashfree order could not be matched to the invoice payment link.');
    const existingOrder = await db.models.cashfree.orderById(organizationId, order.order_id);
    if (existingOrder && existingOrder.link_id !== row.id)
      await review(row, 'This Cashfree order belongs to a different payment link.');
    await db.models.cashfree.insertOrder(organizationId, order.order_id, row.id);
    const payments = await api(`/orders/${encodeURIComponent(order.order_id)}/payments`);
    if (!Array.isArray(payments))
      throw new OnlinePaymentError('Cashfree returned an invalid payment list.', 502);
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
        await review(row, 'A Cashfree payment could not be matched to the order, amount and currency.');
      if (
        payment.payment_status === 'SUCCESS' &&
        (payment.is_captured === undefined || payment.is_captured === true)
      ) {
        const existing = await db.models.cashfree.paymentById(organizationId, id);
        if (existing) {
          if (existing.link_id !== row.id)
            await review(row, 'This Cashfree payment was already assigned to another invoice.');
          continue;
        }
        const providerTime = payment.payment_completion_time ?? payment.payment_time;
        const date = providerTime == null ? now() : new Date(providerTime);
        if (
          !Number.isFinite(date.getTime()) ||
          (providerTime != null && (typeof providerTime !== 'string' || !providerTime.trim()))
        )
          throw new OnlinePaymentError('Cashfree returned an invalid payment timestamp.', 502);
        const reviewReason = await atomic(async () => {
          const credited = await db.models.cashfree.paymentById(organizationId, id);
          if (credited) {
            if (credited.link_id !== row.id)
              throw new OnlinePaymentError(
                'This Cashfree payment was already assigned to another invoice.',
                409,
              );
            return;
          }
          const document = await documentFor(row.document_id);
          if (
            (await staleBalance(row, document)) ||
            document.status === 'cancelled' ||
            amount > paise(balanceDue(document)) ||
            (await received(row)) + amount > row.amount_paise
          )
            return 'Invoice balance changed or Cashfree payment exceeds the balance. Review the payment before recording or refunding it.';
          const recorded = await recordVerifiedPayment({
            documentId: document.id,
            amount: amount / 100,
            paidOn: indiaBusinessDate(date),
            ...(providerTime == null ? {} : { providerPaidAt: date.toISOString() }),
            reference: id,
            requestId: `cashfree:${id}`,
            notes: `Verified Cashfree payment for ${row.reference_id}.`,
          });
          await db.models.cashfree.insertPayment(
            organizationId,
            id,
            row.id,
            amount,
            recorded.id,
            now().toISOString(),
          );
          await options.notifyPayment?.({
            event: 'payment_received',
            key: `cashfree:${organizationId}:success:${id}`,
            document: await documentFor(document.id),
            payment: recorded,
            paymentUrl: row.url,
          });
        });
        if (reviewReason) await review(row, reviewReason);
      } else if (['FAILED', 'USER_DROPPED'].includes(payment.payment_status)) {
        if (await db.models.cashfree.failedById(organizationId, id)) continue;
        await atomic(async () => {
          if (await db.models.cashfree.failedById(organizationId, id)) return;
          const document = await documentFor(row.document_id);
          if (balanceDue(document) > 0 && document.status !== 'cancelled')
            await options.notifyPayment?.({
              event: 'payment_failed',
              key: `cashfree:${organizationId}:failed:${id}`,
              document,
              reason:
                'Cashfree reported an unsuccessful payment attempt. No payment was recorded for that attempt.',
              paymentUrl: row.url,
            });
          await db.models.cashfree.insertFailure(organizationId, id, row.id, now().toISOString());
        });
      }
    }
  }
  async function syncRow(row) {
    await documentFor(row.document_id);
    const link = await api(`/links/${encodeURIComponent(row.reference_id)}`);
    const providerPaid = await validateLink(row, link);
    if (!row.provider_id || !row.url) {
      row.provider_id = row.reference_id;
      row.url = validUrl(link.link_url);
      await db.models.cashfree.setProviderUrl(row.provider_id, row.url, row.id);
    }
    const orders = await api(`/links/${encodeURIComponent(row.reference_id)}/orders`);
    if (!Array.isArray(orders)) throw new OnlinePaymentError('Cashfree returned an invalid order list.', 502);
    for (const order of [...orders].sort(
      (a, b) => Number(b.order_status === 'PAID') - Number(a.order_status === 'PAID'),
    ))
      await processOrder(row, order);
    await atomic(async () => {
      const credited = await received(row);
      if (
        ['cancelled', 'expired', 'paid'].includes(row.state) &&
        providerPaid === credited &&
        (row.state === 'paid' || ['CANCELLED', 'EXPIRED'].includes(link.link_status))
      )
        return;
      if (await staleBalance(row, await documentFor(row.document_id)))
        return await update(
          row,
          'needs_review',
          'Invoice changes or offline payments no longer match this Cashfree link.',
        );
      if (providerPaid !== credited || (link.link_status === 'PAID' && credited !== row.amount_paise))
        return await update(
          row,
          'needs_review',
          'Cashfree totals differ from independently verified payments. Sync again or review the provider account.',
        );
      await update(
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
    });
  }
  async function syncDocument(id) {
    await requireConfiguration();
    await documentFor(id);
    return await serialized(id, async () => {
      for (const row of await rowsFor(id)) if (!terminal(row.state)) await syncRow(row);
      return await getDocumentPayments(id);
    });
  }
  async function cancelPaymentLink(id) {
    await requireConfiguration();
    await documentFor(id);
    return await serialized(id, async () => {
      const row = (await rowsFor(id)).find((item) => !terminal(item.state));
      if (!row) return await getDocumentPayments(id);
      await syncRow(row);
      if (row.state === 'needs_review') throw new OnlinePaymentError(row.review_reason, 409);
      if (!terminal(row.state)) {
        await api(`/links/${encodeURIComponent(row.reference_id)}/cancel`, 'POST', undefined, row.id);
        await syncRow(row);
        if (!terminal(row.state))
          throw new OnlinePaymentError(
            'Cashfree has not confirmed cancellation; keep this invoice unchanged and sync again.',
            409,
          );
      }
      return await getDocumentPayments(id);
    });
  }
  async function createPaymentLink(id) {
    await requireConfiguration();
    await documentFor(id);
    return await serialized(id, async () => {
      eligible(await documentFor(id));
      const active = (await rowsFor(id)).find((row) => !terminal(row.state));
      if (active) {
        await syncRow(active);
        if (active.state === 'needs_review') throw new OnlinePaymentError(active.review_reason, 409);
        if (!['cancelled', 'expired'].includes(active.state)) return await getDocumentPayments(id);
      }
      const document = await documentFor(id);
      eligible(document);
      let phone = (document.customerSnapshot.phone ?? '').replace(/[\s()+-]/g, '');
      if (/^91[6-9]\d{9}$/.test(phone)) phone = phone.slice(2);
      if (!/^[6-9]\d{9}$/.test(phone))
        throw new OnlinePaymentError(
          'Add the customer’s valid 10-digit Indian mobile number before creating a Cashfree payment link.',
        );
      const timestamp = now().toISOString();
      const row = {
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
      await atomic(async () => {
        const latest = await documentFor(id);
        eligible(latest);
        if (await staleBalance(row, latest))
          throw new OnlinePaymentError(
            'Invoice balance changed. Refresh before creating a payment link.',
            409,
          );
        if ((await rowsFor(id)).some((link) => !terminal(link.state)))
          throw new OnlinePaymentError(
            'An online payment link already exists. Sync it before creating another request.',
            409,
          );
        await db.models.cashfree.insertLink(
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
      });
      try {
        const link = await api(
          '/links',
          'POST',
          {
            link_id: row.reference_id,
            link_amount: row.amount_paise / 100,
            link_currency: 'INR',
            link_purpose: `Invoice ${document.number}`.slice(0, 255),
            link_partial_payments: true,
            link_notify: {
              send_sms: false,
              send_email: false,
            },
            link_auto_reminders: false,
            customer_details: {
              customer_name: document.customerSnapshot.name.slice(0, 200),
              customer_phone: phone,
              ...(document.customerSnapshot.email
                ? {
                    customer_email: document.customerSnapshot.email,
                  }
                : {}),
            },
            link_notes: {
              document_id: id,
              organization_id: organizationId,
            },
          },
          row.id,
        );
        await validateLink(row, link);
        row.provider_id = row.reference_id;
        await db.models.cashfree.setProvider(row.provider_id, row.id);
        row.url = validUrl(link.link_url);
        await db.models.cashfree.setUrl(row.url, row.id);
        await update(row, 'created');
        if (await staleBalance(row, await documentFor(id)))
          await update(
            row,
            'needs_review',
            'Invoice changed while its Cashfree payment link was being created.',
          );
        return await getDocumentPayments(id);
      } catch (error) {
        if (error instanceof OnlinePaymentError && error.providerRejected && !row.provider_id)
          await update(row, 'cancelled', 'Cashfree rejected link creation; no payable link was confirmed.');
        else if (row.state !== 'needs_review')
          await update(
            row,
            'creation_unknown',
            'Creation could not be confirmed. Sync the saved Cashfree link reference before another request.',
          );
        throw error;
      }
    });
  }
  async function processWebhook(body, signature, timestamp, eventId) {
    if (!verifyCashfreeSignature(body, signature, timestamp, env.CASHFREE_CLIENT_SECRET ?? ''))
      throw new OnlinePaymentError('Invalid webhook signature.', 401);
    let event;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      throw new OnlinePaymentError('Invalid webhook body.');
    }
    if (!event || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object')
      throw new OnlinePaymentError('Invalid Cashfree webhook event.');
    const hash = createHash('sha256').update(body).digest('hex');
    const key = eventId && /^[A-Za-z0-9_-]{1,200}$/.test(eventId) ? eventId : hash;
    const existing = await db.models.cashfree.eventByKey(organizationId, key);
    if (existing && existing.payload_hash !== hash)
      throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
    if (existing?.status === 'complete')
      return {
        received: true,
        duplicate: true,
      };
    const linkId = event.data.link_id ?? event.data.link?.link_id;
    let row = validId(linkId) ? await db.models.cashfree.linkByReference(organizationId, linkId) : undefined;
    const orderId = event.data.order?.order_id;
    if (!row && validId(orderId)) {
      row = await db.models.cashfree.linkByOrder(organizationId, orderId);
      if (!row) {
        const candidates = await db.models.cashfree.activeLinks(organizationId);
        for (const candidate of candidates) {
          const orders = await api(`/links/${encodeURIComponent(candidate.reference_id)}/orders`);
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
    if (!row)
      return {
        received: true,
        ignored: true,
      };
    await documentFor(row.document_id);
    const receivedAt = now().toISOString();
    await db.models.cashfree.insertEvent(organizationId, key, hash, event.type, receivedAt, receivedAt);
    await serialized(row.document_id, async () => {
      const status = await db.models.cashfree.eventByKey(organizationId, key);
      if (status.payload_hash !== hash)
        throw new OnlinePaymentError('Webhook identifier was reused with a different payload.', 409);
      if (status.status === 'complete') return;
      await syncRow(row);
      await db.models.cashfree.completeEvent(now().toISOString(), organizationId, key);
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
      const { status, message } = paymentErrorResponse(error, 'Cashfree operation failed.');
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
        await processWebhook(
          req.body,
          req.get('x-webhook-signature'),
          req.get('x-webhook-timestamp'),
          req.get('x-idempotency-header'),
        ),
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
