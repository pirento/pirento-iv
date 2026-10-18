/** Integration tests: credit notes lower an invoice's balance, appear in GSTR-1 and the ledger, and can be cancelled. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('a credit note reduces the invoice balance, is retry-safe and cancels cleanly', options, async (t) => {
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
      name: 'Credit Buyer',
      email: '',
      phone: '',
      gstin: '27AAACR5055K1Z7',
      address: 'Lucknow branch of a Mumbai firm',
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
      title: 'Credit invoice',
      items: [{ description: 'Service', hsn: '998719', quantity: 1, rate: 1000, gstRate: 18 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    },
    201,
  );
  const credit = {
    noteDate: '2026-10-10',
    reason: 'Discount after sale',
    taxable: 100,
    gstRate: 18,
    notes: '',
    requestId: '0b8c3a3e-2c62-4d3e-9a39-6f5b4b8f1c11',
  };
  const path = `/documents/${invoice.id}/credit-notes`;
  const note = await call(path, 'POST', credit, 201);
  assert.match(note.number, /\/2627\/C0001$/);
  assert.deepEqual([note.cgst, note.sgst, note.igst, note.total], [9, 9, 0, 118]);
  assert.deepEqual(await call(path, 'POST', credit), note, 'a retried request returns the same credit note');
  let details = await call(`/documents/${invoice.id}/payments`, 'GET');
  assert.deepEqual([details.document.balanceDue, details.document.status], [1062, 'partially_paid']);

  const retry = (changes, status) =>
    call(path, 'POST', { ...credit, requestId: crypto.randomUUID(), ...changes }, status);
  assert.match((await retry({ taxable: 901 }, 409)).error, /more than its total/);
  assert.match((await retry({ gstRate: 5 }, 400)).error, /GST rate used on this invoice/);
  assert.match((await retry({ noteDate: '2026-10-01' }, 400)).error, /between the invoice date and today/);
  const receipt = details.payments.find((row) => row.creditNoteId === note.id);
  assert.match(
    (await call(`/payments/${receipt.id}/void`, 'POST', { reason: 'wrong' }, 409)).error,
    /Cancel the credit note/,
  );
  await call(
    `/documents/${invoice.id}/payments`,
    'POST',
    { amount: 1, paidOn: '2026-10-10', method: 'cash', reference: '', notes: '', requestId: 'credit-note:x' },
    400,
  );
  assert.deepEqual(await backend.db.models.ownership.resource('credit_notes', note.id), {
    organization_id: organizationId,
  });

  const statement = await call(`/ledger/${buyer.id}?organizationId=${organizationId}`, 'GET');
  assert.ok(JSON.stringify(statement).includes('"description":"Credit note"'));
  const listPage = await fetch(
    `${base}/workspace/${organizationId}/credit_notes?month=2026-10&documentId=${invoice.id}`,
  );
  const listHtml = await listPage.text();
  assert.equal(listPage.status, 200);
  assert.match(listHtml, /Credit note against/);
  assert.ok(listHtml.includes(note.number));
  const printPage = await fetch(`${base}/workspace/${organizationId}/credit_notes/preview/${note.id}`);
  assert.match(await printPage.text(), /Rupees One Hundred Eighteen Only/);
  const cdnr = await fetch(
    `${base}/workspace/${organizationId}/gst_returns?month=2026-10&download=csv&section=cdnr`,
  );
  const rows = (await cdnr.text()).trim().split('\r\n');
  assert.equal(rows.length, 2);
  assert.match(
    rows[1],
    /^"27AAACR5055K1Z7","Credit Buyer",".+\/C0001","10-Oct-2026","C",.*"118\.00","","18","100\.00"/,
  );

  const cancelled = await call(`/credit-notes/${note.id}/cancel`, 'POST', { reason: 'Issued by mistake' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    (await call(`/credit-notes/${note.id}/cancel`, 'POST', { reason: 'again' })).status,
    'cancelled',
  );
  details = await call(`/documents/${invoice.id}/payments`, 'GET');
  assert.deepEqual([details.document.balanceDue, details.document.status], [1180, 'sent']);
  const docs = await fetch(
    `${base}/workspace/${organizationId}/gst_returns?month=2026-10&download=csv&section=docs`,
  );
  assert.match(await docs.text(), /"Credit Note","(.+)","\1","1","1"/);
});

test(
  'a credit note on a paid invoice becomes a refund; credits stay out of money received',
  options,
  async (t) => {
    const { base, backend } = await createFixture(t, {
      auth: false,
      now: () => new Date('2026-10-17T06:00:00Z'),
    });
    attachPageRoutes(backend);
    const organizationId = 'pipeline2-legal';
    const organization = await backend.db.models.organizations.findById(organizationId);
    await backend.db.models.organizations.save({
      ...organization,
      gstin: '09AAACA1234A1Z5',
      stateCode: '09',
    });
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
        name: 'Walk-in',
        email: '',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    const invoice = () =>
      call(
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
    const credit = (invoiceId, taxable, status = 201) =>
      call(
        `/documents/${invoiceId}/credit-notes`,
        'POST',
        {
          noteDate: '2026-10-10',
          reason: 'Sales return',
          taxable,
          gstRate: 18,
          notes: '',
          requestId: crypto.randomUUID(),
        },
        status,
      );
    const unpaid = await invoice();
    await credit(unpaid.id, 100);
    const paid = await invoice();
    await call(
      `/documents/${paid.id}/payments`,
      'POST',
      {
        amount: 1180,
        paidOn: '2026-10-06',
        method: 'upi',
        reference: '',
        notes: '',
        requestId: 'paid-in-full',
      },
      201,
    );
    const note = await credit(paid.id, 100);
    assert.deepEqual([note.appliedAmount, note.refundDue, note.refund], [0, 118, null]);
    assert.deepEqual(note.hsnLines, [
      { hsn: '998719', description: 'Service', unit: '', taxable: 100, tax: 18 },
    ]);
    const details = await call(`/documents/${paid.id}/payments`, 'GET');
    assert.deepEqual([details.document.balanceDue, details.document.status], [0, 'paid']);
    assert.equal(details.payments.length, 1, 'no credit-note receipt when nothing is left to pay');
    assert.match((await credit(paid.id, 901, 409)).error, /more than its total/);

    const refund = { paidOn: '2026-10-12', method: 'upi', reference: 'UTR-1' };
    assert.equal(
      (
        await call(`/credit-notes/${note.id}/refund`, 'POST', { ...refund, paidOn: '2026-10-09' }, 400)
      ).error.includes('refund date'),
      true,
    );
    const refunded = await call(`/credit-notes/${note.id}/refund`, 'POST', refund);
    assert.equal(refunded.refund.reference, 'UTR-1');
    assert.deepEqual((await call(`/credit-notes/${note.id}/refund`, 'POST', refund)).refund, refunded.refund);
    assert.match(
      (await call(`/credit-notes/${note.id}/cancel`, 'POST', { reason: 'x' }, 409)).error,
      /refund is recorded/,
    );

    const overview = (await (await fetch(`${base}/workspace/${organizationId}/overview`)).text()).replace(
      /\s+/g,
      ' ',
    );
    assert.match(
      overview,
      /Payments received .*?<div class="metric-value">₹1,180\.00<\/div>/,
      'the credit on the unpaid invoice is not money received',
    );
    const reports = (
      await (await fetch(`${base}/workspace/${organizationId}/reports?year=2026`)).text()
    ).replace(/\s+/g, ' ');
    assert.match(
      reports,
      /<td>Oct 2026<\/td> <td class="text-right">₹1,800\.00<\/td> <td class="text-right">₹2,124\.00<\/td> <td class="text-right">₹1,062\.00<\/td>/,
    );
    const hsn = await fetch(
      `${base}/workspace/${organizationId}/gst_returns?month=2026-10&download=csv&section=hsn-b2c`,
    );
    assert.match(
      await hsn.text(),
      /"998719","Service","NA","2","2124\.00","18","1800\.00","0\.00","162\.00","162\.00"/,
    );
  },
);
