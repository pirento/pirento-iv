import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  cashfreeAmountPaise,
  createCashfreePayments,
  verifyCashfreeSignature,
} from '../../server/integrations/payments/cashfree-payments.ts';
import type { BusinessDocument, PaymentRecord } from '../../shared/types.ts';

const environment = {
  CASHFREE_CLIENT_ID: 'synthetic-client',
  CASHFREE_CLIENT_SECRET: 'synthetic-secret',
  CASHFREE_ENVIRONMENT: 'sandbox',
};
const timestamp = '2026-10-08T12:00:00.000Z';
const webhookTimestamp = '1791460800000';

test('oversized Cashfree creation response keeps one recoverable merchant reference', async (t) => {
  const f = fixture(t);
  f.failCreation('oversized');
  await assert.rejects(f.createPaymentLink('invoice-1'), /invalid response/);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'creation_unknown');
  f.failCreation(null);
  const synced = await f.syncDocument('invoice-1');
  assert.equal(synced.links[0].state, 'created');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});
function fixture(t: TestContext, config: { env?: NodeJS.ProcessEnv } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE documents (id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE receipts (id TEXT PRIMARY KEY,request_id TEXT UNIQUE,data TEXT NOT NULL);
    CREATE TABLE notifications (event_key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  t.after(() => db.close());
  const original = {
    id: 'invoice-1',
    organizationId: 'shri-sarraf',
    kind: 'invoice',
    status: 'sent',
    number: 'SS/26/001',
    amountPaid: 0,
    balanceDue: 100,
    totals: { subtotal: 100, discount: 0, taxable: 100, cgst: 0, sgst: 0, igst: 0, total: 100 },
    customerSnapshot: { name: 'Synthetic Customer', phone: '+91 98765 43210', email: 'buyer@example.test' },
  } as BusinessDocument;
  function save(document: BusinessDocument) {
    db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(document.id, JSON.stringify(document));
  }
  save(original);
  function getDocument(id = original.id) {
    const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as BusinessDocument) : undefined;
  }
  const calls: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
    headers: Record<string, string>;
  }[] = [];
  const links = new Map<string, Record<string, unknown>>();
  const orders = new Map<string, Record<string, unknown>>();
  const payments = new Map<string, Record<string, unknown>[]>();
  let failCreation: 'timeout' | 'reject' | 'conflict' | 'oversized' | null = null;
  let notifyFails = false;
  let cancelRace: (() => void) | undefined;
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(
      url.origin,
      config.env?.CASHFREE_ENVIRONMENT === 'production'
        ? 'https://api.cashfree.com'
        : 'https://sandbox.cashfree.com',
    );
    assert.equal(init?.redirect, 'error');
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers['x-client-id'], environment.CASHFREE_CLIENT_ID);
    assert.equal(headers['x-client-secret'], environment.CASHFREE_CLIENT_SECRET);
    assert.equal(headers['x-api-version'], '2026-01-01');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body, headers });
    if (url.pathname === '/pg/links' && init?.method === 'POST') {
      if (failCreation === 'reject') return Response.json({}, { status: 401 });
      if (failCreation === 'conflict') return Response.json({}, { status: 409 });
      const link = {
        ...body,
        cf_link_id: `provider-${links.size}`,
        link_amount_paid: 0,
        link_status: 'ACTIVE',
        link_url: `https://payments.cashfree.com/links/${body.link_id}`,
      };
      links.set(body.link_id, link);
      if (failCreation === 'oversized')
        return Response.json({ ...link, unexpected: 'x'.repeat(1024 * 1024) });
      if (failCreation === 'timeout') {
        failCreation = null;
        throw new Error('Response lost after creation');
      }
      return Response.json(link);
    }
    const match = /^\/pg\/links\/([\w-]+)(\/orders|\/cancel)?$/.exec(url.pathname);
    if (match) {
      const link = links.get(match[1]);
      if (!link) return Response.json({}, { status: 404 });
      if (match[2] === '/orders')
        return Response.json([...orders.values()].filter((order) => order.link_id === match[1]));
      if (match[2] === '/cancel') {
        link.link_status = 'CANCELLED';
        const race = cancelRace;
        cancelRace = undefined;
        race?.();
      }
      return Response.json(link);
    }
    const orderId = /^\/pg\/orders\/([\w-]+)\/payments$/.exec(url.pathname)?.[1];
    return orderId && payments.has(orderId)
      ? Response.json(payments.get(orderId))
      : Response.json({}, { status: 404 });
  };
  const options = {
    db,
    organizationId: original.organizationId,
    getDocument,
    env: config.env ?? environment,
    fetch: provider,
    now: () => new Date(timestamp),
    recordVerifiedPayment(
      input: Parameters<Parameters<typeof createCashfreePayments>[0]['recordVerifiedPayment']>[0],
    ) {
      const existing = db.prepare('SELECT data FROM receipts WHERE request_id = ?').get(input.requestId) as
        { data: string } | undefined;
      if (existing) return JSON.parse(existing.data) as PaymentRecord;
      const document = getDocument(input.documentId)!;
      assert.ok(input.amount <= document.balanceDue!);
      const receipt: PaymentRecord = {
        ...input,
        id: `receipt-${input.reference}`,
        organizationId: document.organizationId,
        method: 'other',
        createdAt: timestamp,
        voidedAt: null,
        voidReason: '',
      };
      db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(
        receipt.id,
        input.requestId,
        JSON.stringify(receipt),
      );
      document.amountPaid = Math.round((document.amountPaid! + input.amount) * 100) / 100;
      document.balanceDue = Math.round((document.totals.total - document.amountPaid) * 100) / 100;
      document.status = document.balanceDue === 0 ? 'paid' : 'partially_paid';
      document.finalizedAt = document.balanceDue === 0 ? timestamp : null;
      save(document);
      return receipt;
    },
    notifyPayment(
      notification: Parameters<NonNullable<Parameters<typeof createCashfreePayments>[0]['notifyPayment']>>[0],
    ) {
      if (notifyFails) throw new Error('Simulated outbox failure');
      db.prepare('INSERT OR IGNORE INTO notifications VALUES (?,?)').run(
        notification.key,
        JSON.stringify(notification),
      );
    },
  };
  const module = createCashfreePayments(options);
  function linkId() {
    return [...links.keys()].at(-1)!;
  }
  function addPayment(id: string, amount: number, status = 'SUCCESS', reference = linkId()) {
    const orderId = `order_${id}`;
    const link = links.get(reference)!;
    orders.set(orderId, {
      order_id: orderId,
      link_id: reference,
      order_amount: amount,
      order_currency: 'INR',
      order_status: status === 'SUCCESS' ? 'PAID' : 'ACTIVE',
    });
    payments.set(orderId, [
      {
        cf_payment_id: id,
        order_id: orderId,
        payment_amount: amount,
        payment_currency: 'INR',
        payment_status: status,
        is_captured: status === 'SUCCESS',
        payment_completion_time: timestamp,
      },
    ]);
    if (status === 'SUCCESS')
      link.link_amount_paid = Math.round((Number(link.link_amount_paid) + amount) * 100) / 100;
    if (link.link_amount_paid === link.link_amount) link.link_status = 'PAID';
    return { order: orders.get(orderId)!, payment: payments.get(orderId)![0] };
  }
  function signed(body: Buffer) {
    return createHmac('sha256', environment.CASHFREE_CLIENT_SECRET)
      .update(webhookTimestamp)
      .update(body)
      .digest('base64');
  }
  async function webhook(type = 'PAYMENT_LINK_EVENT', id?: string, data: unknown = { link_id: linkId() }) {
    const body = Buffer.from(JSON.stringify({ type, data }));
    return module.processWebhook(body, signed(body), webhookTimestamp, id);
  }
  function count(table: string) {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  }
  return {
    ...module,
    options,
    db,
    original,
    getDocument,
    save,
    calls,
    links,
    orders,
    payments,
    addPayment,
    linkId,
    webhook,
    signed,
    count,
    failCreation: (failure: typeof failCreation) => {
      failCreation = failure;
    },
    notifyFailure: (failure: boolean) => {
      notifyFails = failure;
    },
    onCancel: (fn: () => void) => {
      cancelRace = fn;
    },
  };
}

