import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import {
  blockedPreviewFetch,
  createSyntheticPreviewApp,
  PREVIEW_CSP,
  PREVIEW_DISABLED,
} from '../../server/preview/preview-app.ts';

const { prepareSyntheticPreview } = await import(
  new URL('../../scripts/synthetic-preview-config.mjs', import.meta.url).href
);
const ORIGIN = 'https://preview.example.test';
const OWNER = { email: 'preview-owner@example.test', password: 'Invented preview-only password' };
const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

function fixtureRoot(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'iv-synthetic-preview-test-'));
  const cleanups: (() => void | Promise<void>)[] = [];
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  writeFileSync(
    join(root, 'dist/index.html'),
    '<html><head></head><body>Built test application</body></html>',
  );
  writeFileSync(join(root, 'dist/assets/test.js'), '// Built public test asset');
  mkdirSync(join(root, '.preview-no-static'));
  writeFileSync(join(root, '.preview-no-static/index.html'), '<html>Unintended inner static root</html>');
  writeFileSync(join(root, '.preview-no-static/private-test.txt'), 'Invented private file; never publish');
  writeFileSync(join(root, '.env.example'), 'DOCUMENTATION_ONLY=');
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cleanup: (callback: () => void | Promise<void>) => cleanups.push(callback) };
}

function previewSettings(extra: NodeJS.ProcessEnv = {}) {
  return {
    NODE_ENV: 'production',
    IV_PREVIEW_MODE: 'disposable-synthetic',
    PUBLIC_APP_URL: ORIGIN,
    IV_PREVIEW_ADMIN_EMAIL: OWNER.email,
    IV_PREVIEW_ADMIN_PASSWORD: OWNER.password,
    ...extra,
  };
}

