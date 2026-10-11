import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertBlankExample,
  collectDeploymentFiles,
  deploymentRoots,
} from '../scripts/deployment-package.js';
import { checkDeployment } from '../scripts/check-deployment.js';
import { assertHostedNodeVersion, selectHostedMode } from '../scripts/hostinger-entry.js';
import { validateHostedProduction } from '../src/config/production.js';

const environment = {
  NODE_ENV: 'production',
  PUBLIC_APP_URL: 'https://billing.example.test',
  HOST: '0.0.0.0',
  PORT: '3001',
  BACKUP_ENABLED: 'false',
  EMAIL_AUTOMATION: 'false',
};
const populated = { existing: true, activeAdmins: 1, recoveryPending: false };

test('source packaging accepts the shipped template and rejects filled credential inputs', () => {
  const template = readFileSync(new URL('../.example.env', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertBlankExample(template));
  for (const field of [
    'INITIAL_ADMIN_PASSWORD',
    'RESEND_API_KEY',
    'RAZORPAY_KEY_SECRET',
    'IV_PREVIEW_MONGODB_URI',
  ])
    assert.throws(
      () => assertBlankExample(`${template}\n${field}=never-package-this-test-value\n`),
      /private or non-template/,
    );
  assert.throws(
    () => assertBlankExample(`${template}\nMONGODB_URI=mongodb+srv://private.example.test\n`),
    /private or non-template/,
  );
});

test('deployment preflight distinguishes existing workspaces, first launch and recovery holds', async () => {
  assert.equal(
    (await checkDeployment({ environment, databaseState: populated, nodeVersion: '24.19.0' })).ready,
    true,
  );
  const empty = await checkDeployment({ environment, databaseState: { ...populated, existing: false } });
  assert.equal(empty.ready, false);
  assert.ok(empty.checks.some((row) => row.id === 'new-database' && row.status === 'blocker'));
  const approved = await checkDeployment({
    environment: { ...environment, IV_ALLOW_NEW_DATABASE: 'true' },
    databaseState: { ...populated, existing: false },
  });
  assert.equal(approved.ready, true);
  const held = await checkDeployment({ environment, databaseState: { ...populated, recoveryPending: true } });
  assert.equal(held.ready, false);
  const badOrigin = await checkDeployment({
    environment: { ...environment, PUBLIC_APP_URL: 'https://billing.example.test/path' },
    databaseState: populated,
  });
  assert.equal(badOrigin.ready, false);
  const badProxy = await checkDeployment({
    environment: { ...environment, TRUST_PROXY: 'true' },
    databaseState: populated,
  });
  assert.equal(badProxy.ready, false);
  assert.ok(badProxy.checks.some((row) => row.id === 'trusted-proxy' && row.status === 'blocker'));
  const explicitProxy = await checkDeployment({
    environment: { ...environment, TRUST_PROXY: '127.0.0.1/32,::1/128' },
    databaseState: populated,
  });
  assert.equal(explicitProxy.ready, true);
  assert.equal(JSON.stringify(explicitProxy).includes('127.0.0.1/32'), false);
});

test('hosted launch selects only the supported mode and runtime range', () => {
  assert.equal(selectHostedMode({}), 'production');
  assert.equal(selectHostedMode({ IV_PREVIEW_MODE: 'disposable-synthetic' }), 'disposable-synthetic');
  assert.throws(() => selectHostedMode({ IV_PREVIEW_MODE: 'unknown' }), /Unknown preview mode/);
  for (const version of ['24.5.0', '24.19.0', '26.0.0'])
    assert.doesNotThrow(() => assertHostedNodeVersion(version));
  for (const version of ['22.0.0', '24.0.0', '27.0.0', '24.invalid'])
    assert.throws(() => assertHostedNodeVersion(version));
});

test('release guard rejects an earlier private assignment masked by a blank duplicate', () => {
  for (const contents of [
    'INITIAL_ADMIN_PASSWORD=synthetic-private-value\nINITIAL_ADMIN_PASSWORD=\n',
    'INITIAL_ADMIN_PASSWORD="synthetic-private-value"\nexport INITIAL_ADMIN_PASSWORD = ""\n',
    'MONGODB_URI=mongodb://private-example\nMONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0\n',
    'UNUSED_INPUT=\nUNUSED_INPUT=\n',
    'INITIAL_ADMIN_PASSWORD="\nsynthetic-private-value\n"\n',
    'PRIVATE_INPUT: synthetic-private-value\n',
  ]) {
    assert.throws(
      () => assertBlankExample(contents),
      (error) =>
        /private or non-template/.test(error.message) && !error.message.includes('synthetic-private-value'),
    );
  }
  assert.doesNotThrow(() =>
    assertBlankExample('# Comment\nexport NODE_ENV = "development"\nINITIAL_ADMIN_PASSWORD=\n'),
  );
});

function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'venturecore-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directories = new Set(['docs', 'src', 'shared', 'views', 'public', 'scripts', 'tests']);
  for (const name of deploymentRoots) {
    if (directories.has(name)) mkdirSync(join(root, name));
    else writeFileSync(join(root, name), '');
  }
  writeFileSync(join(root, '.example.env'), 'NODE_ENV=development\nINITIAL_ADMIN_PASSWORD=\n');
  return root;
}

