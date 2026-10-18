/** Integration tests: a debit note is a new receivable document against an invoice and appears in GSTR-1 as type D. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('a debit note gets its own number, takes payments and is reported as type D', options, async (t) => {
  const { base, backend } = await createFixture(t, {
    auth: false,
    now: () => new Date('2026-10-17T06:00:00Z'),
  });
  attachPageRoutes(backend);
  const organizationId = 'pipeline2-legal';
  const organization = await backend.db.models.organizations.findById(organizationId);
  await backend.db.models.organizations.save({ ...organization, gstin: '09AAACA1234A1Z5', stateCode: '09' });
  const call = async (path, method, body, status = 200) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const buyer = await call(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Debit Buyer',
      email: '',
      phone: '',
      gstin: '27AAACR5055K1Z7',
      address: 'Mumbai',
      stateCode: '27',
      contactPerson: '',
    },
    201,
  );
  const invoice = await call(
    '/documents',
    'POST',
    {
      organizationId,
      customerId: buyer.id,
      kind: 'invoice',
      status: 'sent',
      issueDate: '2026-10-05',
      dueDate: '2026-10-05',
      title: 'Invoice',
      items: [{ description: 'Service', hsn: '998719', quantity: 1, rate: 1000, gstRate: 18 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    },
    201,
  );
  const input = {
    noteDate: '2026-10-12',
    dueDate: '2026-10-31',
    reason: 'Short billing',
    taxable: 100,
    gstRate: 18,
    notes: 'Freight missed',
    requestId: 'b6f1c9a4-2f1e-4b8e-9b2a-3d6c1e7f0a11',
  };
  const path = `/documents/${invoice.id}/debit-notes`;
  const note = await call(path, 'POST', input, 201);
  assert.match(note.number, /\/2627\/DN0001$/);
  assert.deepEqual(
    [note.kind, note.status, note.title, note.totals.total, note.balanceDue, note.dueDate],
    ['invoice', 'sent', 'Debit note', 118, 118, '2026-10-31'],
  );
  assert.match(note.notes, /against invoice .*Short billing.*Freight missed/);
  assert.equal(
    (await call(path, 'POST', input)).id,
    note.id,
    'a retried request returns the same debit note',
  );
  assert.match(
    (
      await call(
        `/documents/${note.id}/debit-notes`,
        'POST',
        { ...input, requestId: crypto.randomUUID() },
        409,
      )
    ).error,
    /only against issued invoices/,
  );
  assert.match(
    (await call(path, 'POST', { ...input, requestId: crypto.randomUUID(), gstRate: 5 }, 400)).error,
    /GST rate used on this invoice/,
  );

  const paid = await call(
    `/documents/${note.id}/payments`,
    'POST',
    { amount: 118, paidOn: '2026-10-13', method: 'upi', reference: '', notes: '', requestId: 'debit-paid' },
    201,
  );
  assert.equal(paid.document.status, 'paid');
  const preview = await fetch(`${base}/workspace/${organizationId}/invoices/preview/${note.id}`);
  assert.match(await preview.text(), /<h1>DEBIT NOTE<\/h1>/);

  const csv = async (section) =>
    (
      await (
        await fetch(
          `${base}/workspace/${organizationId}/gst_returns?month=2026-10&download=csv&section=${section}`,
        )
      ).text()
    )
      .trim()
      .split('\r\n');
  assert.equal((await csv('b2b')).length, 2, 'only the original invoice is B2B');
  const cdnr = await csv('cdnr');
  assert.match(
    cdnr[1],
    /^"27AAACR5055K1Z7","Debit Buyer",".+\/DN0001","12-Oct-2026","D",.*"118\.00","","18","100\.00"/,
  );
  assert.match((await csv('docs')).join('\n'), /"Debit Note","(.+)","\1","1","0"/);
});