async function runningPreview(t: TestContext) {
  const files = fixtureRoot(t);
  const prepared = prepareSyntheticPreview({ root: files.root, environment: previewSettings() });
  const app = createSyntheticPreviewApp({ root: files.root, environment: prepared.environment });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  files.cleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.locals.services.backups.stop();
    app.locals.services.db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(path: string, method = 'GET', body?: unknown, cookie?: string, origin = ORIGIN) {
    return fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function login(details = OWNER) {
    const response = await call('/api/auth/login', 'POST', details);
    assert.equal(response.status, 200);
    const cookieHeader = response.headers.get('set-cookie')!;
    assert.match(cookieHeader, /HttpOnly/i);
    assert.match(cookieHeader, /Secure/i);
    assert.match(cookieHeader, /SameSite=Lax/i);
    return cookieHeader.split(';')[0];
  }
  return { ...files, prepared, app, call, login };
}

test('explicit preview proxy ranges reach the outer wrapper and sanitized inner application', (t) => {
  const files = fixtureRoot(t);
  const prepared = prepareSyntheticPreview({
    root: files.root,
    environment: previewSettings({ TRUSTED_PROXY: 'loopback' }),
  });
  assert.equal(prepared.environment.TRUSTED_PROXY, 'loopback');
  const app = createSyntheticPreviewApp({ root: files.root, environment: prepared.environment });
  files.cleanup(() => app.locals.services.db.close());
  assert.deepEqual(app.get('trust proxy'), ['loopback']);
});

test('unsafe proxy configuration fails before creating a preview or business database', (t) => {
  const files = fixtureRoot(t);
  const prepared = prepareSyntheticPreview({
    root: files.root,
    environment: previewSettings({ TRUSTED_PROXY: 'true' }),
  });
  assert.throws(
    () => createSyntheticPreviewApp({ root: files.root, environment: prepared.environment }),
    /TRUSTED_PROXY/,
  );
  assert.equal(existsSync(prepared.databasePath), false);
  const businessPath = join(files.root, 'never-created.sqlite');
  assert.throws(
    () => createApp({ environment: { TRUSTED_PROXY: '1', DATABASE_PATH: businessPath } }),
    /TRUSTED_PROXY/,
  );
  assert.equal(existsSync(businessPath), false);
});

test('ordinary application defaults to untrusted forwarded headers and accepts only configured ranges', () => {
  for (const TRUSTED_PROXY of [undefined, 'loopback,192.0.2.4']) {
    const db = initDb(':memory:');
    try {
      const app = createApp({ db, auth: false, environment: { TRUSTED_PROXY } });
      assert.deepEqual(app.get('trust proxy'), TRUSTED_PROXY ? ['loopback', '192.0.2.4'] : false);
    } finally {
      db.close();
    }
  }
});

test('each disposable start creates independent empty private storage without touching an existing workspace', (t) => {
  const files = fixtureRoot(t);
  mkdirSync(join(files.root, '.data'));
  const original = join(files.root, '.data/workspace.sqlite');
  const sentinel = Buffer.from('Invented existing workspace fixture; never open as SQLite');
  writeFileSync(original, sentinel);
  const first = prepareSyntheticPreview({ root: files.root, environment: previewSettings() });
  const second = prepareSyntheticPreview({ root: files.root, environment: previewSettings() });
  assert.notEqual(first.databasePath, second.databasePath);
  assert.equal(existsSync(first.databasePath), false);
  const one = createSyntheticPreviewApp({ root: files.root, environment: first.environment });
  const two = createSyntheticPreviewApp({ root: files.root, environment: second.environment });
  files.cleanup(() => one.locals.services.db.close());
  files.cleanup(() => two.locals.services.db.close());
  for (const app of [one, two]) {
    assert.equal(app.locals.services.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
    assert.equal(app.locals.services.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 0);
    const rows = app.locals.services.db.prepare('SELECT data FROM organizations').all();
    assert.equal(rows.length, 6);
    for (const row of rows) {
      const org = JSON.parse(String(row.data));
      assert.match(org.name, /^TEST ONLY/);
      assert.match(org.legalName, /NOT A REAL BUSINESS/);
      assert.match(org.supportEmail, /@example\.invalid$/);
      assert.equal(org.gstin, '');
      assert.equal(org.accountNumber, '');
    }
  }
  one.locals.services.db
    .prepare('INSERT INTO customers VALUES (?,?,?)')
    .run('invented-contact', 'pipeline2-legal', '{}');
  assert.equal(two.locals.services.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  assert.deepEqual(readFileSync(original), sentinel);
  assert.throws(
    () => createSyntheticPreviewApp({ root: files.root, environment: first.environment }),
    /EEXIST/,
  );
});

test('preview preparation refuses production credentials, real database settings and private environment files', (t) => {
  const files = fixtureRoot(t);
  for (const key of [
    'DATABASE_PATH',
    'DATABASE_URL',
    'INITIAL_ADMIN_EMAIL',
    'IV_ALLOW_NEW_DATABASE',
    'RAZORPAY_KEY_ID',
    'CASHFREE_SECRET_KEY',
    'SANDBOX_API_KEY',
    'RESEND_API_KEY',
    'SMTP_PASSWORD',
    'BROKER_TOKEN',
  ])
    assert.throws(
      () =>
        prepareSyntheticPreview({
          root: files.root,
          environment: previewSettings({ [key]: 'synthetic-test-value' }),
        }),
      /Disposable preview refused/,
    );
  for (const filename of ['.env', '.env.production', '.env.backup']) {
    const path = join(files.root, filename);
    writeFileSync(path, 'SYNTHETIC_TEST_FILE_ONLY=1');
    assert.throws(
      () => prepareSyntheticPreview({ root: files.root, environment: previewSettings() }),
      /private environment files/,
    );
    rmSync(path);
  }
  assert.equal(existsSync(join(files.root, '.preview-data')), false);
});

test('preview preparation requires an explicit mode, HTTPS origin and separate administrator password', (t) => {
  const files = fixtureRoot(t);
  for (const extra of [
    { IV_PREVIEW_MODE: undefined },
    { IV_PREVIEW_MODE: 'production' },
    { NODE_ENV: 'development' },
    { PUBLIC_APP_URL: 'http://preview.example.test' },
    { PUBLIC_APP_URL: `${ORIGIN}/` },
    { IV_PREVIEW_ADMIN_PASSWORD: 'short' },
    { IV_PREVIEW_ADMIN_EMAIL: undefined },
  ])
    assert.throws(
      () => prepareSyntheticPreview({ root: files.root, environment: previewSettings(extra) }),
      /Disposable preview refused/,
    );
  assert.equal(existsSync(join(files.root, '.preview-data')), false);
});

test('the preview factory independently refuses unsafe paths, worker settings and inherited integrations', (t) => {
  const files = fixtureRoot(t);
  const prepared = prepareSyntheticPreview({ root: files.root, environment: previewSettings() });
  for (const extra of [
    { DATABASE_PATH: '.data/workspace.sqlite' },
    { DATABASE_PATH: join(files.root, '.data/workspace.sqlite') },
    { DATABASE_PATH: join(dirname(prepared.databasePath), 'another.sqlite') },
    { DATABASE_BACKUP_DIR: join(files.root, 'dist/backups') },
    { BACKUP_ENABLED: 'true' },
    { EMAIL_AUTOMATION: 'true' },
    { SHRI_SARRAF_EMAIL_AUTOMATION: 'true' },
    { NODE_ENV: 'development' },
    { GST_PROVIDER: 'sandbox' },
    { SANDBOX_API_SECRET: 'synthetic-test-value' },
  ])
    assert.throws(() =>
      createSyntheticPreviewApp({ root: files.root, environment: { ...prepared.environment, ...extra } }),
    );
  assert.equal(existsSync(prepared.databasePath), false);
  writeFileSync(join(files.root, '.env'), 'SYNTHETIC_TEST_FILE_ONLY=1');
  assert.throws(
    () => createSyntheticPreviewApp({ root: files.root, environment: prepared.environment }),
    /environment files/,
  );
  assert.equal(existsSync(prepared.databasePath), false);
});

test('the preview factory refuses symlink containers, run directories and application ancestors', (t) => {
  const files = fixtureRoot(t);
  const target = join(files.root, 'private-target');
  mkdirSync(target, { mode: 0o700 });
  const container = join(files.root, '.preview-data');
  symlinkSync(target, container, 'dir');
  const environment = {
    ...previewSettings(),
    IV_PREVIEW_ADMIN_EMAIL: undefined,
    IV_PREVIEW_ADMIN_PASSWORD: undefined,
    INITIAL_ADMIN_EMAIL: OWNER.email,
    INITIAL_ADMIN_PASSWORD: OWNER.password,
    BACKUP_ENABLED: 'false',
    EMAIL_AUTOMATION: 'false',
    SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
    DATABASE_PATH: join(container, 'run-linked/workspace.sqlite'),
    DATABASE_BACKUP_DIR: join(container, 'run-linked/backups'),
  };
  assert.throws(() => createSyntheticPreviewApp({ root: files.root, environment }), /symlink/);
  assert.equal(existsSync(join(target, 'run-linked/workspace.sqlite')), false);
  rmSync(container);
  mkdirSync(container, { mode: 0o700 });
  symlinkSync(target, join(container, 'run-linked'), 'dir');
  assert.throws(() => createSyntheticPreviewApp({ root: files.root, environment }), /symlink/);
  assert.equal(existsSync(join(target, 'workspace.sqlite')), false);
  rmSync(join(container, 'run-linked'));
  const rootLink = join(files.root, 'app-link');
  symlinkSync(files.root, rootLink, 'dir');
  assert.throws(() => createSyntheticPreviewApp({ root: rootLink, environment }), /symlink/);
});

test('the preview factory refuses publicly accessible preview storage', (t) => {
  const files = fixtureRoot(t);
  const prepared = prepareSyntheticPreview({ root: files.root, environment: previewSettings() });
  chmodSync(prepared.directory, 0o755);
  assert.throws(
    () => createSyntheticPreviewApp({ root: files.root, environment: prepared.environment }),
    /private/,
  );
  assert.equal(existsSync(prepared.databasePath), false);
});

test('synthetic preview retains secure account sessions, approval, organization access and admin-only backups', async (t) => {
  const f = await runningPreview(t);
  assert.equal((await f.call('/api/customers')).status, 401);
  assert.equal((await f.call('/api/backups')).status, 401);
  const owner = await f.login();
  assert.equal((await f.call('/api/backups/status', 'GET', undefined, owner)).status, 200);
  const staff = {
    name: 'Synthetic Staff',
    email: 'staff-preview@example.test',
    password: 'Invented staff test password',
    company: '',
  };
  assert.equal((await f.call('/api/auth/signup', 'POST', staff)).status, 202);
  assert.equal(
    (await f.call('/api/auth/login', 'POST', { email: staff.email, password: staff.password })).status,
    401,
  );
  const users = await (await f.call('/api/auth/users', 'GET', undefined, owner)).json();
  const pending = users.find((user: { email: string }) => user.email === staff.email);
  assert.equal(pending.role, 'staff');
  assert.equal(pending.status, 'pending');
  assert.equal(
    (
      await f.call(
        `/api/auth/users/${pending.id}`,
        'PATCH',
        { role: 'staff', status: 'active', organizationIds: ['pipeline2-legal'] },
        owner,
      )
    ).status,
    200,
  );
  const staffCookie = await f.login({ email: staff.email, password: staff.password });
  assert.equal((await f.call('/api/backups', 'GET', undefined, staffCookie)).status, 403);
  assert.equal((await f.call('/api/backups/status', 'GET', undefined, staffCookie)).status, 403);
  assert.equal(
    (await f.call('/api/customers?organizationId=pipeline2-legal', 'GET', undefined, staffCookie)).status,
    200,
  );
  assert.equal(
    (await f.call('/api/customers?organizationId=shri-sarraf', 'GET', undefined, staffCookie)).status,
    403,
  );
  assert.equal(
    (await f.call('/api/auth/logout', 'POST', undefined, staffCookie, 'https://other.example.test')).status,
    403,
  );
});

test('all external integration routes are disabled and provider transports never run', async (t) => {
  const f = await runningPreview(t);
  const cookie = await f.login();
  for (const [path, method] of [
    ['/api/gst/27AAPFU0939F1ZV', 'GET'],
    ['/api/gst/portal/captcha', 'GET'],
    ['/api/gst/portal/lookup', 'POST'],
    ['/api/integrations/status', 'GET'],
    ['/api/documents/test/payment-link', 'POST'],
    ['/api/documents/test/payment-link/sync', 'POST'],
    ['/api/documents/test/payment-link/cancel', 'POST'],
    ['/api/documents/test/email', 'POST'],
    ['/api/messages/test/retry', 'POST'],
    ['/api/webhooks/razorpay', 'POST'],
    ['/api/webhooks/razorpay/pipeline2-legal', 'POST'],
    ['/api/webhooks/cashfree/shri-sarraf', 'POST'],
    ['/api/auth/forgot-password', 'POST'],
    ['/api/auth/reset-password', 'POST'],
  ]) {
    const response = await f.call(path, method, method === 'POST' ? {} : undefined, cookie);
    assert.equal(response.status, 503, path);
    assert.equal((await response.json()).error, PREVIEW_DISABLED);
  }
  assert.equal((await f.call('/api/gst/27AAPFU0939F1ZV')).status, 401);
  await assert.rejects(
    blockedPreviewFetch('https://api.sandbox.co.in/authenticate'),
    /Disabled in this disposable synthetic preview/,
  );
  assert.equal(f.app.locals.services.backups.status().enabled, false);
  assert.equal(f.app.locals.services.db.prepare('SELECT COUNT(*) AS n FROM email_outbox').get().n, 0);
});

test('preview serves only compiled assets with same-origin CSP and explicit disposable markers', async (t) => {
  const f = await runningPreview(t);
  const home = await f.call('/');
  assert.equal(home.headers.get('content-security-policy'), PREVIEW_CSP);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.headers.get('x-iv-deployment-mode'), 'disposable-synthetic-preview');
  assert.match(home.headers.get('x-robots-tag')!, /noindex/);
  assert.match(await home.text(), /meta name="iv-deployment-mode"/);
  const asset = await f.call('/assets/test.js');
  assert.equal(await asset.text(), '// Built public test asset');
  for (const path of [
    '/.preview-data/run-private/workspace.sqlite',
    '/server/app.ts',
    '/.env',
    '/private-test.txt',
  ]) {
    const response = await f.call(path);
    assert.match(response.headers.get('content-type')!, /text\/html/);
    assert.match(await response.text(), /Built test application/);
  }
  const api = await f.call('/api/deployment-mode');
  assert.deepEqual(await api.json(), {
    mode: 'disposable-synthetic-preview',
    disposable: true,
    integrationsDisabled: true,
  });
  const cookie = await f.login();
  const organizations = await f.call('/api/organizations', 'GET', undefined, cookie);
  assert.equal(organizations.headers.get('content-security-policy'), PREVIEW_CSP);
});

test('ordinary application has no preview routes, markers or disabled GST wrapper', async (t) => {
  const files = fixtureRoot(t);
  const db = initDb(':memory:');
  const app = createApp({ db, environment: {}, distPath: join(files.root, 'dist') });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  files.cleanup(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = await fetch(base);
  assert.equal(home.headers.get('x-iv-deployment-mode'), null);
  assert.equal((await home.text()).includes('iv-deployment-mode'), false);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/api/deployment-mode`)).status, 401);
  assert.equal((await fetch(`${base}/api/gst/27AAPFU0939F1ZV`)).status, 401);
});

test('process-local network guard rejects client transports while permitting an HTTP listening socket', () => {
  const moduleUrl = new URL('../../scripts/preview-network-lock.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import http, { request as namedRequest } from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import dgram from 'node:dgram';
    import { once } from 'node:events';
    const { installPreviewNetworkLock } = await import(${JSON.stringify(moduleUrl)});
    installPreviewNetworkLock();
    installPreviewNetworkLock();
    const blocked = (error) => error.code === 'IV_PREVIEW_NETWORK_DISABLED';
    for (const invoke of [
      () => fetch('https://provider.example.test'),
      () => http.get('http://127.0.0.1:9'),
      () => namedRequest('http://127.0.0.1:9'),
      () => https.request('https://provider.example.test'),
      () => net.connect(9, '127.0.0.1'),
      () => net.createConnection('/tmp/synthetic-never-connect.sock'),
      () => new net.Socket().connect(9, '127.0.0.1'),
      () => tls.connect(9, '127.0.0.1'),
      () => dgram.createSocket('udp4'),
    ]) assert.throws(invoke, blocked);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'fetch').writable, false);
    const server = http.createServer((_req, res) => res.end('Synthetic listener'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.ok(server.address().port > 0);
    await new Promise((resolve) => server.close(resolve));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: sourceRoot,
    env: { NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
