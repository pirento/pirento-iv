import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const { checkDeployment } = await import(new URL('../../scripts/check-deployment.mjs', import.meta.url).href);
type Check = { id: string; status: string; message: string };
type Report = {
  ready: boolean;
  checks: Check[];
  integrations: { provider: string; state: string; scope: string }[];
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venture-deployment-'));
  const root = join(directory, 'app');
  const storage = join(directory, 'private-storage');
  const backups = join(directory, 'private-backups');
  mkdirSync(root);
  mkdirSync(storage);
  mkdirSync(backups);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = {
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://invoices.example.test',
    HOST: '0.0.0.0',
    PORT: '3001',
    DATABASE_PATH: join(storage, 'workspace.sqlite'),
    INITIAL_ADMIN_EMAIL: 'synthetic-owner@example.test',
    INITIAL_ADMIN_PASSWORD: 'SYNTHETIC-owner-password-47',
  };
  return { root, storage, backups, environment };
}

test('a complete hosted manual-invoice deployment passes without optional provider keys and leaves storage empty', async (t) => {
  const f = fixture(t);
  const report: Report = await checkDeployment({ ...f, nodeVersion: '24.5.0' });
  assert.equal(report.ready, true);
  assert.deepEqual(
    readdirSync(f.storage),
    [],
    'temporary write probes must be removed and no database created',
  );
  assert.equal(report.integrations.find((entry) => entry.provider === 'razorpay')!.state, 'held');
  assert.equal(
    report.checks.some((entry) => entry.id === 'persistent-storage' && entry.status === 'warning'),
    true,
  );
  assert.equal(JSON.stringify(report).includes(f.environment.INITIAL_ADMIN_PASSWORD), false);
  assert.equal(JSON.stringify(report).includes(f.environment.INITIAL_ADMIN_EMAIL), false);
  assert.equal(JSON.stringify(report).includes(f.storage), false);
});

test('old runtimes, nonproduction mode and invalid listening settings are deployment blockers', async (t) => {
  const f = fixture(t);
  for (const override of [
    { nodeVersion: '22.0.0' },
    { nodeVersion: '24.4.0' },
    { environment: { ...f.environment, NODE_ENV: 'development' } },
    { environment: { ...f.environment, HOST: 'https://host.example.test:443' } },
    { environment: { ...f.environment, PORT: '65536' } },
    { environment: { ...f.environment, PORT: '3e3' } },
  ]) {
    const report: Report = await checkDeployment({ ...f, ...override });
    assert.equal(report.ready, false);
  }
});

test('the HTTPS origin cannot contain a path, trailing slash or secret in credentials/query/fragment', async (t) => {
  const f = fixture(t);
  for (const PUBLIC_APP_URL of [
    'http://example.test',
    'https://example.test/',
    'https://example.test/invoices',
    'https://secret-user:secret-value@example.test',
    'https://example.test?key=secret-query',
    'https://example.test#secret-fragment',
  ]) {
    const report: Report = await checkDeployment({ ...f, environment: { ...f.environment, PUBLIC_APP_URL } });
    assert.equal(report.ready, false, PUBLIC_APP_URL);
    assert.equal(JSON.stringify(report).includes('secret-'), false);
  }
});

test('relative, public, source and symlinked-public database locations are rejected before any database is created', async (t) => {
  const f = fixture(t);
  const publicDir = join(f.root, 'public');
  const sourceDir = join(f.root, 'server');
  const linkDir = join(f.root, '.data');
  mkdirSync(publicDir);
  mkdirSync(sourceDir);
  symlinkSync(publicDir, linkDir);
  for (const DATABASE_PATH of [
    '.data/workspace.sqlite',
    ':memory:',
    join(publicDir, 'workspace.sqlite'),
    join(sourceDir, 'workspace.sqlite'),
    join(linkDir, 'workspace.sqlite'),
  ]) {
    const report: Report = await checkDeployment({ ...f, environment: { ...f.environment, DATABASE_PATH } });
    assert.equal(report.ready, false);
  }
  assert.deepEqual(readdirSync(publicDir), []);
  assert.deepEqual(readdirSync(sourceDir), []);
});

