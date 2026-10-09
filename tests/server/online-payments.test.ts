import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  createOnlinePayments,
  verifyRazorpaySignature,
} from '../../server/integrations/payments/online-payments.ts';
import type { BusinessDocument, PaymentRecord } from '../../shared/types.ts';

const environment = {
  RAZORPAY_KEY_ID: 'rzp_test_synthetic',
  RAZORPAY_KEY_SECRET: 'synthetic-private-key',
  RAZORPAY_WEBHOOK_SECRET: 'synthetic-webhook-secret',
};
const timestamp = '2026-10-08T12:00:00.000Z';

test('ambiguous Razorpay conflict, timeout and rate-limit responses keep the payable reservation blocked', async (t) => {
  for (const failure of ['conflict', 'request-timeout', 'rate-limit'] as const) {
    const f = fixture(t);
    f.failCreation(failure);
    await assert.rejects(f.createPaymentLink('invoice-1'), /rejected/);
    const details = f.getDocumentPayments('invoice-1');
    assert.equal(details.links[0].state, 'creation_unknown');
    assert.equal(details.hasBlockingPaymentLink, true);
    assert.throws(() => f.assertManualChangesAllowed('invoice-1'), /Cancel or reconcile/);
  }
});

test('oversized Razorpay create response remains recoverable without a duplicate link or exposed provider data', async (t) => {
  const f = fixture(t);
  f.failCreation('oversized');
  await assert.rejects(f.createPaymentLink('invoice-1'), /invalid response/);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'creation_unknown');
  f.failCreation(null);
  const synced = await f.syncDocument('invoice-1');
  assert.equal(synced.links[0].state, 'created');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('Razorpay recovery rejects nonstandard payment-link ports', async (t) => {
  const f = fixture(t);
  f.failCreation('timeout');
  await assert.rejects(f.createPaymentLink('invoice-1'));
  f.links.get('plink_test1')!.short_url = 'https://rzp.io:444/i/pay';
  await assert.rejects(f.syncDocument('invoice-1'), /unsupported payment URL/);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].url, '');
});

