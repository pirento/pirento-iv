/** Integration tests: email outbox claim leases, heartbeat renewal and shutdown recovery. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createMailer } from '../../src/services/integrations/email/mailer.js';
import { createFixture, integrationEnabled } from './fixture.js';

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 8_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const pdf = (label) => ({
  filename: 'fixture.pdf',
  content: Buffer.from('%PDF ' + label).toString('base64'),
});

test(
  'MongoDB email claim fencing, heartbeat renewal and shutdown recovery',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    const environment = {
      RESEND_API_KEY: 'fixture_email_lease_key',
      EMAIL_FROM: 'Venturecore <billing@example.test>',
      EMAIL_AUTOMATION: 'true',
    };
    const requests = [];
    const accepted = new Map();
    const workers = new Set();
    function recordRequest(url, init) {
      assert.equal(url, 'https://api.resend.com/emails');
      const request = { headers: structuredClone(init.headers), body: JSON.parse(init.body) };
      requests.push(request);
      return request;
    }
    async function provider(url, init) {
      const request = recordRequest(url, init);
      const key = request.headers['Idempotency-Key'];
      const previous = accepted.get(key);
      if (previous) {
        assert.deepEqual(request, previous.request, 'Retry must preserve the entire provider request.');
        return Response.json({ id: previous.id });
      }
      const id = 'accepted_' + (accepted.size + 1);
      accepted.set(key, { id, request });
      return Response.json({ id });
    }
    const fixture = await createFixture(t, { environment, auth: false, emailFetch: provider });
    const { backend, base } = fixture;
    const { db } = backend;
    async function call(path, method = 'GET', body, status = 200) {
      const response = await fetch(base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, status, method + ' ' + path + ': ' + JSON.stringify(data));
      return data;
    }
    const organizationId = 'pipeline2-legal';
    const customer = await call(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Email lease customer',
        email: 'recipient@example.test',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    async function invoice() {
      const document = await call(
        '/documents',
        'POST',
        {
          requestId: randomUUID(),
          organizationId,
          customerId: customer.id,
          kind: 'invoice',
          status: 'sent',
          issueDate: '2026-10-10',
          dueDate: '',
          title: 'Email lease regression',
          items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
        201,
      );
      const row = await db.models.email.findByEvent('invoice-issued:' + document.id);
      assert.equal(row.status, 'queued');
      return row;
    }
    function worker(overrides = {}) {
      const value = createMailer(db, {
        env: fixture.environment,
        fetch: provider,
        getOrganization: (id) => db.models.organizations.findById(id),
        renderInvoiceAttachment: async () => pdf('standard'),
        ...overrides,
      });
      workers.add(value);
      return value;
    }
    async function expireClaim(row) {
      const result = await db
        .collection('email_outbox')
        .updateOne(
          { id: row.id, status: 'sending', claim_token: row.claim_token },
          { $set: { lease_until: new Date(0).toISOString() } },
        );
      assert.equal(result.matchedCount, 1);
    }
    async function dueNow(id) {
      await db
        .collection('email_outbox')
        .updateOne({ id, status: 'queued' }, { $set: { next_attempt_at: new Date(0).toISOString() } });
    }
    t.beforeEach(async () => {
      requests.length = 0;
      accepted.clear();
      await db.collection('email_outbox').deleteMany({});
    });
    t.afterEach(async () => {
      await Promise.all([...workers].map((value) => value.stop({ graceMs: 0 })));
      workers.clear();
    });

    await t.test('two independent workers claim a queued email only once', async () => {
      const row = await invoice();
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const fetch = async (url, init) => {
        const response = await provider(url, init);
        entered.resolve();
        await release.promise;
        return response;
      };
      const a = worker({ fetch }),
        b = worker({ fetch });
      const runs = [a.processQueue(), b.processQueue()];
      try {
        await within(entered.promise, 'first provider request');
        const claimed = await db.models.email.findById(row.id);
        assert.match(claimed.claim_token, /^[a-f0-9-]{36}$/);
        assert.equal(requests.length, 1);
      } finally {
        release.resolve();
      }
      const results = await Promise.all(runs);
      assert.equal(
        results.reduce((sum, value) => sum + value.processed, 0),
        1,
      );
      assert.equal(
        results.reduce((sum, value) => sum + value.sent, 0),
        1,
      );
      const sent = await db.models.email.findById(row.id);
      assert.equal(sent.status, 'sent');
      assert.equal(sent.claim_token, null);
      assert.equal(sent.lease_until, null);
    });

    for (const stage of ['PDF preparation', 'provider response']) {
      await t.test('heartbeat retains ownership during slow ' + stage, async () => {
        const row = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const a = worker({
          leaseMs: 1_500,
          renewalMs: 150,
          ...(stage === 'PDF preparation'
            ? {
                renderInvoiceAttachment: async () => {
                  entered.resolve();
                  await release.promise;
                  return pdf('slow');
                },
              }
            : {
                fetch: async (url, init) => {
                  const response = await provider(url, init);
                  entered.resolve();
                  await release.promise;
                  return response;
                },
              }),
        });
        const running = a.processQueue();
        try {
          await within(entered.promise, stage);
          const first = await db.models.email.findById(row.id);
          await delay(1_800);
          const renewed = await db.models.email.findById(row.id);
          assert.equal(renewed.claim_token, first.claim_token);
          assert.ok(renewed.lease_until > first.lease_until);
          assert.ok(renewed.lease_until > new Date().toISOString());
          assert.equal((await worker().processQueue()).processed, 0);
        } finally {
          release.resolve();
        }
        assert.equal((await running).sent, 1);
        assert.equal(requests.length, 1);
        assert.equal((await db.models.email.findById(row.id)).status, 'sent');
      });
    }

    for (const lateResult of ['success', 'failure']) {
      await t.test('a stale provider ' + lateResult + ' cannot change a recovered delivery', async () => {
        const row = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const a = worker({
          fetch: async (url, init) => {
            const response = await provider(url, init);
            entered.resolve();
            await release.promise;
            return lateResult === 'success'
              ? response
              : Response.json({ message: 'late failure' }, { status: 503 });
          },
        });
        const running = a.processQueue();
        let recovered;
        try {
          await within(entered.promise, 'old request');
          const first = await db.models.email.findById(row.id);
          await expireClaim(first);
          let nextToken;
          const b = worker({
            fetch: async (url, init) => {
              nextToken = (await db.models.email.findById(row.id)).claim_token;
              return await provider(url, init);
            },
          });
          assert.equal((await b.processQueue()).sent, 1);
          assert.notEqual(nextToken, first.claim_token);
          recovered = await db.models.email.findById(row.id);
        } finally {
          release.resolve();
        }
        const oldResult = await running;
        assert.equal(oldResult.lost, 1);
        assert.equal(oldResult.sent, 0);
        assert.equal(oldResult.failed, 0);
        assert.deepEqual(await db.models.email.findById(row.id), recovered);
        assert.equal(accepted.size, 1);
        assert.equal(requests.length, 2);
      });
    }

    for (const finalMethod of ['markSent', 'markFailed']) {
      await t.test(
        'a delayed ' + finalMethod + ' write is fenced after another worker takes over',
        async () => {
          const row = await invoice();
          const entered = Promise.withResolvers(),
            release = Promise.withResolvers(),
            completed = Promise.withResolvers();
          const original = db.models.email[finalMethod];
          let firstToken;
          db.models.email[finalMethod] = async (...args) => {
            if (args.at(-1) !== firstToken) return await original(...args);
            entered.resolve();
            try {
              await release.promise;
              return await original(...args);
            } finally {
              completed.resolve();
            }
          };
          const a = worker({
            fetch: async (url, init) => {
              firstToken = (await db.models.email.findById(row.id)).claim_token;
              const response = await provider(url, init);
              return finalMethod === 'markSent'
                ? response
                : Response.json({ message: 'retry' }, { status: 503 });
            },
          });
          const running = a.processQueue();
          let recovered;
          try {
            await within(entered.promise, 'delayed final write');
            await expireClaim(await db.models.email.findById(row.id));
            const b = worker({
              fetch: async (url, init) => {
                const response = await provider(url, init);
                return finalMethod === 'markFailed'
                  ? response
                  : Response.json({ message: 'new owner retry' }, { status: 503 });
              },
            });
            await b.processQueue();
            recovered = await db.models.email.findById(row.id);
            assert.equal(recovered.status, finalMethod === 'markFailed' ? 'sent' : 'queued');
          } finally {
            release.resolve();
            await within(completed.promise, 'final write cleanup');
            db.models.email[finalMethod] = original;
          }
          assert.equal((await running).lost, 1);
          assert.deepEqual(await db.models.email.findById(row.id), recovered);
        },
      );
    }

    await t.test(
      'renewal failure stops preparation and another worker can recover the expired claim',
      async () => {
        const row = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const original = db.models.email.renew;
        let failedToken, preparationSignal;
        db.models.email.renew = (...args) => {
          if (args.at(-1) === failedToken) throw new Error('Fixture database connection loss.');
          return original(...args);
        };
        const a = worker({
          renewalMs: 50,
          renderInvoiceAttachment: async (_, { signal }) => {
            preparationSignal = signal;
            entered.resolve();
            await release.promise;
            return pdf('old worker');
          },
        });
        const running = a.processQueue();
        try {
          await within(entered.promise, 'preparation before renewal loss');
          const claimed = await db.models.email.findById(row.id);
          failedToken = claimed.claim_token;
          assert.equal((await within(running, 'worker noticing renewal failure')).lost, 1);
          assert.equal(preparationSignal.aborted, true);
          assert.equal(requests.length, 0);
          db.models.email.renew = original;
          await expireClaim(claimed);
          assert.equal((await worker().processQueue()).sent, 1);
        } finally {
          release.resolve();
          db.models.email.renew = original;
        }
        await delay(0);
        assert.equal(requests.length, 1);
        assert.equal((await db.models.email.findById(row.id)).status, 'sent');
      },
    );

    await t.test(
      'graceful stop completes the current delivery and does not claim the next email',
      async () => {
        const first = await invoice(),
          second = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const a = worker({
          fetch: async (url, init) => {
            const response = await provider(url, init);
            entered.resolve();
            await release.promise;
            return response;
          },
        });
        const running = a.processQueue();
        let stopped;
        try {
          await within(entered.promise, 'delivery before graceful stop');
          stopped = a.stop({ graceMs: 2_000 });
          assert.equal(a.stop({ graceMs: 0 }), stopped);
          assert.equal((await a.processQueue()).processed, 0);
        } finally {
          release.resolve();
        }
        assert.equal((await running).sent, 1);
        await stopped;
        assert.equal((await db.models.email.findById(first.id)).status, 'sent');
        assert.equal((await db.models.email.findById(second.id)).status, 'queued');
        assert.equal((await worker().processQueue()).sent, 1);
        assert.equal(requests.length, 2);
      },
    );

    await t.test(
      'forced stop during PDF preparation releases an unattempted claim without sending',
      async () => {
        const row = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const a = worker({
          renderInvoiceAttachment: async () => {
            entered.resolve();
            await release.promise;
            return pdf('stopped worker');
          },
        });
        const running = a.processQueue();
        try {
          await within(entered.promise, 'PDF before forced stop');
          await within(a.stop({ graceMs: 0 }), 'forced PDF stop');
          await running;
          const released = await db.models.email.findById(row.id);
          assert.equal(released.status, 'queued');
          assert.equal(released.claim_token, null);
          assert.equal(released.first_attempt_at, null);
          assert.equal(released.attempts, 0);
          assert.deepEqual(released.payload, row.payload);
          assert.equal(requests.length, 0);
          assert.equal((await worker().processQueue()).sent, 1);
        } finally {
          release.resolve();
        }
        await delay(0);
        assert.equal(requests.length, 1);
        assert.equal((await db.models.email.findById(row.id)).status, 'sent');
      },
    );

    await t.test(
      'forced stop during accepted transport preserves the exact request on recovery',
      async () => {
        const row = await invoice();
        const entered = Promise.withResolvers(),
          release = Promise.withResolvers();
        const a = worker({
          fetch: async (url, init) => {
            const response = await provider(url, init);
            entered.resolve();
            await release.promise;
            return response;
          },
        });
        const running = a.processQueue();
        let prepared;
        try {
          await within(entered.promise, 'accepted transport before stop');
          prepared = await db.models.email.findById(row.id);
          assert.ok(prepared.first_attempt_at);
          await within(a.stop({ graceMs: 0 }), 'forced provider stop');
          await running;
          const released = await db.models.email.findById(row.id);
          assert.equal(released.status, 'queued');
          assert.equal(released.claim_token, null);
          assert.deepEqual(released.payload, prepared.payload);
          assert.equal(released.first_attempt_at, prepared.first_attempt_at);
          await dueNow(row.id);
          assert.equal((await worker().processQueue()).sent, 1);
        } finally {
          release.resolve();
        }
        await delay(0);
        const sent = await db.models.email.findById(row.id);
        assert.equal(sent.status, 'sent');
        assert.deepEqual(sent.payload, { organizationId: prepared.payload.organizationId });
        assert.equal(accepted.size, 1);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0], requests[1]);
      },
    );

    await t.test(
      'expired legacy sending rows recover, and missing tokens never become broad write filters',
      async () => {
        const row = await invoice();
        const stamp = new Date().toISOString();
        await assert.rejects(
          db.models.email.claim(stamp, new Date(Date.now() + 60_000).toISOString(), stamp, stamp),
          /claim token/,
        );
        assert.throws(() => db.models.email.markSent(stamp, stamp, 'unexpected', row.id), /claim token/);
        assert.equal((await db.models.email.findById(row.id)).status, 'queued');
        await db.collection('email_outbox').updateOne(
          { id: row.id },
          {
            $set: { status: 'sending', lease_until: null, attempts: 1 },
            $unset: { claim_token: '' },
          },
        );
        assert.equal((await worker().processQueue()).sent, 1);
        assert.equal((await db.models.email.findById(row.id)).status, 'sent');
        assert.equal(requests.length, 1);
      },
    );

    await t.test(
      'a stale claim cannot renew, change payload or overwrite any recovered terminal state',
      async () => {
        const row = await invoice();
        const at = new Date().toISOString(),
          token = randomUUID();
        const claimed = await db.models.email.claim(
          at,
          new Date(Date.now() + 60_000).toISOString(),
          at,
          at,
          token,
        );
        assert.equal(claimed.id, row.id);
        await expireClaim(claimed);
        assert.equal(
          (
            await db.models.email.renew(
              new Date().toISOString(),
              new Date(Date.now() + 60_000).toISOString(),
              row.id,
              token,
            )
          ).changes,
          0,
        );
        assert.equal((await worker().processQueue()).sent, 1);
        const completed = await db.models.email.findById(row.id);
        const stamp = new Date().toISOString();
        const writes = [
          () => db.models.email.setPayload({ corrupted: true }, row.id, token, stamp),
          () => db.models.email.setPaymentLink(1, row.id, token, stamp),
          () => db.models.email.markFirstAttempt(stamp, row.id, token),
          () => db.models.email.markSent(stamp, stamp, 'stale', row.id, token),
          () => db.models.email.markFailed('queued', stamp, stamp, 'stale', row.id, token),
          () => db.models.email.hold('stale', stamp, row.id, token),
          () => db.models.email.expireReset('stale', stamp, row.id, token),
          () => db.models.email.failUnsafeRetry('stale', stamp, row.id, token),
          () => db.models.email.releaseClaim(stamp, stamp, row.id, token),
        ];
        for (const write of writes) assert.equal((await write()).changes, 0);
        assert.deepEqual(await db.models.email.findById(row.id), completed);
      },
    );

    await t.test('only a concurrent idempotent request conflict is automatically retryable', async () => {
      const row = await invoice();
      const a = worker({
        fetch: async (url, init) => {
          recordRequest(url, init);
          return Response.json({ name: 'concurrent_idempotent_requests' }, { status: 409 });
        },
      });
      assert.equal((await a.processQueue()).failed, 0);
      assert.equal((await db.models.email.findById(row.id)).status, 'queued');
      await dueNow(row.id);
      assert.equal((await worker().processQueue()).sent, 1);
      assert.deepEqual(requests[0], requests[1]);
      const conflict = await invoice();
      const b = worker({
        fetch: async (url, init) => {
          recordRequest(url, init);
          return Response.json({ name: 'invalid_idempotent_request' }, { status: 409 });
        },
      });
      assert.equal((await b.processQueue()).failed, 1);
      assert.equal((await db.models.email.findById(conflict.id)).status, 'failed');
      assert.equal((await db.models.email.findById(conflict.id)).next_attempt_at, null);
    });

    await t.test('startup clean-up trims only emails that were already sent', async () => {
      const at = new Date().toISOString();
      const row = (id, kind, status, payload) => ({
        id,
        event_key: 'compact:' + id,
        document_id: null,
        kind,
        recipient: 'customer@example.test',
        subject: 'Compact',
        status,
        created_at: at,
        updated_at: at,
        payload,
      });
      const document = { organizationId, id: 'doc-compact' };
      const reminder = { automatic: false, label: 'Invoice balance' };
      await db.collection('email_outbox').insertMany([
        row('compact-legacy', 'invoice', 'sent', {
          document,
          html: '<p>x</p>',
          attachment: { content: 'JVBE' },
        }),
        row('compact-reminder', 'payment_reminder', 'sent', {
          organizationId,
          document,
          reminder,
          html: 'x',
        }),
        row('compact-queued', 'invoice', 'queued', { organizationId, document, html: '<p>x</p>' }),
      ]);
      await db.models.email.compactSent();
      await db.models.email.compactSent();
      const payload = async (id) => (await db.models.email.findById(id)).payload;
      assert.deepEqual(await payload('compact-legacy'), { organizationId });
      assert.deepEqual(await payload('compact-reminder'), { organizationId, reminder });
      assert.deepEqual(await payload('compact-queued'), { organizationId, document, html: '<p>x</p>' });
    });
  },
);
