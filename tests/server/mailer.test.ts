import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailer, validPaymentEmailUrl } from '../../server/integrations/email/mailer.ts';
import {
  COMPANY_NAME,
  calculateTotals,
  type BusinessDocument,
  type Organization,
} from '../../shared/types.ts';

const enabled = () => ({
  RESEND_API_KEY: 'secret-test-key',
  EMAIL_FROM: 'Venturecore <invoices@example.test>',
  EMAIL_AUTOMATION: 'true',
});

test('email transport refuses redirects and bounds provider response bodies while preserving delivery idempotency', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z');
  const keys: string[] = [];
  const mailer = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    fetch: (async (url, options) => {
      assert.equal(String(url), 'https://api.resend.com/emails');
      assert.equal(options?.redirect, 'error');
      keys.push((options?.headers as Record<string, string>)['Idempotency-Key']);
      return keys.length === 1
        ? Response.json({ id: 'must-not-be-trusted', unexpected: 'x'.repeat(20_000) })
        : Response.json({ id: 'bounded-response' });
    }) as typeof fetch,
  });
  const message = mailer.enqueueInvoice(sample(), { eventKey: 'bounded-transport' });
  await mailer.processQueue();
  assert.equal(mailer.get(message.id)?.status, 'queued');
  assert.equal(mailer.get(message.id)?.providerId, '');
  time += 60_000;
  await mailer.processQueue();
  assert.equal(mailer.get(message.id)?.status, 'sent');
  assert.equal(keys[0], keys[1]);
});

test('business credentials changed during PDF preparation cannot send with the previous company sender', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const document = sample();
  const organization = { ...document.organizationSnapshot };
  let release!: () => void;
  let started!: () => void;
  let requests = 0;
  const startedRendering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mailer = createMailer(db, {
    env: enabled(),
    getOrganization: () => organization,
    renderInvoiceAttachment: async () => {
      started();
      await gate;
      return { filename: 'invoice.pdf', content: 'cGRm' };
    },
    fetch: (async () => {
      requests++;
      return Response.json({ id: 'should-not-send' });
    }) as typeof fetch,
  });
  const message = mailer.enqueueInvoice(document, { eventKey: 'sender-change-during-pdf' });
  const processing = mailer.processQueue();
  await startedRendering;
  organization.businessType = 'independent';
  release();
  await processing;
  assert.equal(requests, 0);
  assert.equal(mailer.get(message.id)?.status, 'held');
  assert.equal(
    (
      db.prepare('SELECT first_attempt_at FROM email_outbox WHERE id=?').get(message.id) as {
        first_attempt_at: string | null;
      }
    ).first_attempt_at,
    null,
  );
});
function sample(overrides: Partial<BusinessDocument> = {}): BusinessDocument {
  const org: Organization = {
    id: 'org-1',
    name: 'Pirento <legal>',
    legalName: COMPANY_NAME,
    gstin: '09AAACA1234B1ZG',
    email: 'team@example.test',
    phone: '12345',
    address: 'Office & studio',
    stateCode: '09',
    accentColor: '#123456',
    logoUrl: '',
    invoicePrefix: 'PL',
    quotationPrefix: 'PQ',
    bankName: '',
    accountName: '',
    accountNumber: '',
    ifsc: '',
    terms: '',
    signature: '',
    template: 'modern',
  };
  const items = [
    { description: '<script>alert(1)</script> Service', hsn: '9985', quantity: 2, rate: 500, gstRate: 18 },
  ];
  return {
    id: 'doc-1',
    organizationId: org.id,
    customerId: 'customer-1',
    kind: 'invoice',
    status: 'sent',
    issueDate: '2026-10-08',
    dueDate: '2026-11-08',
    title: 'Service invoice',
    items,
    discountPercent: 0,
    placeOfSupply: '09',
    notes: 'Thank you <img src=x onerror=alert(1)>',
    terms: '',
    number: 'PL/2627/0001',
    createdAt: '2026-10-08T10:00:00Z',
    updatedAt: '2026-10-08T10:00:00Z',
    customerSnapshot: {
      id: 'customer-1',
      organizationId: org.id,
      name: 'Buyer & Co',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Customer address',
      stateCode: '09',
      contactPerson: '',
    },
    organizationSnapshot: org,
    totals: calculateTotals(items, 0, false),
    sourceQuotationId: null,
    convertedInvoiceId: null,
    amountPaid: 0,
    balanceDue: 1180,
    finalizedAt: null,
    ...overrides,
  };
}