function fixture(t: TestContext, options: { env?: NodeJS.ProcessEnv; notifyFails?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE documents (id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE test_receipts (id TEXT PRIMARY KEY,request_id TEXT UNIQUE,data TEXT NOT NULL);
    CREATE TABLE test_notifications (event_key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  t.after(() => db.close());
  const original = {
    id: 'invoice-1',
    number: 'TEST/26/001',
    organizationId: 'org-1',
    customerId: 'customer-1',
    kind: 'invoice',
    status: 'sent',
    amountPaid: 0,
    balanceDue: 100,
    totals: { subtotal: 100, discount: 0, taxable: 100, cgst: 0, sgst: 0, igst: 0, total: 100 },
    customerSnapshot: { name: 'Test Customer', email: 'customer@example.test' },
  } as BusinessDocument;
  function save(document: BusinessDocument) {
    db.prepare('INSERT OR REPLACE INTO documents (id,data) VALUES (?,?)').run(
      document.id,
      JSON.stringify(document),
    );
  }
  save(original);
  function getDocument(id = original.id) {
    const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as BusinessDocument);
  }
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const links = new Map<string, Record<string, unknown>>();
  const payments = new Map<string, Record<string, unknown>>();
  let failCreation:
    'timeout' | 'reject' | 'conflict' | 'rate-limit' | 'request-timeout' | 'oversized' | null = null;
  let notifyFails = options.notifyFails ?? false;
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.razorpay.com');
    assert.equal(init?.redirect, 'error');
    const authorization = (init!.headers as Record<string, string>).Authorization;
    assert.equal(
      authorization,
      `Basic ${Buffer.from(`${environment.RAZORPAY_KEY_ID}:${environment.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
    if (url.pathname === '/v1/payment_links' && init?.method === 'POST') {
      if (failCreation === 'reject') return Response.json({ error: 'Rejected' }, { status: 401 });
      if (failCreation === 'conflict' || failCreation === 'rate-limit' || failCreation === 'request-timeout')
        return Response.json(
          {},
          { status: failCreation === 'conflict' ? 409 : failCreation === 'rate-limit' ? 429 : 408 },
        );
      const id = `plink_test${links.size + 1}`;
      const link = {
        id,
        ...body,
        short_url: `https://rzp.io/i/test${links.size + 1}`,
        amount_paid: 0,
        status: 'created',
        payments: [],
      };
      links.set(id, link);
      if (failCreation === 'oversized')
        return Response.json({ ...link, unexpected: 'x'.repeat(1024 * 1024) });
      if (failCreation === 'timeout') {
        failCreation = null;
        throw new Error('Connection interrupted after provider creation');
      }
      return Response.json(link);
    }
    if (url.pathname === '/v1/payment_links' && init?.method === 'GET')
      return Response.json({
        payment_links: [...links.values()].filter((link) =>
          url.searchParams.has('payment_id')
            ? (link.payments as { payment_id: string }[]).some(
                (payment) => payment.payment_id === url.searchParams.get('payment_id'),
              )
            : link.reference_id === url.searchParams.get('reference_id'),
        ),
      });
    const match = /^\/v1\/payment_links\/(plink_\w+)(\/cancel)?$/.exec(url.pathname);
    if (match) {
      const link = links.get(match[1]);
      if (!link) return Response.json({}, { status: 404 });
      if (match[2]) link.status = 'cancelled';
      return Response.json(link);
    }
    const payment = payments.get(url.pathname.split('/').at(-1)!);
    return payment ? Response.json(payment) : Response.json({}, { status: 404 });
  };
  const module = createOnlinePayments({
    db,
    getDocument,
    env: options.env ?? environment,
    fetch: provider,
    now: () => new Date(timestamp),
    recordVerifiedPayment(input) {
      const existing = db
        .prepare('SELECT data FROM test_receipts WHERE request_id = ?')
        .get(input.requestId) as { data: string } | undefined;
      if (existing) return JSON.parse(existing.data) as PaymentRecord;
      const document = getDocument(input.documentId)!;
      assert.ok(input.amount <= document.balanceDue!);
      const payment: PaymentRecord = {
        ...input,
        id: `receipt-${input.reference}`,
        organizationId: document.organizationId,
        method: 'other',
        createdAt: timestamp,
        voidedAt: null,
        voidReason: '',
      };
      db.prepare('INSERT INTO test_receipts VALUES (?,?,?)').run(
        payment.id,
        input.requestId,
        JSON.stringify(payment),
      );
      document.amountPaid = Math.round((document.amountPaid! + input.amount) * 100) / 100;
      document.balanceDue = Math.round((document.totals.total - document.amountPaid) * 100) / 100;
      document.status = document.balanceDue === 0 ? 'paid' : 'partially_paid';
      document.finalizedAt = document.balanceDue === 0 ? timestamp : null;
      save(document);
      return payment;
    },
    notifyPayment(notification) {
      if (notifyFails) throw new Error('Simulated outbox write failure');
      db.prepare('INSERT OR IGNORE INTO test_notifications VALUES (?,?)').run(
        notification.key,
        JSON.stringify(notification),
      );
    },
  });
  function addPayment(id: string, amount: number, status = 'captured', linkId = 'plink_test1') {
    const link = links.get(linkId)!;
    payments.set(id, {
      id,
      amount,
      status,
      captured: status === 'captured',
      currency: 'INR',
      created_at: 1_791_460_800,
      notes: { reference_id: link.reference_id },
    });
    (link.payments as unknown[]).push({ payment_id: id, amount, status });
    if (status === 'captured') link.amount_paid = Number(link.amount_paid) + amount;
    link.status =
      link.amount_paid === link.amount ? 'paid' : Number(link.amount_paid) > 0 ? 'partially_paid' : 'created';
  }
  async function webhook(event: string, id: string, paymentId?: string, linkId = 'plink_test1') {
    const body = Buffer.from(
      JSON.stringify({
        event,
        payload: {
          payment_link: { entity: links.get(linkId) },
          ...(paymentId ? { payment: { entity: payments.get(paymentId) } } : {}),
        },
      }),
    );
    return module.processWebhook(
      body,
      createHmac('sha256', environment.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex'),
      id,
    );
  }
  function count(table: string) {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  }
  return {
    ...module,
    db,
    calls,
    links,
    payments,
    addPayment,
    getDocument,
    save,
    webhook,
    count,
    original,
    failCreation: (value: typeof failCreation) => {
      failCreation = value;
    },
    notifyFailure: (value: boolean) => {
      notifyFails = value;
    },
  };
}

test('Razorpay raw-body HMAC rejects tampering, malformed signatures and missing secret', () => {
  const body = Buffer.from('{"event":"payment_link.paid"}');
  const signature = createHmac('sha256', environment.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  assert.equal(verifyRazorpaySignature(body, signature, environment.RAZORPAY_WEBHOOK_SECRET), true);
  for (const value of ['', 'ab', 'g'.repeat(64), `${signature}x`, undefined])
    assert.equal(verifyRazorpaySignature(body, value, environment.RAZORPAY_WEBHOOK_SECRET), false);
  assert.equal(
    verifyRazorpaySignature(Buffer.from(`${body} `), signature, environment.RAZORPAY_WEBHOOK_SECRET),
    false,
  );
  assert.equal(verifyRazorpaySignature(body, signature, ''), false);
});

test('missing configuration remains inert and reveals no secrets', async (t) => {
  const f = fixture(t, { env: {} });
  assert.deepEqual(f.getStatus(), {
    provider: 'razorpay',
    configured: false,
    keyConfigured: false,
    webhookConfigured: false,
    mode: 'unconfigured',
  });
  await assert.rejects(f.createPaymentLink('invoice-1'), /Configure Razorpay/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.count('online_payment_links'), 0);
});

test('link creation reserves one invoice amount in paise, including concurrent repeated requests', async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.createPaymentLink('invoice-1'), f.createPaymentLink('invoice-1')]);
  assert.equal(results[0].links[0].providerId, results[1].links[0].providerId);
  const creates = f.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body!.amount, 10000);
  assert.equal(creates[0].body!.accept_partial, true);
  assert.deepEqual(creates[0].body!.notify, { sms: false, email: false });
  assert.equal(results[0].hasBlockingPaymentLink, true);
  assert.throws(() => f.assertManualChangesAllowed('invoice-1'), /Cancel or reconcile/);
  assert.ok(!JSON.stringify(results).includes(environment.RAZORPAY_KEY_SECRET));
});

test('draft, cancelled, final and non-invoice documents cannot create payable links', async (t) => {
  const f = fixture(t);
  for (const patch of [
    { status: 'draft' },
    { status: 'cancelled' },
    { kind: 'quotation' },
    { status: 'paid', balanceDue: 0, amountPaid: 100 },
    { finalizedAt: timestamp },
  ]) {
    f.save({ ...f.original, ...patch } as BusinessDocument);
    await assert.rejects(f.createPaymentLink('invoice-1'), /issued invoices/);
  }
  assert.equal(f.calls.length, 0);
});

test('verified partial captures and final capture update the ledger exactly once and queue one email each', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_first', 2501);
  await f.webhook('payment_link.partially_paid', 'event_first', 'pay_first');
  assert.equal(f.getDocument()!.amountPaid, 25.01);
  assert.equal(f.getDocument()!.status, 'partially_paid');
  assert.equal(f.getDocumentPayments('invoice-1').links[0].amountReceived, 25.01);
  assert.equal(f.count('test_notifications'), 1);
  assert.deepEqual(await f.webhook('payment_link.partially_paid', 'event_first', 'pay_first'), {
    received: true,
    duplicate: true,
  });
  await f.webhook('payment.captured', 'event_first_again', 'pay_first');
  assert.equal(f.count('test_receipts'), 1);
  assert.equal(f.count('test_notifications'), 1);
  f.addPayment('pay_final', 7499);
  await f.webhook('payment_link.paid', 'event_final', 'pay_final');
  assert.equal(f.getDocument()!.balanceDue, 0);
  assert.equal(f.getDocument()!.status, 'paid');
  assert.equal(f.getDocument()!.finalizedAt, timestamp);
  assert.equal(f.count('test_receipts'), 2);
  assert.equal(f.count('test_notifications'), 2);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'paid');
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, false);
});

