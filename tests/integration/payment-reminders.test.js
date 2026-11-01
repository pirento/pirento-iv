/** Integration tests: payment reminder eligibility, policy changes, sending and route permissions. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMailer } from '../../src/services/integrations/email/mailer.js';
import { createPaymentReminders } from '../../src/services/integrations/email/payment-reminders.js';
import { createFixture, integrationEnabled } from './fixture.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 180_000,
};
const organizationId = 'pipeline2-legal';
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'Payment reminder eligibility, policy concurrency and first-transport safeguards use native MongoDB',
  settings,
  async (t) => {
    let instant = new Date('2026-10-10T10:00:00.000Z');
    const now = () => new Date(instant);
    const deliveries = [];
    let loseResponse = false;
    const environment = {
      RESEND_API_KEY: 'fixture_reminder_key',
      EMAIL_FROM: 'Venturecore <reminders@example.test>',
      // Reminder opt-in is separate from the older invoice/receipt automation flag.
      EMAIL_AUTOMATION: 'false',
    };
    const emailFetch = async (url, init) => {
      assert.equal(url, 'https://api.resend.com/emails');
      deliveries.push({ headers: structuredClone(init.headers), body: JSON.parse(init.body) });
      if (loseResponse) throw new Error('Fixture: response lost after provider transport started.');
      return Response.json({ id: `reminder_email_${deliveries.length}` });
    };
    const fixture = await createFixture(t, { environment, auth: false, emailFetch, now });
    const { backend, base } = fixture;
    const { db, reminders, mailer } = backend;
    const customMailer = (overrides = {}) =>
      createMailer(db, {
        env: fixture.environment,
        fetch: emailFetch,
        now,
        getOrganization: (id) => db.models.organizations.findById(id),
        renderInvoiceAttachment: async (document) => ({
          filename: `${document.number.replaceAll('/', '-')}.pdf`,
          content: Buffer.from(
            JSON.stringify({
              id: document.id,
              amountPaid: document.amountPaid,
              balanceDue: document.balanceDue,
            }),
          ).toString('base64'),
        }),
        ...overrides,
      });
    async function call(path, method = 'GET', input, status = 200) {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const value = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    }
    const buyer = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Reminder Buyer',
        email: 'buyer@example.test',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    const noEmail = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Missing Email',
        email: '',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    async function invoice(extra = {}) {
      return await call(
        '/documents',
        'POST',
        {
          requestId: randomUUID(),
          organizationId,
          customerId: buyer.id,
          kind: 'invoice',
          status: 'sent',
          issueDate: '2026-10-01',
          dueDate: '2026-10-10',
          title: 'Reminder regression',
          items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
          ...extra,
        },
        201,
      );
    }
    const target = (document, extra = {}) => ({ installmentId: null, dueDate: document.dueDate, ...extra });
    async function pay(document, amount) {
      return await call(
        `/documents/${document.id}/payments`,
        'POST',
        {
          requestId: randomUUID(),
          amount,
          paidOn: '2026-10-10',
          method: 'bank_transfer',
          reference: 'fixture',
          notes: '',
        },
        201,
      );
    }
    async function policy(enabled, offsets = [-3, 0, 3, 7]) {
      const current = await reminders.getPolicy(organizationId);
      return await reminders.updatePolicy(
        organizationId,
        { version: current.version, enabled, offsets },
        'fixture-admin',
      );
    }
    const reminderRows = () => db.collection('email_outbox').find({ kind: 'payment_reminder' }).toArray();
    const savedMessage = (message) => db.models.email.findById(message.id);

    t.beforeEach(async () => {
      instant = new Date('2026-10-10T10:00:00.000Z');
      deliveries.length = 0;
      loseResponse = false;
      for (const name of [
        'email_outbox',
        'payment_reminder_policies',
        'documents',
        'payments',
        'document_events',
        'document_requests',
      ])
        await db.collection(name).deleteMany({});
    });

    await t.test(
      'dashboard counts current installments and due states without exposing invoice snapshots',
      async () => {
        await invoice({ dueDate: '2026-10-09' });
        await invoice();
        const split = await invoice({
          installmentPlan: {
            name: '30/70',
            installments: [
              { id: 'first', label: 'Initial', dueDate: '2026-10-09', amount: 30 },
              { id: 'second', label: 'Remainder', dueDate: '2026-10-13', amount: 70 },
            ],
          },
        });
        await pay(split, 30);
        const paid = await invoice();
        await pay(paid, 100);
        await invoice({ dueDate: '' });
        await invoice({ customerId: noEmail.id });
        await invoice({ status: 'draft' });
        const listed = await call(`/reminders?organizationId=${organizationId}`);
        assert.equal(listed.policy.enabled, false);
        assert.deepEqual(listed.counters, {
          total: { count: 4, amount: 370 },
          overdue: { count: 1, amount: 100 },
          dueToday: { count: 2, amount: 200 },
          upcoming: { count: 1, amount: 70 },
          unavailableCount: 1,
        });
        assert.equal(listed.items.find((item) => item.documentId === split.id).installmentId, 'second');
        assert.ok(listed.items.every((item) => !item.items && !item.document && !item.organizationSnapshot));
        const overdue = await call(`/reminders?organizationId=${organizationId}&status=overdue`);
        assert.equal(overdue.pagination.total, 1);
        assert.equal((await call(`/reminders?organizationId=${organizationId}&q=unmatched`)).items.length, 0);
        await call(`/reminders?organizationId=${organizationId}&page=0`, 'GET', undefined, 400);
        const preview = await call(`/documents/${split.id}/reminder-preview?installmentId=second`);
        assert.equal(preview.item.balanceDue, 70);
        await call(`/documents/${split.id}/reminder-preview`, 'GET', undefined, 409);
        await call(`/documents/${paid.id}/reminders`, 'POST', target(paid), 409);
      },
    );

    await t.test(
      'repeated manual actions across independent MongoDB clients queue and send one actual PDF',
      async () => {
        const document = await invoice();
        const second = await fixture.startInstance();
        const queued = await Promise.all([
          reminders.enqueueManual(document.id, target(document)),
          second.backend.reminders.enqueueManual(document.id, target(document)),
        ]);
        assert.equal(queued[0].message.id, queued[1].message.id);
        assert.deepEqual(queued.map((result) => result.duplicate).sort(), [false, true]);
        assert.equal((await reminderRows()).length, 1);
        assert.equal(
          (await call(`/documents/${document.id}/reminders`, 'POST', target(document), 202)).duplicate,
          true,
        );
        const result = await Promise.all([mailer.processQueue(), second.backend.mailer.processQueue()]);
        assert.equal(
          result.reduce((sum, value) => sum + value.sent, 0),
          1,
        );
        assert.equal(deliveries.length, 1);
        assert.match(deliveries[0].body.subject, /Payment reminder/);
        assert.match(deliveries[0].body.text, /payment for (tax )?invoice \S+ is due today/);
        assert.equal(
          Buffer.from(deliveries[0].body.attachments[0].content, 'base64').subarray(0, 4).toString(),
          '%PDF',
        );
        assert.equal((await savedMessage(queued[0].message)).has_payment_link, 0);
        assert.equal(await db.collection('online_payment_links').countDocuments({}), 0);
        assert.equal(await db.collection('cashfree_payment_links').countDocuments({}), 0);
      },
    );

    await t.test(
      'payment or cancellation before first transport holds reminders and refuses retry',
      async () => {
        const paid = await invoice();
        const paidMessage = await reminders.enqueueManual(paid.id, target(paid));
        await pay(paid, 100);
        const cancelled = await invoice();
        const cancelledMessage = await reminders.enqueueManual(cancelled.id, target(cancelled));
        await call(`/documents/${cancelled.id}`, 'PUT', { ...cancelled, status: 'cancelled' });
        assert.equal((await savedMessage(cancelledMessage.message)).status, 'held');
        await mailer.processQueue();
        for (const { message } of [paidMessage, cancelledMessage]) {
          const row = await savedMessage(message);
          assert.equal(row.status, 'held');
          assert.equal(row.first_attempt_at, null);
          assert.equal((await mailer.get(message.id)).canRetry, false);
          await assert.rejects(mailer.retry(message.id), { status: 409 });
        }
        assert.equal(deliveries.length, 0);
      },
    );

    await t.test(
      'a partial payment before preparation refreshes the reminder balance and its attachment',
      async () => {
        const document = await invoice();
        const queued = await reminders.enqueueManual(document.id, target(document));
        await pay(document, 25);
        const worker = customMailer();
        try {
          assert.equal((await worker.processQueue()).sent, 1);
          assert.match(deliveries[0].body.text, /attached again with the amount and payment details/);
          const attachment = JSON.parse(
            Buffer.from(deliveries[0].body.attachments[0].content, 'base64').toString(),
          );
          assert.equal(attachment.balanceDue, 75);
          assert.equal((await savedMessage(queued.message)).payload.reminder.balanceDue, 75);
        } finally {
          await worker.stop({ graceMs: 0 });
        }
      },
    );

    await t.test(
      'a paid installment is held even when other installments leave the invoice open',
      async () => {
        const document = await invoice({
          installmentPlan: {
            name: '30/70',
            installments: [
              { id: 'first', label: 'Initial', dueDate: '2026-10-10', amount: 30 },
              { id: 'second', label: 'Remainder', dueDate: '2026-10-20', amount: 70 },
            ],
          },
        });
        const queued = await reminders.enqueueManual(
          document.id,
          target(document, { installmentId: 'first' }),
        );
        await pay(document, 30);
        assert.equal((await mailer.processQueue()).sent, 0);
        const row = await savedMessage(queued.message);
        assert.equal(row.status, 'held');
        assert.equal(row.first_attempt_at, null);
        assert.equal((await db.models.documents.findById(document.id)).balanceDue, 70);
        assert.equal((await mailer.get(row.id)).canRetry, false);
        assert.equal(deliveries.length, 0);
      },
    );

    await t.test(
      'a changed due date invalidates an unattempted reminder instead of reusing its old rule',
      async () => {
        const document = await invoice();
        const queued = await reminders.enqueueManual(document.id, target(document));
        await call(`/documents/${document.id}`, 'PUT', { ...document, dueDate: '2026-10-12' });
        await mailer.processQueue();
        assert.equal((await savedMessage(queued.message)).status, 'held');
        assert.equal((await mailer.get(queued.message.id)).canRetry, false);
        await assert.rejects(reminders.enqueueManual(document.id, target(document)), { status: 409 });
        assert.equal(deliveries.length, 0);
      },
    );

    await t.test('manual daily deduplication and automatic due rules follow midnight in India', async () => {
      instant = new Date('2026-10-09T20:00:00.000Z');
      const document = await invoice();
      const first = await reminders.enqueueManual(document.id, target(document));
      assert.equal(first.message.reminder.scheduledFor, '2026-10-10');
      await policy(true, [0]);
      assert.equal((await reminders.processDue()).queued, 1);
      instant = new Date('2026-10-10T18:29:59.000Z');
      assert.equal(
        (await reminders.enqueueManual(document.id, target(document))).message.id,
        first.message.id,
      );
      instant = new Date('2026-10-10T18:30:00.000Z');
      const nextDay = await reminders.enqueueManual(document.id, target(document));
      assert.equal(nextDay.duplicate, false);
      assert.notEqual(nextDay.message.id, first.message.id);
      assert.equal(nextDay.message.reminder.scheduledFor, '2026-10-11');
      assert.equal((await reminders.processDue()).queued, 0);
    });

    await t.test(
      'an unavailable business sender disables actions and cannot enable automatic reminders',
      async () => {
        const document = await invoice();
        const unavailable = createPaymentReminders({
          db,
          now,
          mailer: {
            ...mailer,
            status: async () => ({
              configured: false,
              provider: 'resend',
              from: '',
              organizationId,
              reason: 'Fixture sender is unavailable.',
            }),
          },
        });
        try {
          const listed = await unavailable.list(organizationId);
          assert.equal(listed.items[0].canSend, false);
          assert.equal(listed.counters.unavailableCount, 1);
          await assert.rejects(unavailable.enqueueManual(document.id, target(document)), { status: 503 });
          await assert.rejects(
            unavailable.updatePolicy(organizationId, { version: 0, enabled: true, offsets: [0] }),
            { status: 503 },
          );
          assert.equal((await reminderRows()).length, 0);
        } finally {
          await unavailable.stop();
        }
      },
    );

    await t.test(
      'a payment during slow PDF work defers an unpaid reminder and prepares it again',
      async () => {
        const document = await invoice();
        const queued = await reminders.enqueueManual(document.id, target(document));
        const started = deferred();
        const release = deferred();
        let renderCount = 0;
        const worker = customMailer({
          renderInvoiceAttachment: async (record) => {
            renderCount += 1;
            if (renderCount === 1) {
              started.resolve();
              await release.promise;
            }
            return {
              filename: 'invoice.pdf',
              content: Buffer.from(String(record.balanceDue)).toString('base64'),
            };
          },
        });
        const run = worker.processQueue();
        try {
          await started.promise;
          await pay(document, 25);
          release.resolve();
          await run;
          const deferredRow = await savedMessage(queued.message);
          assert.equal(deferredRow.status, 'queued');
          assert.equal(deferredRow.first_attempt_at, null);
          assert.equal(deferredRow.attempts, 0);
          assert.equal(deliveries.length, 0);
          instant = new Date(instant.getTime() + 61_000);
          assert.equal((await worker.processQueue()).sent, 1);
          assert.equal(renderCount, 2);
          assert.match(deliveries[0].body.text, /attached again with the amount and payment details/);
          assert.equal(Buffer.from(deliveries[0].body.attachments[0].content, 'base64').toString(), '75');
        } finally {
          release.resolve();
          await run;
          await worker.stop({ graceMs: 0 });
        }
      },
    );

    await t.test('a fully paid invoice during PDF preparation never reaches provider transport', async () => {
      const document = await invoice();
      const queued = await reminders.enqueueManual(document.id, target(document));
      const started = deferred();
      const release = deferred();
      const worker = customMailer({
        renderInvoiceAttachment: async () => {
          started.resolve();
          await release.promise;
          return { filename: 'invoice.pdf', content: 'JVBERg==' };
        },
      });
      const run = worker.processQueue();
      try {
        await started.promise;
        await pay(document, 100);
        release.resolve();
        await run;
        const row = await savedMessage(queued.message);
        assert.equal(row.status, 'held');
        assert.equal(row.first_attempt_at, null);
        assert.equal(deliveries.length, 0);
      } finally {
        release.resolve();
        await run;
        await worker.stop({ graceMs: 0 });
      }
    });

    await t.test(
      'automatic opt-in is distinct, concurrent schedules deduplicate, and edits hold old unattempted rules',
      async () => {
        for (const dueDate of ['2026-10-13', '2026-10-10', '2026-10-07', '2026-10-03', '2026-10-02'])
          await invoice({ dueDate });
        assert.equal((await reminders.processDue()).queued, 0);
        const enabled = await policy(true);
        assert.equal(enabled.version, 1);
        const scheduler = createPaymentReminders({ db, mailer, now });
        try {
          const passes = await Promise.all([reminders.processDue(), scheduler.processDue()]);
          assert.equal(
            passes.reduce((sum, value) => sum + value.queued, 0),
            4,
          );
          const rows = await reminderRows();
          assert.equal(rows.length, 4);
          assert.ok(rows.every((row) => row.status === 'queued' && row.payload.reminder.automatic));
          assert.equal((await policy(false)).version, 2);
          assert.ok((await reminderRows()).every((row) => row.status === 'held' && row.claim_token === null));
          assert.equal((await policy(true)).version, 3);
          assert.equal((await reminders.processDue()).queued, 0);
          assert.equal((await reminderRows()).length, 4);
          for (const row of rows) assert.equal((await mailer.get(row.id)).canRetry, false);
          await assert.rejects(
            reminders.updatePolicy(organizationId, { enabled: false, version: 1, offsets: [0] }),
            { status: 409 },
          );
        } finally {
          await scheduler.stop();
        }
      },
    );

    await t.test(
      'a policy disable after the scheduler reads its snapshot prevents a concurrent enqueue',
      async () => {
        await invoice();
        await policy(true);
        const started = deferred();
        const release = deferred();
        const scheduler = createPaymentReminders({
          db,
          now,
          mailer: {
            ...mailer,
            status: async (id) => {
              started.resolve();
              await release.promise;
              return await mailer.status(id);
            },
          },
        });
        const run = scheduler.processDue();
        try {
          await started.promise;
          await policy(false);
          release.resolve();
          assert.equal((await run).queued, 0);
          assert.equal((await reminderRows()).length, 0);
        } finally {
          release.resolve();
          await run;
          await scheduler.stop();
        }
      },
    );

    await t.test(
      'disabling policy while a reminder PDF is in flight revokes its claim without sending',
      async () => {
        await invoice();
        await policy(true, [0]);
        assert.equal((await reminders.processDue()).queued, 1);
        const row = (await reminderRows())[0];
        const started = deferred();
        const release = deferred();
        const worker = customMailer({
          renderInvoiceAttachment: async () => {
            started.resolve();
            await release.promise;
            return { filename: 'invoice.pdf', content: 'JVBERg==' };
          },
        });
        const run = worker.processQueue();
        try {
          await started.promise;
          await policy(false, [0]);
          release.resolve();
          await run;
          assert.equal((await db.models.email.findById(row.id)).status, 'held');
          assert.equal(deliveries.length, 0);
        } finally {
          release.resolve();
          await run;
          await worker.stop({ graceMs: 0 });
        }
      },
    );

    await t.test(
      'an uncertain attempted reminder preserves exact provider identity after payment and policy disable',
      async () => {
        const document = await invoice();
        await policy(true, [0]);
        await reminders.processDue();
        const worker = customMailer();
        try {
          loseResponse = true;
          await worker.processQueue();
          const before = (await reminderRows())[0];
          assert.ok(before.first_attempt_at);
          assert.equal(before.status, 'queued');
          await pay(document, 100);
          await policy(false, [0]);
          const heldCheck = await db.models.email.findById(before.id);
          assert.equal(heldCheck.status, 'queued');
          instant = new Date(instant.getTime() + 61_000);
          loseResponse = false;
          assert.equal((await worker.processQueue()).sent, 1);
          assert.equal(deliveries.length, 2);
          assert.deepEqual(deliveries[1], deliveries[0]);
          const after = await db.models.email.findById(before.id);
          assert.equal(after.first_attempt_at, before.first_attempt_at);
          assert.deepEqual(after.payload, {
            organizationId: before.payload.organizationId,
            reminder: before.payload.reminder,
          });
          assert.equal(after.status, 'sent');
        } finally {
          await worker.stop({ graceMs: 0 });
        }
      },
    );

    await t.test('new reminder preparation writes reject a worker whose claim was replaced', async () => {
      const document = await invoice();
      await reminders.enqueueManual(document.id, target(document));
      const at = now().toISOString();
      const a = await db.models.email.claim(
        at,
        new Date(instant.getTime() + 300_000).toISOString(),
        at,
        at,
        randomUUID(),
      );
      await db
        .collection('email_outbox')
        .updateOne({ id: a.id }, { $set: { lease_until: new Date(instant.getTime() - 1).toISOString() } });
      const b = await db.models.email.claim(
        at,
        new Date(instant.getTime() + 300_000).toISOString(),
        at,
        at,
        randomUUID(),
      );
      assert.notEqual(a.claim_token, b.claim_token);
      assert.equal(
        (
          await db.models.email.setReminderPayload(
            { broken: true },
            'other@example.test',
            'stale',
            a.id,
            a.claim_token,
            at,
          )
        ).changes,
        0,
      );
      assert.equal(
        (await db.models.email.deferReminderPreparation('stale', at, at, a.id, a.claim_token)).changes,
        0,
      );
      const current = await db.models.email.findById(a.id);
      assert.equal(current.claim_token, b.claim_token);
      assert.deepEqual(current.payload, b.payload);
      await db.models.email.releaseClaim(at, at, b.id, b.claim_token);
    });

    await t.test('scheduler stop drains its current enqueue and does not start the next target', async () => {
      await invoice();
      await invoice();
      await policy(true, [0]);
      const started = deferred();
      const release = deferred();
      const scheduler = createPaymentReminders({
        db,
        now,
        mailer: {
          ...mailer,
          enqueueReminder: async (...args) => {
            const message = await mailer.enqueueReminder(...args);
            started.resolve();
            await release.promise;
            return message;
          },
        },
      });
      const run = scheduler.processDue();
      try {
        await started.promise;
        const stopping = scheduler.stop();
        release.resolve();
        const result = await run;
        await stopping;
        assert.equal(result.queued, 1);
        assert.equal(result.stopped, true);
        assert.equal((await reminderRows()).length, 1);
        assert.equal((await scheduler.processDue()).stopped, true);
      } finally {
        release.resolve();
        await run;
        await scheduler.stop();
      }
    });

    await t.test(
      'reminder history is paginated and scoped while policy validation rejects malformed schedules',
      async () => {
        const document = await invoice();
        const { message } = await reminders.enqueueManual(document.id, target(document));
        const original = await savedMessage(message);
        const { _id, ...record } = original;
        await db.collection('email_outbox').insertMany(
          Array.from({ length: 55 }, (_, index) => ({
            ...structuredClone(record),
            id: randomUUID(),
            event_key: `history-fixture:${index}`,
            created_at: new Date(instant.getTime() + index + 1).toISOString(),
            payload: {
              ...structuredClone(record.payload),
              organizationId: index === 54 ? 'at-facilities' : organizationId,
            },
          })),
        );
        const first = await call(`/reminders/history?organizationId=${organizationId}`);
        assert.equal(first.messages.length, 50);
        assert.equal(first.pagination.total, 55);
        assert.ok(first.messages.every((row) => row.to === buyer.email && row.reminder && !row.payload));
        const second = await call(`/reminders/history?organizationId=${organizationId}&page=2`);
        assert.equal(second.messages.length, 5);
        assert.equal(second.pagination.page, 2);
        const clamped = await reminders.history(organizationId, { page: '999' });
        assert.equal(clamped.pagination.page, 2);
        for (const offsets of [[0, 0], [-31], [91], []])
          await call('/reminders/policy', 'PUT', { organizationId, enabled: true, version: 0, offsets }, 400);
        await call(
          `/documents/${document.id}/reminders`,
          'POST',
          { installmentId: null, dueDate: '2026-10-11' },
          409,
        );
      },
    );
  },
);

test(
  'Reminder routes allow scoped staff sends and reserve automatic policy changes for administrators',
  settings,
  async (t) => {
    const fixture = await createFixture(t, {
      environment: {
        INITIAL_ADMIN_EMAIL: 'reminder-admin@example.test',
        INITIAL_ADMIN_PASSWORD: 'SyntheticAdminChecks123!',
        INITIAL_ADMIN_NAME: 'Reminder Admin',
        RESEND_API_KEY: 'fixture_reminder_key',
        EMAIL_FROM: 'Venturecore <reminders@example.test>',
        EMAIL_AUTOMATION: 'false',
      },
      now: () => new Date('2026-10-10T10:00:00Z'),
      emailFetch: async () => {
        throw new Error('No provider transport in access tests.');
      },
    });
    let cookie = '';
    async function api(path, method = 'GET', input, expected = 200, session = cookie) {
      const response = await fetch(fixture.base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', cookie: session },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const result = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return result;
    }
    await api('/auth/login', 'POST', {
      email: fixture.environment.INITIAL_ADMIN_EMAIL,
      password: fixture.environment.INITIAL_ADMIN_PASSWORD,
    });
    const invoices = [];
    for (const id of [organizationId, 'at-facilities']) {
      const customer = await api(
        '/customers',
        'POST',
        {
          organizationId: id,
          name: 'Scoped Buyer',
          email: 'buyer@example.test',
          phone: '',
          gstin: '',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: '',
        },
        201,
      );
      invoices.push(
        await api(
          '/documents',
          'POST',
          {
            requestId: randomUUID(),
            organizationId: id,
            customerId: customer.id,
            kind: 'invoice',
            status: 'sent',
            issueDate: '2026-10-01',
            dueDate: '2026-10-10',
            title: 'Scoped reminder invoice',
            items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
            discountPercent: 0,
            placeOfSupply: '09',
            notes: '',
            terms: '',
          },
          201,
        ),
      );
    }
    await api(
      '/auth/signup',
      'POST',
      {
        name: 'Reminder Staff',
        email: 'reminder-staff@example.test',
        password: 'SyntheticStaffChecks123!',
        company: 'Test',
      },
      202,
    );
    const staff = (await api('/auth/users')).find((row) => row.email === 'reminder-staff@example.test');
    await api('/auth/users/' + staff.id, 'PATCH', {
      role: 'staff',
      status: 'active',
      organizationIds: [organizationId],
    });
    await api('/auth/login', 'POST', { email: staff.email, password: 'SyntheticStaffChecks123!' }, 200, '');
    await api(`/reminders?organizationId=${organizationId}`);
    await api(`/reminders/history?organizationId=at-facilities`, 'GET', undefined, 403);
    await api(`/reminders?organizationId=at-facilities`, 'GET', undefined, 403);
    await api('/reminders/policy', 'PUT', { organizationId, enabled: true, version: 0, offsets: [0] }, 403);
    await api(`/documents/${invoices[0].id}/reminder-preview`);
    await api(
      `/documents/${invoices[0].id}/reminders`,
      'POST',
      { installmentId: null, dueDate: invoices[0].dueDate },
      202,
    );
    await api(`/documents/${invoices[1].id}/reminder-preview`, 'GET', undefined, 403);
    await api(
      `/documents/${invoices[1].id}/reminders`,
      'POST',
      { installmentId: null, dueDate: invoices[1].dueDate },
      403,
    );
  },
);
