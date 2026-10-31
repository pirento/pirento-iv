/** Integration tests: the real runtime runs recurring invoices and reminders, then drains before closing MongoDB. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MongoNotConnectedError } from 'mongodb';
import { createApplication } from '../../src/app.js';
import { createHttpRuntime } from '../../src/services/operations/http-runtime.js';
import { createLogger } from '../../src/services/operations/logger.js';
import { createFixture, integrationEnabled } from './fixture.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 20_000,
};

async function waitFor(check, description) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

test(
  'The real runtime starts recurring generation and reminder delivery automatically, then drains before closing MongoDB',
  settings,
  async (t) => {
    const now = () => new Date('2026-10-10T10:00:00.000Z');
    const organizationId = 'pipeline2-legal';
    const deliveries = [];
    const logs = [];
    let releaseProvider;
    const providerGate = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const emailFetch = async (url, init) => {
      deliveries.push({ url, headers: structuredClone(init.headers), body: JSON.parse(init.body) });
      await providerGate;
      return Response.json({ id: 'synthetic_runtime_reminder' });
    };
    const fixture = await createFixture(t, {
      auth: false,
      now,
      emailFetch,
      environment: {
        RESEND_API_KEY: 'synthetic_runtime_reminder_key',
        EMAIL_FROM: 'Billing <runtime@example.test>',
        // Reminder policy opt-in is independent of invoice/receipt automation.
        EMAIL_AUTOMATION: 'false',
      },
    });
    const db = fixture.backend.db;
    async function request(path, method, input, status) {
      const response = await fetch(`${fixture.base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
      return value;
    }

    const buyer = await request(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Runtime reminder buyer',
        email: 'runtime-buyer@example.test',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    async function invoice(status, title, dueDate) {
      return await request(
        '/documents',
        'POST',
        {
          requestId: randomUUID(),
          organizationId,
          customerId: buyer.id,
          kind: 'invoice',
          status,
          issueDate: '2026-10-01',
          dueDate,
          title,
          items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
        201,
      );
    }
    const source = await invoice('draft', 'Recurring runtime source', '2026-10-31');
    const dueInvoice = await invoice('sent', 'Due runtime reminder', '2026-10-10');
    const { schedule } = await request(
      '/recurring-invoices',
      'POST',
      {
        organizationId,
        sourceDocumentId: source.id,
        sourceVersion: source.version,
        requestId: randomUUID(),
        name: 'Runtime monthly service',
        frequency: 'monthly',
        startDate: '2026-10-10',
        dueDays: 30,
        endDate: '',
        maxOccurrences: 2,
        active: true,
      },
      201,
    );
    const { policy } = await request(
      '/reminders/policy',
      'PUT',
      { organizationId, version: 0, enabled: true, offsets: [0] },
      200,
    );
    assert.equal(policy.enabled, true);
    assert.equal(await db.collection('recurring_invoice_occurrences').countDocuments({}), 0);
    assert.equal(await db.collection('email_outbox').countDocuments({ kind: 'payment_reminder' }), 0);
    assert.equal(deliveries.length, 0);
    await new Promise((resolve) => fixture.server.close(resolve));

    let application;
    let runtime;
    try {
      // This application owns a distinct MongoDB client. The fixture client remains
      // open only to inspect durable results after runtime shutdown closes its client.
      application = await createApplication({
        auth: false,
        now,
        environment: fixture.environment,
        emailFetch,
        logger: createLogger({ write: (line) => logs.push(JSON.parse(line)) }),
      });
      runtime = createHttpRuntime(application, {
        host: '127.0.0.1',
        port: 0,
        shutdownGraceMs: 8_000,
      });
      await runtime.ready;
      // Only the real runtime invokes the automation runner and email worker.
      await waitFor(() => deliveries.length > 0, 'the initial automatic reminder transport');

      const occurrences = await db.collection('recurring_invoice_occurrences').find({}).toArray();
      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0].scheduleId, schedule.id);
      assert.equal(occurrences[0].scheduledDate, '2026-10-10');
      assert.equal(occurrences[0].status, 'generated');
      const draft = await db.models.documents.findById(occurrences[0].documentId);
      assert.equal(draft.status, 'draft');
      assert.equal(draft.title, source.title);
      assert.equal(draft.totals.total, 100);
      assert.equal(draft.amountPaid, 0);
      assert.equal(draft.balanceDue, 100);
      assert.equal(draft.issueDate, '2026-10-10');
      assert.equal(draft.dueDate, '2026-11-09');
      assert.equal(await db.collection('documents').countDocuments({ recurringScheduleId: schedule.id }), 1);
      const advanced = await db.collection('recurring_invoice_schedules').findOne({ id: schedule.id });
      assert.equal(advanced.generatedCount, 1);
      assert.equal(advanced.nextDate, '2026-11-10');

      const reminder = await db.collection('email_outbox').findOne({ kind: 'payment_reminder' });
      assert.equal(reminder.document_id, dueInvoice.id);
      assert.equal(reminder.status, 'sending');
      assert.equal(reminder.first_attempt_at, now().toISOString());
      assert.equal(reminder.payload.reminder.automatic, true);
      assert.equal(reminder.payload.reminder.offset, 0);
      assert.equal(reminder.payload.reminder.policyVersion, policy.version);
      assert.equal(reminder.payload.reminder.scheduledFor, '2026-10-10');
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].url, 'https://api.resend.com/emails');
      assert.equal(deliveries[0].headers['Idempotency-Key'], `venturecore-email/${reminder.id}`);
      assert.deepEqual(deliveries[0].body.to, [buyer.email]);
      assert.match(deliveries[0].body.subject, /Payment reminder/);
      assert.match(deliveries[0].body.text, /100\.00 remains due on 10 Oct 2026/);
      assert.equal(
        Buffer.from(deliveries[0].body.attachments[0].content, 'base64').subarray(0, 4).toString(),
        '%PDF',
      );

      let stopped = false;
      const stopping = runtime.stop('automatic_runtime_test');
      stopping.then(() => {
        stopped = true;
      });
      await delay(0);
      assert.equal((await application.readiness.check()).state, 'draining');
      assert.equal(stopped, false, 'Shutdown must wait for the in-flight reminder response.');
      assert.equal((await application.db.database.command({ ping: 1 }, { timeoutMS: 500 })).ok, 1);
      releaseProvider();
      assert.deepEqual(await stopping, { forced: false, failed: false });
      assert.equal(runtime.stop('repeat_stop'), stopping);
      assert.equal(runtime.server.listening, false);
      assert.equal((await application.readiness.check()).state, 'stopped');
      await assert.rejects(
        application.db.database.command({ ping: 1 }, { timeoutMS: 500 }),
        MongoNotConnectedError,
      );

      const persisted = await db.collection('email_outbox').find({ kind: 'payment_reminder' }).toArray();
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].id, reminder.id);
      assert.equal(persisted[0].status, 'sent');
      assert.equal(persisted[0].provider_id, 'synthetic_runtime_reminder');
      assert.equal(persisted[0].attempts, 1);
      assert.equal(persisted[0].claim_token, null);
      assert.equal(persisted[0].lease_until, null);
      assert.equal(persisted[0].first_attempt_at, reminder.first_attempt_at);
      assert.equal(deliveries.length, 1);
      assert.equal(await db.collection('recurring_invoice_occurrences').countDocuments({}), 1);
      assert.equal(await db.collection('documents').countDocuments({}), 3);
      assert.equal(await db.collection('payments').countDocuments({}), 0);
      assert.equal(await db.collection('online_payment_links').countDocuments({}), 0);
      assert.equal(await db.collection('cashfree_payment_links').countDocuments({}), 0);
      assert.ok(logs.some((entry) => entry.event === 'shutdown_completed' && entry.forced === false));
      assert.deepEqual(
        logs.filter((entry) => entry.level === 'error'),
        [],
      );
    } finally {
      releaseProvider();
      await runtime?.stop('automatic_runtime_cleanup');
      await application?.close();
    }
  },
);
