import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { createAuth } from '../../src/services/auth/auth.js';
import { createAuthSecurity } from '../../src/services/auth/security.js';
import { createAccountRateLimiter } from '../../src/services/auth/account-rate-limit.js';
import { createFixture, integrationEnabled } from './fixture.js';

const native = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const ownerEnvironment = {
  INITIAL_ADMIN_EMAIL: 'security-owner@example.test',
  INITIAL_ADMIN_PASSWORD: 'SecurityReviewPassword2026!',
  INITIAL_ADMIN_NAME: 'Security reviewer',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function request(base, path, { method = 'GET', body, cookie = '', headers = {} } = {}) {
  const response = await fetch(`${base}/api/auth${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
}

async function login(base, environment = ownerEnvironment) {
  const result = await request(base, '/login', {
    method: 'POST',
    body: { email: environment.INITIAL_ADMIN_EMAIL, password: environment.INITIAL_ADMIN_PASSWORD },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return { cookie: result.cookie, user: result.data.user };
}

async function legacySession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const result = await db.collection('auth_sessions').insertOne({
    token_hash: digest(token),
    user_id: userId,
    created_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
    expiresOn: new Date(Date.now() + 3_600_000),
  });
  return {
    id: `legacy-${result.insertedId.toHexString()}`,
    cookie: `venturecore_session=${token}`,
    hash: digest(token),
  };
}

test(
  'Account quotas are atomic across instances, survive another app startup and preserve all four limits',
  native,
  async (t) => {
    const first = await createFixture(t);
    const second = await first.startInstance();
    const lockBefore = await first.backend.db
      .collection('transaction_locks')
      .find({})
      .sort({ _id: 1 })
      .toArray();
    const requests = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        request(index % 2 ? first.base : second.base, '/login', {
          method: 'POST',
          body: {},
          headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` },
        }),
      ),
    );
    assert.equal(requests.filter((result) => result.status === 400).length, 20);
    assert.equal(requests.filter((result) => result.status === 429).length, 10);
    assert.equal(
      await first.backend.db.collection('auth_audit').countDocuments({ action: 'account-throttled' }),
      1,
    );
    assert.deepEqual(
      await first.backend.db.collection('transaction_locks').find({}).sort({ _id: 1 }).toArray(),
      lockBefore,
    );
    const third = await first.startInstance();
    const blocked = await request(third.base, '/login', { method: 'POST', body: {} });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.response.headers.get('retry-after')) > 0);
    for (const [path, count] of [
      ['signup', 10],
      ['forgot-password', 8],
      ['reset-password', 15],
    ]) {
      const results = await Promise.all(
        Array.from({ length: count + 3 }, (_, index) =>
          request(index % 2 ? first.base : second.base, `/${path}`, { method: 'POST', body: {} }),
        ),
      );
      assert.equal(results.filter((result) => result.status === 400).length, count, path);
      assert.equal(results.filter((result) => result.status === 429).length, 3, path);
    }
    const rows = await first.backend.db.collection('auth_rate_limits').find({}).toArray();
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.match(row._id, /^[a-f0-9]{64}$/);
      assert.equal(JSON.stringify(row).includes('198.51.100'), false);
      assert.ok(row.expiresOn instanceof Date);
    }
    const indexes = await first.backend.db.collection('auth_rate_limits').indexes();
    assert.ok(indexes.some((index) => index.expireAfterSeconds === 0 && index.key.expiresOn === 1));
  },
);

test(
  'Trusted proxy clients have separate counters while untrusted forwarded hops cannot spoof the selected client',
  native,
  async (t) => {
    const fixture = await createFixture(t, { environment: { TRUST_PROXY: '127.0.0.1/32' } });
    const independent = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        request(fixture.base, '/login', {
          method: 'POST',
          body: {},
          headers: { 'X-Forwarded-For': `198.51.100.${index + 1}` },
        }),
      ),
    );
    assert.equal(
      independent.every((result) => result.status === 400),
      true,
    );
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        request(fixture.base, '/login', {
          method: 'POST',
          body: {},
          headers: { 'X-Forwarded-For': `203.0.113.${index + 1}, 192.0.2.7` },
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === 400).length, 20);
    assert.equal(results.filter((result) => result.status === 429).length, 5);
  },
);