test('email outbox preserves a rendered invoice snapshot, safe HTML, idempotency, and exact PDF across transport retries', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    renders = 0;
  const requests: { body: any; key: string }[] = [];
  const mailer = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    renderInvoiceAttachment: async (doc) => {
      renders++;
      assert.equal(doc.customerSnapshot.name, 'Buyer & Co');
      return { filename: 'invoice.pdf', content: 'cGRm' };
    },
    fetch: (async (_url, options) => {
      requests.push({
        body: JSON.parse(String(options?.body)),
        key: (options?.headers as Record<string, string>)['Idempotency-Key'],
      });
      return new Response(JSON.stringify(requests.length === 1 ? { error: 'temporary' } : { id: 'mail-1' }), {
        status: requests.length === 1 ? 503 : 200,
      });
    }) as typeof fetch,
  });
  const doc = sample(),
    queued = mailer.enqueueInvoice(doc, {
      eventKey: 'issued:doc-1',
      paymentUrl: 'https://rzp.io/i/example?a=1&b=2',
      automatic: true,
    });
  assert.equal(queued.status, 'queued');
  doc.customerSnapshot.name = 'Changed after enqueue';
  assert.equal(mailer.enqueueInvoice(sample(), { eventKey: 'issued:doc-1' }).id, queued.id);
  assert.equal(mailer.listMessages(doc.id).length, 1);
  assert.deepEqual(await mailer.processQueue(), { processed: 1, sent: 0, failed: 0 });
  assert.equal(mailer.get(queued.id)?.attempts, 1);
  assert.equal(mailer.get(queued.id)?.status, 'queued');
  assert.equal(mailer.get(queued.id)?.nextAttemptAt, '2026-10-08T10:01:00.000Z');
  time += 60_000;
  assert.deepEqual(await mailer.processQueue(), { processed: 1, sent: 1, failed: 0 });
  assert.equal(renders, 1);
  assert.deepEqual(requests[0], requests[1]);
  assert.match(requests[0].body.html, /&lt;script&gt;/);
  assert.doesNotMatch(requests[0].body.html, /<script>|<img src=x/);
  assert.match(requests[0].body.html, /Buyer &amp; Co/);
  assert.match(requests[0].body.html, /href="https:\/\/rzp.io\/i\/example\?a=1&amp;b=2"/);
  assert.match(requests[0].body.text, /CGST: ₹90.00/);
  assert.deepEqual(requests[0].body.attachments, [{ filename: 'invoice.pdf', content: 'cGRm' }]);
  assert.equal(mailer.get(queued.id)?.status, 'sent');
  assert.equal(mailer.get(queued.id)?.providerId, 'mail-1');
  assert.equal('payload' in mailer.get(queued.id)!, false);
  assert.equal(JSON.stringify(mailer.listMessages(doc.id)).includes('secret-test-key'), false);
});