test('release inventory retains CI and browser tests and leaves root private settings out', (t) => {
  const root = releaseFixture(t);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'verify.yml'), 'name: Verify\n');
  writeFileSync(join(root, 'playwright.config.js'), 'export default {};\n');
  mkdirSync(join(root, 'tests', 'browser'));
  writeFileSync(join(root, 'tests', 'browser', 'workspace.spec.js'), '// Browser regression\n');
  writeFileSync(join(root, '.env'), 'INITIAL_ADMIN_PASSWORD=synthetic-private-value\n');
  const files = collectDeploymentFiles(root);
  assert.ok(files.includes('.github/workflows/verify.yml'));
  assert.ok(files.includes('playwright.config.js'));
  assert.ok(files.includes('tests/browser/workspace.spec.js'));
  assert.equal(files.includes('.env'), false);
});

test('release inventory rejects nested environment files and validates nested example templates', (t) => {
  const root = releaseFixture(t);
  const privatePath = join(root, 'docs', 'production.env');
  writeFileSync(privatePath, 'INITIAL_ADMIN_PASSWORD=synthetic-private-value\n');
  assert.throws(() => collectDeploymentFiles(root), /private file/);
  rmSync(privatePath);
  writeFileSync(
    join(root, 'docs', '.example.env'),
    'INITIAL_ADMIN_PASSWORD=synthetic-private-value\nINITIAL_ADMIN_PASSWORD=\n',
  );
  assert.throws(() => collectDeploymentFiles(root), /private or non-template/);
});

test('release inventory refuses symlinked CI files', (t) => {
  const root = releaseFixture(t);
  mkdirSync(join(root, '.github'));
  symlinkSync(join(root, 'README.md'), join(root, '.github', 'linked-source'));
  assert.throws(() => collectDeploymentFiles(root), /symbolic links/);
});

test('production preflight requires an active administrator or complete bootstrap before initialization', async () => {
  const noAdmin = { existing: true, activeAdmins: 0, recoveryPending: false };
  const inspectDatabase = async () => noAdmin;
  await assert.rejects(validateHostedProduction(environment, { inspectDatabase }), /No active administrator/);
  const bootstrap = {
    ...environment,
    INITIAL_ADMIN_EMAIL: 'owner@example.test',
    INITIAL_ADMIN_PASSWORD: 'TemporaryOwnerTest123!',
  };
  assert.equal((await validateHostedProduction(bootstrap, { inspectDatabase })).activeAdmins, 0);
  const report = await checkDeployment({ environment, databaseState: noAdmin });
  assert.equal(report.ready, false);
  assert.equal((await checkDeployment({ environment: bootstrap, databaseState: noAdmin })).ready, true);

  let inspections = 0;
  await assert.rejects(
    validateHostedProduction(
      { ...environment, INITIAL_ADMIN_EMAIL: 'owner@example.test' },
      {
        inspectDatabase: async () => {
          inspections++;
          return populated;
        },
      },
    ),
    /INITIAL_ADMIN_EMAIL/,
  );
  assert.equal(inspections, 0);
});

test('production preflight blocks wrong empty databases and recovery holds and redacts inspection failures', async () => {
  const bootstrap = {
    ...environment,
    INITIAL_ADMIN_EMAIL: 'owner@example.test',
    INITIAL_ADMIN_PASSWORD: 'TemporaryOwnerTest123!',
  };
  const empty = async () => ({ existing: false, activeAdmins: 0, recoveryPending: false });
  await assert.rejects(
    validateHostedProduction(bootstrap, { inspectDatabase: empty }),
    /Expected workspace database is empty/,
  );
  assert.equal(
    (
      await validateHostedProduction(
        { ...bootstrap, IV_ALLOW_NEW_DATABASE: 'true' },
        { inspectDatabase: empty },
      )
    ).existing,
    false,
  );
  await assert.rejects(
    validateHostedProduction(
      { ...bootstrap, IV_ALLOW_NEW_DATABASE: 'true' },
      { inspectDatabase: async () => ({ existing: true, activeAdmins: 1, recoveryPending: true }) },
    ),
    /held for recovery review/,
  );
  await assert.rejects(
    validateHostedProduction(environment, {
      inspectDatabase: async () => {
        throw new Error('synthetic-private-uri-and-password');
      },
    }),
    (error) => /preflight failed/.test(error.message) && !error.message.includes('synthetic-private'),
  );
  assert.equal(
    (
      await checkDeployment({
        environment: { ...environment, IV_ALLOW_NEW_DATABASE: 'yes' },
        databaseState: populated,
      })
    ).ready,
    false,
  );
});
