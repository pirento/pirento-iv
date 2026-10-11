import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { connectDatabase, transaction } from '../../src/config/database.js';
import {
  TRANSACTION_LOCK_IDS,
  WORKSPACE_TRANSACTION_LOCK,
  organizationTransactionStripe,
} from '../../src/config/transaction-scopes.js';
import { assertEmptyDestination } from '../../scripts/database.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const clock = () => new Date('2026-10-11T05:00:00.000Z');
const firstOrganization = 'pipeline2-legal';
const secondOrganization = 'at-facilities';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bounded(promise, description, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function holdTransaction(db, scope, action = async () => {}) {
  const entered = deferred();
  const release = deferred();
  const done = db.transaction(async () => {
    await action();
    entered.resolve();
    await release.promise;
  }, scope);
  done.catch(entered.reject);
  return { entered: entered.promise, release: release.resolve, done };
}

/** Observe a real server write conflict, avoiding a sleep-based assertion of exclusion. */
function nextLockConflict(client, lockId) {
  const observed = deferred();
  const requests = new Set();
  function started(event) {
    if (
      event.commandName === 'update' &&
      event.command.update === 'transaction_locks' &&
      event.command.updates.some((update) => update.q._id === lockId)
    )
      requests.add(event.requestId);
  }
  function failed(event) {
    if (requests.delete(event.requestId)) observed.resolve(event.failure);
  }
  function succeeded(event) {
    if (!requests.delete(event.requestId)) return;
    if (event.reply.writeErrors?.length) observed.resolve(event.reply.writeErrors[0]);
  }
  client.on('commandStarted', started);
  client.on('commandFailed', failed);
  client.on('commandSucceeded', succeeded);
  return {
    promise: observed.promise,
    close() {
      client.off('commandStarted', started);
      client.off('commandFailed', failed);
      client.off('commandSucceeded', succeeded);
    },
  };
}

async function databasePair(t) {
  const databaseName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
  const clients = Array.from(
    { length: 2 },
    () =>
      new MongoClient(process.env.MONGODB_TEST_URI, {
        monitorCommands: true,
      }),
  );
  t.after(async () => {
    try {
      assert.match(databaseName, /^venturecore_test_[a-f0-9]{32}$/);
      await clients[0].db(databaseName).dropDatabase();
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
  const first = await connectDatabase({ client: clients[0], databaseName, seed: false });
  const second = await connectDatabase({ client: clients[1], databaseName, seed: false });
  return { first, second, clients };
}

async function assertExclusion(first, second, client, heldScope, requestedScope, lockId) {
  const held = holdTransaction(first, heldScope);
  await bounded(held.entered, 'first transaction acquires its scope');
  let entered = false;
  const conflict = nextLockConflict(client, lockId);
  const next = second.transaction(async () => {
    entered = true;
    return 'committed after release';
  }, requestedScope);
  next.catch(() => {});
  try {
    const failure = await bounded(conflict.promise, 'second client conflicts with held coordination row');
    assert.equal(failure.code, 112, JSON.stringify(failure));
    assert.equal(entered, false, 'Business reads must not run before the held scope is released.');
  } finally {
    conflict.close();
    held.release();
    await held.done;
  }
  assert.equal(await bounded(next, 'retried transaction commits'), 'committed after release');
}

test(
  'Scoped MongoDB transactions overlap independent businesses and preserve exclusive barriers',
  options,
  async (t) => {
    const { first, second, clients } = await databasePair(t);
    const stripe = organizationTransactionStripe(firstOrganization);
    assert.notEqual(stripe, organizationTransactionStripe(secondOrganization));

    await t.test('empty import targets accept only the fixed coordination protocol rows', async () => {
      const locks = first.collection('transaction_locks');
      assert.deepEqual(
        (await locks.find().sort({ _id: 1 }).toArray()).map((row) => row._id),
        [...TRANSACTION_LOCK_IDS],
      );
      await assertEmptyDestination(first.database);
      await locks.insertOne({ _id: 'unexpected-stripe', revision: 0 });
      await assert.rejects(assertEmptyDestination(first.database), /unexpected transaction lock/);
      await locks.deleteOne({ _id: 'unexpected-stripe' });
      await locks.updateOne({ _id: stripe }, { $set: { extra: 'unexpected' } });
      await assert.rejects(assertEmptyDestination(first.database), /unexpected transaction lock/);
      await locks.updateOne({ _id: stripe }, { $unset: { extra: '' }, $set: { revision: -1 } });
      await assert.rejects(assertEmptyDestination(first.database), /unexpected transaction lock/);
      await locks.updateOne({ _id: stripe }, { $set: { revision: 0 } });
      await first.transaction(async () => {});
      await assertEmptyDestination(first.database);
    });

    await t.test('a different stripe commits while another business is held', async () => {
      const held = holdTransaction(first, { organizationId: firstOrganization });
      await bounded(held.entered, 'first business lock');
      try {
        const result = await bounded(
          second.transaction(
            async () => {
              await second.models.customers.insert({
                id: 'parallel-customer',
                organizationId: secondOrganization,
                name: 'Parallel business',
              });
              return 'independent commit';
            },
            { organizationId: secondOrganization },
          ),
          'independent business commits before release',
        );
        assert.equal(result, 'independent commit');
        assert.equal((await first.models.customers.findById('parallel-customer')).name, 'Parallel business');
      } finally {
        held.release();
        await held.done;
      }
    });

    await t.test('the same business retries with a fresh committed snapshot', async () => {
      await first.models.customers.insert({
        id: 'snapshot-customer',
        organizationId: firstOrganization,
        name: 'Before',
      });
      const held = holdTransaction(first, { organizationId: firstOrganization }, async () => {
        await first.models.customers.save({
          id: 'snapshot-customer',
          organizationId: firstOrganization,
          name: 'After commit',
        });
      });
      await bounded(held.entered, 'first update is uncommitted');
      const conflict = nextLockConflict(clients[1], stripe);
      let callbacks = 0;
      const next = second.transaction(
        async () => {
          callbacks++;
          return second.models.customers.findById('snapshot-customer');
        },
        { organizationId: firstOrganization },
      );
      next.catch(() => {});
      try {
        assert.equal((await bounded(conflict.promise, 'same-business write conflict')).code, 112);
        assert.equal(callbacks, 0);
      } finally {
        conflict.close();
        held.release();
        await held.done;
      }
      assert.equal((await bounded(next, 'fresh committed snapshot')).name, 'After commit');
      assert.equal(callbacks, 1);
    });

    await t.test('stripe collisions preserve exclusion and cannot bypass nested ownership', async () => {
      let collision;
      for (let index = 0; index < 10_000 && !collision; index++) {
        const candidate = `collision-business-${index}`;
        if (organizationTransactionStripe(candidate) === stripe) collision = candidate;
      }
      assert.ok(collision);
      await assertExclusion(
        first,
        second,
        clients[1],
        { organizationId: firstOrganization },
        { organizationId: collision },
        stripe,
      );
      await first.transaction(
        async () => {
          let called = false;
          await assert.rejects(
            first.transaction(
              async () => {
                called = true;
              },
              { organizationId: collision },
            ),
            /cannot change organization/,
          );
          assert.equal(called, false);
        },
        { organizationId: firstOrganization },
      );
    });

    await t.test('default workspace operations exclude scoped writers in both directions', async () => {
      await assertExclusion(
        first,
        second,
        clients[1],
        undefined,
        { organizationId: firstOrganization },
        stripe,
      );
      await assertExclusion(
        first,
        second,
        clients[1],
        { organizationId: firstOrganization },
        undefined,
        stripe,
      );
    });

    await t.test(
      'nested scope inheritance, explicit workspace requests and rollback remain atomic',
      async () => {
        const locks = first.collection('transaction_locks');
        const before = await locks.find().sort({ _id: 1 }).toArray();
        await transaction(
          first,
          async () => {
            const session = first.options().session;
            await first.transaction(async () => assert.equal(first.options().session, session));
            await first.transaction(async () => assert.equal(first.options().session, session), {
              organizationId: firstOrganization,
            });
            let expanded = false;
            await assert.rejects(
              first.transaction(
                async () => {
                  expanded = true;
                },
                { scope: 'workspace' },
              ),
              /cannot change organization/,
            );
            await assert.rejects(
              first.transaction(
                async () => {
                  expanded = true;
                },
                { organizationId: secondOrganization },
              ),
              /cannot change organization/,
            );
            assert.equal(expanded, false);
          },
          { organizationId: firstOrganization },
        );
        const after = await locks.find().sort({ _id: 1 }).toArray();
        for (let index = 0; index < before.length; index++)
          assert.equal(after[index].revision - before[index].revision, before[index]._id === stripe ? 1 : 0);
        await first.transaction(
          async () => {
            await first.transaction(async () => {}, { organizationId: firstOrganization });
            await first.transaction(async () => {}, { organizationId: secondOrganization });
            await first.transaction(async () => {}, { scope: 'workspace' });
          },
          { scope: 'workspace' },
        );
        const rollbackRevision = (await locks.findOne({ _id: stripe })).revision;
        await assert.rejects(
          first.transaction(
            async () => {
              await first.models.customers.insert({
                id: 'rolled-back',
                organizationId: firstOrganization,
                name: 'Not committed',
              });
              await first.models.events.insert({
                id: randomUUID(),
                documentId: 'rolled-back',
                type: 'fixture',
              });
              throw new Error('Abort both records');
            },
            { organizationId: firstOrganization },
          ),
          /Abort both records/,
        );
        assert.equal(await first.models.customers.findById('rolled-back'), undefined);
        assert.equal((await first.models.events.list('rolled-back')).length, 0);
        assert.equal((await locks.findOne({ _id: stripe })).revision, rollbackRevision);
        for (const malformed of [
          {},
          { organizationId: '' },
          { scope: 'organization' },
          { organizationId: firstOrganization, scope: 'workspace' },
          null,
        ])
          await assert.rejects(
            first.transaction(async () => assert.fail('Invalid scope callback ran'), malformed),
            TypeError,
          );
      },
    );

    await t.test('missing coordination rows stop a transaction before business reads', async () => {
      await first.collection('transaction_locks').deleteOne({ _id: stripe });
      let entered = false;
      await assert.rejects(
        first.transaction(
          async () => {
            entered = true;
          },
          { organizationId: firstOrganization },
        ),
        /coordination is unavailable/,
      );
      assert.equal(entered, false);
    });
  },
);

async function call(base, path, method = 'GET', body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
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
      name: 'Scoped transaction buyer',
      email: 'buyer@example.test',
      phone: '9000000000',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: 'Accounts',
    },
    201,
  );
}

function invoiceInput(buyer, extra = {}) {
  return {
    organizationId: buyer.organizationId,
    customerId: buyer.id,
    kind: 'invoice',
    status: 'sent',
    issueDate: '2026-10-10',
    dueDate: '2026-10-31',
    title: 'Scoped transaction invoice',
    items: [{ description: 'Service', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    ...extra,
  };
}

function payment(amount) {
  return {
    amount,
    requestId: randomUUID(),
    paidOn: '2026-10-10',
    method: 'bank_transfer',
    reference: 'FIXTURE',
    notes: '',
    finalizeWhenPaid: false,
  };
}

function pauseNextMethod(object, name, predicate = () => true) {
  const original = object[name];
  const entered = deferred(),
    release = deferred();
  let armed = true;
  object[name] = async (...args) => {
    if (armed && predicate(...args)) {
      armed = false;
      entered.resolve(args);
      await release.promise;
    }
    return original(...args);
  };
  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      release.resolve();
      object[name] = original;
    },
  };
}

function observeNextTransaction(db, organizationId) {
  const original = db.transaction;
  const entered = deferred();
  db.transaction = (action, scope) => {
    if (scope?.organizationId === organizationId) entered.resolve();
    return original(action, scope);
  };
  return {
    entered: entered.promise,
    restore() {
      db.transaction = original;
    },
  };
}

test(
  'Business API transactions preserve document, contact, format and payment predicates across instances',
  options,
  async (t) => {
    const fixture = await createFixture(t, { auth: false, now: clock });
    const second = await fixture.startInstance();
    const { db } = fixture.backend;
    const buyer = await customer(fixture.base, firstOrganization);
    const otherBuyer = await customer(fixture.base, secondOrganization);

    await t.test(
      'real document requests for another stripe complete while one business is held',
      async () => {
        const revision = (
          await db.collection('transaction_locks').findOne({ _id: WORKSPACE_TRANSACTION_LOCK })
        ).revision;
        const held = holdTransaction(db, { organizationId: firstOrganization });
        await bounded(held.entered, 'business write lock');
        const blocked = call(fixture.base, '/documents', 'POST', invoiceInput(buyer));
        blocked.catch(() => {});
        try {
          const other = await bounded(
            expectCall(second.base, '/documents', 'POST', invoiceInput(otherBuyer), 201),
            'another business creates its invoice',
          );
          assert.equal(other.organizationId, secondOrganization);
        } finally {
          held.release();
          await held.done;
        }
        assert.equal((await blocked).status, 201);
        assert.equal(
          (await db.collection('transaction_locks').findOne({ _id: WORKSPACE_TRANSACTION_LOCK })).revision,
          revision,
        );
      },
    );

    await t.test('creating an invoice before a customer deletion preserves its saved contact', async () => {
      const recipient = await customer(fixture.base, firstOrganization);
      const gate = pauseNextMethod(
        db.models.documents,
        'insert',
        (document) => document.customerId === recipient.id,
      );
      const creating = call(fixture.base, '/documents', 'POST', invoiceInput(recipient));
      creating.catch(() => {});
      let deleting;
      const observed = observeNextTransaction(second.backend.db, firstOrganization);
      try {
        await bounded(gate.entered, 'invoice validates customer before insertion');
        deleting = call(second.base, `/customers/${recipient.id}`, 'DELETE');
        deleting.catch(() => {});
        await bounded(observed.entered, 'customer deletion asks for the same business');
      } finally {
        observed.restore();
        gate.restore();
      }
      assert.equal((await creating).status, 201);
      assert.equal((await deleting).status, 409);
      assert.ok(await db.models.customers.findById(recipient.id));
      assert.equal(await db.collection('documents').countDocuments({ customerId: recipient.id }), 1);
    });

    await t.test('deleting a customer first prevents an invoice with a dangling contact', async () => {
      const recipient = await customer(fixture.base, firstOrganization);
      const gate = pauseNextMethod(db.models.customers, 'remove', (id) => id === recipient.id);
      const deleting = call(fixture.base, `/customers/${recipient.id}`, 'DELETE');
      deleting.catch(() => {});
      let creating;
      const observed = observeNextTransaction(second.backend.db, firstOrganization);
      try {
        await bounded(gate.entered, 'customer delete passes the no-document predicate');
        creating = call(second.base, '/documents', 'POST', invoiceInput(recipient));
        creating.catch(() => {});
        await bounded(observed.entered, 'invoice creation asks for the same business');
      } finally {
        observed.restore();
        gate.restore();
      }
      assert.equal((await deleting).status, 200);
      assert.equal((await creating).status, 404);
      assert.equal(await db.collection('documents').countDocuments({ customerId: recipient.id }), 0);
    });

    await t.test('simultaneous receipts and voids cannot overpay or leave a stale balance', async () => {
      const invoice = await expectCall(fixture.base, '/documents', 'POST', invoiceInput(buyer), 201);
      const receipts = await Promise.all([
        call(fixture.base, `/documents/${invoice.id}/payments`, 'POST', payment(70)),
        call(second.base, `/documents/${invoice.id}/payments`, 'POST', payment(70)),
      ]);
      assert.deepEqual(receipts.map((result) => result.status).sort(), [201, 409]);
      let details = await expectCall(fixture.base, `/documents/${invoice.id}/payments`);
      assert.equal(details.payments.length, 1);
      assert.equal(details.document.amountPaid, 70);
      assert.equal(details.document.balanceDue, 30);
      const results = await Promise.all([
        call(fixture.base, `/payments/${details.payments[0].id}/void`, 'POST', {
          reason: 'Receipt correction in fixture',
        }),
        call(second.base, `/documents/${invoice.id}/payments`, 'POST', payment(70)),
      ]);
      assert.equal(results[0].status, 200);
      assert.ok([201, 409].includes(results[1].status), JSON.stringify(results));
      details = await expectCall(fixture.base, `/documents/${invoice.id}/payments`);
      const active = details.payments
        .filter((receipt) => !receipt.voidedAt)
        .reduce((total, receipt) => total + Math.round(receipt.amount * 100), 0);
      assert.equal(Math.round(details.document.amountPaid * 100), active);
      assert.equal(Math.round(details.document.balanceDue * 100), 10_000 - active);
      assert.ok(active <= 10_000);
      assert.equal(details.payments.filter((receipt) => receipt.voidedAt).length, 1);
    });

    await t.test(
      'legacy receipts without organization ownership can still be voided through their parent invoice',
      async () => {
        for (const missing of [true, false]) {
          const invoice = await expectCall(fixture.base, '/documents', 'POST', invoiceInput(buyer), 201);
          const received = await expectCall(
            fixture.base,
            `/documents/${invoice.id}/payments`,
            'POST',
            payment(20),
            201,
          );
          const receipt = received.payments[0];
          await db
            .collection('payments')
            .updateOne(
              { id: receipt.id },
              missing ? { $unset: { organizationId: '' } } : { $set: { organizationId: null } },
            );
          const before = await db.collection('transaction_locks').find().sort({ _id: 1 }).toArray();
          const details = await expectCall(second.base, `/payments/${receipt.id}/void`, 'POST', {
            reason: 'Legacy receipt correction',
          });
          assert.equal(details.document.organizationId, firstOrganization);
          assert.equal(details.document.amountPaid, 0);
          assert.equal(details.document.balanceDue, 100);
          assert.ok(details.payments[0].voidedAt);
          const after = await db.collection('transaction_locks').find().sort({ _id: 1 }).toArray();
          for (let index = 0; index < before.length; index++)
            assert.equal(
              after[index].revision - before[index].revision,
              before[index]._id === organizationTransactionStripe(firstOrganization) ? 1 : 0,
            );
          const replay = await expectCall(fixture.base, `/payments/${receipt.id}/void`, 'POST', {
            reason: 'Legacy receipt correction',
          });
          assert.equal(replay.payments[0].voidedAt, details.payments[0].voidedAt);
        }
      },
    );

    await t.test(
      'voids reject an explicit foreign owner or a payment reassigned after scope resolution',
      async () => {
        const invoice = await expectCall(fixture.base, '/documents', 'POST', invoiceInput(buyer), 201);
        const otherInvoice = await expectCall(
          fixture.base,
          '/documents',
          'POST',
          invoiceInput(otherBuyer),
          201,
        );
        const received = await expectCall(
          fixture.base,
          `/documents/${invoice.id}/payments`,
          'POST',
          payment(20),
          201,
        );
        const receipt = received.payments[0];
        await db
          .collection('payments')
          .updateOne({ id: receipt.id }, { $set: { organizationId: secondOrganization } });
        await expectCall(
          second.base,
          `/payments/${receipt.id}/void`,
          'POST',
          { reason: 'Must reject foreign ownership' },
          409,
        );
        assert.equal((await db.models.payments.findById(receipt.id)).voidedAt, null);
        await db
          .collection('payments')
          .updateOne({ id: receipt.id }, { $set: { organizationId: firstOrganization } });
        const gate = pauseNextMethod(
          db,
          'transaction',
          (_action, scope) => scope?.organizationId === firstOrganization,
        );
        const voiding = call(fixture.base, `/payments/${receipt.id}/void`, 'POST', {
          reason: 'Must reject changed parent',
        });
        voiding.catch(() => {});
        try {
          await bounded(gate.entered, 'void resolves the original invoice business');
          await db
            .collection('payments')
            .updateOne({ id: receipt.id }, { $set: { documentId: otherInvoice.id } });
        } finally {
          gate.restore();
        }
        assert.equal((await voiding).status, 409);
        assert.equal((await db.models.payments.findById(receipt.id)).voidedAt, null);
        await db.collection('payments').updateOne({ id: receipt.id }, { $set: { documentId: invoice.id } });
        assert.equal((await db.models.documents.findById(invoice.id)).balanceDue, 80);
        assert.equal((await db.models.documents.findById(otherInvoice.id)).balanceDue, 100);
        assert.equal(
          (await db.models.events.list(invoice.id)).filter((event) => event.type === 'payment_voided').length,
          0,
        );
      },
    );

    await t.test('format deletion versus choosing a default retains one valid default', async () => {
      const formats = await db.models.formats.list(secondOrganization);
      const current = formats.find((format) => format.isDefault);
      const next = formats.find((format) => !format.isDefault);
      await db.transaction(async () => {
        for (const format of formats)
          if (![current.id, next.id].includes(format.id)) await db.models.formats.remove(format.id);
      });
      const results = await Promise.all([
        call(fixture.base, `/formats/${next.id}`, 'PUT', { ...next, isDefault: true }),
        call(second.base, `/formats/${next.id}`, 'DELETE'),
      ]);
      assert.ok([200, 404].includes(results[0].status), JSON.stringify(results));
      assert.ok([200, 409].includes(results[1].status), JSON.stringify(results));
      const remaining = await db.models.formats.list(secondOrganization);
      assert.ok(remaining.length >= 1);
      assert.equal(remaining.filter((format) => format.isDefault).length, 1);
    });
  },
);

test(
  'Gateway reservations share business locks with manual receipts without holding locks over provider HTTP',
  options,
  async (t) => {
    let providerGate = null;
    const providerCalls = [];
    let serial = 0;
    const fixture = await createFixture(t, {
      auth: false,
      now: clock,
      environment: {
        RAZORPAY_KEY_ID: 'rzp_test_scopes',
        RAZORPAY_KEY_SECRET: 'fixture_key',
        RAZORPAY_WEBHOOK_SECRET: 'fixture_webhook',
        SHRI_SARRAF_CASHFREE_CLIENT_ID: 'fixture_cashfree_id',
        SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'fixture_cashfree_secret',
        SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
      },
      paymentFetch: async (url, request) => {
        const address = new URL(url);
        assert.equal(request.method, 'POST');
        const payload = JSON.parse(request.body);
        providerCalls.push({ host: address.hostname, amount: payload.amount ?? payload.link_amount });
        if (providerGate) {
          providerGate.entered.resolve();
          await providerGate.release.promise;
        }
        return Response.json(
          address.hostname === 'api.razorpay.com'
            ? {
                id: `plink_SCOPES${++serial}`,
                reference_id: payload.reference_id,
                amount: payload.amount,
                amount_paid: 0,
                currency: 'INR',
                status: 'created',
                short_url: `https://rzp.io/scopes${serial}`,
                payments: [],
              }
            : {
                link_id: payload.link_id,
                link_amount: payload.link_amount,
                link_amount_paid: 0,
                link_currency: 'INR',
                link_status: 'ACTIVE',
                link_url: `https://payments.cashfree.com/links/${payload.link_id}`,
              },
        );
      },
    });
    const second = await fixture.startInstance();
    for (const organizationId of [firstOrganization, 'shri-sarraf']) {
      const buyer = await customer(fixture.base, organizationId);
      await t.test(
        `${organizationId}: a committed reservation blocks receipts while unrelated invoice edits remain available`,
        async () => {
          const invoice = await expectCall(fixture.base, '/documents', 'POST', invoiceInput(buyer), 201);
          providerGate = { entered: deferred(), release: deferred() };
          const pending = call(fixture.base, `/documents/${invoice.id}/payment-link`, 'POST', {});
          pending.catch(() => {});
          try {
            await bounded(providerGate.entered.promise, 'provider request begins after reservation commits');
            await bounded(
              expectCall(second.base, `/documents/${invoice.id}/payments`, 'POST', payment(10), 409),
              'manual receipt observes reserved link',
            );
            const edited = await bounded(
              expectCall(second.base, `/documents/${invoice.id}`, 'PUT', {
                ...invoice,
                title: 'Reviewed while provider request is pending',
              }),
              'invoice note/title edit proceeds outside provider HTTP',
            );
            assert.equal(edited.title, 'Reviewed while provider request is pending');
          } finally {
            providerGate.release.resolve();
          }
          assert.equal((await pending).status, 200);
          providerGate = null;
          assert.equal(
            (await expectCall(second.base, `/documents/${invoice.id}/payments`)).payments.length,
            0,
          );
        },
      );

      await t.test(
        `${organizationId}: a receipt committing first prevents a stale provider reservation`,
        async () => {
          const invoice = await expectCall(fixture.base, '/documents', 'POST', invoiceInput(buyer), 201);
          const gate = pauseNextMethod(
            fixture.backend.db.models.payments,
            'insert',
            (receipt) => receipt.documentId === invoice.id,
          );
          const observed = observeNextTransaction(second.backend.db, organizationId);
          const paying = call(fixture.base, `/documents/${invoice.id}/payments`, 'POST', payment(70));
          paying.catch(() => {});
          const before = providerCalls.length;
          let creating;
          try {
            await bounded(gate.entered, 'receipt validates balance before commit');
            creating = call(second.base, `/documents/${invoice.id}/payment-link`, 'POST', {});
            creating.catch(() => {});
            await bounded(observed.entered, 'provider reservation requests the receipt business lock');
          } finally {
            observed.restore();
            gate.restore();
          }
          assert.equal((await paying).status, 201);
          assert.equal((await creating).status, 409);
          assert.equal(providerCalls.length, before);
          const details = await expectCall(fixture.base, `/documents/${invoice.id}/payments`);
          assert.equal(details.document.balanceDue, 30);
          assert.equal(
            (await expectCall(fixture.base, `/documents/${invoice.id}/online-payments`)).links.length,
            0,
          );
        },
      );
    }
    assert.equal(providerCalls.length, 2);
  },
);

test(
  'Authenticated staff void legacy receipts only through an authorized and matching parent invoice',
  options,
  async (t) => {
    const administrator = { email: 'scope-admin@example.test', password: 'ScopedValidationPassword2026!' };
    const staff = {
      name: 'Scoped receipt reviewer',
      email: 'scope-staff@example.test',
      password: 'ScopedStaffValidation2026!',
    };
    const fixture = await createFixture(t, {
      now: clock,
      environment: {
        INITIAL_ADMIN_EMAIL: administrator.email,
        INITIAL_ADMIN_PASSWORD: administrator.password,
      },
    });
    const { db } = fixture.backend;
    async function request(path, method, body, cookie = '', status = 200) {
      const response = await fetch(`${fixture.base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
    }
    const adminCookie = (await request('/auth/login', 'POST', administrator)).cookie;
    await request('/auth/signup', 'POST', staff, '', 202);
    const accounts = (await request('/auth/users', 'GET', undefined, adminCookie)).data;
    const account = accounts.find((user) => user.email === staff.email);
    assert.ok(account);
    await request(
      `/auth/users/${account.id}`,
      'PATCH',
      {
        role: 'staff',
        status: 'active',
        organizationIds: [firstOrganization],
      },
      adminCookie,
    );
    const staffCookie = (
      await request('/auth/login', 'POST', { email: staff.email, password: staff.password })
    ).cookie;
    assert.notEqual(staffCookie, adminCookie);
    const buyers = new Map();
    for (const organizationId of [firstOrganization, secondOrganization]) {
      const created = await request(
        '/customers',
        'POST',
        {
          organizationId,
          name: 'Authorized receipt buyer',
          email: 'buyer@example.test',
          phone: '',
          gstin: '',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: 'Accounts',
        },
        adminCookie,
        201,
      );
      buyers.set(organizationId, created.data);
    }
    async function receipt(organizationId = firstOrganization) {
      const invoice = (
        await request('/documents', 'POST', invoiceInput(buyers.get(organizationId)), adminCookie, 201)
      ).data;
      const received = (
        await request(`/documents/${invoice.id}/payments`, 'POST', payment(20), adminCookie, 201)
      ).data;
      return { invoice, payment: received.payments[0] };
    }
    for (const missing of [true, false]) {
      const saved = await receipt();
      await db
        .collection('payments')
        .updateOne(
          { id: saved.payment.id },
          missing ? { $unset: { organizationId: '' } } : { $set: { organizationId: null } },
        );
      const reason = 'Authorized legacy receipt correction';
      const result = (await request(`/payments/${saved.payment.id}/void`, 'POST', { reason }, staffCookie))
        .data;
      assert.equal(result.document.organizationId, firstOrganization);
      assert.equal(result.document.amountPaid, 0);
      assert.equal(result.document.balanceDue, 100);
      assert.ok(result.payments[0].voidedAt);
      const replay = (await request(`/payments/${saved.payment.id}/void`, 'POST', { reason }, staffCookie))
        .data;
      assert.equal(replay.payments[0].voidedAt, result.payments[0].voidedAt);
    }
    for (const owner of [undefined, null, firstOrganization]) {
      const saved = await receipt(secondOrganization);
      await db
        .collection('payments')
        .updateOne(
          { id: saved.payment.id },
          owner === undefined ? { $unset: { organizationId: '' } } : { $set: { organizationId: owner } },
        );
      await request(
        `/payments/${saved.payment.id}/void`,
        'POST',
        { reason: 'Must not void a foreign invoice' },
        staffCookie,
        403,
      );
      assert.equal((await db.models.payments.findById(saved.payment.id)).voidedAt, null);
      assert.equal((await db.models.documents.findById(saved.invoice.id)).balanceDue, 80);
    }
    const mismatched = await receipt();
    await db
      .collection('payments')
      .updateOne({ id: mismatched.payment.id }, { $set: { organizationId: secondOrganization } });
    await request(
      `/payments/${mismatched.payment.id}/void`,
      'POST',
      { reason: 'Must not accept a mismatched receipt owner' },
      staffCookie,
      403,
    );
    assert.equal((await db.models.payments.findById(mismatched.payment.id)).voidedAt, null);
    const moving = await receipt();
    const foreignParent = await receipt(secondOrganization);
    const originalPaymentLookup = db.models.payments.findById;
    let reads = 0;
    db.models.payments.findById = async (id) => {
      if (id === moving.payment.id && ++reads === 2)
        await db
          .collection('payments')
          .updateOne(
            { id },
            { $set: { documentId: foreignParent.invoice.id }, $unset: { organizationId: '' } },
          );
      return originalPaymentLookup(id);
    };
    try {
      await request(
        `/payments/${moving.payment.id}/void`,
        'POST',
        { reason: 'Must reject a parent changed after access authorization' },
        staffCookie,
        403,
      );
    } finally {
      db.models.payments.findById = originalPaymentLookup;
      await db
        .collection('payments')
        .updateOne(
          { id: moving.payment.id },
          { $set: { documentId: moving.invoice.id, organizationId: firstOrganization } },
        );
    }
    assert.equal((await db.models.payments.findById(moving.payment.id)).voidedAt, null);
    assert.equal(
      (await db.models.documents.findById(foreignParent.invoice.id)).version,
      foreignParent.invoice.version + 1,
    );
    assert.equal((await db.models.documents.findById(foreignParent.invoice.id)).balanceDue, 80);
    for (const documentId of [undefined, null, '', 42, { $ne: null }, 'missing-invoice']) {
      const saved = await receipt();
      await db
        .collection('payments')
        .updateOne(
          { id: saved.payment.id },
          documentId === undefined
            ? { $unset: { documentId: '', organizationId: '' } }
            : { $set: { documentId }, $unset: { organizationId: '' } },
        );
      const original = db.models.ownership.document;
      let lookups = 0;
      db.models.ownership.document = async (id) => {
        lookups++;
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 0);
        return original(id);
      };
      try {
        await request(
          `/payments/${saved.payment.id}/void`,
          'POST',
          { reason: 'Must not authorize an invalid parent' },
          staffCookie,
          403,
        );
      } finally {
        db.models.ownership.document = original;
      }
      assert.equal(lookups, documentId === 'missing-invoice' ? 1 : 0);
      assert.equal((await db.models.payments.findById(saved.payment.id)).voidedAt, null);
    }
  },
);
