import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createAuth, type AuthOptions } from '../../server/auth/auth.ts';
import type { AuthUser } from '../../shared/auth-types.ts';

const OWNER = { email: 'owner@example.test', password: 'Owner security password 2026' };
const STAFF = {
  name: 'Division member',
  email: 'staff@example.test',
  password: 'Staff secure password 2026',
  company: 'Venturecore',
};

async function fixture(t: TestContext, options: AuthOptions = {}, filename = ':memory:', provision = true) {
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY); INSERT OR IGNORE INTO organizations VALUES ('legal'), ('ecosystem');",
  );
  const auth = createAuth(db, {
    environment: { INITIAL_ADMIN_EMAIL: OWNER.email, INITIAL_ADMIN_PASSWORD: OWNER.password },
    ...options,
  });
  if (provision) await auth.initializeOwner();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', auth.router);
  app.get('/private', auth.requireSession, (_req, res) => res.json({ user: res.locals.user }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie'),
      headers: response.headers,
    };
  }
  async function signIn(credentials = OWNER) {
    const result = await call('/api/auth/login', 'POST', credentials);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return {
      cookie: result.cookie!.split(';')[0],
      user: result.body.user as AuthUser,
      fullCookie: result.cookie!,
    };
  }
  async function member(ownerCookie: string) {
    assert.equal((await call('/api/auth/signup', 'POST', STAFF)).status, 202);
    const listing = await call('/api/auth/users', 'GET', undefined, ownerCookie);
    return (listing.body as AuthUser[]).find((item) => item.email === STAFF.email)!;
  }
  return { db, auth, base, call, signIn, member };
}

test('signup is pending and cannot claim owner privileges; duplicate signup is generic and leaves owner password intact', async (t) => {
  const f = await fixture(t, { environment: {} }, ':memory:', false);
  const response = await f.call('/api/auth/signup', 'POST', STAFF);
  assert.equal(response.status, 202);
  assert.equal(
    (await f.call('/api/auth/login', 'POST', STAFF)).status,
    400,
    'login rejects unrelated signup fields',
  );
  assert.equal(
    (await f.call('/api/auth/login', 'POST', { email: STAFF.email, password: STAFF.password })).status,
    401,
  );
  const row = f.db.prepare('SELECT role,status,password_hash FROM auth_users').get() as {
    role: string;
    status: string;
    password_hash: string;
  };
  assert.equal(row.role, 'staff');
  assert.equal(row.status, 'pending');
  assert.match(row.password_hash, /^scrypt-v1:/);
  assert.ok(!row.password_hash.includes(STAFF.password));
  assert.equal((await f.call('/api/auth/signup', 'POST', { ...STAFF, role: 'admin' })).status, 400);
  const duplicate = await f.call('/api/auth/signup', 'POST', {
    ...STAFF,
    password: 'A different strong password',
  });
  assert.deepEqual(duplicate.body, response.body);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n, 1);
});

test('owner setup is explicit and idempotent, never replaces existing account passwords or promotes pending users', async (t) => {
  const f = await fixture(t);
  const original = f.db.prepare('SELECT password_hash FROM auth_users').get();
  const another = createAuth(f.db, {
    environment: {
      INITIAL_ADMIN_EMAIL: OWNER.email,
      INITIAL_ADMIN_PASSWORD: 'A totally different password 123',
    },
  });
  await another.initializeOwner();
  assert.deepEqual(f.db.prepare('SELECT password_hash FROM auth_users').get(), original);
  await f.signIn();
  assert.equal((await f.call('/api/auth/signup', 'POST', STAFF)).status, 202);
  const takeover = createAuth(f.db, {
    environment: { INITIAL_ADMIN_EMAIL: STAFF.email, INITIAL_ADMIN_PASSWORD: STAFF.password },
  });
  await assert.rejects(takeover.initializeOwner(), /existing non-administrator/);
  const weak = createAuth(f.db, {
    environment: { INITIAL_ADMIN_EMAIL: 'new@example.test', INITIAL_ADMIN_PASSWORD: 'weak' },
  });
  await assert.rejects(weak.initializeOwner());
});