test('missing configuration, disabled automation and missing recipients hold messages without automatic release', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const env: Record<string, string | undefined> = {};
  let calls = 0;
  const mailer = createMailer(db, {
    env,
    fetch: (async () => {
      calls++;
      return Response.json({ id: 'mail' });
    }) as typeof fetch,
  });
  const held = mailer.enqueueInvoice(sample(), { eventKey: 'invoice:held', automatic: true });
  assert.equal(held.status, 'held');
  assert.match(held.lastError, /not configured/);
  await mailer.processQueue();
  assert.equal(calls, 0);
  Object.assign(env, enabled());
  await mailer.processQueue();
  assert.equal(calls, 0);
  assert.equal(mailer.get(held.id)?.canRetry, true);
  mailer.retry(held.id);
  await mailer.processQueue();
  assert.equal(calls, 1);
  env.EMAIL_AUTOMATION = 'false';
  const auto = mailer.enqueuePayment(sample(), {
    outcome: 'received',
    eventKey: 'pay:auto-off',
    automatic: true,
  });
  assert.equal(auto.status, 'held');
  assert.match(auto.lastError, /Automatic email/);
  const missing = mailer.enqueueInvoice(
    sample({ customerSnapshot: { ...sample().customerSnapshot, email: '' } }),
    { eventKey: 'invoice:no-email' },
  );
  assert.equal(missing.status, 'held');
  assert.equal(missing.canRetry, false);
  assert.throws(() => mailer.retry(missing.id), /no valid recipient/);
  assert.equal(mailer.enqueueInvoice(sample(), { eventKey: 'invoice:manual' }).status, 'queued');
});

test('outbox entries are rolled back with business transactions and remain durable across database restarts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'venture-mailer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'outbox.sqlite');
  let db = new DatabaseSync(filename);
  let mailer = createMailer(db, { env: enabled() });
  db.exec('BEGIN');
  mailer.enqueueInvoice(sample(), { eventKey: 'will-rollback' });
  db.exec('ROLLBACK');
  assert.equal(mailer.listMessages('doc-1').length, 0);
  const saved = mailer.enqueueInvoice(sample(), { eventKey: 'will-persist' });
  db.close();
  db = new DatabaseSync(filename);
  t.after(() => db.close());
  mailer = createMailer(db, {
    env: enabled(),
    fetch: (async () => Response.json({ id: 'durable' })) as typeof fetch,
  });
  assert.equal(mailer.listMessages('doc-1')[0].id, saved.id);
  await mailer.processQueue();
  assert.equal(mailer.get(saved.id)?.status, 'sent');
});

test('competing workers claim a notification once and restart recovers only expired leases', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    calls = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const one = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    fetch: (async () => {
      calls++;
      await gate;
      return Response.json({ id: 'worker-1' });
    }) as typeof fetch,
  });
  const two = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    fetch: (async () => {
      calls++;
      return Response.json({ id: 'worker-2' });
    }) as typeof fetch,
  });
  const record = one.enqueueInvoice(sample(), { eventKey: 'concurrent' });
  const pending = one.processQueue();
  await two.processQueue();
  assert.equal(calls, 1);
  unblock();
  await pending;
  assert.equal(one.get(record.id)?.status, 'sent');
  const crashed = one.enqueueInvoice(sample(), { eventKey: 'crashed' });
  db.prepare(
    "UPDATE email_outbox SET status='sending',attempts=1,first_attempt_at=?,lease_until=? WHERE id=?",
  ).run(new Date(time).toISOString(), new Date(time + 60_000).toISOString(), crashed.id);
  assert.equal((await two.processQueue()).processed, 0);
  time += 60_000;
  assert.equal((await two.processQueue()).sent, 1);
});

test('ambiguous delivery outside provider idempotency window requires manual investigation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    calls = 0;
  const mailer = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    fetch: (async () => {
      calls++;
      throw new Error('network problem including secret-test-key');
    }) as typeof fetch,
  });
  const queued = mailer.enqueueInvoice(sample(), { eventKey: 'ambiguous' });
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.doesNotMatch(mailer.get(queued.id)!.lastError, /secret/);
  time += 24 * 60 * 60_000;
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(queued.id)?.status, 'failed');
  assert.equal(mailer.get(queued.id)?.canRetry, false);
  assert.throws(() => mailer.retry(queued.id), /idempotency window/);
});

