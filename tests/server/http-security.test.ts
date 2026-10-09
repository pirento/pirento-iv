import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';

async function fixture(t: TestContext, production = false) {
  const root = mkdtempSync(join(tmpdir(), 'venture-http-security-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>Public testing home</body></html>');
  writeFileSync(join(root, '.env'), 'SYNTHETIC_PRIVATE_ENV=keep-private');
  writeFileSync(join(root, 'workspace.sqlite'), 'SYNTHETIC_PRIVATE_DATABASE');
  writeFileSync(join(dist, '.hidden-file'), 'SYNTHETIC_HIDDEN_ASSET');
  const db = initDb(':memory:');
  const app = createApp({
    db,
    distPath: dist,
    environment: production
      ? { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://invoices.example.test' }
      : {},
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, base };
}

test('production home and API responses restrict scripts, framing and referrers while permitting uploaded images and invoice styles', async (t) => {
  const f = await fixture(t, true);
  for (const path of ['/', '/api/health', '/api/auth/me']) {
    const response = await fetch(f.base + path);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy')!;
    assert.match(csp, /script-src 'self'/);
    assert.equal(csp.includes("'unsafe-eval'"), false);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /img-src 'self' data: blob: https:/);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('strict-transport-security')!, /max-age=/);
    if (path.startsWith('/api')) assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const dev = await fixture(t);
  assert.equal(
    (await fetch(dev.base)).headers.get('content-security-policy'),
    null,
    'development HMR is not subject to production script rules',
  );
});

test('public account routes reject oversized and compressed-large bodies before signup hashing or persistence', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify({
    name: 'Synthetic applicant',
    email: 'body-limit@example.test',
    password: 'Synthetic secure password',
    company: 'x'.repeat(20_000),
  });
  for (const compressed of [false, true]) {
    const response = await fetch(`${f.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) },
      body: compressed ? gzipSync(body) : body,
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request is too large.' });
  }
  assert.equal(
    (f.db.prepare('SELECT COUNT(*) AS count FROM auth_users').get() as { count: number }).count,
    0,
  );
  const malformed = await fetch(`${f.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.stringify(await malformed.json()).includes('not-json'), false);
});

test('ambiguous organization/document query values are rejected consistently even on endpoints that do not consume them', async (t) => {
  const f = await fixture(t);
  for (const query of [
    'organizationId=legal&organizationId=other',
    'documentId=one&documentId=two',
    'organizationId=',
    'documentId=' + 'x'.repeat(101),
  ]) {
    const response = await fetch(`${f.base}/api/health?${query}`);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error, /Provide one valid/);
  }
});

test('static routes cannot retrieve server files, hidden assets or private storage, and invalid route encoding returns a safe client error', async (t) => {
  const f = await fixture(t);
  for (const path of [
    '/.env',
    '/workspace.sqlite',
    '/.data/workspace.sqlite',
    '/server/app.ts',
    '/.hidden-file',
    '/assets/%2e%2e/%2e%2e/.env',
  ]) {
    const response = await fetch(f.base + path);
    const body = await response.text();
    assert.equal(/SYNTHETIC_PRIVATE_|SYNTHETIC_HIDDEN_ASSET/.test(body), false, path);
  }
  const malformed = await fetch(`${f.base}/%zz`);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'The request URL contains an invalid identifier.' });
});
