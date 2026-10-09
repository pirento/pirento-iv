import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPaymentGateways } from '../../server/integrations/payments/payment-gateways.ts';
import type { BusinessDocument, Organization, PaymentRecord } from '../../shared/types.ts';

const timestamp = '2026-10-08T12:00:00.000Z';
const environment: NodeJS.ProcessEnv = {
  RAZORPAY_KEY_ID: 'rzp_test_global',
  RAZORPAY_KEY_SECRET: 'global-key',
  RAZORPAY_WEBHOOK_SECRET: 'global-webhook',
  CASHFREE_CLIENT_ID: 'global-cashfree',
  CASHFREE_CLIENT_SECRET: 'global-cashfree-secret',
  SHRI_SARRAF_CASHFREE_CLIENT_ID: 'sarraf-client',
  SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'sarraf-secret',
  AT_FACILITY_RAZORPAY_KEY_ID: 'rzp_test_facility',
  AT_FACILITY_RAZORPAY_KEY_SECRET: 'facility-key',
  AT_FACILITY_RAZORPAY_WEBHOOK_SECRET: 'facility-webhook',
};
function fixture(t: TestContext, env = { ...environment }) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE documents (id TEXT PRIMARY KEY,data TEXT NOT NULL);');
  t.after(() => db.close());
  const organizations = new Map<string, Organization>([
    ['pipeline2-legal', { id: 'pipeline2-legal', paymentGateway: 'razorpay' } as Organization],
    ['at-facilities', { id: 'at-facilities', paymentGateway: 'razorpay' } as Organization],
    [
      'shri-sarraf',
      { id: 'shri-sarraf', paymentGateway: 'cashfree', businessType: 'independent' } as Organization,
    ],
  ]);
  function save(document: BusinessDocument) {
    db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(document.id, JSON.stringify(document));
  }
  for (const organization of organizations.values())
    save({
      id: `invoice-${organization.id}`,
      organizationId: organization.id,
      kind: 'invoice',
      status: 'sent',
      number: `INV/${organization.id}`,
      amountPaid: 0,
      balanceDue: 100,
      totals: { subtotal: 100, discount: 0, taxable: 100, cgst: 0, sgst: 0, igst: 0, total: 100 },
      organizationSnapshot: { ...organization },
      customerSnapshot: { name: 'Synthetic Customer', phone: '9876543210', email: 'buyer@example.test' },
    } as BusinessDocument);
  function getDocument(id: string) {
    const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as BusinessDocument) : undefined;
  }
  const calls: {
    host: string;
    path: string;
    method: string;
    authorization: string;
    body?: Record<string, unknown>;
  }[] = [];
  const links = new Map<string, Record<string, unknown>>();
  const payments = new Map<string, Record<string, unknown>>();
  const receipts: PaymentRecord[] = [];
  const provider: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const headers = init?.headers as Record<string, string>;
    const authorization = headers.Authorization ?? headers['x-client-id'];
    calls.push({
      host: url.hostname,
      path: url.pathname + url.search,
      method: init?.method ?? 'GET',
      authorization,
      body,
    });
    if (url.pathname === '/v1/payment_links' && init?.method === 'POST') {
      const id = `plink_${links.size + 1}`;
      const link = {
        id,
        ...body,
        amount_paid: 0,
        status: 'created',
        short_url: `https://rzp.io/i/${id}`,
        payments: [],
        authorization,
      };
      links.set(id, link);
      return Response.json(link);
    }
    if (url.pathname === '/v1/payment_links')
      return Response.json({
        payment_links: [...links.values()].filter((link) =>
          (link.payments as { payment_id: string }[]).some(
            (item) => item.payment_id === url.searchParams.get('payment_id'),
          ),
        ),
      });
    const match = /^\/v1\/payment_links\/(plink_\w+)(\/cancel)?$/.exec(url.pathname);
    if (match) {
      const link = links.get(match[1])!;
      assert.equal(
        authorization,
        link.authorization,
        'Requests must use the link owner’s server credentials',
      );
      if (match[2]) link.status = 'cancelled';
      return Response.json(link);
    }
    if (url.pathname.startsWith('/v1/payments/'))
      return Response.json(payments.get(url.pathname.split('/').at(-1)!));
    if (url.pathname === '/pg/links' && init?.method === 'POST') {
      const id = String(body!.link_id);
      const link = {
        ...body,
        link_status: 'ACTIVE',
        link_amount_paid: 0,
        link_url: `https://payments.cashfree.com/links/${id}`,
        authorization,
      };
      links.set(id, link);
      return Response.json(link);
    }
    const cf = /^\/pg\/links\/([\w-]+)(\/orders|\/cancel)?$/.exec(url.pathname);
    if (cf) {
      const link = links.get(cf[1])!;
      assert.equal(authorization, link.authorization);
      if (cf[2] === '/orders') return Response.json([]);
      if (cf[2]) link.link_status = 'CANCELLED';
      return Response.json(link);
    }
    throw new Error(`Unexpected test request ${url.pathname}`);
  };
  const online = createPaymentGateways({
    db,
    env,
    getDocument,
    getOrganization: (id) => organizations.get(id),
    fetch: provider,
    now: () => new Date(timestamp),
    recordVerifiedPayment(input) {
      const document = getDocument(input.documentId)!;
      const payment = {
        ...input,
        id: `receipt-${input.reference}`,
        organizationId: document.organizationId,
        method: 'other',
        createdAt: timestamp,
        voidedAt: null,
        voidReason: '',
      } as PaymentRecord;
      document.amountPaid = (document.amountPaid ?? 0) + input.amount;
      document.balanceDue = document.totals.total - document.amountPaid;
      document.status = document.balanceDue === 0 ? 'paid' : 'partially_paid';
      document.finalizedAt = document.balanceDue === 0 ? timestamp : null;
      save(document);
      receipts.push(payment);
      return payment;
    },
  });
  function payment(linkId: string, id: string) {
    const link = links.get(linkId)!;
    const record = { id, amount: 10000, currency: 'INR', status: 'captured', captured: true };
    payments.set(id, record);
    (link.payments as unknown[]).push({ payment_id: id, amount: 10000 });
    link.amount_paid = 10000;
    link.status = 'paid';
  }
  function razorpayEvent(linkId: string, event = 'payment_link.paid') {
    return Buffer.from(JSON.stringify({ event, payload: { payment_link: { entity: links.get(linkId) } } }));
  }
  function signature(body: Buffer, secret = environment.RAZORPAY_WEBHOOK_SECRET!) {
    return createHmac('sha256', secret).update(body).digest('hex');
  }
  return {
    ...online,
    db,
    env,
    organizations,
    getDocument,
    save,
    calls,
    links,
    payments,
    receipts,
    payment,
    razorpayEvent,
    signature,
  };
}