test('a provisioned private .data directory is accepted but database path must point to a file', async (t) => {
  const f = fixture(t);
  const privateDir = join(f.root, '.data');
  mkdirSync(privateDir);
  const valid: Report = await checkDeployment({
    ...f,
    environment: { ...f.environment, DATABASE_PATH: join(privateDir, 'workspace.sqlite') },
  });
  assert.equal(valid.ready, true);
  const directory: Report = await checkDeployment({
    ...f,
    environment: { ...f.environment, DATABASE_PATH: privateDir },
  });
  assert.equal(directory.ready, false);
});

test('administrator provisioning needs a complete valid bootstrap pair unless an active admin already exists', async (t) => {
  const f = fixture(t);
  const environment = { ...f.environment, INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '' };
  assert.equal((await checkDeployment({ ...f, environment })).ready, false);
  assert.equal((await checkDeployment({ ...f, environment, existingAdminCount: 1 })).ready, true);
  assert.equal(
    (
      await checkDeployment({
        ...f,
        environment: { ...environment, INITIAL_ADMIN_EMAIL: 'synthetic@example.test' },
        existingAdminCount: 1,
      })
    ).ready,
    false,
  );
  assert.equal(
    (await checkDeployment({ ...f, environment: { ...f.environment, INITIAL_ADMIN_PASSWORD: 'short' } }))
      .ready,
    false,
  );
  assert.equal(
    (await checkDeployment({ ...f, environment: { ...f.environment, INITIAL_ADMIN_EMAIL: 'not-email' } }))
      .ready,
    false,
  );
});

test('existing administrator detection reads only a synthetic database count and never changes its contents', async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.environment.DATABASE_PATH);
  db.exec(
    "CREATE TABLE auth_users (id TEXT, role TEXT, status TEXT); INSERT INTO auth_users VALUES ('fixture-admin', 'admin', 'active')",
  );
  db.close();
  const before = readFileSync(f.environment.DATABASE_PATH);
  const environment = { ...f.environment, INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '' };
  const report: Report = await checkDeployment({ ...f, environment });
  assert.equal(report.ready, true);
  assert.deepEqual(readFileSync(f.environment.DATABASE_PATH), before);
  assert.deepEqual(readdirSync(f.storage), ['workspace.sqlite']);
  assert.equal(JSON.stringify(report).includes('fixture-admin'), false);
});

test('a malformed existing database fails safely rather than producing a passing fresh deployment', async (t) => {
  const f = fixture(t);
  writeFileSync(f.environment.DATABASE_PATH, 'synthetic-invalid-database-secret');
  const report: Report = await checkDeployment(f);
  assert.equal(report.ready, false);
  assert.equal(JSON.stringify(report).includes('synthetic-invalid-database-secret'), false);
  assert.equal(report.checks.find((check) => check.id === 'database-readable')!.status, 'blocker');
});

test('enabled backups need a private separate directory and a valid schedule; disabled backups are a warning', async (t) => {
  const f = fixture(t);
  const environment = {
    ...f.environment,
    BACKUP_ENABLED: 'true',
    DATABASE_BACKUP_DIR: f.backups,
    BACKUP_INTERVAL_MINUTES: '1440',
    BACKUP_RETENTION_COUNT: '7',
  };
  assert.equal((await checkDeployment({ ...f, environment })).ready, true);
  assert.deepEqual(readdirSync(f.backups), []);
  for (const override of [
    { DATABASE_BACKUP_DIR: '' },
    { DATABASE_BACKUP_DIR: f.storage },
    { BACKUP_INTERVAL_MINUTES: '0' },
    { BACKUP_INTERVAL_MINUTES: '10081' },
    { BACKUP_RETENTION_COUNT: '-1' },
    { BACKUP_RETENTION_COUNT: '366' },
    { BACKUP_ENABLED: 'yes' },
  ])
    assert.equal(
      (await checkDeployment({ ...f, environment: { ...environment, ...override } })).ready,
      false,
    );
});

