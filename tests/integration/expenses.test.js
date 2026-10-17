/** Integration tests: the expenses API, its page, monthly totals, CSV and record ownership. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test(
  'expenses are saved with their GST split, listed by month, edited, exported and deleted',
  options,
  async (t) => {
    const { base, backend } = await createFixture(t, { auth: false });
    attachPageRoutes(backend);
    const organizationId = 'pipeline2-legal';
    const organization = await backend.db.models.organizations.findById(organizationId);
    await backend.db.models.organizations.save({ ...organization, stateCode: '09' });
    const call = async (path, method = 'GET', body, status = 200) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, JSON.stringify(data));
      return data;
    };
    const vendor = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Paper Mart',
        roles: ['vendor'],
        email: '',
        phone: '',
        gstin: '27AAACR5055K1Z7',
        address: 'Mumbai',
        stateCode: '27',
        contactPerson: '',
      },
      201,
    );
    const bill = {
      organizationId,
      vendorId: vendor.id,
      vendorName: 'Typed name is replaced',
      billNumber: 'PM-17',
      billDate: '2026-09-12',
      category: 'Office supplies',
      taxable: 1000,
      gstRate: 18,
      interstate: true,
    };
    const created = await call('/expenses', 'POST', bill, 201);
    assert.equal(created.vendorName, 'Paper Mart', 'a chosen contact supplies the vendor name and GSTIN');
    assert.equal(created.vendorGstin, '27AAACR5055K1Z7');
    assert.deepEqual([created.igst, created.tax, created.total], [180, 180, 1180]);
    await call(
      '/expenses',
      'POST',
      { ...bill, vendorId: '', vendorName: 'Tea stall', billDate: '2026-10-01', taxable: 50, gstRate: 0 },
      201,
    );

    const september = await call(`/expenses?organizationId=${organizationId}&month=2026-09`);
    assert.deepEqual(
      september.expenses.map((row) => row.id),
      [created.id],
      'October bills stay out of September',
    );
    assert.deepEqual(september.totals, { count: 1, taxable: 1000, tax: 180, total: 1180 });

    const edited = await call(`/expenses/${created.id}`, 'PUT', {
      ...bill,
      taxable: 2000,
      interstate: false,
    });
    assert.deepEqual([edited.cgst, edited.sgst, edited.igst, edited.total], [180, 180, 0, 2360]);
    assert.equal(edited.createdAt, created.createdAt);
    await call(`/expenses/${created.id}`, 'PUT', { ...bill, organizationId: 'other-business' }, 400);
    assert.deepEqual(await backend.db.models.ownership.resource('expenses', created.id), {
      organization_id: organizationId,
    });

    await backend.db.collection('customers').insertOne({
      id: 'foreign-vendor',
      organizationId: 'other-business',
      name: 'Other business vendor',
      roles: ['vendor'],
    });
    const foreign = await call('/expenses', 'POST', { ...bill, vendorId: 'foreign-vendor' }, 400);
    assert.match(foreign.error, /vendor from this business/);
    await call('/expenses', 'POST', { ...bill, gstRate: 7 }, 400);

    const page = await fetch(`${base}/workspace/${organizationId}/expenses/edit/${created.id}?month=2026-09`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Edit expense/);
    assert.match(
      html,
      /<option value="[^"]+" data-gstin="27AAACR5055K1Z7" data-state="27" selected>Paper Mart/,
    );
    assert.equal((await fetch(`${base}/workspace/${organizationId}/expenses/edit/missing`)).status, 404);
    const csv = await fetch(`${base}/workspace/${organizationId}/expenses?month=2026-09&download=csv`);
    assert.equal(csv.status, 200);
    const rows = (await csv.text()).trim().split('\r\n');
    assert.equal(rows.length, 2);
    assert.match(
      rows[1],
      /^"2026-09-12","PM-17","Paper Mart","27AAACR5055K1Z7","Office supplies",.*"2360\.00",""$/,
    );

    await call(`/expenses/${created.id}`, 'DELETE');
    await call(`/expenses/${created.id}`, 'DELETE', undefined, 404);
    assert.equal((await call(`/expenses?organizationId=${organizationId}&month=2026-09`)).totals.count, 0);
  },
);