test('Cashfree raw-body signature authenticates timestamp and rejects tampering and malformed values', () => {
  const body = Buffer.from('{"type":"PAYMENT_LINK_EVENT"}');
  const signature = createHmac('sha256', environment.CASHFREE_CLIENT_SECRET)
    .update(webhookTimestamp)
    .update(body)
    .digest('base64');
  assert.equal(
    verifyCashfreeSignature(body, signature, webhookTimestamp, environment.CASHFREE_CLIENT_SECRET),
    true,
  );
  for (const value of ['', 'abcd', `${signature}x`, undefined])
    assert.equal(
      verifyCashfreeSignature(body, value, webhookTimestamp, environment.CASHFREE_CLIENT_SECRET),
      false,
    );
  assert.equal(
    verifyCashfreeSignature(
      Buffer.from(`${body} `),
      signature,
      webhookTimestamp,
      environment.CASHFREE_CLIENT_SECRET,
    ),
    false,
  );
  assert.equal(
    verifyCashfreeSignature(body, signature, '1791460800001', environment.CASHFREE_CLIENT_SECRET),
    false,
  );
  assert.equal(verifyCashfreeSignature(body, signature, webhookTimestamp, ''), false);
});

test('Cashfree rupee amounts retain exact paise and reject unsafe or silently rounded values', () => {
  for (const [input, expected] of [
    [100, 10000],
    ['25.01', 2501],
    [0.29, 29],
    ['0.01', 1],
    ['10.1', 1010],
  ] as const)
    assert.equal(cashfreeAmountPaise(input), expected);
  for (const input of ['1e3', '10.001', ' 10', -1, Infinity, '9999999999999999', {}, null])
    assert.equal(Number.isNaN(cashfreeAmountPaise(input)), true);
});