test('provider rejections stop retrying and payment events render distinct honest outcomes', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const bodies: any[] = [];
  const mailer = createMailer(db, {
    env: enabled(),
    fetch: (async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({ message: 'secret-test-key invalid' }, { status: 401 });
    }) as typeof fetch,
  });
  const partial = mailer.enqueuePayment(sample({ amountPaid: 400, balanceDue: 780 }), {
    eventKey: 'partial',
    outcome: 'received',
    amount: 400,
    reference: '<payment-ref>',
  });
  const final = mailer.enqueuePayment(
    sample({ amountPaid: 1180, balanceDue: 0, finalizedAt: '2026-10-08T10:00:00Z' }),
    { eventKey: 'final', outcome: 'paid', amount: 780 },
  );
  const failed = mailer.enqueuePayment(sample(), {
    eventKey: 'failed',
    outcome: 'failed',
    paymentUrl: 'https://rzp.io/i/example',
  });
  assert.equal(partial.kind, 'payment_received');
  assert.equal(final.kind, 'payment_paid');
  assert.equal(failed.kind, 'payment_failed');
  await mailer.processQueue();
  assert.ok(
    mailer
      .listMessages('doc-1')
      .every(
        (message) => message.status === 'failed' && message.attempts === 1 && message.nextAttemptAt === null,
      ),
  );
  assert.match(bodies[0].text, /remaining balance is ₹780.00/);
  assert.match(bodies[1].subject, /Paid \/ Final/);
  assert.doesNotMatch(bodies[1].html, /Pay securely/);
  assert.match(bodies[2].text, /No successful payment has been recorded for this attempt/);
  assert.doesNotMatch(JSON.stringify(mailer.listMessages('doc-1')), /secret-test-key/);
  assert.match(bodies[0].html, /&lt;payment-ref&gt;/);
});

test('untrusted payment URLs and cross-document reuse of event identifiers are rejected', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const mailer = createMailer(db, { env: enabled() });
  for (const url of [
    'javascript:alert(1)',
    'http://rzp.io/pay',
    'https://rzp.io.evil.test/pay',
    'https://rzp.to.evil.test/pay',
    'https://unexpected.razorpay.com/pay',
    'https://user:pass@rzp.io/pay',
    'https://localhost/pay',
    'https://rzp.io:123/pay',
  ]) {
    assert.equal(validPaymentEmailUrl(url), false);
    assert.throws(
      () => mailer.enqueueInvoice(sample(), { eventKey: 'bad-link', paymentUrl: url }),
      /verified HTTPS/,
    );
  }
  assert.equal(validPaymentEmailUrl('https://pages.razorpay.com/pay/example'), true);
  assert.equal(validPaymentEmailUrl('https://rzp.to/i/example'), true);
  assert.equal(
    mailer.enqueueInvoice(sample(), { eventKey: 'rzp-to-link', paymentUrl: 'https://rzp.to/i/example' })
      .hasPaymentLink,
    true,
  );
  mailer.enqueueInvoice(sample(), { eventKey: 'unique' });
  assert.throws(
    () => mailer.enqueueInvoice(sample({ id: 'another-document' }), { eventKey: 'unique' }),
    /already in use/,
  );
});

