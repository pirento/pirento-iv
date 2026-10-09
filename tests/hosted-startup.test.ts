import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { assertHostedNodeVersion, selectHostedMode, validateHostedProduction } = await import(
  new URL('../scripts/hosted-startup-config.mjs', import.meta.url).href
);

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venture-hosted-startup-'));
  const root = join(directory, 'app');
  const storage = join(directory, 'private-storage');
  const databasePath = join(storage, 'workspace.sqlite');
  mkdirSync(root);
  mkdirSync(storage);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://invoices.example.test',
    DATABASE_PATH: databasePath,
  };
  return { directory, root, storage, databasePath, environment };
}

test('hosted launchers require Node 24.5 for the environment proxy flag', () => {
  for (const version of ['24.5.0', '24.15.0', '25.0.0', '26.1.2']) {
    assert.doesNotThrow(() => assertHostedNodeVersion(version));
  }
  for (const version of ['22.20.0', '23.9.0', '24.0.0', '24.4.99', 'invalid', '24']) {
    assert.throws(() => assertHostedNodeVersion(version), /Node 24\.5 or newer/);
  }
});

test('only the exact explicit preview mode selects disposable storage', () => {
  assert.equal(selectHostedMode({}), 'production');
  assert.equal(selectHostedMode({ IV_PREVIEW_MODE: 'disposable-synthetic' }), 'disposable-synthetic');
  for (const IV_PREVIEW_MODE of ['', 'production', 'true', 'DISPOSABLE-SYNTHETIC', 'disposable-synthetic ']) {
    assert.throws(() => selectHostedMode({ IV_PREVIEW_MODE }), /Unknown IV preview mode/);
  }
});

test('valid production startup validates an existing database without modifying it', (t) => {
  const f = fixture(t);
  const before = Buffer.from('SYNTHETIC database validation fixture');
  writeFileSync(f.databasePath, before, { mode: 0o600 });
  const config = validateHostedProduction(f);
  assert.deepEqual(config, { root: f.root, databasePath: f.databasePath, creatingDatabase: false });
  assert.deepEqual(readFileSync(f.databasePath), before);
  assert.deepEqual(readdirSync(f.storage), ['workspace.sqlite']);
});

test('hosted production refuses development mode before creating storage', (t) => {
  const f = fixture(t);
  for (const NODE_ENV of [undefined, '', 'development', 'test', 'production ']) {
    assert.throws(
      () => validateHostedProduction({ ...f, environment: { ...f.environment, NODE_ENV } }),
      /requires NODE_ENV=production/,
    );
  }
  assert.deepEqual(readdirSync(f.storage), []);
});

test('hosted origin must be exact HTTPS and error messages never echo URL secrets', (t) => {
  const f = fixture(t);
  for (const PUBLIC_APP_URL of [
    undefined,
    '',
    'http://invoices.example.test',
    'https://invoices.example.test/',
    'https://invoices.example.test/invoices',
    'https://secret-user:secret-password@invoices.example.test',
    'https://invoices.example.test?secret-key=value',
    'https://invoices.example.test#secret-token',
  ]) {
    assert.throws(
      () => validateHostedProduction({ ...f, environment: { ...f.environment, PUBLIC_APP_URL } }),
      (error: Error) => /exact HTTPS origin/.test(error.message) && !error.message.includes('secret-'),
    );
  }
  assert.deepEqual(readdirSync(f.storage), []);
});

test('a missing production database refuses silent reset even when its parent exists', (t) => {
  const f = fixture(t);
  for (const IV_ALLOW_NEW_DATABASE of [undefined, '', 'false', 'TRUE', 'true ']) {
    assert.throws(
      () => validateHostedProduction({ ...f, environment: { ...f.environment, IV_ALLOW_NEW_DATABASE } }),
      /database is missing.*silent reset/,
    );
  }
  assert.deepEqual(readdirSync(f.storage), []);
});

test('first provisioning requires an explicit flag and validation itself never creates a database', (t) => {
  const f = fixture(t);
  const config = validateHostedProduction({
    ...f,
    environment: { ...f.environment, IV_ALLOW_NEW_DATABASE: 'true' },
  });
  assert.equal(config.creatingDatabase, true);
  assert.equal(config.databasePath, f.databasePath);
  assert.deepEqual(readdirSync(f.storage), []);
});

test('relative and inaccessible database paths are rejected without provisioning directories', (t) => {
  const f = fixture(t);
  for (const DATABASE_PATH of [
    '',
    ':memory:',
    '.data/workspace.sqlite',
    join(f.directory, 'missing', 'db.sqlite'),
  ]) {
    assert.throws(() =>
      validateHostedProduction({
        ...f,
        environment: { ...f.environment, DATABASE_PATH, IV_ALLOW_NEW_DATABASE: 'true' },
      }),
    );
  }
  assert.deepEqual(readdirSync(f.directory).sort(), ['app', 'private-storage']);
});