test('unconfigured and invalid-environment Cashfree integrations stay inert without leaking secrets', async (t) => {
  const f = fixture(t, { env: {} });
  assert.deepEqual(f.getStatus(), {
    provider: 'cashfree',
    configured: false,
    keyConfigured: false,
    webhookConfigured: false,
    mode: 'unconfigured',
  });
  await assert.rejects(f.createPaymentLink('invoice-1'), /Configure.*Cashfree/);
  assert.equal(f.calls.length, 0);
  const invalid = createCashfreePayments({
    ...f.options,
    env: { ...environment, CASHFREE_ENVIRONMENT: 'prodction' },
  });
  assert.equal(invalid.getStatus().configured, false);
  assert.equal(JSON.stringify(invalid.getStatus()).includes(environment.CASHFREE_CLIENT_SECRET), false);
});

test('Cashfree creation sends remaining rupees, partial-payment permission, normalized phone and one idempotency key', async (t) => {
  const f = fixture(t);
  f.save({ ...f.original, amountPaid: 25.01, balanceDue: 74.99, status: 'partially_paid' });
  const [a, b] = await Promise.all([f.createPaymentLink('invoice-1'), f.createPaymentLink('invoice-1')]);
  assert.equal(a.links[0].id, b.links[0].id);
  const creates = f.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body!.link_amount, 74.99);
  assert.equal(creates[0].body!.link_partial_payments, true);
  assert.deepEqual(creates[0].body!.link_notify, { send_sms: false, send_email: false });
  assert.equal((creates[0].body!.customer_details as Record<string, unknown>).customer_phone, '9876543210');
  assert.equal(creates[0].headers['x-idempotency-key'], a.links[0].id);
  assert.equal(a.hasBlockingPaymentLink, true);
  assert.throws(() => f.assertManualChangesAllowed('invoice-1'), /Cancel or reconcile/);
  assert.equal(JSON.stringify(a).includes(environment.CASHFREE_CLIENT_SECRET), false);
});

test('Cashfree cannot create links for a different business, an unissued invoice, or a missing customer mobile', async (t) => {
  const f = fixture(t);
  for (const patch of [
    { organizationId: 'other-business' },
    { status: 'draft' },
    { kind: 'quotation' },
    { finalizedAt: timestamp },
    { customerSnapshot: { ...f.original.customerSnapshot, phone: '' } },
  ]) {
    f.save({ ...f.original, ...patch } as BusinessDocument);
    await assert.rejects(f.createPaymentLink('invoice-1'));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.count('cashfree_payment_links'), 0);
});

test('verified Cashfree partial and final payments post exactly once, finalize and queue matching emails', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('1001', 25.01);
  await f.webhook('PAYMENT_LINK_EVENT', 'event1');
  assert.equal(f.getDocument()!.amountPaid, 25.01);
  assert.equal(f.getDocument()!.status, 'partially_paid');
  assert.equal(f.getDocumentPayments('invoice-1').links[0].amountReceived, 25.01);
  assert.deepEqual(await f.webhook('PAYMENT_LINK_EVENT', 'event1'), { received: true, duplicate: true });
  await f.webhook('PAYMENT_LINK_EVENT', 'event2');
  assert.equal(f.count('receipts'), 1);
  assert.equal(f.count('notifications'), 1);
  f.addPayment('1002', 74.99);
  await f.webhook('PAYMENT_LINK_EVENT', 'event3');
  assert.equal(f.getDocument()!.balanceDue, 0);
  assert.equal(f.getDocument()!.status, 'paid');
  assert.equal(f.getDocument()!.finalizedAt, timestamp);
  assert.equal(f.count('receipts'), 2);
  assert.equal(f.count('notifications'), 2);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, false);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'paid');
  const receipt = f.db.prepare('SELECT request_id FROM receipts ORDER BY rowid LIMIT 1').get() as {
    request_id: string;
  };
  assert.equal(receipt.request_id, 'cashfree:1001');
});