test('simultaneous owner initialization creates exactly one admin and rejects a competing pending signup', async (t) => {
  const f = await fixture(t, {}, ':memory:', false);
  const another = createAuth(f.db, {
    environment: { INITIAL_ADMIN_EMAIL: OWNER.email, INITIAL_ADMIN_PASSWORD: OWNER.password },
  });
  const owners = await Promise.all([f.auth.initializeOwner(), another.initializeOwner()]);
  assert.equal(owners[0]?.id, owners[1]?.id);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM auth_users').get() as { n: number }).n, 1);
  const pendingEmail = 'competing@example.test';
  const competing = createAuth(f.db, {
    environment: { INITIAL_ADMIN_EMAIL: pendingEmail, INITIAL_ADMIN_PASSWORD: OWNER.password },
  });
  const initialization = competing.initializeOwner();
  const timestamp = new Date().toISOString();
  f.db
    .prepare(
      'INSERT INTO auth_users (id,name,email,company,password_hash,role,status,organization_ids,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'competing',
      'Pending applicant',
      pendingEmail,
      '',
      'not-an-admin-hash',
      'staff',
      'pending',
      '[]',
      timestamp,
      timestamp,
    );
  await assert.rejects(initialization, /existing non-administrator/);
  assert.equal(
    (f.db.prepare('SELECT status FROM auth_users WHERE id = ?').get('competing') as { status: string })
      .status,
    'pending',
  );
});

test('sessions use opaque hashed tokens, HttpOnly SameSite cookies, expiration and logout; no credential data is returned', async (t) => {
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const f = await fixture(t, { now: () => clock });
  assert.equal((await f.call('/private')).status, 401);
  assert.equal((await f.call('/api/auth/me')).body.user, null);
  const signed = await f.signIn();
  assert.match(signed.fullCookie, /HttpOnly/);
  assert.match(signed.fullCookie, /SameSite=Lax/);
  assert.ok(!JSON.stringify(signed.user).includes('password'));
  const token = signed.cookie.split('=')[1];
  const stored = f.db.prepare('SELECT token_hash FROM auth_sessions').get() as { token_hash: string };
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.equal((await f.call('/private', 'GET', undefined, signed.cookie)).status, 200);
  clock += 12 * 60 * 60 * 1000 + 1;
  assert.equal((await f.call('/private', 'GET', undefined, signed.cookie)).status, 401);
  const again = await f.signIn();
  assert.equal((await f.call('/api/auth/logout', 'POST', {}, again.cookie)).status, 200);
  assert.equal((await f.call('/private', 'GET', undefined, again.cookie)).status, 401);
});

test('sessions and assigned permissions survive a database/server reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'venture-auth-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  const first = await fixture(t, {}, filename);
  const signed = await first.signIn();
  const second = await fixture(t, {}, filename);
  const response = await second.call('/private', 'GET', undefined, signed.cookie);
  assert.equal(response.status, 200);
  assert.equal(response.body.user.id, signed.user.id);
});

test('administrator approval and organization assignment control access, and changes revoke outstanding sessions', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const pending = await f.member(owner.cookie);
  const update = (body: unknown, cookie = owner.cookie) =>
    f.call(`/api/auth/users/${pending.id}`, 'PATCH', body, cookie);
  assert.equal((await update({ role: 'staff', status: 'active', organizationIds: [] })).status, 400);
  assert.equal((await update({ role: 'staff', status: 'active', organizationIds: ['missing'] })).status, 400);
  const approved = await update({ role: 'staff', status: 'active', organizationIds: ['legal'] });
  assert.equal(approved.status, 200);
  assert.deepEqual(approved.body.organizationIds, ['legal']);
  const staff = await f.signIn({ email: STAFF.email, password: STAFF.password });
  assert.equal((await f.call('/api/auth/users', 'GET', undefined, staff.cookie)).status, 403);
  assert.equal(
    (await update({ role: 'admin', status: 'active', organizationIds: [] }, staff.cookie)).status,
    403,
  );
  assert.equal(
    (await update({ role: 'staff', status: 'active', organizationIds: ['ecosystem'] })).status,
    200,
  );
  assert.equal((await f.call('/private', 'GET', undefined, staff.cookie)).status, 401);
  const reassigned = await f.signIn({ email: STAFF.email, password: STAFF.password });
  assert.deepEqual(reassigned.user.organizationIds, ['ecosystem']);
  assert.equal((await update({ role: 'staff', status: 'disabled', organizationIds: [] })).status, 200);
  assert.equal((await f.call('/private', 'GET', undefined, reassigned.cookie)).status, 401);
  assert.equal(
    (await f.call('/api/auth/login', 'POST', { email: STAFF.email, password: STAFF.password })).status,
    401,
  );
  const self = await f.call(
    `/api/auth/users/${owner.user.id}`,
    'PATCH',
    { role: 'staff', status: 'disabled', organizationIds: [] },
    owner.cookie,
  );
  assert.equal(self.status, 409);
});