test('gateway status uses each business’s keys and independent businesses never inherit global credentials', async (t) => {
  const env = { ...environment };
  delete env.SHRI_SARRAF_CASHFREE_CLIENT_ID;
  delete env.SHRI_SARRAF_CASHFREE_CLIENT_SECRET;
  const f = fixture(t, env);
  assert.equal(f.getStatus('pipeline2-legal').configured, true);
  assert.equal(f.getStatus('at-facilities').configured, true);
  assert.deepEqual(f.getStatus('shri-sarraf'), {
    provider: 'cashfree',
    configured: false,
    keyConfigured: false,
    webhookConfigured: false,
    mode: 'unconfigured',
  });
  await assert.rejects(f.createPaymentLink('invoice-shri-sarraf'), /Configure.*Cashfree/);
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.getStatus('at-facilities')).includes('facility-key'), false);
});

test('payment link creation selects frozen invoice gateway while resolving credentials from current business', async (t) => {
  const f = fixture(t);
  const a = await f.createPaymentLink('invoice-pipeline2-legal');
  const b = await f.createPaymentLink('invoice-at-facilities');
  const c = await f.createPaymentLink('invoice-shri-sarraf');
  assert.equal(a.links[0].provider, 'razorpay');
  assert.equal(b.links[0].provider, 'razorpay');
  assert.equal(c.links[0].provider, 'cashfree');
  assert.equal(
    f.calls[0].authorization,
    `Basic ${Buffer.from('rzp_test_global:global-key').toString('base64')}`,
  );
  assert.equal(
    f.calls[1].authorization,
    `Basic ${Buffer.from('rzp_test_facility:facility-key').toString('base64')}`,
  );
  assert.equal(f.calls[2].authorization, 'sarraf-client');
  f.organizations.get('pipeline2-legal')!.paymentGateway = 'cashfree';
  assert.equal(f.getStatus('pipeline2-legal').provider, 'cashfree');
  assert.equal(f.getStatus('pipeline2-legal', 'invoice-pipeline2-legal').provider, 'razorpay');
  assert.throws(() => f.getStatus('shri-sarraf', 'invoice-pipeline2-legal'), /outside/);
});