test('password reset messages never expose tokens in history and expire or scrub token content', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    calls = 0;
  const env: Record<string, string | undefined> = {};
  const mailer = createMailer(db, {
    env,
    now: () => new Date(time),
    fetch: (async () => {
      calls++;
      return Response.json({ id: 'reset-accepted' });
    }) as typeof fetch,
  });
  const held = mailer.enqueuePasswordReset({
    to: 'buyer@example.test',
    name: 'Buyer',
    resetUrl: 'https://example.test/#reset-password?token=very-secret-token',
    eventKey: 'reset:hashed1',
  });
  assert.equal(held.status, 'held');
  assert.doesNotMatch(JSON.stringify(held), /very-secret-token/);
  time += 30 * 60_000;
  await mailer.processQueue();
  assert.equal(mailer.get(held.id)?.status, 'failed');
  assert.equal(mailer.get(held.id)?.canRetry, false);
  assert.equal(
    (db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(held.id) as { payload: string }).payload,
    '{}',
  );
  Object.assign(env, enabled());
  await mailer.processQueue();
  assert.equal(calls, 0);
  const live = mailer.enqueuePasswordReset({
    to: 'buyer@example.test',
    name: 'Buyer',
    resetUrl: 'https://example.test/#reset-password?token=second-secret',
    eventKey: 'reset:hashed2',
  });
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(live.id)?.status, 'sent');
  assert.equal(
    (db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(live.id) as { payload: string }).payload,
    '{}',
  );
  assert.throws(
    () =>
      mailer.enqueuePasswordReset({
        to: 'buyer@example.test',
        name: 'Buyer',
        resetUrl: 'http://example.test/reset',
        eventKey: 'insecure',
      }),
    /HTTPS/,
  );
});

test('deferred payment links are resolved after commit, persist once and use the current invoice in both email and PDF', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    links = 0,
    sends = 0;
  const payloads: any[] = [];
  const mailer = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    resolveInvoicePaymentUrl: async (original) => {
      links++;
      assert.equal(original.balanceDue, 1180);
      return {
        document: sample({ amountPaid: 500, balanceDue: 680 }),
        paymentUrl: 'https://rzp.io/i/current',
      };
    },
    renderInvoiceAttachment: async (current) => {
      assert.equal(current.balanceDue, 680);
      return { filename: 'invoice.pdf', content: 'cGRm' };
    },
    fetch: (async (_url, options) => {
      payloads.push(JSON.parse(String(options?.body)));
      sends++;
      return sends === 1 ? Response.json({}, { status: 503 }) : Response.json({ id: 'accepted-current' });
    }) as typeof fetch,
  });
  db.exec('BEGIN');
  const record = mailer.enqueueInvoice(sample(), {
    eventKey: 'deferred',
    automatic: true,
    resolvePaymentLink: true,
  });
  assert.equal(links, 0);
  db.exec('COMMIT');
  await mailer.processQueue();
  assert.equal(links, 1);
  assert.equal(mailer.get(record.id)?.hasPaymentLink, true);
  time += 60_000;
  await mailer.processQueue();
  assert.equal(links, 1);
  assert.equal(mailer.get(record.id)?.status, 'sent');
  assert.deepEqual(payloads[0], payloads[1]);
  assert.match(payloads[0].text, /Outstanding: ₹680.00/);
  assert.match(payloads[0].text, /https:\/\/rzp.io\/i\/current/);
});

test('requested but unavailable payment links never produce a misleading emailed invoice', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let time = Date.parse('2026-10-08T10:00:00Z'),
    calls = 0,
    paid = false;
  const mailer = createMailer(db, {
    env: enabled(),
    now: () => new Date(time),
    resolveInvoicePaymentUrl: async () => ({
      document: paid
        ? sample({ amountPaid: 1180, balanceDue: 0, finalizedAt: '2026-10-08T10:00:00Z' })
        : sample(),
    }),
    fetch: (async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      assert.doesNotMatch(body.html, /Pay securely/);
      assert.match(body.text, /Outstanding: ₹0.00/);
      return Response.json({ id: 'paid-invoice' });
    }) as typeof fetch,
  });
  const queued = mailer.enqueueInvoice(sample(), { eventKey: 'missing-link', resolvePaymentLink: true });
  await mailer.processQueue();
  assert.equal(calls, 0);
  assert.equal(mailer.get(queued.id)?.status, 'queued');
  assert.match(mailer.get(queued.id)!.lastError, /could not be prepared/);
  assert.equal(
    (
      db.prepare('SELECT first_attempt_at FROM email_outbox WHERE id=?').get(queued.id) as {
        first_attempt_at: string | null;
      }
    ).first_attempt_at,
    null,
  );
  time += 60_000;
  paid = true;
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(queued.id)?.status, 'sent');
});

