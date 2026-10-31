/** Integration tests: each business's letterhead, documents printed on it, and the one-time teal format update. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderInvoiceAttachment } from '../../src/services/documents/invoice-pdf.js';
import { migrateFormatsToTeal } from '../../src/models/workspace-seed.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a business letterhead is copied onto documents printed on it', options, async (t) => {
  const { base, backend } = await createFixture(t, { auth: false });
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
  const buyer = await call(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Letterhead Buyer',
      email: '',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    },
    201,
  );
  const input = (extra = {}) => ({
    organizationId,
    customerId: buyer.id,
    kind: 'quotation',
    status: 'draft',
    issueDate: '2026-10-05',
    dueDate: '2026-10-05',
    title: 'Quotation',
    items: [{ description: 'Service', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    ...extra,
  });
  assert.match(
    (await call('/documents', 'POST', input({ useLetterhead: true }), 400)).error,
    /Upload a letterhead/,
  );
  const letterhead = { image, top: 45, bottom: 30, left: 15, right: 15, defaultOn: true };
  await call(
    `/letterheads/${organizationId}`,
    'PUT',
    { ...letterhead, image: 'data:image/gif;base64,R0lGOD' },
    400,
  );
  await call(`/letterheads/${organizationId}`, 'PUT', letterhead);
  const onLetterhead = await call('/documents', 'POST', input({ useLetterhead: true }), 201);
  assert.deepEqual(onLetterhead.letterhead, { image, top: 45, bottom: 30, left: 15, right: 15 });
  const plain = await call('/documents', 'POST', input(), 201);
  assert.equal(plain.letterhead, null);

  // Later letterhead changes do not alter a saved document; choosing plain removes its copy.
  await call(`/letterheads/${organizationId}`, 'PUT', { ...letterhead, top: 60 });
  const kept = await backend.db.models.documents.findById(onLetterhead.id);
  assert.equal(kept.letterhead.top, 45);
  const pdf = await renderInvoiceAttachment(kept);
  assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString(), '%PDF-');
  const switched = await call(`/documents/${onLetterhead.id}`, 'PUT', {
    ...input({ useLetterhead: false }),
    version: kept.version,
  });
  assert.equal(switched.letterhead, null);
  const invoice = await call(`/documents/${plain.id}/convert`, 'POST', undefined, 201);
  assert.equal(invoice.letterhead, null, 'a converted document follows its quotation');

  await call(`/letterheads/${organizationId}`, 'DELETE');
  assert.equal(await backend.db.models.letterheads.findById(organizationId), undefined);
});

test('saved formats take the teal accent once', options, async (t) => {
  const { backend } = await createFixture(t, { auth: false });
  const formats = backend.db.collection('formats');
  const [first] = await formats.find({}).limit(1).toArray();
  await formats.updateOne({ _id: first._id }, { $set: { accentColor: '#26705b' } });
  await backend.db.collection('workspace_metadata').deleteOne({ _id: 'formats-teal-v1' });
  assert.ok((await migrateFormatsToTeal(backend.db)) >= 1);
  assert.equal((await formats.findOne({ _id: first._id })).accentColor, '#0e4d64');
  await formats.updateOne({ _id: first._id }, { $set: { accentColor: '#a44969' } });
  assert.equal(await migrateFormatsToTeal(backend.db), 0, 'a colour chosen later is kept');
});
