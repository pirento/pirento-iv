/** Integration tests: decimal pricing for new documents while saved legacy amounts stay unchanged. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ejs from 'ejs';
import { buildDocumentDefinition } from '../../shared/pdf.js';
import { DECIMAL_ROUNDING_POLICY, money } from '../../shared/types.js';
import { helpers } from '../../src/controllers/pages/view-helpers.js';
import { createFixture, integrationEnabled } from './fixture.js';

const organizationId = 'pipeline2-legal';
const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const views = fileURLToPath(new URL('../../views/documents/', import.meta.url));
const legacyTotals = {
  subtotal: 10.07,
  discount: 0,
  taxable: 10.07,
  cgst: 0,
  sgst: 0,
  igst: 0,
  total: 10.07,
};

async function assertRenderedAmount(document, expected, absent) {
  const before = JSON.stringify(document);
  const data = {
    document,
    organization: document.organizationSnapshot,
    route: { organizationId, view: 'invoices', action: 'preview', id: document.id },
  };
  const preview = await ejs.renderFile(`${views}preview.ejs`, { data, helpers });
  assert.ok(preview.includes(`doc-paper-amount">${money(expected)}</td>`));
  assert.ok(!preview.includes(money(absent)));
  const editorLine = await ejs.renderFile(`${views}line.ejs`, {
    data,
    helpers,
    line: document.items[0],
    index: 0,
    locked: false,
    isDelivery: false,
  });
  assert.ok(editorLine.includes(`data-line-amount>${money(expected)}</output>`));
  assert.ok(!editorLine.includes(money(absent)));
  const definition = JSON.stringify(buildDocumentDefinition(document, {}));
  assert.ok(definition.includes(money(expected)));
  assert.ok(!definition.includes(money(absent)));
  assert.equal(JSON.stringify(document), before, 'Rendering must not rewrite saved money');
}

test(
  'decimal pricing applies to new work and preserves saved legacy amounts in every document flow',
  settings,
  async (t) => {
    const fixture = await createFixture(t, {
      auth: false,
      now: () => new Date('2026-10-11T06:00:00.000Z'),
      emailFetch: async () => {
        throw new Error('This test must not contact an email provider.');
      },
      paymentFetch: async () => {
        throw new Error('This test must not contact a payment provider.');
      },
    });
    const { backend, base } = fixture;
    async function api(path, method = 'GET', body, expectedStatus = 200) {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result)}`);
      return result;
    }
    const customer = await api(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Decimal invoice buyer',
        email: 'buyer@example.test',
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
      customerId: customer.id,
      kind: 'invoice',
      status: 'draft',
      issueDate: '2026-10-11',
      dueDate: '2026-10-31',
      title: 'Decimal invoice',
      items: [{ description: 'Fractional service', hsn: '', quantity: 0.5, rate: 20.15, gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
      ...extra,
    });

    const fresh = await api('/documents', 'POST', input({ status: 'sent' }), 201);
    assert.equal(fresh.totals.total, 10.08);
    assert.equal(fresh.totals.roundingPolicy, DECIMAL_ROUNDING_POLICY);
    await assertRenderedAmount(fresh, 10.08, 10.07);
    const freshEmail = await backend.db.collection('email_outbox').findOne({ document_id: fresh.id });
    assert.ok(freshEmail.payload.html.includes(money(10.08)));
    assert.ok(!freshEmail.payload.html.includes(money(10.07)));
    assert.ok(freshEmail.payload.text.includes(` | ${money(10.08)}`));

    async function legacyDocument(extra = {}) {
      const document = await api('/documents', 'POST', input(extra), 201);
      // Model a persisted invoice written by the previous version, without a policy marker.
      await backend.db.collection('documents').updateOne(
        { id: document.id },
        {
          $set: { totals: { ...legacyTotals }, balanceDue: document.kind === 'invoice' ? 10.07 : 0 },
        },
      );
      return {
        ...document,
        totals: { ...legacyTotals },
        balanceDue: document.kind === 'invoice' ? 10.07 : 0,
      };
    }
    const oldDraft = await legacyDocument();
    const issued = await api(`/documents/${oldDraft.id}`, 'PUT', {
      ...oldDraft,
      status: 'sent',
      notes: 'Issue the existing amount without recalculating it.',
      totals: { total: 10.08, roundingPolicy: DECIMAL_ROUNDING_POLICY },
    });
    assert.deepEqual(issued.totals, legacyTotals, 'Client-supplied totals cannot reprice an issued draft');
    assert.equal(issued.balanceDue, 10.07);
    await assertRenderedAmount(issued, 10.07, 10.08);
    const oldEmail = await backend.db.collection('email_outbox').findOne({ document_id: issued.id });
    assert.ok(oldEmail.payload.html.includes(money(10.07)));
    assert.ok(!oldEmail.payload.html.includes(money(10.08)));
    assert.ok(oldEmail.payload.text.includes(` | ${money(10.07)}`));
    const updatedNotes = await api(`/documents/${issued.id}`, 'PUT', { ...issued, notes: 'A later note' });
    assert.deepEqual(updatedNotes.totals, legacyTotals);
    await api(
      `/documents/${issued.id}`,
      'PUT',
      {
        ...updatedNotes,
        items: [{ ...updatedNotes.items[0], rate: 20.16 }],
      },
      409,
    );

    const editable = await legacyDocument();
    const recalculated = await api(`/documents/${editable.id}`, 'PUT', {
      ...editable,
      items: [{ ...editable.items[0], quantity: 1.25, rate: 8.06 }],
    });
    assert.equal(recalculated.totals.total, 10.08);
    assert.equal(recalculated.totals.roundingPolicy, DECIMAL_ROUNDING_POLICY);

    const quotation = await legacyDocument({ kind: 'quotation' });
    const converted = await api(`/documents/${quotation.id}/convert`, 'POST', {}, 201);
    assert.deepEqual(converted.totals, legacyTotals, 'Conversion retains the agreed quotation amount');
    await assertRenderedAmount(converted, 10.07, 10.08);

    const { schedule } = await api(
      '/recurring-invoices',
      'POST',
      {
        organizationId,
        sourceDocumentId: updatedNotes.id,
        sourceVersion: updatedNotes.version,
        requestId: randomUUID(),
        name: 'New monthly draft from a legacy invoice',
        dueDays: 30,
        endDate: '',
        maxOccurrences: 1,
        frequency: 'monthly',
        startDate: '2026-10-11',
        active: true,
      },
      201,
    );
    const occurrence = await api(
      `/recurring-invoices/${schedule.id}/generate`,
      'POST',
      {
        organizationId,
        version: schedule.version,
        occurrenceDate: schedule.nextDate,
      },
      201,
    );
    const recurringDraft = await backend.db.models.documents.findById(occurrence.document.id);
    assert.equal(recurringDraft.status, 'draft');
    assert.equal(recurringDraft.totals.total, 10.08);
    assert.equal(recurringDraft.totals.roundingPolicy, DECIMAL_ROUNDING_POLICY);
    assert.deepEqual((await backend.db.models.documents.findById(updatedNotes.id)).totals, legacyTotals);
  },
);