function independentDocument(): BusinessDocument {
  const doc = sample({ id: 'shri-document', organizationId: 'shri-sarraf' });
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    id: 'shri-sarraf',
    name: 'Shri Sarraf',
    legalName: 'Shri Sarraf Jewellers',
    businessType: 'independent',
    paymentGateway: 'cashfree',
    supportEmail: 'support@shrisarraf.com',
  };
  doc.customerSnapshot = { ...doc.customerSnapshot, organizationId: 'shri-sarraf' };
  return doc;
}

test('independent business email never inherits workspace sender, credentials or automation', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const shri = independentDocument(),
    division = sample();
  const env: Record<string, string | undefined> = enabled();
  let calls = 0;
  const mailer = createMailer(db, {
    env,
    getOrganization: (id) =>
      id === shri.organizationId
        ? shri.organizationSnapshot
        : id === division.organizationId
          ? division.organizationSnapshot
          : undefined,
    fetch: (async () => {
      calls++;
      return Response.json({ id: 'sent' });
    }) as typeof fetch,
  });
  assert.equal(mailer.status().configured, true);
  assert.equal(mailer.status(division.organizationId).configured, true);
  assert.equal(mailer.status(shri.organizationId).configured, false);
  assert.equal(mailer.status(shri.organizationId).from, '');
  assert.equal(mailer.status(shri.organizationId).replyTo, 'support@shrisarraf.com');
  const held = mailer.enqueueInvoice(shri, { eventKey: 'independent-held', automatic: true });
  assert.equal(held.status, 'held');
  assert.equal(held.canRetry, false);
  assert.throws(() => mailer.retry(held.id), /not configured/);
  const ordinary = mailer.enqueueInvoice(division, { eventKey: 'division-live' });
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(ordinary.id)?.status, 'sent');
  env.SHRI_SARRAF_EMAIL_FROM = 'Shri Sarraf <invoices@shrisarraf.example>';
  assert.equal(
    mailer.status(shri.organizationId).configured,
    false,
    'separate sender alone must not borrow a global API key',
  );
  env.SHRI_SARRAF_RESEND_API_KEY = 'shri-secret-key';
  assert.equal(mailer.status(shri.organizationId).configured, true);
  assert.equal(mailer.status(shri.organizationId).automationEnabled, false);
  assert.equal(
    mailer.enqueuePayment(shri, {
      eventKey: 'independent-automation-held',
      outcome: 'failed',
      automatic: true,
    }).status,
    'held',
  );
  mailer.retry(held.id);
  await mailer.processQueue();
  assert.equal(calls, 2);
});

test('per-business senders and credentials work without a global sender and freeze across retries', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const shri = independentDocument();
  const env: Record<string, string | undefined> = {
    SHRI_SARRAF_RESEND_API_KEY: 'shri-secret',
    SHRI_SARRAF_EMAIL_FROM: 'Shri <invoices@shri.example>',
    SHRI_SARRAF_EMAIL_AUTOMATION: 'true',
  };
  let time = Date.parse('2026-10-08T10:00:00Z');
  const requests: { body: any; authorization: string }[] = [];
  const mailer = createMailer(db, {
    env,
    getOrganization: () => shri.organizationSnapshot,
    now: () => new Date(time),
    fetch: (async (_url, options) => {
      requests.push({
        body: JSON.parse(String(options?.body)),
        authorization: (options?.headers as Record<string, string>).Authorization,
      });
      return requests.length === 1 ? Response.json({}, { status: 503 }) : Response.json({ id: 'shri-sent' });
    }) as typeof fetch,
  });
  assert.equal(mailer.status().configured, false);
  const record = mailer.enqueueInvoice(shri, { eventKey: 'shri-retry', automatic: true });
  assert.equal(record.status, 'queued');
  await mailer.processQueue();
  env.SHRI_SARRAF_EMAIL_FROM = 'Updated <other@shri.example>';
  shri.organizationSnapshot.supportEmail = 'changed@shri.example';
  time += 60_000;
  await mailer.processQueue();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].authorization, 'Bearer shri-secret');
  assert.equal(requests[0].body.from, 'Shri <invoices@shri.example>');
  assert.equal(requests[0].body.reply_to, 'support@shrisarraf.com');
  assert.match(requests[0].body.text, /Support: support@shrisarraf.com/);
  assert.match(requests[0].body.html, /Issued by Shri Sarraf Jewellers/);
  assert.doesNotMatch(requests[0].body.html, /support@pirento.com/);
  assert.doesNotMatch(
    (db.prepare('SELECT payload FROM email_outbox WHERE id=?').get(record.id) as { payload: string }).payload,
    /shri-secret/,
  );
  assert.doesNotMatch(JSON.stringify(mailer.listMessages(shri.id)), /shri-secret/);
});

