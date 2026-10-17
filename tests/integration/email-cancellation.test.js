/** Integration tests: email delivery rules for cancelled documents and frozen retries. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMailer } from '../../src/services/integrations/email/mailer.js';
import { createFixture, integrationEnabled } from './fixture.js';

test(
  'MongoDB cancelled-document email eligibility and frozen delivery retries',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    const environment = {
      RESEND_API_KEY: 'fixture_email_key',
      EMAIL_FROM: 'Venturecore <billing@example.test>',
      EMAIL_AUTOMATION: 'true',
    };
    const now = () => new Date('2026-10-10T10:00:00.000Z');
    const deliveries = [];
    let rejectDelivery = false;
    async function emailFetch(url, init) {
      assert.equal(url, 'https://api.resend.com/emails');
      deliveries.push({ headers: structuredClone(init.headers), body: JSON.parse(init.body) });
      if (rejectDelivery) throw new Error('Fixture: provider response was lost.');
      return Response.json({ id: `email_${deliveries.length}` });
    }
    const fixture = await createFixture(t, { environment, auth: false, emailFetch, now });
    const { backend, base } = fixture;
    const { db, mailer } = backend;
    async function call(path, method = 'GET', body, status = 200) {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    const organizationId = 'pipeline2-legal';
    const customer = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Cancellation test customer',
        email: 'recipient@example.test',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    async function invoice(status = 'sent') {
      return await call(
        '/documents',
        'POST',
        {
          requestId: randomUUID(),
          organizationId,
          customerId: customer.id,
          kind: 'invoice',
          status,
          issueDate: '2026-10-10',
          dueDate: '',
          title: 'Email cancellation regression',
          items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
        201,
      );
    }
    async function cancel(document) {
      const current = await db.models.documents.findById(document.id);
      return await call('/documents/' + current.id, 'PUT', { ...current, status: 'cancelled' });
    }
    async function issuedMessage(document) {
      return await db.models.email.findByEvent(`invoice-issued:${document.id}`);
    }
    const customMailer = (overrides = {}) =>
      createMailer(db, {
        env: fixture.environment,
        now,
        fetch: emailFetch,
        getOrganization: (id) => db.models.organizations.findById(id),
        ...overrides,
      });
    const queueCount = () => db.collection('email_outbox').countDocuments({ status: 'queued' });
    t.beforeEach(async () => {
      // Each scenario owns its outbox. A failed fixture must not leave a queued
      // message that a later scenario accidentally processes.
      await db.collection('email_outbox').deleteMany({});
    });

    await t.test('an active invoice still sends its actual PDF once', async () => {
      const document = await invoice();
      const before = deliveries.length;
      const result = await mailer.processQueue();
      assert.equal(result.sent, 1);
      assert.equal(deliveries.length, before + 1);
      assert.match(deliveries.at(-1).body.text, new RegExp(document.number));
      assert.equal(
        Buffer.from(deliveries.at(-1).body.attachments[0].content, 'base64').subarray(0, 4).toString(),
        '%PDF',
      );
      assert.equal((await issuedMessage(document)).status, 'sent');
      await mailer.processQueue();
      assert.equal(deliveries.length, before + 1);
    });

    await t.test(
      'API cancellation holds all unattempted invoice and payment messages atomically',
      async () => {
        const document = await invoice();
        await mailer.enqueuePayment(document, {
          eventKey: `fixture-failed:${document.id}`,
          outcome: 'failed',
          automatic: true,
        });
        const payments = [];
        for (const amount of [25, 75]) {
          const details = await call(
            '/documents/' + document.id + '/payments',
            'POST',
            {
              amount,
              paidOn: '2026-10-10',
              method: 'upi',
              reference: 'fixture',
              notes: '',
              requestId: randomUUID(),
            },
            201,
          );
          payments.push(details.payments.find((payment) => payment.amount === amount));
        }
        for (const payment of payments)
          await call('/payments/' + payment.id + '/void', 'POST', {
            reason: 'Fixture reversal before cancellation',
          });
        assert.deepEqual(
          new Set((await db.models.email.list(document.id)).map((row) => row.kind)),
          new Set(['invoice', 'payment_failed', 'payment_received', 'payment_paid']),
        );
        await cancel(document);
        const rows = await db.models.email.list(document.id);
        assert.equal(rows.length, 4);
        for (const row of rows) {
          assert.equal(row.status, 'held');
          assert.equal(row.first_attempt_at, null);
          assert.equal(row.next_attempt_at, null);
          assert.match(row.last_error, /cancelled/i);
          assert.equal((await mailer.get(row.id)).canRetry, false);
          await assert.rejects(
            mailer.retry(row.id),
            (error) => error.status === 409 && /cancelled/i.test(error.message),
          );
        }
        const before = deliveries.length;
        await mailer.processQueue();
        assert.equal(deliveries.length, before);
      },
    );

    await t.test(
      'worker checks pre-existing cancelled snapshots with and without gateway resolution',
      async () => {
        let resolutions = 0;
        const worker = customMailer({
          resolveInvoicePaymentUrl: async () => {
            resolutions++;
            throw new Error('Cancelled documents must never reach gateway resolution.');
          },
        });
        for (const resolvePaymentLink of [false, true]) {
          const document = await invoice();
          const queued = await issuedMessage(document);
          const savedPayload = { ...queued.payload, resolvePaymentLink };
          await db.models.email.setPayload(savedPayload, queued.id);
          // Represents a message already saved by an older application version:
          // there was no cancellation hook when this document became cancelled.
          await db.transaction(async () => {
            const result = await db.models.documents.save(
              { ...document, status: 'cancelled', version: document.version + 1 },
              document.version,
            );
            assert.equal(result.changes, 1);
          });
          const before = deliveries.length;
          await worker.processQueue();
          const held = await db.models.email.findById(queued.id);
          assert.equal(held.status, 'held');
          assert.equal(held.first_attempt_at, null);
          assert.deepEqual(held.payload, savedPayload);
          assert.match(held.last_error, /cancelled/i);
          assert.equal(deliveries.length, before);
        }
        assert.equal(resolutions, 0);
      },
    );

    for (const failPreparation of [false, true]) {
      await t.test(
        `cancellation during PDF preparation prevents transport${failPreparation ? ' even when preparation fails' : ''}`,
        async () => {
          const document = await invoice();
          const queued = await issuedMessage(document);
          const entered = Promise.withResolvers();
          const release = Promise.withResolvers();
          const worker = customMailer({
            renderInvoiceAttachment: async () => {
              entered.resolve();
              await release.promise;
              if (failPreparation) throw new Error('Fixture PDF failure.');
              return { filename: 'fixture.pdf', content: Buffer.from('%PDF fixture').toString('base64') };
            },
          });
          const before = deliveries.length;
          const processing = worker.processQueue();
          try {
            await entered.promise;
            assert.equal((await db.models.email.findById(queued.id)).status, 'sending');
            await cancel(document);
            assert.equal((await db.models.email.findById(queued.id)).status, 'held');
          } finally {
            release.resolve();
            await processing;
          }
          const held = await db.models.email.findById(queued.id);
          assert.equal(held.status, 'held');
          assert.equal(held.first_attempt_at, null);
          assert.deepEqual(held.payload, queued.payload);
          assert.match(held.last_error, /cancelled/i);
          assert.equal(deliveries.length, before);
        },
      );
    }

    await t.test('eligibility is checked again immediately before first provider transport', async () => {
      const document = await invoice();
      const queued = await issuedMessage(document);
      const worker = customMailer({
        renderInvoiceAttachment: async () => {
          // Bypass the hook to prove the final transport check itself protects
          // an existing claimed row when its document changes during preparation.
          await db.transaction(async () => {
            const result = await db.models.documents.save(
              { ...document, status: 'cancelled', version: document.version + 1 },
              document.version,
            );
            assert.equal(result.changes, 1);
          });
          return { filename: 'fixture.pdf', content: Buffer.from('%PDF fixture').toString('base64') };
        },
      });
      const before = deliveries.length;
      await worker.processQueue();
      const held = await db.models.email.findById(queued.id);
      assert.equal(held.status, 'held');
      assert.equal(held.first_attempt_at, null);
      assert.match(held.last_error, /cancelled/i);
      assert.equal(deliveries.length, before);
    });

    await t.test(
      'an uncertain attempted delivery keeps its exact request and key after cancellation',
      async () => {
        const document = await invoice();
        const queued = await issuedMessage(document);
        await db.models.email.setPayload({ ...queued.payload, resolvePaymentLink: true }, queued.id);
        let resolutions = 0;
        let attachments = 0;
        const worker = customMailer({
          resolveInvoicePaymentUrl: async (snapshot) => {
            resolutions++;
            return { document: snapshot, paymentUrl: 'https://rzp.io/fixture-email' };
          },
          renderInvoiceAttachment: async () => {
            attachments++;
            return { filename: 'frozen.pdf', content: Buffer.from('%PDF original').toString('base64') };
          },
        });
        rejectDelivery = true;
        try {
          await worker.processQueue();
        } finally {
          rejectDelivery = false;
        }
        const attempted = await db.models.email.findById(queued.id);
        assert.equal(attempted.status, 'queued');
        assert.ok(attempted.first_attempt_at);
        const request = structuredClone(deliveries.at(-1));
        await cancel(document);
        assert.equal((await db.models.email.findById(queued.id)).status, 'queued');
        await db
          .collection('email_outbox')
          .updateOne({ id: queued.id }, { $set: { status: 'failed', next_attempt_at: null } });
        assert.equal((await worker.get(queued.id)).canRetry, true);
        await worker.retry(queued.id);
        await worker.processQueue();
        const sent = await db.models.email.findById(queued.id);
        assert.equal(sent.status, 'sent');
        assert.equal(sent.first_attempt_at, attempted.first_attempt_at);
        assert.deepEqual(sent.payload, attempted.payload);
        assert.deepEqual(deliveries.at(-1), request);
        assert.equal(resolutions, 1);
        assert.equal(attachments, 1);
      },
    );

    await t.test('cancellation cannot retract an email already accepted by provider transport', async () => {
      const document = await invoice();
      const queued = await issuedMessage(document);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const worker = customMailer({
        fetch: async (url, init) => {
          const response = await emailFetch(url, init);
          entered.resolve();
          await release.promise;
          return response;
        },
      });
      const before = deliveries.length;
      const processing = worker.processQueue();
      try {
        await entered.promise;
        const sending = await db.models.email.findById(queued.id);
        assert.equal(sending.status, 'sending');
        assert.ok(sending.first_attempt_at);
        await cancel(document);
        assert.equal((await db.models.email.findById(queued.id)).status, 'sending');
      } finally {
        release.resolve();
        await processing;
      }
      assert.equal(deliveries.length, before + 1);
      assert.equal((await db.models.email.findById(queued.id)).status, 'sent');
    });

    await t.test('a failed cancellation transaction also rolls back its outbox hold', async () => {
      const document = await invoice();
      const queued = await issuedMessage(document);
      await assert.rejects(
        db.transaction(async () => {
          const cancelled = { ...document, status: 'cancelled', version: document.version + 1 };
          const result = await db.models.documents.save(cancelled, document.version);
          assert.equal(result.changes, 1);
          await mailer.holdCancelledDocument(cancelled);
          assert.equal((await db.models.email.findById(queued.id)).status, 'held');
          throw new Error('Fixture transaction rollback.');
        }),
        /Fixture transaction rollback/,
      );
      assert.equal((await db.models.documents.findById(document.id)).status, 'sent');
      assert.equal((await db.models.email.findById(queued.id)).status, 'queued');
      const before = deliveries.length;
      await mailer.processQueue();
      assert.equal(deliveries.length, before + 1);
      assert.equal((await db.models.email.findById(queued.id)).status, 'sent');
    });

    await t.test('newly enqueued stale snapshots and invalid draft/deleted documents stay held', async () => {
      const stale = await invoice();
      await cancel(stale);
      const message = await mailer.enqueueInvoice(stale, { eventKey: `fixture-stale:${stale.id}` });
      assert.equal(message.status, 'held');
      assert.equal(message.canRetry, false);
      assert.match(message.lastError, /cancelled/i);

      const draft = await invoice('draft');
      const draftMessage = await mailer.enqueueInvoice(draft, { eventKey: `fixture-draft:${draft.id}` });
      assert.equal(draftMessage.status, 'held');
      assert.equal(draftMessage.canRetry, false);
      assert.match(draftMessage.lastError, /draft/i);

      const deleted = await invoice();
      const queued = await issuedMessage(deleted);
      await db.models.documents.remove(deleted.id);
      const before = deliveries.length;
      await mailer.processQueue();
      assert.equal(deliveries.length, before);
      const missing = await mailer.get(queued.id);
      assert.equal(missing.status, 'held');
      assert.equal(missing.canRetry, false);
      assert.match(missing.lastError, /no longer exists/i);
    });

    await t.test('password reset delivery remains independent of document eligibility', async () => {
      const message = await mailer.enqueuePasswordReset({
        to: 'recipient@example.test',
        name: 'Recipient',
        resetUrl: 'https://workspace.example.test/reset-password?token=fixture',
        eventKey: 'fixture-password-reset:' + randomUUID(),
      });
      assert.equal(message.status, 'queued');
      const before = deliveries.length;
      await mailer.processQueue();
      assert.equal(deliveries.length, before + 1);
      assert.equal((await mailer.get(message.id)).status, 'sent');
    });
    assert.equal(await queueCount(), 0);
  },
);
