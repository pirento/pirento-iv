/** Integration tests: the GST returns page and its CSV downloads use issued invoices of the chosen month. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('GST returns page lists issued invoices and downloads each table', options, async (t) => {
  const { base, backend } = await createFixture(t, { auth: false });
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
    name: 'GST Buyer',
    email: '',
    phone: '',
    gstin: '27AAACR5055K1Z7',
    address: 'Mumbai',
    stateCode: '27',
    contactPerson: '',
  });
  const invoice = (status, issueDate) =>
    call('/documents', {
      organizationId,
      customerId: buyer.id,
      kind: 'invoice',
      status,
      issueDate,
      dueDate: issueDate,
      title: 'GST invoice',
      items: [{ description: 'Service', hsn: '998719', quantity: 1, rate: 1000, gstRate: 18 }],
      discountPercent: 0,
      placeOfSupply: '27',
      notes: '',
      terms: '',
    });
  await invoice('sent', '2026-09-10');
  await invoice('draft', '2026-09-11');
  await invoice('sent', '2026-10-01');

  const page = await fetch(`${base}/workspace/${organizationId}/gst_returns?month=2026-09`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /GST returns \(GSTR-1\)/);
  const csv = await fetch(
    `${base}/workspace/${organizationId}/gst_returns?month=2026-09&download=csv&section=b2b`,
  );
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /GSTR1-09AAACA1234A1Z5-2026-09-b2b\.csv/);
  const rows = (await csv.text()).trim().split('\r\n');
  assert.equal(
    rows.length,
    2,
    'one issued September invoice; the draft and the October invoice are left out',
  );
  assert.match(rows[1], /"27AAACR5055K1Z7","GST Buyer",".+","10-Sep-2026","1180.00","27-Maharashtra"/);
  const docs = await fetch(
    `${base}/workspace/${organizationId}/gst_returns?month=2026-09&download=csv&section=docs`,
  );
  const docsRows = (await docs.text()).trim().split('\r\n');
  assert.equal(docsRows.length, 2);
  assert.match(
    docsRows[1],
    /^"Invoices for outward supply","(.+)","\1","1","0"$/,
    'the draft is not a document issued',
  );
  const missing = await fetch(`${base}/workspace/${organizationId}/gst_returns?download=csv&section=unknown`);
  assert.equal(missing.status, 404);
});
