/** Integration tests: e-invoice and e-way bill files download for an issued invoice, and the saved IRN / e-way bill print. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { renderInvoiceAttachment } from '../../src/services/documents/invoice-pdf.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

test('e-invoice and e-way bill files, saved IRN and e-way bill on the invoice', options, async (t) => {
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
    address: '12 Hazratganj, Lucknow 226001',
  });
  const call = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return { data, headers: response.headers };
  };
  const buyer = (
    await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Buyer Ltd',
        email: '',
        phone: '',
        gstin: '27AAACR5055K1Z7',
        address: 'Andheri East, Mumbai 400069',
        stateCode: '27',
        contactPerson: '',
      },
      201,
    )
  ).data;
  const invoice = async (status, hsn = '9401') =>
    (
      await call(
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
          items: [{ description: 'Steel chair', hsn, unit: 'Nos', quantity: 2, rate: 1000, gstRate: 18 }],
          discountPercent: 0,
          placeOfSupply: '27',
          notes: '',
          terms: '',
        },
        201,
      )
    ).data;
  const issued = await invoice('sent');
  const file = await call(`/documents/${issued.id}/einvoice-file`);
  assert.match(
    file.headers.get('content-disposition'),
    /attachment; filename="?P2LI-2627-0001-einvoice\.json"?/,
  );
  assert.deepEqual(
    [file.data.Version, file.data.ValDtls.TotInvVal, file.data.BuyerDtls.Pin],
    ['1.1', 2360, 400069],
  );
  const draft = await invoice('draft', '');
  assert.match(
    (await call(`/documents/${draft.id}/einvoice-file`, 'GET', undefined, 409)).data.error,
    /issued invoice.*HSN/,
  );
  const eway = await call(
    `/documents/${issued.id}/eway-bill-file?mode=road&distanceKm=1400&vehicleNo=up32 ab 1234`,
  );
  assert.deepEqual(
    [eway.data.billLists[0].vehicleNo, eway.data.billLists[0].transDistance],
    ['UP32AB1234', '1400'],
  );
  await call(`/documents/${issued.id}/eway-bill-file?distanceKm=9000`, 'GET', undefined, 400);

  const irn = 'a'.repeat(64);
  const signedQr = 'eyJhbGciOiJSUzI1NiJ9.signed-qr-payload-for-test.signature';
  await call(
    `/documents/${issued.id}/einvoice`,
    'PUT',
    { irn: 'short', ackNo: '1', ackDate: 'x', signedQr },
    400,
  );
  const saved = (
    await call(`/documents/${issued.id}/einvoice`, 'PUT', {
      irn,
      ackNo: '112610012345678',
      ackDate: '17/10/2026 11:32:00',
      signedQr,
    })
  ).data;
  assert.equal(saved.einvoice.irn, irn);
  const withBill = (
    await call(`/documents/${issued.id}/eway-bill`, 'PUT', {
      number: '331001234567',
      date: '17/10/2026 11:40',
    })
  ).data;
  assert.deepEqual([withBill.einvoice.irn, withBill.ewayBill.number], [irn, '331001234567']);
  await call(
    `/documents/${draft.id}/einvoice`,
    'PUT',
    { irn, ackNo: '112610012345678', ackDate: 'x', signedQr },
    409,
  );

  const preview = await (
    await fetch(`${base}/workspace/${organizationId}/invoices/preview/${issued.id}`)
  ).text();
  assert.ok(preview.includes(`<strong>IRN:</strong> ${irn}`));
  assert.match(preview, /<div class="doc-einvoice-qr"[^>]*><svg [^>]+><rect [^>]+\/><path d="M[^"]+"/);
  assert.ok(preview.includes('331001234567'));
  const pdf = await renderInvoiceAttachment(await backend.db.models.documents.findById(issued.id));
  assert.ok(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString() === '%PDF-');
  const page = await fetch(`${base}/workspace/${organizationId}/e_invoice/edit/${issued.id}`);
  assert.match(await page.text(), /Remove the saved IRN/);

  await call(`/documents/${issued.id}/einvoice`, 'DELETE');
  assert.equal((await backend.db.models.documents.findById(issued.id)).einvoice, null);
});
