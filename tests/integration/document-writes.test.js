/** Integration tests: idempotent document creation and version checks against stale edits. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const clock = () => new Date('2026-10-10T12:00:00.000Z');

async function call(base, path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function expectCall(base, path, method, body, status = 200) {
  const result = await call(base, path, method, body);
  assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function customer(base, organizationId) {
  return expectCall(
    base,
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Phase 1 Buyer',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: 'Accounts',
    },
    201,
  );
}

function documentInput(buyer, extra = {}) {
  return {
    organizationId: buyer.organizationId,
    customerId: buyer.id,
    kind: 'invoice',
    status: 'draft',
    issueDate: '2026-10-10',
    dueDate: '2026-10-31',
    title: 'Phase 1 Invoice',
    items: [{ description: 'Service', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    ...extra,
  };
}

test(
  'A creation request makes one invoice, number and outbox message across instances',
  options,
  async (t) => {
    const fixture = await createFixture(t, {
      auth: false,
      now: clock,
      environment: {
        EMAIL_AUTOMATION: 'true',
        RESEND_API_KEY: 'synthetic_phase1_key',
        EMAIL_FROM: 'Billing <billing@example.test>',
      },
    });
    const second = await fixture.startInstance();
    const { base, backend } = fixture;
    const buyer = await customer(base, 'pipeline2-legal');
    const input = documentInput(buyer, { status: 'sent', requestId: randomUUID() });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        call(index % 2 ? second.base : base, '/documents', 'POST', input),
      ),
    );
    assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(attempts.map((result) => result.body.id)).size, 1);
    assert.equal(new Set(attempts.map((result) => result.body.number)).size, 1);
    const created = attempts[0].body;
    assert.equal(created.version, 1);
    assert.equal(
      await backend.db.collection('documents').countDocuments({ organizationId: buyer.organizationId }),
      1,
    );
    assert.equal(await backend.db.collection('email_outbox').countDocuments({ document_id: created.id }), 1);
    assert.equal(await backend.db.collection('document_requests').countDocuments({}), 1);
    const sequence = await backend.db
      .collection('sequences')
      .findOne({ organizationId: buyer.organizationId, kind: 'invoice' });
    assert.equal(sequence.value, 1);

    const reordered = Object.fromEntries(Object.entries(input).reverse());
    reordered.items = input.items.map((item) => Object.fromEntries(Object.entries(item).reverse()));
    assert.equal((await expectCall(second.base, '/documents', 'POST', reordered)).id, created.id);
    const conflict = await expectCall(
      base,
      '/documents',
      'POST',
      { ...input, title: 'Different details' },
      409,
    );
    assert.equal(conflict.code, 'DOCUMENT_REQUEST_CONFLICT');
    assert.deepEqual(conflict.document, {
      id: created.id,
      organizationId: created.organizationId,
      kind: created.kind,
    });
    const edited = await expectCall(base, `/documents/${created.id}`, 'PUT', {
      ...created,
      notes: 'Later edit',
    });
    const replay = await expectCall(second.base, '/documents', 'POST', input);
    assert.equal(replay.version, edited.version);
    assert.equal(replay.notes, 'Later edit');
    assert.equal(await backend.db.collection('email_outbox').countDocuments({ document_id: created.id }), 1);

    const otherBuyer = await customer(base, 'at-facilities');
    const other = await expectCall(
      base,
      '/documents',
      'POST',
      documentInput(otherBuyer, { requestId: input.requestId }),
      201,
    );
    assert.notEqual(other.id, created.id);
    assert.equal(other.organizationId, otherBuyer.organizationId);
  },
);

test(
  'Failed creates can be corrected; deleted drafts are not recreated by old retries',
  options,
  async (t) => {
    const { base, backend } = await createFixture(t, { auth: false, now: clock });
    const buyer = await customer(base, 'pipeline2-legal');
    const requestId = randomUUID();
    const input = documentInput(buyer, { requestId });
    await expectCall(base, '/documents', 'POST', { ...input, customerId: 'missing-buyer' }, 404);
    assert.equal(await backend.db.collection('document_requests').countDocuments({}), 0);
    const created = await expectCall(base, '/documents', 'POST', input, 201);
    assert.match(created.number, /0001$/);
    await expectCall(base, `/documents/${created.id}`, 'DELETE');
    const replay = await expectCall(base, '/documents', 'POST', input, 409);
    assert.equal(replay.code, 'DOCUMENT_REQUEST_CONFLICT');
    assert.equal(replay.document, undefined);
    assert.equal(await backend.db.collection('documents').countDocuments({}), 0);
    assert.equal(await backend.db.collection('document_requests').countDocuments({}), 1);
    const next = await expectCall(base, '/documents', 'POST', { ...input, requestId: randomUUID() }, 201);
    assert.match(next.number, /0002$/);
  },
);

test('Stale document edits cannot overwrite another edit or a ledger update', options, async (t) => {
  const fixture = await createFixture(t, { auth: false, now: clock });
  const { base } = fixture;
  const second = await fixture.startInstance();
  const buyer = await customer(base, 'pipeline2-legal');
  const created = await expectCall(base, '/documents', 'POST', documentInput(buyer), 201);
  const results = await Promise.all([
    call(base, `/documents/${created.id}`, 'PUT', { ...created, title: 'First editor' }),
    call(second.base, `/documents/${created.id}`, 'PUT', { ...created, notes: 'Second editor' }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, 'DOCUMENT_VERSION_CONFLICT');
  const saved = results.find((result) => result.status === 200).body;
  assert.equal(saved.version, 2);
  const current = (await expectCall(base, `/documents?organizationId=${buyer.organizationId}`, 'GET'))[0];
  assert.equal(current.title, saved.title);
  assert.equal(current.notes, saved.notes);
  const { version: _version, ...missingVersion } = saved;
  assert.equal(
    (await expectCall(base, `/documents/${saved.id}`, 'PUT', missingVersion, 409)).code,
    'DOCUMENT_VERSION_CONFLICT',
  );
  await expectCall(base, `/documents/${saved.id}`, 'PUT', { ...saved, version: '2' }, 400);

  const details = await expectCall(
    base,
    `/documents/${saved.id}/payments`,
    'POST',
    {
      amount: 20,
      paidOn: '2026-10-10',
      method: 'bank_transfer',
      reference: 'BANK-20',
      notes: '',
      requestId: randomUUID(),
      finalizeWhenPaid: false,
    },
    201,
  );
  assert.equal(details.document.version, saved.version + 1);
  assert.equal(
    (await expectCall(base, `/documents/${saved.id}`, 'PUT', { ...saved, notes: 'Old screen' }, 409)).code,
    'DOCUMENT_VERSION_CONFLICT',
  );
  const latest = await expectCall(base, `/documents/${saved.id}`, 'PUT', {
    ...details.document,
    notes: 'Current screen',
  });
  assert.equal(latest.amountPaid, 20);
  assert.equal(latest.balanceDue, 80);
  assert.equal(latest.version, details.document.version + 1);
  const voided = await expectCall(base, `/payments/${details.payments[0].id}/void`, 'POST', {
    reason: 'Test correction',
  });
  assert.equal(voided.document.version, latest.version + 1);
  assert.equal(voided.document.balanceDue, 100);
});

test('Legacy documents expose version zero and migrate on a guarded write', options, async (t) => {
  const { base, backend } = await createFixture(t, { auth: false, now: clock });
  const buyer = await customer(base, 'pipeline2-legal');
  const created = await expectCall(base, '/documents', 'POST', documentInput(buyer), 201);
  await backend.db.collection('documents').updateOne({ id: created.id }, { $unset: { version: '' } });
  const legacy = (await expectCall(base, `/documents?organizationId=${buyer.organizationId}`, 'GET'))[0];
  assert.equal(legacy.version, 0);
  const saved = await expectCall(base, `/documents/${created.id}`, 'PUT', {
    ...legacy,
    title: 'Migrated draft',
  });
  assert.equal(saved.version, 1);
  await expectCall(base, `/documents/${created.id}`, 'PUT', { ...legacy, notes: 'Stale legacy screen' }, 409);
  const stale = await backend.db.models.documents.save({ ...legacy, version: 1 }, 0);
  assert.equal(stale.changes, 0);
  await expectCall(base, `/documents/${created.id}`, 'DELETE');
  const deleted = await backend.db.models.documents.save({ ...saved, version: 2 }, saved.version);
  assert.equal(deleted.changes, 0);
  assert.equal(await backend.db.collection('documents').countDocuments({ id: created.id }), 0);
});

test('Stale installment replacements and removals preserve the newer saved plan', options, async (t) => {
  const { base } = await createFixture(t, { auth: false, now: clock });
  const buyer = await customer(base, 'pipeline2-legal');
  const invoice = await expectCall(base, '/documents', 'POST', documentInput(buyer, { status: 'sent' }), 201);
  const path = `/documents/${invoice.id}/installments`;
  const plan = (first) => ({
    name: `${first}/${100 - first}`,
    installments: [
      { id: 'first', label: 'First payment', dueDate: '2026-10-15', amount: first },
      { id: 'second', label: 'Final payment', dueDate: '2026-10-31', amount: 100 - first },
    ],
  });
  const accepted = await expectCall(base, path, 'PUT', { plan: plan(70), version: invoice.version });
  assert.equal(accepted.document.version, invoice.version + 1);
  const stale = await expectCall(base, path, 'PUT', { plan: plan(50), version: invoice.version }, 409);
  assert.equal(stale.code, 'DOCUMENT_VERSION_CONFLICT');
  const latest = await expectCall(base, `/documents/${invoice.id}/payments`, 'GET');
  assert.deepEqual(latest.document.installmentPlan, plan(70));
  assert.equal(latest.events.length, accepted.events.length);
  await expectCall(base, path, 'PUT', { plan: null }, 409);
  const changed = await expectCall(base, `/documents/${invoice.id}`, 'PUT', {
    ...latest.document,
    notes: 'Another user edited this invoice',
  });
  await expectCall(base, path, 'PUT', { plan: null, version: latest.document.version }, 409);
  const removed = await expectCall(base, path, 'PUT', { plan: null, version: changed.version });
  assert.equal(removed.document.installmentPlan, null);
  assert.equal(removed.document.version, changed.version + 1);
  assert.equal(removed.document.notes, changed.notes);
});