test('manual-only invoices expose history and forbid new online links without any provider request', async (t) => {
  const f = fixture(t);
  const document = f.getDocument('invoice-pipeline2-legal')!;
  document.organizationSnapshot.paymentGateway = 'none';
  f.save(document);
  const result = f.getDocumentPayments(document.id);
  assert.equal(result.configuration.provider, 'none');
  assert.equal(result.hasBlockingPaymentLink, false);
  await assert.rejects(f.createPaymentLink(document.id), /disabled/);
  f.assertManualChangesAllowed(document.id);
  assert.equal(f.calls.length, 0);
});

test('legacy Razorpay webhook settles shared company links and scoped route deduplicates the same delivery', async (t) => {
  const f = fixture(t);
  const details = await f.createPaymentLink('invoice-pipeline2-legal');
  const linkId = details.links[0].providerId!;
  f.payment(linkId, 'pay_shared');
  const body = f.razorpayEvent(linkId);
  const signature = f.signature(body);
  await f.processWebhook(body, signature, 'same-event');
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].organizationId, 'pipeline2-legal');
  assert.deepEqual(await f.processRazorpayWebhook('pipeline2-legal', body, signature, 'same-event'), {
    received: true,
    duplicate: true,
  });
  assert.equal(f.receipts.length, 1);
});

test('legacy webhook cannot process a custom business, and scoped Razorpay signatures cannot cross businesses', async (t) => {
  const f = fixture(t);
  const shared = await f.createPaymentLink('invoice-pipeline2-legal');
  const custom = await f.createPaymentLink('invoice-at-facilities');
  f.payment(custom.links[0].providerId!, 'pay_facility');
  const customBody = f.razorpayEvent(custom.links[0].providerId!);
  const calls = f.calls.length;
  assert.deepEqual(await f.processWebhook(customBody, f.signature(customBody), 'custom'), {
    received: true,
    ignored: true,
  });
  assert.equal(f.calls.length, calls);
  assert.equal(f.receipts.length, 0);
  await assert.rejects(
    f.processRazorpayWebhook('at-facilities', customBody, f.signature(customBody), 'custom'),
    /signature/,
  );
  const sharedBody = f.razorpayEvent(shared.links[0].providerId!);
  assert.deepEqual(
    await f.processRazorpayWebhook(
      'at-facilities',
      sharedBody,
      f.signature(sharedBody, 'facility-webhook'),
      'cross',
    ),
    { received: true, ignored: true },
  );
  assert.equal(f.calls.length, calls);
  await f.processRazorpayWebhook(
    'at-facilities',
    customBody,
    f.signature(customBody, 'facility-webhook'),
    'custom',
  );
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].organizationId, 'at-facilities');
});

test('identical Razorpay webhook event IDs in separate businesses do not collide', async (t) => {
  const f = fixture(t);
  for (const [org, secret] of [
    ['pipeline2-legal', 'global-webhook'],
    ['at-facilities', 'facility-webhook'],
  ]) {
    const details = await f.createPaymentLink(`invoice-${org}`);
    const linkId = details.links[0].providerId!;
    f.payment(linkId, org === 'pipeline2-legal' ? 'pay_one' : 'pay_two');
    const body = f.razorpayEvent(linkId);
    await f.processRazorpayWebhook(org, body, f.signature(body, secret), 'provider-reused-event-id');
  }
  assert.equal(f.receipts.length, 2);
});

test('old provider links block new provider creation, manual payments and business gateway changes until cancelled', async (t) => {
  const f = fixture(t);
  await f.createPaymentLink('invoice-pipeline2-legal');
  const current = f.organizations.get('pipeline2-legal')!;
  assert.throws(
    () => f.assertOrganizationChangesAllowed(current, { ...current, paymentGateway: 'cashfree' }),
    /active online/,
  );
  assert.throws(
    () => f.assertOrganizationChangesAllowed(current, { ...current, businessType: 'independent' }),
    /active online/,
  );
  const document = f.getDocument('invoice-pipeline2-legal')!;
  document.organizationSnapshot.paymentGateway = 'cashfree';
  f.save(document);
  await assert.rejects(f.createPaymentLink(document.id), /previous provider/);
  assert.throws(() => f.assertManualChangesAllowed(document.id), /active online/);
  await f.cancelPaymentLink(document.id);
  f.assertManualChangesAllowed(document.id);
  f.assertOrganizationChangesAllowed(current, { ...current, paymentGateway: 'cashfree' });
  const details = await f.createPaymentLink(document.id);
  assert.equal(details.links.length, 2);
  assert.equal(details.links.find((link) => link.state === 'created')?.provider, 'cashfree');
});