test('unused partial credentials are held while explicitly selected GST or automated email needs complete valid settings', async (t) => {
  const f = fixture(t);
  const environment = {
    ...f.environment,
    RAZORPAY_KEY_ID: 'synthetic-key',
    SHRI_SARRAF_CASHFREE_CLIENT_ID: 'synthetic-client',
    SANDBOX_API_KEY: 'synthetic-gst-key',
  };
  const unused: Report = await checkDeployment({ ...f, environment });
  assert.equal(unused.ready, true);
  assert.equal(
    unused.checks.some((check) => check.id === 'shri_sarraf-cashfree' && check.status === 'warning'),
    true,
  );
  assert.equal(
    (await checkDeployment({ ...f, environment: { ...environment, GST_PROVIDER: 'sandbox' } })).ready,
    false,
  );
  assert.equal(
    (await checkDeployment({ ...f, environment: { ...environment, EMAIL_AUTOMATION: 'true' } })).ready,
    false,
  );
  const complete: Report = await checkDeployment({
    ...f,
    environment: {
      ...environment,
      GST_PROVIDER: 'sandbox',
      SANDBOX_API_SECRET: 'synthetic-gst-secret',
      SANDBOX_ENVIRONMENT: 'test',
    },
  });
  assert.equal(complete.ready, true);
  assert.equal(
    (
      await checkDeployment({
        ...f,
        environment: {
          ...environment,
          GST_PROVIDER: 'sandbox',
          SANDBOX_API_SECRET: 'synthetic-gst-secret',
          SANDBOX_ENVIRONMENT: 'sandbox',
        },
      })
    ).ready,
    false,
  );
  assert.equal(JSON.stringify(complete).includes('synthetic-gst-secret'), false);
  assert.equal(JSON.stringify(complete).includes('synthetic-gst-key'), false);
});

test('scoped email automation cannot pass using another organization shared credentials', async (t) => {
  const f = fixture(t);
  const environment = {
    ...f.environment,
    EMAIL_FROM: 'Invoices <verified@example.test>',
    RESEND_API_KEY: 'synthetic-shared-secret',
    SHRI_SARRAF_EMAIL_AUTOMATION: 'true',
  };
  assert.equal((await checkDeployment({ ...f, environment })).ready, false);
  const complete = {
    ...environment,
    SHRI_SARRAF_EMAIL_FROM: 'private-business@example.test',
    SHRI_SARRAF_RESEND_API_KEY: 'synthetic-private-secret',
  };
  assert.equal((await checkDeployment({ ...f, environment: complete })).ready, true);
  assert.equal(
    (
      await checkDeployment({
        ...f,
        environment: { ...complete, SHRI_SARRAF_EMAIL_FROM: 'unsafe\r\nsender@example.test' },
      })
    ).ready,
    false,
  );
});

test('generic GST configuration is validated without exposing query keys or provider credentials', async (t) => {
  const f = fixture(t);
  const environment = {
    ...f.environment,
    GST_PROVIDER: 'generic',
    GST_LOOKUP_URL: 'https://provider.example.test/search?gstin={gstin}&key=synthetic-provider-secret',
  };
  const report: Report = await checkDeployment({ ...f, environment });
  assert.equal(report.ready, true);
  assert.equal(JSON.stringify(report).includes('synthetic-provider-secret'), false);
  assert.equal(
    (
      await checkDeployment({
        ...f,
        environment: { ...environment, GST_LOOKUP_URL: 'http://provider.example.test/{gstin}' },
      })
    ).ready,
    false,
  );
  assert.equal(
    (
      await checkDeployment({
        ...f,
        environment: { ...environment, GST_PROVIDER: 'invalid-secret-provider-name' },
      })
    ).ready,
    false,
  );
});

test('CLI blockers return nonzero with a safe JSON report and do not inherit credentials from tests', (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [new URL('../../scripts/check-deployment.mjs', import.meta.url).pathname],
    {
      cwd: f.root,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        DATABASE_PATH: '.data/workspace.sqlite',
        PUBLIC_APP_URL: 'https://secret-user:secret-password@example.test',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(result.stdout.includes('secret-password'), false);
});
