/** Integration tests: security-log and webhook duplicate-check records expire through TTL indexes. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { RETENTION_DAYS } from '../../src/config/retention.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const day = 86_400_000;

test('Log records carry an expiry date and TTL indexes delete them', options, async (t) => {
  const { backend } = await createFixture(t, { auth: false });
  const { db } = backend;
  const createdAt = '2026-10-10T00:00:00.000Z';
  await db.models.auth.audit('retention-audit', null, 'login', null, {}, createdAt);
  await db.models.razorpay.insertEvent('retention-event', 'hash', 'payment.captured', createdAt, createdAt);
  await db.models.cashfree.insertEvent(
    'pipeline2-legal',
    'retention-cf',
    'hash',
    'PAYMENT',
    createdAt,
    createdAt,
  );
  const expiry = async (name, filter) =>
    (await db.collection(name).findOne(filter)).expiresOn.getTime() - Date.parse(createdAt);
  assert.equal(await expiry('auth_audit', { id: 'retention-audit' }), RETENTION_DAYS.securityLog * day);
  assert.equal(
    await expiry('online_webhook_events', { event_key: 'retention-event' }),
    RETENTION_DAYS.webhookEvents * day,
  );
  assert.equal(
    await expiry('cashfree_webhook_events', { event_key: 'retention-cf' }),
    RETENTION_DAYS.webhookEvents * day,
  );
  for (const name of ['auth_audit', 'online_webhook_events', 'cashfree_webhook_events']) {
    const ttl = (await db.collection(name).listIndexes().toArray()).find(
      (index) => index.key.expiresOn === 1,
    );
    assert.equal(ttl?.expireAfterSeconds, 0, `${name} has a TTL index`);
  }
  // Business records have no expiry.
  for (const name of ['documents', 'payments', 'document_events'])
    assert.equal(
      (await db.collection(name).listIndexes().toArray()).some((index) => 'expireAfterSeconds' in index),
      false,
    );
});
