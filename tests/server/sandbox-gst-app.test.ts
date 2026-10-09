import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';

const GSTIN = '27AAPFU0939F1ZV';
const OWNER = { email: 'gst-owner@example.test', password: 'Synthetic GST owner password' };
const KEY = 'key_test_synthetic_only';
const SECRET = 'secret_test_synthetic_only';
const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
).toString('base64url')}.synthetic-signature`;

async function fixture(t: TestContext, configured: boolean) {
  const db = initDb(':memory:');
  const requests: string[] = [];
  const app = createApp({
    db,
    environment: {
      GST_PROVIDER: 'sandbox',
      SANDBOX_ENVIRONMENT: 'test',
      ...(configured ? { SANDBOX_API_KEY: KEY, SANDBOX_API_SECRET: SECRET } : {}),
      INITIAL_ADMIN_EMAIL: OWNER.email,
      INITIAL_ADMIN_PASSWORD: OWNER.password,
    },
    fetch: (async (url, init) => {
      requests.push(String(url));
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      if (String(url).endsWith('/authenticate')) {
        assert.equal(headers.get('x-api-key'), KEY);
        assert.equal(headers.get('x-api-secret'), SECRET);
        return Response.json({ code: 200, data: { access_token: token } });
      }
      assert.equal(String(url), 'https://test-api.sandbox.co.in/gst/compliance/public/gstin/search');
      assert.equal(headers.get('authorization'), token);
      assert.equal(headers.get('x-api-secret'), null);
      assert.deepEqual(JSON.parse(String(init?.body)), { gstin: GSTIN });
      return Response.json({
        code: 200,
        data: {
          status_cd: '1',
          data: {
            gstin: GSTIN,
            lgnm: 'Sample registered buyer',
            sts: 'Active',
            pradr: { addr: { bno: '12', st: 'Example Road', stcd: 'Maharashtra', pncd: '400001' } },
          },
        },
      });
    }) as typeof fetch,
  });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  async function call(path: string, authenticated = true) {
    const response = await fetch(base + path, { headers: authenticated ? { Cookie: cookie } : {} });
    return { status: response.status, body: await response.json() };
  }
  return { db, call, requests };
}

test('Sandbox GST lookup requires login and only returns normalized fields for explicit customer review', async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.call(`/api/gst/${GSTIN}`, false)).status, 401);
  assert.deepEqual((await f.call('/api/health', false)).body, { ok: true });
  assert.equal(f.requests.length, 0);
  const health = (await f.call('/api/health')).body;
  assert.equal(health.gstProvider, 'sandbox');
  assert.equal(health.gstMode, 'provider');
  assert.equal(health.gstEnvironment, 'test');
  assert.equal(health.gstConfigured, true);
  const result = await f.call(`/api/gst/${GSTIN}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.name, 'Sample registered buyer');
  assert.equal(result.body.stateCode, '27');
  assert.equal(result.body.gstin, GSTIN);
  assert.match(result.body.address, /Example Road/);
  assert.equal(f.requests.length, 2);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM customers').get() as { count: number }).count, 0);
  assert.equal((await f.call(`/api/gst/${GSTIN}`)).status, 200);
  assert.equal(f.requests.length, 2, 'A repeated click reuses the bounded short-lived successful cache.');
  const status = await f.call('/api/integrations/status?organizationId=pipeline2-legal');
  assert.equal(status.body.gst.provider, 'sandbox');
  assert.equal(status.body.gst.keyConfigured, true);
  assert.equal(status.body.gst.secretConfigured, true);
  const serialized = JSON.stringify([health, result.body, status.body]);
  for (const secret of [KEY, SECRET, token]) assert.equal(serialized.includes(secret), false);
});

test('selected Sandbox with missing credentials fails safely without falling back to a CAPTCHA or another provider', async (t) => {
  const f = await fixture(t, false);
  const health = (await f.call('/api/health')).body;
  assert.equal(health.gstMode, 'provider');
  assert.equal(health.gstConfigured, false);
  const invalid = await f.call('/api/gst/not-a-gstin');
  assert.equal(invalid.status, 400);
  const missing = await f.call(`/api/gst/${GSTIN}`);
  assert.equal(missing.status, 503);
  assert.equal(f.requests.length, 0);
});