test('two administrators cannot concurrently disable each other and leave no active administrator', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const pending = await f.member(owner.cookie);
  const approved = await f.call(
    `/api/auth/users/${pending.id}`,
    'PATCH',
    { role: 'admin', status: 'active', organizationIds: [] },
    owner.cookie,
  );
  assert.equal(approved.status, 200);
  const otherAdmin = await f.signIn({ email: STAFF.email, password: STAFF.password });
  const changes = await Promise.all([
    f.call(
      `/api/auth/users/${pending.id}`,
      'PATCH',
      { role: 'staff', status: 'disabled', organizationIds: [] },
      owner.cookie,
    ),
    f.call(
      `/api/auth/users/${owner.user.id}`,
      'PATCH',
      { role: 'staff', status: 'disabled', organizationIds: [] },
      otherAdmin.cookie,
    ),
  ]);
  assert.equal(changes.filter((result) => result.status === 200).length, 1);
  assert.equal(
    (
      f.db
        .prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role = 'admin' AND status = 'active'")
        .get() as { n: number }
    ).n,
    1,
  );
});

test('password resets are generic, single-use, hashed, expire and revoke sessions', async (t) => {
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const messages: { to: string; name: string; token: string }[] = [];
  const f = await fixture(t, {
    now: () => clock,
    sendPasswordReset: async (message) => {
      messages.push(message);
    },
  });
  const signed = await f.signIn();
  const unknown = await f.call('/api/auth/forgot-password', 'POST', { email: 'unknown@example.test' });
  const known = await f.call('/api/auth/forgot-password', 'POST', { email: OWNER.email });
  assert.deepEqual(known.body, unknown.body);
  assert.equal(known.status, 202);
  assert.equal(messages.length, 1);
  const token = messages[0].token;
  assert.ok(!JSON.stringify(known.body).includes(token));
  assert.notEqual(
    (f.db.prepare('SELECT token_hash FROM auth_password_resets').get() as { token_hash: string }).token_hash,
    token,
  );
  const newPassword = 'Changed secure password 2026';
  const simultaneous = await Promise.all([
    f.call('/api/auth/reset-password', 'POST', { token, password: newPassword }),
    f.call('/api/auth/reset-password', 'POST', { token, password: newPassword }),
  ]);
  assert.deepEqual(simultaneous.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await f.call('/private', 'GET', undefined, signed.cookie)).status, 401);
  assert.equal((await f.call('/api/auth/login', 'POST', OWNER)).status, 401);
  await f.signIn({ email: OWNER.email, password: newPassword });
  await f.call('/api/auth/forgot-password', 'POST', { email: OWNER.email });
  clock += 31 * 60 * 1000;
  assert.equal(
    (await f.call('/api/auth/reset-password', 'POST', { token: messages[1].token, password: OWNER.password }))
      .status,
    400,
  );
});

test('failed password-reset delivery exposes no token and invalidates its reset request', async (t) => {
  const f = await fixture(t, {
    sendPasswordReset: async () => {
      throw new Error('provider-secret');
    },
  });
  const result = await f.call('/api/auth/forgot-password', 'POST', { email: OWNER.email });
  assert.equal(result.status, 202);
  assert.ok(!JSON.stringify(result.body).includes('provider-secret'));
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM auth_password_resets').get() as { n: number }).n, 0);
});

test('cross-site and non-JSON account mutations are rejected; production requires HTTPS and secure cookies', async (t) => {
  const unconfigured = new DatabaseSync(':memory:');
  assert.throws(
    () => createAuth(unconfigured, { production: true, environment: {} }),
    /HTTPS PUBLIC_APP_URL/,
  );
  unconfigured.close();
  const f = await fixture(t, { production: true, publicOrigin: 'https://invoices.example.test' });
  assert.equal(
    (await f.call('/api/auth/login', 'POST', OWNER, undefined, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(
    (await f.call('/api/auth/login', 'POST', OWNER, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status,
    403,
  );
  assert.equal(
    (await f.call('/api/auth/login', 'POST', OWNER, undefined, { 'Content-Type': 'text/plain' })).status,
    415,
  );
  const good = await f.call('/api/auth/login', 'POST', OWNER, undefined, {
    Origin: 'https://invoices.example.test',
  });
  assert.equal(good.status, 200);
  assert.match(good.cookie!, /Secure/);
});

test('the login IP abuse guard cannot be evaded by spoofing untrusted forwarded client addresses', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 200; i++) {
    const result = await f.call('/api/auth/login', 'POST', { email: 'invalid' }, undefined, {
      'X-Forwarded-For': `203.0.113.${i}`,
    });
    assert.equal(result.status, 400);
  }
  const blocked = await f.call('/api/auth/login', 'POST', OWNER, undefined, {
    'X-Forwarded-For': '192.0.2.9',
  });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get('retry-after'));
});
