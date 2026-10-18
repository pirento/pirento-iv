/** Integration tests: business images are stored once, restored on every read, and old records are converted. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { migrateStoredImages } from '../../src/models/image-store.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
// Distinct fake PNG data URLs, large enough to be stored separately.
const image = (seed) => 'data:image/png;base64,' + Buffer.alloc(3000, seed).toString('base64');
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function expectCall(base, path, method, body, status = 200) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

test('Documents and email payloads store each image once and read back unchanged', options, async (t) => {
  const { base, backend } = await createFixture(t, {
    auth: false,
    environment: { RESEND_API_KEY: 'stored_images_key', EMAIL_FROM: 'Billing <billing@example.test>' },
  });
  const { db } = backend;
  const organizationId = 'pipeline2-legal';
  const logoUrl = image(1);
  const stampImageUrl = image(2);
  const organization = await db.models.organizations.findById(organizationId);
  await db.models.organizations.save({ ...organization, logoUrl, stampImageUrl });
  const buyer = await expectCall(
    base,
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Image Buyer',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    },
    201,
  );
  const input = {
    organizationId,
    customerId: buyer.id,
    kind: 'invoice',
    status: 'sent',
    issueDate: '2026-10-10',
    dueDate: '2026-10-31',
    title: 'Image invoice',
    items: [{ description: 'Service', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
  };
  const created = await expectCall(base, '/documents', 'POST', input, 201);
  const second = await expectCall(base, '/documents', 'POST', input, 201);

  await t.test('saved rows hold references and every read restores the original', async () => {
    const raw = await db.collection('documents').findOne({ id: created.id });
    assert.equal(raw.organizationSnapshot.logoUrl, 'stored-image:' + hash(logoUrl));
    assert.equal(raw.organizationSnapshot.stampImageUrl, 'stored-image:' + hash(stampImageUrl));
    assert.deepEqual(await db.models.documents.findById(created.id), created);
    const listed = await db.models.documents.list(organizationId, 'invoice');
    assert.deepEqual(
      listed.find((document) => document.id === second.id),
      second,
    );
    // Only printed / matching fields are copied; internal contact data stays on the contact.
    assert.deepEqual(Object.keys(raw.customerSnapshot).sort(), [
      'active',
      'address',
      'contactPerson',
      'email',
      'gstin',
      'id',
      'name',
      'organizationId',
      'pan',
      'phone',
      'roles',
      'stateCode',
    ]);
    assert.equal('gstRegistrations' in raw.organizationSnapshot, false);
    // Two invoices share one stored copy of each image.
    assert.equal(await db.collection('images').countDocuments({ _id: hash(logoUrl) }), 1);
  });

  await t.test('email payloads keep references and restore the full document', async () => {
    const raw = await db.collection('email_outbox').findOne({ document_id: created.id });
    assert.equal(raw.payload.document.organizationSnapshot.logoUrl, 'stored-image:' + hash(logoUrl));
    const row = await db.models.email.findById(raw.id);
    assert.equal(row.payload.document.organizationSnapshot.logoUrl, logoUrl);
  });

  await t.test('startup conversion compacts older rows once', async () => {
    const legacyLogo = image(3);
    const legacy = { ...created, id: 'legacy-image-doc', number: 'LEGACY-1' };
    legacy.organizationSnapshot = { ...created.organizationSnapshot, logoUrl: legacyLogo };
    await db.collection('documents').insertOne(structuredClone(legacy));
    await db.collection('email_outbox').insertOne({
      id: 'legacy-image-email',
      event_key: 'legacy-image-email',
      document_id: legacy.id,
      kind: 'invoice',
      status: 'held',
      claim_token: null,
      updated_at: '2026-10-10T00:00:00.000Z',
      payload: { organizationId, document: legacy },
    });
    await db.collection('workspace_metadata').deleteOne({ _id: 'stored-images-v1' });
    const counts = await migrateStoredImages(db);
    assert.ok(counts.documents >= 1 && counts.emails >= 1, JSON.stringify(counts));
    const raw = await db.collection('documents').findOne({ id: legacy.id });
    assert.equal(raw.organizationSnapshot.logoUrl, 'stored-image:' + hash(legacyLogo));
    assert.deepEqual(await db.models.documents.findById(legacy.id), legacy);
    const email = await db.collection('email_outbox').findOne({ id: 'legacy-image-email' });
    assert.equal(email.payload.document.organizationSnapshot.logoUrl, 'stored-image:' + hash(legacyLogo));
    assert.deepEqual(await migrateStoredImages(db), { documents: 0, emails: 0 });
  });
});