test('authorized payment and forged browser status cannot finalize; failed attempts notify once', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_authorized', 10000, 'authorized');
  await f.webhook('payment.captured', 'event_authorized', 'pay_authorized');
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.getDocument()!.status, 'sent');
  const forged = Buffer.from(
    JSON.stringify({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_test1' } } },
    }),
  );
  await assert.rejects(f.processWebhook(forged, '0'.repeat(64)), /signature/);
  f.addPayment('pay_failed', 10000, 'failed');
  await f.webhook('payment.failed', 'event_failed', 'pay_failed');
  await f.webhook('payment.failed', 'event_failed_retry', 'pay_failed');
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.count('test_notifications'), 1);
  assert.equal(f.getDocument()!.amountPaid, 0);
});

test('captured payment with wrong currency or mismatched link membership cannot credit an invoice', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_wrong', 10000);
  f.payments.get('pay_wrong')!.currency = 'USD';
  await assert.rejects(f.webhook('payment_link.paid', 'event_wrong', 'pay_wrong'), /matched/);
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'needs_review');
  f.payments.get('pay_wrong')!.currency = 'INR';
  f.payments.get('pay_wrong')!.amount = 9000;
  await assert.rejects(f.syncDocument('invoice-1'), /matched/);
  assert.equal(f.count('test_receipts'), 0);
});

test('offline balance changes and overpayments are held for review without silent credit', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.save({ ...f.getDocument()!, amountPaid: 20, balanceDue: 80, status: 'partially_paid' });
  f.addPayment('pay_conflict', 10000);
  await assert.rejects(f.webhook('payment_link.paid', 'event_conflict', 'pay_conflict'), /balance changed/);
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.getDocument()!.amountPaid, 20);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'needs_review');
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
});

