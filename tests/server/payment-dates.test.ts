import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import type { BusinessDocument, Customer, PaymentDetails, PaymentInput } from '../../shared/types.ts';

async function fixture(t: TestContext, timestamp: string) {
  const db = initDb(':memory:');
  const app = createApp({
    auth: false,
    db,
    now: () => new Date(timestamp),
    environment: {
      RESEND_API_KEY: 'synthetic-payment-date-test',
      EMAIL_FROM: 'Invoice tests <invoices@example.test>',
      EMAIL_AUTOMATION: 'true',
    },
    emailFetch: (async () => {
      throw new Error('Receipt tests must never send real email.');
    }) as typeof fetch,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function request<T>(path: string, method = 'GET', body?: unknown, expectedStatus = 200) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  const customer = await request<Customer>(
    '/customers',
    'POST',
    {
      organizationId: 'at-facilities',
      name: 'Synthetic receipt date customer',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Synthetic address',
      stateCode: '27',
      contactPerson: '',
    },
    201,
  );
  const invoice = await request<BusinessDocument>(
    '/documents',
    'POST',
    {
      organizationId: customer.organizationId,
      customerId: customer.id,
      kind: 'invoice',
      status: 'draft',
      issueDate: '2026-10-01',
      dueDate: '2026-10-20',
      title: 'Receipt date test',
      items: [{ description: 'Synthetic service', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '27',
      notes: '',
      terms: '',
    },
    201,
  );
  const path = `/documents/${invoice.id}/payments`;
  function snapshot() {
    return Object.fromEntries(
      ['documents', 'payments', 'document_events', 'email_outbox'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  }
  return { request, invoice, path, snapshot };
}

const receipt = (paidOn: string, overrides: Partial<PaymentInput> = {}): PaymentInput => ({
  amount: 100,
  paidOn,
  method: 'bank_transfer',
  reference: 'synthetic-date-receipt',
  notes: '',
  requestId: 'manual-date-test',
  ...overrides,
});

for (const paidOn of ['2026-10-07', '2026-10-08']) {
  test(`manual receipt accepts ${paidOn} when the India business date is 2026-10-08`, async (t) => {
    const { request, invoice, path } = await fixture(t, '2026-10-08T12:00:00.000Z');
    const input = receipt(paidOn);
    const result = await request<PaymentDetails>(path, 'POST', input, 201);
    assert.equal(result.payments[0].paidOn, paidOn);
    assert.equal(result.document.amountPaid, 100);
    assert.equal(result.document.balanceDue, 0);
    assert.equal(result.document.status, 'paid');
    assert.ok(result.document.finalizedAt);
    assert.deepEqual(await request<PaymentDetails>(path, 'POST', input), result);
    await request(`/documents/${invoice.id}`, 'PUT', { ...invoice, notes: 'Change finalized invoice' }, 409);
  });
}

for (const { timestamp, paidOn } of [
  { timestamp: '2026-10-08T18:29:59.999Z', paidOn: '2026-10-09' },
  { timestamp: '2026-10-08T18:30:00.000Z', paidOn: '2026-10-10' },
]) {
  test(`manual receipt rejects ${paidOn} at ${timestamp} without database changes`, async (t) => {
    const { request, path, snapshot } = await fixture(t, timestamp);
    const before = snapshot();
    const error = await request<{ error: string }>(path, 'POST', receipt(paidOn), 400);
    assert.match(error.error, /payment date cannot be in the future/i);
    assert.deepEqual(snapshot(), before);
  });
}

test('manual receipt accepts the new India business date at midnight even while UTC is the previous day', async (t) => {
  const { request, path } = await fixture(t, '2026-10-08T18:30:00.000Z');
  const result = await request<PaymentDetails>(path, 'POST', receipt('2026-10-09'), 201);
  assert.equal(result.payments[0].paidOn, '2026-10-09');
  assert.equal(result.document.status, 'paid');
  assert.equal(result.document.balanceDue, 0);
});

test('a 2199 receipt cannot finalize a partially paid invoice, enqueue email or consume its request ID', async (t) => {
  const { request, path, snapshot } = await fixture(t, '2026-10-08T12:00:00.000Z');
  const partial = await request<PaymentDetails>(
    path,
    'POST',
    receipt('2026-10-08', { amount: 70, requestId: 'partial-payment' }),
    201,
  );
  assert.equal(partial.document.status, 'partially_paid');
  assert.equal(partial.document.balanceDue, 30);
  assert.equal(snapshot().email_outbox.length, 1);
  const before = snapshot();
  const finalInput = receipt('2199-01-01', { amount: 30, requestId: 'final-payment' });
  await request(path, 'POST', finalInput, 400);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(await request<PaymentDetails>(path), partial);

  const correctedInput = { ...finalInput, paidOn: '2026-10-08' };
  const final = await request<PaymentDetails>(path, 'POST', correctedInput, 201);
  assert.equal(final.document.amountPaid, 100);
  assert.equal(final.document.balanceDue, 0);
  assert.equal(final.document.status, 'paid');
  assert.ok(final.document.finalizedAt);
  assert.equal(final.payments.length, 2);
  assert.equal(final.events.filter((event) => event.type === 'invoice_finalized').length, 1);
  assert.equal(snapshot().email_outbox.length, 2);
  assert.deepEqual(await request<PaymentDetails>(path, 'POST', correctedInput), final);
});