test('generic Cashfree payment webhooks discover authenticated link/order membership before applying money', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  const { order } = f.addPayment('1003', 100);
  await f.webhook('PAYMENT_SUCCESS_WEBHOOK', 'generic1', {
    order: { order_id: order.order_id },
    payment: { cf_payment_id: 'forged-ignored' },
  });
  assert.equal(f.getDocument()!.status, 'paid');
  assert.equal(f.count('receipts'), 1);
  assert.ok(f.calls.some((call) => call.path.endsWith(`/orders/${order.order_id}/payments`)));
});

test('failed Cashfree attempts notify once while pending or uncaptured attempts never finalize', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('2001', 100, 'PENDING');
  await f.webhook('PAYMENT_SUCCESS_WEBHOOK', 'pending');
  assert.equal(f.count('receipts'), 0);
  f.addPayment('2002', 100, 'FAILED');
  await f.webhook('PAYMENT_FAILED_WEBHOOK', 'failed1');
  await f.webhook('PAYMENT_FAILED_WEBHOOK', 'failed2');
  assert.equal(f.count('notifications'), 1);
  assert.equal(f.count('receipts'), 0);
  const attempt = f.addPayment('2003', 100);
  attempt.payment.is_captured = false;
  await f.webhook('PAYMENT_LINK_EVENT', 'uncaptured');
  assert.equal(f.count('receipts'), 0);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'needs_review');
});

test('malformed Cashfree capture confirmation cannot be interpreted as captured money', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  const attempt = f.addPayment('2999', 100);
  for (const value of ['false', 'true', 0, 1, null]) {
    attempt.payment.is_captured = value;
    await f.syncDocument('invoice-1');
    assert.equal(f.count('receipts'), 0);
    assert.equal(f.getDocument()!.status, 'sent');
    assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'needs_review');
  }
  attempt.payment.is_captured = true;
  await f.syncDocument('invoice-1');
  assert.equal(f.count('receipts'), 1);
});

test('Cashfree link, order and payment identities, currency and amounts must all match', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  const attempt = f.addPayment('3001', 100);
  for (const patch of [
    { payment_currency: 'USD' },
    { order_id: 'other-order' },
    { payment_amount: '99.999' },
    { payment_amount: 99 },
    { cf_payment_id: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const saved = { ...attempt.payment };
    Object.assign(attempt.payment, patch);
    await assert.rejects(f.syncDocument('invoice-1'), /matched/);
    assert.equal(f.count('receipts'), 0);
    for (const key of Object.keys(attempt.payment)) delete attempt.payment[key];
    Object.assign(attempt.payment, saved);
  }
  attempt.order.order_currency = 'USD';
  await assert.rejects(f.syncDocument('invoice-1'), /matched/);
  assert.equal(f.count('receipts'), 0);
});

test('Cashfree review blocks stale invoice balances and prevents crediting overpayments', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.save({ ...f.original, amountPaid: 20, balanceDue: 80, status: 'partially_paid' });
  f.addPayment('4001', 100);
  await assert.rejects(f.webhook('PAYMENT_LINK_EVENT', 'stale'), /balance changed/);
  assert.equal(f.getDocument()!.amountPaid, 20);
  assert.equal(f.count('receipts'), 0);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
});

test('Cashfree receipt, deduplication and email queue roll back together and retry safely', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('5001', 100);
  f.notifyFailure(true);
  await assert.rejects(f.webhook('PAYMENT_LINK_EVENT', 'atomic'), /outbox failure/);
  assert.equal(f.count('receipts'), 0);
  assert.equal(f.count('cashfree_verified_payments'), 0);
  assert.equal(f.getDocument()!.amountPaid, 0);
  f.notifyFailure(false);
  await f.webhook('PAYMENT_LINK_EVENT', 'atomic');
  assert.equal(f.count('receipts'), 1);
  assert.equal(f.count('notifications'), 1);
});

test('Cashfree lost creation response recovers by saved merchant link ID without duplicate creation', async (t) => {
  const f = fixture(t);
  f.failCreation('timeout');
  await assert.rejects(f.createPaymentLink('invoice-1'), /could not be reached/);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'creation_unknown');
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
  const details = await f.createPaymentLink('invoice-1');
  assert.equal(details.links[0].state, 'created');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('Cashfree rejection unblocks creation but conflict retains a blocking uncertain request', async (t) => {
  const f = fixture(t);
  f.failCreation('reject');
  await assert.rejects(f.createPaymentLink('invoice-1'), /rejected/);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, false);
  f.failCreation('conflict');
  await assert.rejects(f.createPaymentLink('invoice-1'), /rejected/);
  assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
  assert.equal(f.getDocumentPayments('invoice-1').links[0].state, 'creation_unknown');
});

