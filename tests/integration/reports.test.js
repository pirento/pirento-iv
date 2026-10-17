/** Integration tests: the Reports page adds up the year's invoices, receipts (old ones too) and expenses. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('Reports page shows the financial year by month, ageing and top customers', options, async (t) => {
  const { base, backend } = await createFixture(t, {
    auth: false,
    now: () => new Date('2026-10-17T06:00:00Z'),
  });
  attachPageRoutes(backend);
  const organizationId = 'pipeline2-legal';
  const organization = await backend.db.models.organizations.findById(organizationId);
  await backend.db.models.organizations.save({ ...organization, gstin: '09AAACA1234A1Z5', stateCode: '09' });
  const call = async (path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const buyer = await call('/customers', {
    organizationId,
    name: 'Report Buyer',
    email: '',
    phone: '',
    gstin: '',
    address: 'Lucknow',
    stateCode: '09',
    contactPerson: '',
  });
  const invoice = (status, issueDate, rate) =>
    call('/documents', {
      organizationId,
      customerId: buyer.id,
      kind: 'invoice',
      status,
      issueDate,
      dueDate: issueDate,
      title: 'Report invoice',
      items: [{ description: 'Service', hsn: '998719', quantity: 1, rate, gstRate: 18 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    });
  const april = await invoice('sent', '2026-04-10', 1000);
  await invoice('draft', '2026-04-11', 5000);
  await invoice('sent', '2026-03-31', 7000);
  await call(`/documents/${april.id}/payments`, {
    amount: 500,
    paidOn: '2026-05-02',
    method: 'upi',
    reference: '',
    notes: '',
    requestId: 'report-receipt',
  });
  // A receipt saved before receipts carried organizationId still counts through its invoice.
  await backend.db.collection('payments').insertOne({
    id: 'old-receipt',
    documentId: april.id,
    amount: 100,
    paidOn: '2026-05-03',
    method: 'cash',
  });
  await call('/expenses', {
    organizationId,
    vendorName: 'Landlord',
    billDate: '2026-05-01',
    category: 'Rent',
    taxable: 300,
    gstRate: 0,
  });

  const page = await fetch(`${base}/workspace/${organizationId}/reports?year=2026`);
  assert.equal(page.status, 200);
  const html = (await page.text()).replace(/\s+/g, ' ');
  assert.match(html, /FY 2026-27/);
  assert.match(
    html,
    /<td>Apr 2026<\/td> <td class="text-right">₹1,000\.00<\/td> <td class="text-right">₹1,180\.00<\/td>/,
  );
  assert.match(
    html,
    /<td>May 2026<\/td> <td class="text-right">₹0\.00<\/td> <td class="text-right">₹0\.00<\/td> <td class="text-right">₹600\.00<\/td> <td class="text-right">₹300\.00<\/td> <td class="text-right"><strong>-₹300\.00</,
  );
  assert.match(
    html,
    /<td>Report Buyer<\/td><td class="text-right">1<\/td>/,
    'the draft and the March 2026 invoice are left out',
  );
  assert.match(html, /<td>Over 90 days<\/td><td class="text-right">2<\/td>/);
});