test('ledger, provider deduplication and queued mail roll back together and a webhook retry recovers', async (t) => {
  const f = fixture(t, { notifyFails: true });
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_atomic', 10000);
  await assert.rejects(f.webhook('payment_link.paid', 'event_atomic', 'pay_atomic'), /outbox write failure/);
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.count('online_verified_payments'), 0);
  assert.equal(f.getDocument()!.amountPaid, 0);
  f.notifyFailure(false);
  await f.webhook('payment_link.paid', 'event_atomic', 'pay_atomic');
  assert.equal(f.count('test_receipts'), 1);
  assert.equal(f.count('test_notifications'), 1);
  assert.equal(f.getDocument()!.status, 'paid');
});

test('uncertain network outcome recovers the original reference without creating a duplicate link', async (t) => {
  const f = fixture(t);
  f.failCreation('timeout');
  await assert.rejects(f.createPaymentLink('invoice-1'), /could not be reached/);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'creation_unknown');
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
  const recovered = await f.syncDocument('invoice-1');
  assert.equal(recovered.links[0].providerId, 'plink_test1');
  assert.equal(recovered.links[0].state, 'created');
  await f.createPaymentLink('invoice-1');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('known provider rejection releases reservation so corrected credentials can retry', async (t) => {
  const f = fixture(t);
  f.failCreation('reject');
  await assert.rejects(f.createPaymentLink('invoice-1'), /rejected/);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, false);
  f.failCreation(null);
  assert.equal((await f.createPaymentLink('invoice-1')).links[0].state, 'created');
});

test('cancellation reconciles a partial payment and allows a new link for exactly the remaining amount', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_partial', 4000);
  const cancelled = await f.cancelPaymentLink('invoice-1');
  assert.equal(f.getDocument()!.amountPaid, 40);
  assert.equal(cancelled.links[0].state, 'cancelled');
  assert.equal(cancelled.hasBlockingPaymentLink, false);
  f.assertManualChangesAllowed('invoice-1');
  const next = await f.createPaymentLink('invoice-1');
  assert.equal(next.links[0].providerId, 'plink_test2');
  assert.equal(next.links[0].amount, 60);
  f.addPayment('pay_remaining', 6000, 'captured', 'plink_test2');
  await f.webhook('payment_link.paid', 'event_remaining', 'pay_remaining', 'plink_test2');
  assert.equal(f.getDocument()!.status, 'paid');
});

test('webhook event IDs cannot be reused with modified content', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  await f.webhook('payment_link.partially_paid', 'event_reused');
  await assert.rejects(f.webhook('payment_link.paid', 'event_reused'), /reused/);
  assert.equal(f.count('test_receipts'), 0);
});

test('generic failed webhook without link or notes resolves an invoice using the documented payment_id filter', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_generic', 10000, 'failed');
  const body = Buffer.from(
    JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_generic', status: 'failed' } } },
    }),
  );
  await f.processWebhook(
    body,
    createHmac('sha256', environment.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex'),
    'event_generic',
  );
  assert.ok(f.calls.some((call) => call.path === '/v1/payment_links?payment_id=pay_generic'));
  assert.equal(f.count('test_notifications'), 1);
  assert.equal(f.count('test_receipts'), 0);
});

test('documented integer-string provider amounts reconcile exactly, while missing capture confirmation cannot credit', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_string', 10000);
  const link = f.links.get('plink_test1')!;
  link.amount = '10000';
  link.amount_paid = '10000';
  (link.payments as { amount: unknown }[])[0].amount = '10000';
  f.payments.get('pay_string')!.amount = '10000';
  delete f.payments.get('pay_string')!.captured;
  await f.syncDocument('invoice-1');
  assert.equal(f.count('test_receipts'), 0);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'needs_review');
  f.payments.get('pay_string')!.captured = true;
  await f.syncDocument('invoice-1');
  assert.equal(f.getDocument()!.amountPaid, 100);
  assert.equal(f.getDocument()!.status, 'paid');
});

test('delayed old cancellation webhook cannot block or corrupt a later fully paid invoice', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_old', 4000);
  await f.cancelPaymentLink('invoice-1');
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_new', 6000, 'captured', 'plink_test2');
  await f.webhook('payment_link.paid', 'event_new_paid', 'pay_new', 'plink_test2');
  await f.webhook('payment_link.cancelled', 'event_old_delayed');
  assert.equal(f.getDocumentPayments('invoice-1').links[1].state, 'cancelled');
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, false);
  assert.equal(f.getDocument()!.amountPaid, 100);
});

test('a delayed failed attempt does not email a payment request after the invoice is fully paid', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('pay_success', 10000);
  await f.webhook('payment_link.paid', 'event_success', 'pay_success');
  f.addPayment('pay_latefailed', 10000, 'failed');
  await f.webhook('payment.failed', 'event_latefailed', 'pay_latefailed');
  assert.equal(f.count('test_notifications'), 1);
  assert.equal(f.count('online_failed_attempts'), 1);
  assert.equal(f.getDocument()!.status, 'paid');
});