test(
  'Mapped addresses share a counter and an expired retained row resets without waiting for TTL cleanup',
  native,
  async (t) => {
    const { backend } = await createFixture(t, { auth: false });
    const limiter = createAccountRateLimiter({ db: backend.db });
    for (let index = 0; index < 20; index++)
      assert.equal(
        (await limiter.take('login', { ip: index % 2 ? '192.0.2.5' : '::ffff:192.0.2.5' })).allowed,
        true,
      );
    const blocked = await limiter.take('login', { ip: '::ffff:c000:205' });
    assert.equal(blocked.allowed, false);
    assert.equal(await backend.db.collection('auth_rate_limits').countDocuments(), 1);
    await backend.db
      .collection('auth_rate_limits')
      .updateOne({ _id: blocked.key }, { $set: { expiresOn: new Date(Date.now() - 1) } });
    const reset = await limiter.take('login', { ip: '192.0.2.5' });
    assert.equal(reset.allowed, true);
    const row = await backend.db.collection('auth_rate_limits').findOne({ _id: blocked.key });
    assert.equal(row.count, 1);
    assert.equal(row.failureRecorded, false);
    assert.ok(row.expiresOn.getTime() > Date.now());
  },
);

test(
  'Own sessions expose independent IDs, support legacy records, prevent cross-account revocation and preserve the current session',
  native,
  async (t) => {
    const { backend, base } = await createFixture(t, { environment: ownerEnvironment });
    const first = await login(base);
    const second = await login(base);
    const old = await legacySession(backend.db, first.user.id);
    const list = await request(base, '/sessions', { cookie: first.cookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.total, 3);
    assert.equal(list.data.sessions.filter((row) => row.current).length, 1);
    assert.ok(list.data.sessions.find((row) => row.id === old.id));
    const serialized = JSON.stringify(list.data);
    assert.equal(serialized.includes(old.hash), false);
    assert.doesNotMatch(serialized, /token_hash|password_hash|venturecore_session/);
    assert.ok(
      list.data.sessions.filter((row) => row.id !== old.id).every((row) => /^[a-f0-9-]{36}$/.test(row.id)),
    );
    assert.equal((await request(base, '/sessions')).status, 401);

    const removed = await request(base, `/sessions/${old.id}/revoke`, {
      method: 'POST',
      body: {},
      cookie: first.cookie,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.revokedSessions, 1);
    assert.equal((await request(base, '/me', { cookie: old.cookie })).data.user, null);
    assert.equal(
      (await request(base, `/sessions/${old.id}/revoke`, { method: 'POST', body: {}, cookie: first.cookie }))
        .data.revokedSessions,
      0,
    );

    const otherUserId = randomUUID();
    await backend.db.collection('auth_users').insertOne({
      id: otherUserId,
      role: 'staff',
      status: 'active',
      organization_ids: [],
      email: 'other-session@example.test',
      name: 'Other session user',
    });
    const other = await legacySession(backend.db, otherUserId);
    const cross = await request(base, `/sessions/${other.id}/revoke`, {
      method: 'POST',
      body: {},
      cookie: first.cookie,
    });
    assert.equal(cross.status, 200);
    assert.equal(cross.data.revokedSessions, 0);
    assert.ok((await request(base, '/me', { cookie: other.cookie })).data.user);
    assert.equal(
      (await request(base, '/sessions?userId=' + first.user.id, { cookie: other.cookie })).status,
      400,
    );
    assert.equal((await request(base, '/audit', { cookie: other.cookie })).status, 403);
    assert.equal(
      (
        await request(base, `/users/${first.user.id}/revoke-sessions`, {
          method: 'POST',
          body: {},
          cookie: other.cookie,
        })
      ).status,
      403,
    );

    const remaining = await request(base, '/sessions/revoke-others', {
      method: 'POST',
      body: {},
      cookie: first.cookie,
    });
    assert.equal(remaining.data.revokedSessions, 1);
    assert.equal(remaining.data.signedOut, false);
    assert.ok((await request(base, '/me', { cookie: first.cookie })).data.user);
    assert.equal((await request(base, '/me', { cookie: second.cookie })).data.user, null);
    const currentId = (await request(base, '/sessions', { cookie: first.cookie })).data.sessions[0].id;
    const signedOut = await request(base, `/sessions/${currentId}/revoke`, {
      method: 'POST',
      body: {},
      cookie: first.cookie,
    });
    assert.equal(signedOut.data.signedOut, true);
    assert.match(signedOut.response.headers.get('set-cookie'), /venturecore_session=;/);
    assert.equal((await request(base, '/me', { cookie: first.cookie })).data.user, null);
  },
);

test(
  'Administrator revocation is audited and rechecks both actor access and the acting session inside its transaction',
  native,
  async (t) => {
    const { backend, base } = await createFixture(t, { environment: ownerEnvironment });
    const admin = await login(base);
    const hash = digest(admin.cookie.split('=')[1]);
    const targetId = randomUUID();
    await backend.db.collection('auth_users').insertOne({
      id: targetId,
      role: 'staff',
      status: 'active',
      organization_ids: ['venturecore'],
      email: 'revocation@example.test',
      name: 'Revocation test',
    });
    const target = await legacySession(backend.db, targetId);
    await legacySession(backend.db, targetId);
    const result = await request(base, `/users/${targetId}/revoke-sessions`, {
      method: 'POST',
      body: {},
      cookie: admin.cookie,
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.revokedSessions, 2);
    assert.equal(result.data.signedOut, false);
    assert.equal((await request(base, '/me', { cookie: target.cookie })).data.user, null);
    assert.equal((await backend.db.models.auth.userById(targetId)).status, 'active');
    const record = await backend.db.collection('auth_audit').findOne({ action: 'user-sessions-revoked' });
    assert.equal(record.actor_id, admin.user.id);
    assert.equal(record.user_id, targetId);
    assert.deepEqual(record.details, { revokedSessions: 2 });

    const retained = await legacySession(backend.db, targetId);
    const security = createAuthSecurity({ db: backend.db, audit: async () => {} });
    await backend.db.collection('auth_users').updateOne({ id: admin.user.id }, { $set: { role: 'staff' } });
    await assert.rejects(
      security.revokeUserSessions(admin.user, hash, targetId),
      (error) => error.status === 403,
    );
    await assert.rejects(backend.auth.listAudit(admin.user, {}), (error) => error.status === 403);
    assert.ok(await backend.db.collection('auth_sessions').findOne({ token_hash: retained.hash }));
    await backend.db.collection('auth_users').updateOne({ id: admin.user.id }, { $set: { role: 'admin' } });
    await backend.db.models.auth.deleteSession(hash);
    await assert.rejects(
      security.revokeUserSessions(admin.user, hash, targetId),
      (error) => error.status === 401,
    );
    assert.ok(await backend.db.collection('auth_sessions').findOne({ token_hash: retained.hash }));
  },
);

test(
  'Security audit paginates deterministically, uses inclusive Indian dates and projects only authorized fields',
  native,
  async (t) => {
    const { backend, base } = await createFixture(t, { environment: ownerEnvironment });
    const admin = await login(base);
    const accountId = 'legacy-involved-account';
    const secret = 'NEVER_EXPOSE_PRIVATE_AUDIT_DATA';
    const rows = Array.from({ length: 61 }, (_, index) => ({
      id: randomUUID(),
      action: 'access-updated',
      created_at: '2026-10-10T18:30:00.000Z',
      actor_id: index % 2 ? accountId : admin.user.id,
      user_id: index % 2 ? admin.user.id : accountId,
      token_hash: secret,
      details: {
        before: { role: 'admin', status: 'active', password: secret },
        after: { role: 'staff', status: 'active', organizationIds: ['venturecore'] },
        password_hash: secret,
        headers: { authorization: secret },
      },
    }));
    await backend.db
      .collection('auth_audit')
      .insertMany([
        ...rows,
        { ...rows[0], id: randomUUID(), created_at: '2026-10-10T18:29:59.999Z' },
        { ...rows[0], id: randomUUID(), created_at: '2026-10-11T18:30:00.000Z' },
      ]);
    const query = `/audit?from=2026-10-11&to=2026-10-11&action=access-updated&userId=${accountId}`;
    const first = await request(base, query, { cookie: admin.cookie });
    const second = await request(base, query + '&page=2', { cookie: admin.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.pagination.total, 61);
    assert.equal(first.data.events.length, 50);
    assert.equal(second.data.events.length, 11);
    const actualIds = [...first.data.events, ...second.data.events].map((row) => row.id);
    assert.deepEqual(
      actualIds,
      rows
        .map((row) => row.id)
        .sort()
        .reverse(),
    );
    const serialized = JSON.stringify([first.data, second.data]);
    assert.equal(serialized.includes(secret), false);
    assert.doesNotMatch(serialized, /token_hash|password_hash|authorization/);
    assert.ok(first.data.events.every((row) => row.actor && row.user));
    assert.ok(first.data.actions.some((action) => action.value === 'user-sessions-revoked'));
    for (const query of [
      '?page=0',
      '?from=2026-02-29',
      '?from=2026-10-11&from=2026-10-12',
      '?userId[$ne]=ignored',
      '?action=unknown',
    ])
      assert.equal((await request(base, '/audit' + query, { cookie: admin.cookie })).status, 400, query);
  },
);

test(
  'Unsuccessful login observations are bounded per window and retain the generic public response',
  native,
  async (t) => {
    const { backend, base } = await createFixture(t, { environment: ownerEnvironment });
    const locksBefore = await backend.db.collection('transaction_locks').find({}).sort({ _id: 1 }).toArray();
    const calls = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(base, '/login', {
          method: 'POST',
          body: { email: 'missing@example.test', password: 'WrongPasswordForObservation' },
        }),
      ),
    );
    assert.equal(
      calls.every((result) => result.status === 401),
      true,
    );
    const rows = await backend.db.collection('auth_audit').find({ action: 'login-unsuccessful' }).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, null);
    assert.equal(JSON.stringify(rows).includes('missing@example.test'), false);
    assert.equal(JSON.stringify(rows).includes('WrongPasswordForObservation'), false);
    assert.deepEqual(
      await backend.db.collection('transaction_locks').find({}).sort({ _id: 1 }).toArray(),
      locksBefore,
    );
  },
);

test(
  'Counter storage failure returns a controlled HTTP 503 before password lookup or session creation',
  native,
  async (t) => {
    const { backend } = await createFixture(t, { auth: false });
    let passwordLookups = 0;
    const failingDb = {
      ...backend.db,
      collection: (name) =>
        name === 'auth_rate_limits'
          ? {
              findOneAndUpdate: async () => {
                throw new Error('mongodb://private-password@example.test/secret');
              },
            }
          : backend.db.collection(name),
      models: {
        ...backend.db.models,
        auth: {
          ...backend.db.models.auth,
          userByEmail: async () => {
            passwordLookups++;
            return undefined;
          },
        },
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/auth', createAuth(failingDb, { environment: { NODE_ENV: 'test' } }).router);
    app.use(backend.app.locals.errorHandler);
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const result = await request(`http://127.0.0.1:${server.address().port}`, '/login', {
      method: 'POST',
      body: { email: 'failure@example.test', password: 'ExampleFailurePassword' },
    });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
    assert.equal(result.response.headers.get('retry-after'), '5');
    assert.doesNotMatch(JSON.stringify(result.data), /private-password|mongodb|secret/);
    assert.equal(passwordLookups, 0);
    assert.equal(await backend.db.collection('auth_sessions').countDocuments(), 0);
  },
);
