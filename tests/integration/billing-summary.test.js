/** Integration tests: the editor's contact summary (GET /api/customers/:id/billing-summary). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('the billing summary gives what a contact owes and their latest document lines', options, async (t) => {
  const { base } = await createFixture(t, { auth: false, now: () => new Date('2026-10-31T06:00:00Z') });
  const organizationId = 'pipeline2-legal';
  const call = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const customer = await call(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Summary Buyer',
      email: '',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
      creditLimit: 500,
    },
    201,
  );
  const document = (kind, status, issueDate, description, rate) =>
    call(
      '/documents',
      'POST',
      {
        organizationId,
        customerId: customer.id,
        kind,
        status,
        issueDate,
        dueDate: issueDate,
        title: kind,
        items: [{ description, hsn: '', quantity: 1, rate, gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
      },
      201,
    );
  await document('invoice', 'sent', '2026-10-01', 'Old service', 100);
  await document('invoice', 'sent', '2026-10-31', 'Latest service', 40);
  await document('invoice', 'draft', '2026-10-30', 'Draft only', 999);
  await document('quotation', 'sent', '2026-10-20', 'Quoted work', 70);

  const summary = await call(`/customers/${customer.id}/billing-summary?kind=invoice`);
  assert.deepEqual(
    [summary.outstanding, summary.openInvoices, summary.overdueInvoices, summary.creditLimit],
    [140, 2, 1, 500],
    'drafts are not owed; the October 1 invoice is overdue',
  );
  assert.equal(summary.lastDocument.items[0].description, 'Latest service');
  assert.equal(
    (await call(`/customers/${customer.id}/billing-summary?kind=quotation`)).lastDocument.items[0]
      .description,
    'Quoted work',
  );
  await call(`/customers/${customer.id}/billing-summary?kind=receipt`, 'GET', undefined, 400);
  await call('/customers/missing/billing-summary', 'GET', undefined, 404);
});