test('changing credentials, losing an organization, or cross-business event reuse cannot redirect email', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let org: Organization | undefined = independentDocument().organizationSnapshot;
  const env: Record<string, string | undefined> = {
    ...enabled(),
    SHRI_SARRAF_RESEND_API_KEY: 'original-shri-key',
    SHRI_SARRAF_EMAIL_FROM: 'Shri <invoices@shri.example>',
  };
  let time = Date.parse('2026-10-08T10:00:00Z'),
    calls = 0;
  const mailer = createMailer(db, {
    env,
    getOrganization: () => org,
    now: () => new Date(time),
    fetch: (async () => {
      calls++;
      return Response.json({}, { status: 503 });
    }) as typeof fetch,
  });
  const attempted = mailer.enqueueInvoice(independentDocument(), { eventKey: 'immutable-merchant' });
  assert.throws(
    () => mailer.enqueueInvoice(sample({ id: 'shri-document' }), { eventKey: 'immutable-merchant' }),
    /already in use/,
  );
  await mailer.processQueue();
  assert.equal(calls, 1);
  env.SHRI_SARRAF_RESEND_API_KEY = 'different-merchant-key';
  time += 60_000;
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(attempted.id)?.status, 'held');
  assert.equal(mailer.get(attempted.id)?.canRetry, false);
  assert.throws(() => mailer.retry(attempted.id), /different business email credentials/);
  env.SHRI_SARRAF_RESEND_API_KEY = 'original-shri-key';
  assert.equal(mailer.get(attempted.id)?.canRetry, true);
  const pending = mailer.enqueueInvoice(independentDocument(), { eventKey: 'org-removed' });
  org = undefined;
  await mailer.processQueue();
  assert.equal(calls, 1);
  assert.equal(mailer.get(pending.id)?.status, 'held');
  assert.equal(mailer.status('shri-sarraf').configured, false);
  assert.equal(mailer.get(pending.id)?.canRetry, false);
});

test('workspace reset email retains global sender and support while business mail uses isolated settings', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const doc = independentDocument();
  const env = {
    ...enabled(),
    SHRI_SARRAF_RESEND_API_KEY: 'shri-secret',
    SHRI_SARRAF_EMAIL_FROM: 'Shri <invoices@shri.example>',
  };
  const requests: { body: any; key: string }[] = [];
  const mailer = createMailer(db, {
    env,
    getOrganization: () => doc.organizationSnapshot,
    fetch: (async (_url, options) => {
      requests.push({
        body: JSON.parse(String(options?.body)),
        key: (options?.headers as Record<string, string>).Authorization,
      });
      return Response.json({ id: 'delivered' });
    }) as typeof fetch,
  });
  mailer.enqueueInvoice(doc, { eventKey: 'independent-invoice' });
  mailer.enqueuePasswordReset({
    to: 'admin@example.test',
    name: 'Admin',
    resetUrl: 'https://workspace.example/reset?token=secret',
    eventKey: 'workspace-reset',
  });
  await mailer.processQueue();
  assert.equal(requests[0].key, 'Bearer shri-secret');
  assert.equal(requests[1].key, 'Bearer secret-test-key');
  assert.equal(requests[1].body.from, enabled().EMAIL_FROM);
  assert.equal(requests[1].body.reply_to, 'support@pirento.com');
  assert.match(requests[1].body.text, /support@pirento.com/);
});