test('all storage under the replaceable app is rejected, including its private-looking .data directory', (t) => {
  const f = fixture(t);
  for (const name of ['.data', 'server', 'public', 'dist', 'src']) {
    const parent = join(f.root, name);
    mkdirSync(parent);
    assert.throws(
      () =>
        validateHostedProduction({
          ...f,
          environment: {
            ...f.environment,
            DATABASE_PATH: join(parent, 'workspace.sqlite'),
            IV_ALLOW_NEW_DATABASE: 'true',
          },
        }),
      /private and outside/,
    );
    assert.deepEqual(readdirSync(parent), []);
  }
});

test('public, dist and source directories outside the app cannot hold the hosted database', (t) => {
  const f = fixture(t);
  for (const name of ['public', 'dist', 'src']) {
    const parent = join(f.directory, name);
    mkdirSync(parent);
    assert.throws(
      () =>
        validateHostedProduction({
          ...f,
          environment: {
            ...f.environment,
            DATABASE_PATH: join(parent, 'workspace.sqlite'),
            IV_ALLOW_NEW_DATABASE: 'true',
          },
        }),
      /private and outside/,
    );
    assert.deepEqual(readdirSync(parent), []);
  }
});

test('empty files and directories remain invalid even with the first-provisioning flag', (t) => {
  const f = fixture(t);
  writeFileSync(f.databasePath, '');
  for (const DATABASE_PATH of [f.databasePath, f.storage]) {
    assert.throws(
      () =>
        validateHostedProduction({
          ...f,
          environment: { ...f.environment, DATABASE_PATH, IV_ALLOW_NEW_DATABASE: 'true' },
        }),
      /nonempty regular file/,
    );
  }
  assert.equal(readFileSync(f.databasePath).length, 0);
});

test('canonical and lexical storage checks prevent symlink escapes into or out of the app', (t) => {
  const f = fixture(t);
  const appDatabase = join(f.root, 'database.sqlite');
  writeFileSync(appDatabase, 'SYNTHETIC app-local database');
  writeFileSync(f.databasePath, 'SYNTHETIC external database');
  const externalAlias = join(f.storage, 'app-alias');
  const internalAlias = join(f.root, 'private-alias');
  symlinkSync(f.root, externalAlias, 'dir');
  symlinkSync(f.storage, internalAlias, 'dir');
  for (const DATABASE_PATH of [
    join(externalAlias, 'database.sqlite'),
    join(internalAlias, 'workspace.sqlite'),
  ]) {
    assert.throws(
      () => validateHostedProduction({ ...f, environment: { ...f.environment, DATABASE_PATH } }),
      /private and outside/,
    );
  }
  const fileAlias = join(f.storage, 'app-database.sqlite');
  symlinkSync(appDatabase, fileAlias);
  assert.throws(
    () => validateHostedProduction({ ...f, environment: { ...f.environment, DATABASE_PATH: fileAlias } }),
    /private and outside/,
  );
});

test('first provisioning refuses a dangling database symlink instead of silently following it', (t) => {
  const f = fixture(t);
  symlinkSync(join(f.directory, 'unprovisioned.sqlite'), f.databasePath);
  assert.throws(
    () =>
      validateHostedProduction({ ...f, environment: { ...f.environment, IV_ALLOW_NEW_DATABASE: 'true' } }),
    /Provision and verify/,
  );
  assert.deepEqual(readdirSync(f.directory).sort(), ['app', 'private-storage']);
});

test('a hard-linked database is rejected so an app-local alias cannot bypass private storage checks', (t) => {
  const f = fixture(t);
  writeFileSync(f.databasePath, 'SYNTHETIC external database');
  linkSync(f.databasePath, join(f.root, 'public-database-alias.sqlite'));
  assert.throws(() => validateHostedProduction(f), /without hard links/);
  assert.equal(readFileSync(f.databasePath, 'utf8'), 'SYNTHETIC external database');
});

test('a symlinked application root does not make an app-local database alias private', (t) => {
  const f = fixture(t);
  const rootAlias = join(f.directory, 'app-alias');
  const storageAlias = join(f.root, 'private-storage-alias');
  writeFileSync(f.databasePath, 'SYNTHETIC external database');
  symlinkSync(f.root, rootAlias, 'dir');
  symlinkSync(f.storage, storageAlias, 'dir');
  assert.throws(
    () =>
      validateHostedProduction({
        ...f,
        root: rootAlias,
        environment: {
          ...f.environment,
          DATABASE_PATH: join(rootAlias, 'private-storage-alias', 'workspace.sqlite'),
        },
      }),
    /private and outside/,
  );
});

test('an actual dispatcher process rejects unknown mode before touching any database', (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../hostinger-entry.mjs', import.meta.url))],
    {
      env: { ...f.environment, IV_PREVIEW_MODE: 'unknown-preview-mode' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown IV preview mode; startup refused/);
  assert.deepEqual(readdirSync(f.storage), []);
});

test('an actual production launcher rejects missing HTTPS origin before opening any database', (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../production-entry.mjs', import.meta.url))],
    {
      env: { NODE_ENV: 'production', DATABASE_PATH: f.databasePath, IV_ALLOW_NEW_DATABASE: 'true' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUBLIC_APP_URL must be the exact HTTPS origin/);
  assert.deepEqual(readdirSync(f.storage), []);
});
