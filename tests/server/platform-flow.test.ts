import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import type { Mailer } from '../../server/integrations/email/mailer.ts';
import type { BusinessDocument, Customer, DocumentInput, PaymentDetails } from '../../shared/types.ts';
import type { EmailMessage } from '../../shared/messaging-types.ts';
import type { OnlinePaymentDetails } from '../../shared/online-payment-types.ts';

const timestamp = '2026-10-08T12:00:00.000Z';
const environment = {
  RAZORPAY_KEY_ID: 'rzp_test_platformfixture',
  RAZORPAY_KEY_SECRET: 'platform-fixture-key',
  RAZORPAY_WEBHOOK_SECRET: 'platform-fixture-webhook',
  RESEND_API_KEY: 're_platform_fixture',
  EMAIL_FROM: 'Venturecore INV <billing@example.test>',
  EMAIL_AUTOMATION: 'true',
};
interface ProviderPayment {
  id: string;
  amount: number;
  status: 'captured' | 'failed';
  captured: boolean;
  currency: 'INR';
  created_at: number;
}
interface ProviderLink {
  id: string;
  reference_id: string;
  amount: number;
  amount_paid: number;
  currency: 'INR';
  status: string;
  short_url: string;
  payments: { payment_id: string; amount: number; status: string }[] | null;
}
interface EmailBody {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; content: string }[];
}

