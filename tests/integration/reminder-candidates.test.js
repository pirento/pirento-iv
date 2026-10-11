import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';
import { organizationTransactionStripe } from '../../src/config/transaction-scopes.js';
import { reminderCandidateFilter } from '../../src/models/reminder-queries.js';
import { DOCUMENT_SUMMARY_FIELDS } from '../../src/models/workspace-queries.js';
import { createPaymentReminders } from '../../src/services/integrations/email/payment-reminders.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const organizationId = 'pipeline2-legal';

async function fixture(t, now = () => new Date('2026-10-10T10:00:00.000Z')) {
  const f = await createFixture(t, {
    auth: false,
    now,
    environment: {
      RESEND_API_KEY: 'fixture_candidate_key',
      EMAIL_FROM: 'Venturecore <reminders@example.test>',
      EMAIL_AUTOMATION: 'false',
    },
    emailFetch: async () => {
      throw new Error('This candidate-selection test must not contact an email provider.');
    },
  });
  async function post(path, body) {
    const response = await fetch(f.base + '/api' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 201, JSON.stringify(result));
    return result;
  }
  const customer = await post('/customers', {
    organizationId,
    name: 'Candidate Buyer',
    email: 'buyer@example.test',
    phone: '',
    gstin: '',
    address: 'Lucknow',
    stateCode: '09',
    contactPerson: '',
  });
  const invoice = await post('/documents', {
    organizationId,
    customerId: customer.id,
    requestId: randomUUID(),
    kind: 'invoice',
    status: 'sent',
    issueDate: '2026-10-01',
    dueDate: '2026-10-10',
    title: 'Candidate invoice',
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
  });
  const clone = (extra = {}) => ({
    ...structuredClone(invoice),
    id: randomUUID(),
    number: `CANDIDATE-${randomUUID()}`,
    ...extra,
  });
  return { ...f, invoice, clone };
}

const coordination = async (db) =>
  new Map(
    (await db.collection('transaction_locks').find({}).toArray()).map((row) => [row._id, row.revision]),
  );
const changedLocks = (before, after) =>
  [...after]
    .filter(([id, revision]) => revision !== before.get(id))
    .map(([id]) => id)
    .sort();