test('changing a business to independent refreshes cached credentials without inheriting shared keys', async (t) => {
  const f = fixture(t);
  assert.equal(f.getStatus('pipeline2-legal').configured, true);
  f.organizations.get('pipeline2-legal')!.businessType = 'independent';
  assert.equal(f.getStatus('pipeline2-legal').configured, false);
});

test('Cashfree webhook dispatch uses the independent business secret and rejects global credentials', async (t) => {
  const f = fixture(t);
  const details = await f.createPaymentLink('invoice-shri-sarraf');
  const body = Buffer.from(
    JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: details.links[0].referenceId } }),
  );
  const stamp = '1791460800000';
  const sign = (secret: string) => createHmac('sha256', secret).update(stamp).update(body).digest('base64');
  await assert.rejects(
    f.processCashfreeWebhook('shri-sarraf', body, sign('global-cashfree-secret'), stamp),
    /signature/,
  );
  await f.processCashfreeWebhook('shri-sarraf', body, sign('sarraf-secret'), stamp);
  assert.equal(f.receipts.length, 0);
  assert.equal(f.getDocument('invoice-shri-sarraf')!.status, 'sent');
});

test('old Venturecore-issued Shri Sarraf invoices cannot collect through the independent merchant', async (t) => {
  const f = fixture(t);
  const document = f.getDocument('invoice-shri-sarraf')!;
  document.organizationSnapshot = {
    ...document.organizationSnapshot,
    legalName: 'VENTURECORE SOLUTIONS PRIVATE LIMITED',
    paymentGateway: undefined,
    gstin: '09AAACA1234B1ZG',
  };
  f.save(document);
  f.organizations.get('shri-sarraf')!.legalName = 'Sri Sarraf Jewellers';
  await assert.rejects(f.createPaymentLink(document.id), /different legal business/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.getDocumentPayments(document.id).links.length, 0);
});

test('changed legal PAN blocks new collection but case, address and logo updates do not', async (t) => {
  const f = fixture(t);
  const document = f.getDocument('invoice-pipeline2-legal')!;
  document.organizationSnapshot.pan = 'aaaca1234b';
  f.save(document);
  const organization = f.organizations.get('pipeline2-legal')!;
  organization.pan = 'ABCDE1234F';
  await assert.rejects(f.createPaymentLink(document.id), /different legal business/);
  assert.equal(f.calls.length, 0);
  organization.pan = 'AAACA1234B';
  organization.address = 'Updated registered office';
  organization.logoUrl = 'data:image/png;base64,new';
  await f.createPaymentLink(document.id);
  assert.equal(f.calls.length, 1);
});

test('provider tables survive an application transaction rollback before first document read', async (t) => {
  const f = fixture(t);
  f.db.exec('BEGIN');
  f.getDocumentPayments('invoice-shri-sarraf');
  f.db.exec('ROLLBACK');
  const details = f.getDocumentPayments('invoice-shri-sarraf');
  assert.equal(details.links.length, 0);
  await f.createPaymentLink('invoice-shri-sarraf');
  assert.equal(f.calls.length, 1);
});

test('generic Razorpay webhook on the wrong shared-merchant division cannot mutate or consume another division’s link', async (t) => {
  const env = { ...environment };
  for (const key of [
    'AT_FACILITY_RAZORPAY_KEY_ID',
    'AT_FACILITY_RAZORPAY_KEY_SECRET',
    'AT_FACILITY_RAZORPAY_WEBHOOK_SECRET',
  ])
    delete env[key];
  const f = fixture(t, env);
  const details = await f.createPaymentLink('invoice-at-facilities');
  const linkId = details.links[0].providerId!;
  f.payment(linkId, 'pay_otherdivision');
  f.links.get(linkId)!.amount = 9999;
  const body = Buffer.from(
    JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_otherdivision' } } },
    }),
  );
  assert.deepEqual(
    await f.processRazorpayWebhook('pipeline2-legal', body, f.signature(body), 'generic-other-division'),
    { received: true, ignored: true },
  );
  assert.equal(f.getDocumentPayments('invoice-at-facilities').links[0].state, 'created');
  assert.equal(
    (f.db.prepare('SELECT COUNT(*) AS count FROM online_webhook_events').get() as { count: number }).count,
    0,
  );
  assert.equal(f.receipts.length, 0);
  f.links.get(linkId)!.amount = 10000;
  await f.processRazorpayWebhook('at-facilities', body, f.signature(body), 'generic-other-division');
  assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0].organizationId, 'at-facilities');
});