test('zero-value invoice finalization queues one complete-payment notification without creating a charge', async (t) => {
  const flow = await fixture(t);
  const { input } = await flow.issuedInvoice();
  const document = await flow.request<BusinessDocument>(
    '/documents',
    'POST',
    {
      ...input,
      title: 'Zero-value invoice',
      items: input.items.map((item) => ({ ...item, rate: 0 })),
      installmentPlan: null,
    },
    201,
  );
  const finalized = await flow.request<PaymentDetails>(`/documents/${document.id}/finalize`, 'POST');
  assert.equal(finalized.document.status, 'paid');
  assert.ok(finalized.document.finalizedAt);
  assert.equal(finalized.payments.length, 0);
  await flow.request(`/documents/${document.id}/finalize`, 'POST');
  const messages = await flow.request<EmailMessage[]>(`/documents/${document.id}/messages`);
  assert.equal(messages.filter((message) => message.kind === 'payment_paid').length, 1);
  assert.equal(flow.providerCalls.length, 0);
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venturecore-platform-flow-'));
  const filename = join(directory, 'test.sqlite');
  let db = initDb(filename);
  const links = new Map<string, ProviderLink>();
  const payments = new Map<string, ProviderPayment>();
  const paymentLinks = new Map<string, string>();
  const providerCalls: { path: string; method: string }[] = [];
  const emails: { body: EmailBody; key: string }[] = [];
  const paymentFetch: typeof fetch = async (input, init) => {
    assert.equal(db.isTransaction, false, 'provider requests must occur after database commit');
    const url = new URL(String(input)),
      method = init?.method ?? 'GET';
    assert.equal(url.origin, 'https://api.razorpay.com');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      `Basic ${Buffer.from(`${environment.RAZORPAY_KEY_ID}:${environment.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
    );
    providerCalls.push({ path: url.pathname + url.search, method });
    if (url.pathname === '/v1/payment_links' && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.accept_partial, true);
      assert.deepEqual(body.notify, { sms: false, email: false });
      const id = `plink_platform${links.size + 1}`;
      const link: ProviderLink = {
        ...body,
        id,
        amount_paid: 0,
        status: 'created',
        short_url: `https://rzp.io/i/platform${links.size + 1}`,
        payments: null,
      };
      links.set(id, link);
      return Response.json(link);
    }
    if (url.pathname === '/v1/payment_links' && method === 'GET') {
      const matching = [...links.values()].filter((link) =>
        url.searchParams.has('payment_id')
          ? paymentLinks.get(url.searchParams.get('payment_id')!) === link.id
          : link.reference_id === url.searchParams.get('reference_id'),
      );
      return Response.json({ payment_links: matching });
    }
    const linkId = /^\/v1\/payment_links\/(plink_[A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
    if (linkId && method === 'GET') {
      assert.ok(links.has(linkId), 'fixture link must exist');
      return Response.json(links.get(linkId));
    }
    const paymentId = /^\/v1\/payments\/(pay_[A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
    if (paymentId && method === 'GET') {
      assert.ok(payments.has(paymentId), 'fixture payment must exist');
      return Response.json(payments.get(paymentId));
    }
    assert.fail(`Unexpected provider operation: ${method} ${url.pathname}`);
  };
  const emailFetch: typeof fetch = async (input, init) => {
    assert.equal(db.isTransaction, false, 'email delivery must occur after database commit');
    assert.equal(String(input), 'https://api.resend.com/emails');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${environment.RESEND_API_KEY}`);
    const body = JSON.parse(String(init?.body)) as EmailBody;
    const key = new Headers(init?.headers).get('Idempotency-Key')!;
    assert.ok(key.startsWith('venturecore-email/'));
    assert.equal(body.from, environment.EMAIL_FROM);
    assert.deepEqual(body.to, ['buyer@example.test']);
    emails.push({ body, key });
    return Response.json({ id: `mail_platform${emails.length}` });
  };
  const makeApp = () =>
    createApp({
      auth: false,
      db,
      environment,
      paymentFetch,
      emailFetch,
      now: () => new Date(timestamp),
      distPath: join(directory, 'no-dist'),
    });
  let app = makeApp();
  let server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  t.after(async () => {
    await stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function restart() {
    await stop();
    db.close();
    db = initDb(filename);
    app = makeApp();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function request<T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function issuedInvoice() {
    const customer = await request<Customer>(
      '/customers',
      'POST',
      {
        organizationId: 'pipeline2-legal',
        name: 'Platform flow buyer',
        email: 'buyer@example.test',
        phone: '',
        gstin: '',
        address: 'Synthetic buyer address',
        stateCode: '09',
        contactPerson: 'Accounts',
      },
      201,
    );
    const input: DocumentInput = {
      organizationId: customer.organizationId,
      customerId: customer.id,
      kind: 'invoice',
      status: 'sent',
      issueDate: '2026-10-08',
      dueDate: '2026-11-08',
      title: 'Platform integration invoice',
      items: [
        {
          description: 'Synthetic legal service',
          quantity: 1,
          rate: 100.01,
          gstRate: 0,
          hsn: '',
          unit: 'Service',
        },
      ],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: 'Integration fixture only',
      terms: 'Pay against this invoice',
      installmentPlan: {
        name: 'Part payment plan',
        installments: [
          { id: 'first', label: 'First installment', amount: 25.01, dueDate: '2026-10-08' },
          { id: 'last', label: 'Final installment', amount: 75, dueDate: '2026-11-08' },
        ],
      },
    };
    return { input, document: await request<BusinessDocument>('/documents', 'POST', input, 201) };
  }
  function addPayment(id: string, amount: number, status: 'captured' | 'failed' = 'captured') {
    const link = [...links.values()][0];
    assert.ok(link);
    const payment: ProviderPayment = {
      id,
      amount,
      status,
      captured: status === 'captured',
      currency: 'INR',
      created_at: Date.parse(timestamp) / 1000,
    };
    payments.set(id, payment);
    paymentLinks.set(id, link.id);
    // Real link responses can omit failed attempts; payment_id filtering still
    // establishes membership when the webhook contains only a payment entity.
    if (status === 'captured') {
      (link.payments ??= []).push({ payment_id: id, amount, status });
      link.amount_paid += amount;
      link.status = link.amount_paid === link.amount ? 'paid' : 'partially_paid';
    }
    return payment;
  }
  function event(event: string, payment: ProviderPayment, includeLink = true) {
    return Buffer.from(
      JSON.stringify({
        event,
        payload: {
          payment: { entity: payment },
          ...(includeLink ? { payment_link: { entity: [...links.values()][0] } } : {}),
        },
      }),
    );
  }
  async function webhook(body: Buffer, eventId: string, expected = 200, signatureBody = body) {
    const signature = createHmac('sha256', environment.RAZORPAY_WEBHOOK_SECRET)
      .update(signatureBody)
      .digest('hex');
    const response = await fetch(`${base}/api/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      },
      body: body.toString('utf8'),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result as { received?: boolean; duplicate?: boolean; error?: string };
  }
  function count(
    table: 'payments' | 'documents' | 'online_verified_payments' | 'online_webhook_events' | 'email_outbox',
  ) {
    return Number((db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total);
  }
  return {
    request,
    issuedInvoice,
    restart,
    addPayment,
    event,
    webhook,
    count,
    links,
    providerCalls,
    emails,
    get db() {
      return db;
    },
    get mailer() {
      return app.locals.services.mailer as Mailer;
    },
  };
}

function assertPdf(email: EmailBody) {
  assert.equal(email.attachments.length, 1);
  const attachment = email.attachments[0];
  assert.match(attachment.filename, /\.pdf$/);
  const bytes = Buffer.from(attachment.content, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 5000, 'actual invoice PDF includes rendered content and fonts');
  assert.match(bytes.subarray(-30).toString(), /%%EOF/);
}

test('issued invoice survives restart, sends a real PDF and link, then verified part and final payments update one invoice and durable receipt emails', async (t) => {
  const f = await fixture(t);
  const { input, document } = await f.issuedInvoice();
  const path = `/documents/${document.id}`;
  assert.equal(document.totals.total, 100.01);
  let messages = await f.request<EmailMessage[]>(`${path}/messages`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'queued');
  assert.equal(messages[0].kind, 'invoice');
  assert.equal(f.providerCalls.length, 0, 'saving an invoice only writes an outbox entry');
  assert.equal(f.emails.length, 0);
  const queuedId = messages[0].id;
  await f.restart();
  messages = await f.request<EmailMessage[]>(`${path}/messages`);
  assert.equal(messages[0].id, queuedId);
  assert.equal(messages[0].status, 'queued');
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.equal(f.emails.length, 1);
  assertPdf(f.emails[0].body);
  assert.match(f.emails[0].body.text, /https:\/\/rzp\.io\/i\/platform1/);
  assert.ok(f.emails[0].body.text.includes(document.number));
  assert.equal(f.providerCalls.filter((call) => call.method === 'POST').length, 1);
  messages = await f.request<EmailMessage[]>(`${path}/messages`);
  assert.equal(messages[0].status, 'sent');
  assert.equal(messages[0].hasPaymentLink, true);
  assert.equal(
    (await f.request<OnlinePaymentDetails>(`${path}/online-payments`)).hasBlockingPaymentLink,
    true,
  );
  const blocked = await f.request<{ error: string }>(
    `${path}/payments`,
    'POST',
    { amount: 1, paidOn: '2026-10-08', method: 'cash', reference: '', notes: '', requestId: randomUUID() },
    409,
  );
  assert.match(blocked.error, /Cancel or reconcile/);
  assert.equal(f.count('payments'), 0);
  assert.equal(f.count('email_outbox'), 1);

  const part = f.addPayment('pay_platformpart', 2501);
  const partEvent = f.event('payment_link.partially_paid', part);
  await f.webhook(partEvent, 'platform_partial');
  let ledger = await f.request<PaymentDetails>(`${path}/payments`);
  assert.equal(ledger.document.amountPaid, 25.01);
  assert.equal(ledger.document.balanceDue, 75);
  assert.equal(ledger.document.status, 'partially_paid');
  assert.equal(ledger.document.finalizedAt, null);
  assert.equal(ledger.payments.length, 1);
  assert.equal(f.count('online_verified_payments'), 1);
  assert.equal(f.emails.length, 1, 'webhook queues receipt without sending email inside its transaction');
  messages = await f.request<EmailMessage[]>(`${path}/messages`);
  assert.equal(messages.find((item) => item.kind === 'payment_received')?.status, 'queued');
  assert.equal(messages.find((item) => item.kind === 'payment_received')?.hasPaymentLink, true);
  assert.deepEqual(await f.webhook(partEvent, 'platform_partial'), { received: true, duplicate: true });
  await f.webhook(partEvent, 'platform_partial_redelivery');
  assert.equal(f.count('payments'), 1);
  assert.equal(f.count('email_outbox'), 2);
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.match(f.emails[1].body.subject, /Part payment received/);
  assertPdf(f.emails[1].body);
  const refused = await f.request<{ error: string }>(
    `/payments/${ledger.payments[0].id}/void`,
    'POST',
    { reason: 'Attempted manual gateway correction' },
    409,
  );
  assert.match(refused.error, /cannot be manually voided/);

  const full = f.addPayment('pay_platformfinal', 7500);
  const fullEvent = f.event('payment_link.paid', full);
  await f.webhook(fullEvent, 'platform_final');
  ledger = await f.request<PaymentDetails>(`${path}/payments`);
  assert.equal(ledger.document.id, document.id);
  assert.equal(ledger.document.number, document.number);
  assert.equal(ledger.document.amountPaid, 100.01);
  assert.equal(ledger.document.balanceDue, 0);
  assert.equal(ledger.document.status, 'paid');
  assert.equal(ledger.document.finalizedAt, timestamp);
  assert.equal(ledger.events.filter((item) => item.type === 'invoice_finalized').length, 1);
  assert.equal(ledger.payments.length, 2);
  assert.equal(f.count('documents'), 1);
  assert.equal(f.count('online_verified_payments'), 2);
  assert.equal(
    (await f.request<OnlinePaymentDetails>(`${path}/online-payments`)).hasBlockingPaymentLink,
    false,
  );
  await f.request(path, 'PUT', { ...input, notes: 'Attempted change after payment' }, 409);
  const finalReceipt = (await f.request<EmailMessage[]>(`${path}/messages`)).find(
    (item) => item.kind === 'payment_paid',
  )!;
  assert.equal(finalReceipt.status, 'queued');
  assert.equal(finalReceipt.hasPaymentLink, false);
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.match(f.emails[2].body.subject, /Payment complete.*Paid \/ Final/);
  assert.doesNotMatch(f.emails[2].body.html, /Pay securely with Razorpay/);
  assertPdf(f.emails[2].body);
  assert.deepEqual(await f.webhook(fullEvent, 'platform_final'), { received: true, duplicate: true });
  await f.webhook(fullEvent, 'platform_final_redelivery');
  assert.deepEqual(await f.mailer.processQueue(), { processed: 0, sent: 0, failed: 0 });
  assert.equal(f.count('payments'), 2);
  assert.equal(f.count('email_outbox'), 3);
  assert.equal(f.emails.length, 3);
  assert.equal(new Set(f.emails.map((item) => item.key)).size, 3);
});

test('HTTP webhook verification uses the original bytes and rejects tampering without any receipt or email', async (t) => {
  const f = await fixture(t);
  const { document } = await f.issuedInvoice();
  await f.mailer.processQueue();
  const payment = f.addPayment('pay_platformtampered', 10001);
  const signed = f.event('payment_link.paid', payment);
  const before = f.providerCalls.length;
  const result = await f.webhook(Buffer.concat([signed, Buffer.from(' ')]), 'platform_tampered', 401, signed);
  assert.match(result.error!, /signature/);
  assert.equal(f.providerCalls.length, before, 'invalid signatures never query the provider');
  assert.equal(f.count('payments'), 0);
  assert.equal(f.count('online_verified_payments'), 0);
  assert.equal(f.count('online_webhook_events'), 0);
  assert.equal(f.count('email_outbox'), 1);
  const ledger = await f.request<PaymentDetails>(`/documents/${document.id}/payments`);
  assert.equal(ledger.document.status, 'sent');
  assert.equal(ledger.document.balanceDue, 100.01);
  assert.equal(ledger.document.finalizedAt, null);
});

test('a verified failed provider attempt queues one failure email with retry link and never credits the invoice', async (t) => {
  const f = await fixture(t);
  const { document } = await f.issuedInvoice();
  await f.mailer.processQueue();
  const payment = f.addPayment('pay_platformfailed', 10001, 'failed');
  const failedEvent = f.event('payment.failed', payment, false);
  await f.webhook(failedEvent, 'platform_failed');
  await f.webhook(failedEvent, 'platform_failed');
  await f.webhook(failedEvent, 'platform_failed_redelivery');
  assert.equal(f.count('payments'), 0);
  assert.equal(f.count('online_verified_payments'), 0);
  assert.equal(f.count('email_outbox'), 2);
  const messages = await f.request<EmailMessage[]>(`/documents/${document.id}/messages`);
  const failed = messages.find((message) => message.kind === 'payment_failed')!;
  assert.equal(failed.status, 'queued');
  assert.equal(failed.hasPaymentLink, true);
  assert.deepEqual(await f.mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.match(f.emails[1].body.subject, /Payment unsuccessful/);
  assert.match(f.emails[1].body.text, /No successful payment has been recorded/);
  assert.match(f.emails[1].body.text, /https:\/\/rzp\.io\/i\/platform1/);
  assertPdf(f.emails[1].body);
  const ledger = await f.request<PaymentDetails>(`/documents/${document.id}/payments`);
  assert.equal(ledger.document.amountPaid, 0);
  assert.equal(ledger.document.balanceDue, 100.01);
  assert.equal(ledger.document.status, 'sent');
});