test('Cashfree links render with its name and reject lookalikes or the wrong business gateway', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const shri = independentDocument();
  shri.organizationSnapshot.tradeName = 'SYNTHETIC JEWELLERS';
  shri.organizationSnapshot.legalName = 'SYNTHETIC PROPRIETOR';
  const bodies: any[] = [];
  const mailer = createMailer(db, {
    env: { SHRI_SARRAF_RESEND_API_KEY: 'isolated', SHRI_SARRAF_EMAIL_FROM: 'invoices@shri.example' },
    fetch: (async (_url, options) => {
      bodies.push(JSON.parse(String(options?.body)));
      return Response.json({ id: 'cashfree-mail' });
    }) as typeof fetch,
  });
  for (const url of [
    'https://payments.cashfree.com.evil.test/links/a',
    'https://unexpected.cashfree.com/links/a',
    'https://payments.cashfree.com:99/links/a',
    'http://payments.cashfree.com/links/a',
    'https://user@payments.cashfree.com/links/a',
  ])
    assert.equal(validPaymentEmailUrl(url), false);
  assert.equal(validPaymentEmailUrl('https://payments.cashfree.com/links/example'), true);
  assert.equal(validPaymentEmailUrl('https://sandbox.cashfree.com/links/example'), true);
  assert.throws(
    () =>
      mailer.enqueueInvoice(sample(), {
        eventKey: 'bad-merchant',
        paymentUrl: 'https://payments.cashfree.com/links/example',
      }),
    /issuing business payment gateway/,
  );
  assert.throws(
    () => mailer.enqueueInvoice(shri, { eventKey: 'wrong-merchant', paymentUrl: 'https://rzp.io/i/example' }),
    /issuing business payment gateway/,
  );
  const record = mailer.enqueueInvoice(shri, {
    eventKey: 'cashfree-invoice',
    paymentUrl: 'https://payments.cashfree.com/links/example',
  });
  await mailer.processQueue();
  assert.equal(mailer.get(record.id)?.status, 'sent');
  assert.match(bodies[0].html, /Pay securely with Cashfree/);
  assert.doesNotMatch(bodies[0].html, /Pay securely with Razorpay/);
  assert.match(bodies[0].html, /SYNTHETIC JEWELLERS · Legal name: SYNTHETIC PROPRIETOR/);
  assert.match(bodies[0].text, /Issued by SYNTHETIC JEWELLERS · Legal name: SYNTHETIC PROPRIETOR/);
});

test('legacy attempted messages without a credential identity are held for provider review', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let calls = 0;
  const mailer = createMailer(db, {
    env: enabled(),
    fetch: (async () => {
      calls++;
      return Response.json({ id: 'unexpected' });
    }) as typeof fetch,
  });
  const record = mailer.enqueueInvoice(sample(), { eventKey: 'legacy-attempt' });
  db.prepare(
    "UPDATE email_outbox SET payload=json_set(payload,'$.sender',?), first_attempt_at=? WHERE id=?",
  ).run('Previous sender <old@example.test>', new Date().toISOString(), record.id);
  await mailer.processQueue();
  assert.equal(calls, 0);
  assert.equal(mailer.get(record.id)?.status, 'held');
  assert.equal(mailer.get(record.id)?.canRetry, false);
  assert.throws(() => mailer.retry(record.id), /no saved sender credential profile/);
});
