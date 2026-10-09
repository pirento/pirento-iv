import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createAuth } from '../../server/auth/auth.ts';
import { parseTrustedProxy } from '../../server/http/trusted-proxy.ts';

const OWNER = { email: 'owner@example.test', password: 'Synthetic owner password 2026' };
const OTHER = { email: 'other@example.test', password: OWNER.password };

async function fixture(t: TestContext, trustedProxy?: string) {
  let clock = Date.parse('2026-10-09T12:00:00Z');
  const db = new DatabaseSync(':memory:');
  const auth = createAuth(db, {
    environment: { INITIAL_ADMIN_EMAIL: OWNER.email, INITIAL_ADMIN_PASSWORD: OWNER.password },
    now: () => clock,
  });
  await auth.initializeOwner();
  // Two independent accounts share a synthetic fixture password, never a real credential.
  db.prepare(
    'INSERT INTO auth_users SELECT ?,name,?,company,password_hash,role,status,organization_ids,created_at,updated_at,last_login_at FROM auth_users WHERE email = ?',
  ).run('another-synthetic-admin', OTHER.email, OWNER.email);
  const app = express();
  app.set('trust proxy', parseTrustedProxy(trustedProxy));
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function login(body: unknown = OWNER, forwardedFor?: string) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return {
    login,
    base,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

test('successful logins for multiple users behind one connection do not consume the failed-attempt limit', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 24; index++)
    assert.equal((await f.login(index % 2 ? OWNER : OTHER)).status, 200);
});

test('normalized email and client address scope failed login limits without blocking another user', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) {
    const response = await f.login({
      email: index % 2 ? OWNER.email.toUpperCase() : ` ${OWNER.email} `,
      password: 'Incorrect synthetic password',
    });
    assert.equal(response.status, 401);
  }
  const blocked = await f.login(OWNER);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  assert.equal((await f.login(OTHER)).status, 200, 'another account uses its own failed-attempt bucket');
  f.advance(15 * 60 * 1000);
  assert.equal((await f.login(OWNER)).status, 200, 'expired failures permit a new attempt');
});

test('successful authentication clears that account failures and releases reservations', async (t) => {
  const f = await fixture(t);
  for (const length of [12, 12]) {
    for (let index = 0; index < length; index++)
      assert.equal((await f.login({ ...OWNER, password: 'Incorrect synthetic password' })).status, 401);
    assert.equal((await f.login()).status, 200);
  }
});

test('concurrent failed attempts reserve capacity before password hashing and retain generic unknown-account responses', async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 25 }, () =>
      f.login({ email: 'unknown@example.test', password: 'Incorrect synthetic password' }),
    ),
  );
  assert.equal(responses.filter((response) => response.status === 401).length, 20);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
  assert.ok(
    responses
      .filter((response) => response.status === 429)
      .every((response) => Boolean(response.headers.get('retry-after'))),
  );
  const knownFailure = await f.login({ ...OWNER, password: 'Incorrect synthetic password' });
  assert.deepEqual(knownFailure.body, responses.find((response) => response.status === 401)!.body);
  assert.equal((await f.login(OTHER)).status, 200);
});

test('trusted proxy addresses separate forwarded clients while untrusted connections ignore spoofed headers', async (t) => {
  const trusted = await fixture(t, '127.0.0.1/32');
  for (let index = 0; index < 200; index++)
    assert.equal((await trusted.login({ email: 'invalid' }, '203.0.113.10')).status, 400);
  assert.equal((await trusted.login(OWNER, '203.0.113.10')).status, 429);
  assert.equal((await trusted.login(OWNER, '203.0.113.11')).status, 200);
  const untrusted = await fixture(t, '192.0.2.100/32');
  for (const f of [trusted, untrusted]) {
    const response = await fetch(`${f.base}/ip`, {
      headers: { 'X-Forwarded-For': '192.0.2.200, 203.0.113.12' },
    });
    const { ip } = await response.json();
    assert.equal(ip, f === trusted ? '203.0.113.12' : '127.0.0.1');
  }
});

test('invalid forwarded addresses cannot evade the IP abuse guard even through a trusted proxy', async (t) => {
  const f = await fixture(t, 'loopback');
  for (let index = 0; index < 200; index++)
    assert.equal((await f.login({ email: 'invalid' }, `invalid-client-${index}`)).status, 400);
  assert.equal((await f.login(OWNER, 'different-invalid-client')).status, 429);
});

test('equivalent IPv6 spellings and IPv4-mapped addresses share the same failed-attempt bucket', async (t) => {
  const f = await fixture(t, 'loopback');
  for (let index = 0; index < 200; index++) {
    const address = index % 2 ? '2001:db8::1' : '2001:0db8:0000:0000:0000:0000:0000:0001';
    assert.equal((await f.login({ email: 'invalid' }, address)).status, 400);
  }
  assert.equal((await f.login(OWNER, '2001:db8::1')).status, 429);
  for (let index = 0; index < 200; index++) {
    const address = index % 2 ? '203.0.113.21' : '::ffff:203.0.113.21';
    assert.equal((await f.login({ email: 'invalid' }, address)).status, 400);
  }
  assert.equal((await f.login(OWNER, '::ffff:cb00:7115')).status, 429);
});

test('a flood of distinct clients is bounded and expired buckets restore login capacity', async (t) => {
  const f = await fixture(t, 'loopback');
  for (let index = 0; index < 4096; index++) {
    const address = `198.18.${Math.floor(index / 256)}.${index % 256}`;
    assert.equal((await f.login({ email: 'invalid' }, address)).status, 400);
  }
  const busy = await f.login(OWNER, '198.19.0.1');
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '60');
  f.advance(15 * 60 * 1000);
  assert.equal((await f.login(OWNER, '198.19.0.1')).status, 200);
});