test('Cashfree cancellation reconciles captures during cancellation before allowing manual payments', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.onCancel(() => f.addPayment('6001', 40));
  const details = await f.cancelPaymentLink('invoice-1');
  assert.equal(f.getDocument()!.amountPaid, 40);
  assert.equal(details.links[0].state, 'cancelled');
  assert.equal(details.hasBlockingPaymentLink, false);
  f.assertManualChangesAllowed('invoice-1');
  const next = await f.createPaymentLink('invoice-1');
  assert.equal(next.links[0].amount, 60);
  await f.webhook('PAYMENT_LINK_EVENT', 'old-cancelled', { link_id: details.links[0].referenceId });
  assert.equal(f.getDocumentPayments('invoice-1').links[1].state, 'cancelled');
});

test('Cashfree webhooks never cross businesses and reused event IDs with different bodies are rejected', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  f.addPayment('7001', 100);
  const other = createCashfreePayments({
    ...f.options,
    organizationId: 'other-business',
    env: { ...environment, CASHFREE_CLIENT_SECRET: 'other-secret' },
  });
  const body = Buffer.from(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: f.linkId() } }));
  await assert.rejects(other.processWebhook(body, f.signed(body), webhookTimestamp), /signature/);
  const otherSignature = createHmac('sha256', 'other-secret')
    .update(webhookTimestamp)
    .update(body)
    .digest('base64');
  assert.deepEqual(await other.processWebhook(body, otherSignature, webhookTimestamp), {
    received: true,
    ignored: true,
  });
  assert.equal(f.count('receipts'), 0);
  await f.webhook('PAYMENT_LINK_EVENT', 'reused');
  await assert.rejects(f.webhook('PAYMENT_SUCCESS_WEBHOOK', 'reused'), /reused/);
});

test('Cashfree production requires explicit environment and uses the production API host', async (t) => {
  const f = fixture(t, { env: { ...environment, CASHFREE_ENVIRONMENT: 'production' } });
  assert.equal(f.getStatus().mode, 'live');
  await f.createPaymentLink('invoice-1');
  assert.equal(f.calls.length, 1);
});

test('Cashfree link totals and authenticated references must match before payments can be fetched', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  const link = f.links.get(f.linkId())!;
  f.addPayment('8001', 100);
  for (const patch of [
    { link_id: 'unrelated-link' },
    { link_currency: 'USD' },
    { link_amount: 99 },
    { link_amount_paid: '100.001' },
  ]) {
    const saved = { ...link };
    Object.assign(link, patch);
    await assert.rejects(f.syncDocument('invoice-1'), /link details/);
    assert.equal(f.count('receipts'), 0);
    for (const key of Object.keys(link)) delete link[key];
    Object.assign(link, saved);
  }
});

test('Cashfree webhook claims are not payment evidence and invalid signatures cause no provider requests', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-1');
  const calls = f.calls.length;
  const body = Buffer.from(
    JSON.stringify({
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        link_id: f.linkId(),
        payment: { cf_payment_id: 'fake', payment_status: 'SUCCESS', payment_amount: 100 },
      },
    }),
  );
  await assert.rejects(f.processWebhook(body, 'A'.repeat(43) + '=', webhookTimestamp), /signature/);
  assert.equal(f.calls.length, calls);
  await f.processWebhook(body, f.signed(body), webhookTimestamp);
  assert.equal(f.count('receipts'), 0);
  assert.equal(f.getDocument()!.status, 'sent');
});

test('Cashfree recovery rejects a provider URL that could send customers to an unrelated host', async (t) => {
  const f = fixture(t);
  f.failCreation('timeout');
  await assert.rejects(f.createPaymentLink('invoice-1'));
  const link = f.links.get(f.linkId())!;
  for (const url of [
    'https://payments.cashfree.com.attacker.test/links/1',
    'http://payments.cashfree.com/links/1',
    'https://user:password@payments.cashfree.com/links/1',
    'https://payments.cashfree.com:444/links/1',
  ]) {
    link.link_url = url;
    await assert.rejects(f.syncDocument('invoice-1'), /payment URL/);
    assert.equal(f.getDocumentPayments('invoice-1').links[0].url, '');
    assert.equal(f.getDocumentPayments('invoice-1').hasBlockingPaymentLink, true);
  }
});
