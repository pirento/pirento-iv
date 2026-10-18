/** Integration tests: stock in hand is stock added minus the quantity on issued, not cancelled, invoices. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('stock entries and issued invoices give stock in hand; cancelling gives it back', options, async (t) => {
  const { base, backend } = await createFixture(t, { auth: false });
  attachPageRoutes(backend);
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
  const catalogItem = (name, type) =>
    call(
      '/catalog',
      'POST',
      {
        organizationId,
        name,
        sku: '',
        description: '',
        type,
        unit: 'Nos',
        hsn: '',
        rate: 10,
        gstRate: 0,
        active: true,
      },
      201,
    );
  const product = await catalogItem('Stocked chair', 'product');
  const service = await catalogItem('Repair visit', 'service');
  const buyer = await call(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Stock Buyer',
      email: '',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    },
    201,
  );
  const entry = (quantity, catalogItemId = product.id, status = 201) =>
    call(
      '/stock-adjustments',
      'POST',
      { organizationId, catalogItemId, date: '2026-10-01', quantity, note: '' },
      status,
    );
  const opening = await entry(10);
  await entry(-0.5);
  assert.match((await entry(3, service.id, 400)).error, /product from this business/);
  assert.match((await entry(0, product.id, 400)).error, /other than 0/);
  const invoice = (status, quantity) =>
    call(
      '/documents',
      'POST',
      {
        organizationId,
        customerId: buyer.id,
        kind: 'invoice',
        status,
        issueDate: '2026-10-05',
        dueDate: '2026-10-05',
        title: 'Invoice',
        items: [{ description: 'Chair', catalogItemId: product.id, hsn: '', quantity, rate: 10, gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
      },
      201,
    );
  const sold = await invoice('sent', 3);
  await invoice('draft', 100);

  // [added, sold, in stock] for the product, as the Stock page shows them.
  const levels = async () => {
    const html = (await (await fetch(`${base}/workspace/${organizationId}/stock`)).text()).replace(
      /\s+/g,
      ' ',
    );
    const cells =
      /<strong>Stocked chair<\/strong><\/td> <td class="text-right">([^<]+)<\/td> <td class="text-right">([^<]+)<\/td> <td class="text-right"><strong>([^<]+?) Nos/;
    return cells.exec(html)?.slice(1);
  };
  assert.deepEqual(await levels(), ['9.5', '3', '6.5'], 'the draft does not take stock');
  await call(`/documents/${sold.id}`, 'PUT', {
    organizationId,
    customerId: buyer.id,
    kind: 'invoice',
    status: 'cancelled',
    issueDate: '2026-10-05',
    dueDate: '2026-10-05',
    title: 'Invoice',
    items: sold.items,
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    version: sold.version,
  });
  assert.deepEqual(await levels(), ['9.5', '0', '9.5'], 'a cancelled invoice gives the stock back');
  await call(`/stock-adjustments/${opening.id}`, 'DELETE');
  await call(`/stock-adjustments/${opening.id}`, 'DELETE', undefined, 404);
  assert.deepEqual(await levels(), ['-0.5', '0', '-0.5']);
  assert.deepEqual(await backend.db.models.ownership.resource('stock_adjustments', opening.id), undefined);
});