test(
  'Native reminder scheduling scans indexed due-date candidates while dashboards retain every eligible balance',
  settings,
  async (t) => {
    const f = await fixture(t);
    const { db, reminders } = f.backend;
    const split = f.clone({
      status: 'partially_paid',
      dueDate: '2026-12-01',
      amountPaid: 30,
      balanceDue: 70,
      installmentPlan: {
        name: '30/70',
        installments: [
          { id: 'first', label: 'Paid first', amount: 30, dueDate: '2026-10-02' },
          { id: 'second', label: 'Remaining second', amount: 70, dueDate: '2026-10-13' },
        ],
      },
    });
    const covered = f.clone({
      status: 'partially_paid',
      dueDate: '2026-12-01',
      amountPaid: 30,
      balanceDue: 70,
      installmentPlan: {
        name: 'Paid today',
        installments: [
          { id: 'paid', label: 'Paid target', amount: 30, dueDate: '2026-10-10' },
          { id: 'later', label: 'Future target', amount: 70, dueDate: '2026-12-01' },
        ],
      },
    });
    const invoiceDateOnly = f.clone({
      installmentPlan: {
        name: 'Future plan',
        installments: [{ id: 'later', label: 'Future installment', amount: 100, dueDate: '2026-12-01' }],
      },
    });
    const bothBranches = f.clone({
      installmentPlan: {
        name: '40/60',
        installments: [
          { id: 'today', label: 'First', amount: 40, dueDate: '2026-10-10' },
          { id: 'next', label: 'Second', amount: 60, dueDate: '2026-10-13' },
        ],
      },
    });
    const noEmail = f.clone({ customerSnapshot: { ...f.invoice.customerSnapshot, email: '' } });
    const zeroBalance = f.clone({ amountPaid: 100, balanceDue: 0 });
    const direct = [
      f.clone({ dueDate: '2026-10-13' }),
      f.clone({ dueDate: '2026-10-07' }),
      f.clone({ dueDate: '2026-10-03' }),
    ];
    const unrelated = Array.from({ length: 1200 }, () => f.clone({ dueDate: '2026-12-01' }));
    await db
      .collection('documents')
      .insertMany([
        ...direct,
        split,
        covered,
        invoiceDateOnly,
        bothBranches,
        noEmail,
        zeroBalance,
        f.clone({ status: 'draft' }),
        f.clone({ status: 'cancelled' }),
        f.clone({ status: 'paid' }),
        f.clone({ kind: 'quotation' }),
        f.clone({ organizationId: 'at-facilities' }),
        f.clone({ dueDate: '' }),
        ...unrelated,
      ]);
    const beforePolicy = await coordination(db);
    await reminders.updatePolicy(organizationId, { version: 0, enabled: true, offsets: [-3, 0, 3, 7] });
    assert.deepEqual(changedLocks(beforePolicy, await coordination(db)), [
      organizationTransactionStripe(organizationId),
    ]);

    const expectedCounters = {
      total: { count: 1210, amount: 120840 },
      overdue: { count: 2, amount: 200 },
      dueToday: { count: 3, amount: 240 },
      upcoming: { count: 1205, amount: 120400 },
      unavailableCount: 1,
    };
    const dashboard = await reminders.list(organizationId, { q: 'no matching invoice', status: 'overdue' });
    assert.equal(dashboard.items.length, 0);
    assert.deepEqual(dashboard.counters, expectedCounters);

    const dueDates = ['2026-10-13', '2026-10-10', '2026-10-07', '2026-10-03'];
    const filter = reminderCandidateFilter(organizationId, dueDates);
    const openInvoices = await db.collection('documents').countDocuments({
      organizationId,
      kind: 'invoice',
      status: { $in: ['sent', 'partially_paid'] },
    });
    assert.equal(openInvoices, 1211);
    const explain = await db
      .collection('documents')
      .find(filter, { projection: { ...DOCUMENT_SUMMARY_FIELDS, 'customerSnapshot.email': 1 } })
      .sort({ _id: 1 })
      .explain('executionStats');
    assert.equal(explain.executionStats.nReturned, 10);
    assert.ok(
      explain.executionStats.totalDocsExamined <= 20,
      'Due-date indexes avoid unrelated invoice fetches',
    );
    assert.ok(
      explain.executionStats.totalKeysExamined < 100,
      'The scheduler does not walk the complete open-invoice index',
    );
    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    assert.doesNotMatch(plan, /COLLSCAN/);
    assert.match(plan, /installmentPlan\.installments\.dueDate/);
    assert.match(plan, /"dueDate":1/);
    t.diagnostic(
      `Due-date candidate explain: ${explain.executionStats.nReturned} returned, ` +
        `${explain.executionStats.totalDocsExamined} documents examined, ` +
        `${explain.executionStats.totalKeysExamined} keys examined; ${openInvoices} open invoices in the business.`,
    );

    const queries = [];
    const collection = db.collection;
    db.collection = (name) => {
      const result = collection(name);
      if (name === 'documents') {
        const find = result.find.bind(result);
        result.find = (query, options) => {
          queries.push(query);
          return find(query, options);
        };
      }
      return result;
    };
    const beforeQueue = await coordination(db);
    let run;
    try {
      run = await reminders.processDue();
    } finally {
      db.collection = collection;
    }
    assert.deepEqual(
      queries.filter((query) => !Object.hasOwn(query, 'id')),
      [filter],
    );
    assert.ok(
      queries
        .filter((query) => Object.hasOwn(query, 'id'))
        .every((query) => Object.keys(query).length === 1 && typeof query.id === 'string'),
      'Eligibility refreshes use point reads, not another open-invoice scan',
    );
    assert.equal(run.scanned, 10);
    assert.equal(run.queued, 7);
    assert.equal(run.failed, 0);
    assert.deepEqual(changedLocks(beforeQueue, await coordination(db)), [
      organizationTransactionStripe(organizationId),
    ]);
    const messages = await db.collection('email_outbox').find({ kind: 'payment_reminder' }).toArray();
    assert.equal(messages.length, 7);
    assert.ok(messages.every((message) => message.payload.organizationId === organizationId));
    assert.equal(
      messages.find((message) => message.document_id === split.id).payload.reminder.installmentId,
      'second',
    );
    assert.equal(
      messages.find((message) => message.document_id === split.id).payload.reminder.balanceDue,
      70,
    );
    assert.equal(messages.filter((message) => message.document_id === bothBranches.id).length, 2);
    for (const excluded of [covered, invoiceDateOnly, noEmail, zeroBalance])
      assert.ok(messages.every((message) => message.document_id !== excluded.id));
    const repeated = await reminders.processDue();
    assert.equal(repeated.queued, 0);
    assert.equal(repeated.duplicates, 7);
    assert.equal(repeated.scanned, 10);
    assert.equal(await db.collection('email_outbox').countDocuments({ kind: 'payment_reminder' }), 7);
    assert.deepEqual((await reminders.list(organizationId)).counters, expectedCounters);

    const beforeManual = await coordination(db);
    await reminders.enqueueManual(f.invoice.id, { installmentId: null, dueDate: f.invoice.dueDate });
    assert.deepEqual(changedLocks(beforeManual, await coordination(db)), [
      organizationTransactionStripe(organizationId),
    ]);
  },
);

test(
  'Native automatic reminder candidates refresh after Indian midnight without catching up missed rules',
  settings,
  async (t) => {
    let instant = new Date('2026-10-10T18:29:59.000Z');
    const now = () => new Date(instant);
    const f = await fixture(t, now);
    const { db, mailer } = f.backend;
    const oldSecond = f.clone();
    const newDay = f.clone({ dueDate: '2026-10-11' });
    await db.collection('documents').insertMany([oldSecond, newDay]);
    let rollover = true;
    const reminders = createPaymentReminders({
      db,
      now,
      mailer: {
        ...mailer,
        enqueueReminder: async (...args) => {
          const result = await mailer.enqueueReminder(...args);
          if (rollover) {
            rollover = false;
            instant = new Date('2026-10-10T18:30:00.000Z');
          }
          return result;
        },
      },
    });
    try {
      await reminders.updatePolicy(organizationId, { version: 0, enabled: true, offsets: [0] });
      const first = await reminders.processDue();
      assert.equal(first.scanned, 1);
      assert.equal(first.queued, 1);
      const next = await reminders.processDue();
      assert.equal(next.scanned, 1);
      assert.equal(next.queued, 1);
      const messages = await db.collection('email_outbox').find({ kind: 'payment_reminder' }).toArray();
      assert.equal(messages.length, 2);
      assert.ok(
        messages.some(
          (message) =>
            message.document_id === f.invoice.id && message.payload.reminder.scheduledFor === '2026-10-10',
        ),
      );
      assert.ok(
        messages.some(
          (message) =>
            message.document_id === newDay.id && message.payload.reminder.scheduledFor === '2026-10-11',
        ),
      );
      assert.ok(messages.every((message) => message.document_id !== oldSecond.id));
    } finally {
      await reminders.stop();
    }
  },
);
