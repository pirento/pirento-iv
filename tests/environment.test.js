/** Unit tests: .env / .example.env loading and production setting checks. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadEnvironment, loadEnvironmentValues } from '../src/config/environment.js';

function sandbox(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'venturecore-env-'));
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
test('private .env overrides legacy template and respects hosting values', () =>
  sandbox((cwd) => {
    writeFileSync(join(cwd, '.example.env'), 'MONGODB_URI=mongodb://legacy\nPORT=2000\n');
    writeFileSync(join(cwd, '.env'), 'MONGODB_URI=mongodb://private\nPORT=4000\n');
    const environment = { PORT: '5000' };
    const result = loadEnvironment({ cwd, environment });
    assert.equal(result.port, 5000);
    assert.equal(environment.MONGODB_URI, 'mongodb://private');
  }));
test('legacy configuration remains compatible', () =>
  sandbox((cwd) => {
    writeFileSync(join(cwd, '.example.env'), 'MONGODB_URI=mongodb://legacy\n');
    assert.equal(loadEnvironment({ cwd, environment: {} }).environment.MONGODB_URI, 'mongodb://legacy');
  }));
test('production rejects HTTP public origin', () =>
  sandbox((cwd) => {
    assert.throws(
      () =>
        loadEnvironment({
          cwd,
          environment: {
            NODE_ENV: 'production',
            MONGODB_URI: 'mongodb://localhost',
            PUBLIC_APP_URL: 'http://example.com',
          },
        }),
      /HTTPS origin/,
    );
  }));
test('production accepts HTTPS origin', () =>
  sandbox((cwd) => {
    assert.equal(
      loadEnvironment({
        cwd,
        environment: {
          NODE_ENV: 'production',
          MONGODB_URI: 'mongodb://localhost',
          PUBLIC_APP_URL: 'https://example.com',
        },
      }).port,
      3001,
    );
  }));

test('selecting a private file never falls back to a different database in the example', () =>
  sandbox((cwd) => {
    writeFileSync(join(cwd, '.example.env'), 'MONGODB_URI=mongodb://legacy\n');
    writeFileSync(join(cwd, '.env'), 'PORT=4000\n');
    assert.throws(() => loadEnvironment({ cwd, environment: {} }), /Set MONGODB_URI/);
  }));

test('values-only loading supports dedicated test and preview inputs without a persistent URI', () =>
  sandbox((cwd) => {
    writeFileSync(
      join(cwd, '.example.env'),
      'MONGODB_TEST_URI=mongodb://test-only\nIV_PREVIEW_MONGODB_URI=mongodb://preview-only\n',
    );
    const environment = loadEnvironmentValues({
      cwd,
      environment: { MONGODB_TEST_URI: 'mongodb://host-test' },
    });
    assert.equal(environment.MONGODB_TEST_URI, 'mongodb://host-test');
    assert.equal(environment.IV_PREVIEW_MONGODB_URI, 'mongodb://preview-only');
    assert.equal(environment.MONGODB_URI, undefined);
  }));

test('production origin validation rejects paths, userinfo, fragments and ambiguous syntax without echoing inputs', () =>
  sandbox((cwd) => {
    for (const origin of [
      'https://workspace.example.test/path',
      'https://workspace.example.test/',
      'https://private-user:private-password@workspace.example.test',
      'https://workspace.example.test#private-fragment',
      'https://workspace.example.test?private-query',
      ' https://workspace.example.test',
    ]) {
      assert.throws(
        () =>
          loadEnvironment({
            cwd,
            environment: {
              NODE_ENV: 'production',
              MONGODB_URI: 'mongodb://local-test',
              PUBLIC_APP_URL: origin,
            },
          }),
        (error) => /exact HTTPS origin/.test(error.message) && !error.message.includes('private-'),
      );
    }
    assert.throws(
      () => loadEnvironment({ cwd, environment: { NODE_ENV: 'prod', MONGODB_URI: 'mongodb://local-test' } }),
      /NODE_ENV must/,
    );
  }));

function hostingerCli(cwd, hostValues = {}) {
  const serverUrl = new URL('../server.js', import.meta.url).href;
  const syntheticUrl = new URL('../scripts/synthetic-preview.js', import.meta.url).href;
  const source = (mode) =>
    'console.log(JSON.stringify({' +
    'mode:' +
    JSON.stringify(mode) +
    ',nodeEnv:process.env.NODE_ENV,uri:process.env.MONGODB_URI,' +
    'origin:process.env.PUBLIC_APP_URL,port:process.env.PORT,' +
    'previewUri:process.env.IV_PREVIEW_MONGODB_URI}));';
  const hook = join(cwd, 'launch-hook.mjs');
  // Run the actual CLI, replacing only its final application launch. Configuration
  // loading and mode selection remain real; no database or network is contacted.
  writeFileSync(
    hook,
    "import { registerHooks } from 'node:module';\n" +
      'const replacements = ' +
      JSON.stringify({ [serverUrl]: source('production'), [syntheticUrl]: source('synthetic') }) +
      ';\n' +
      'registerHooks({load(url, context, nextLoad) {' +
      "if (Object.hasOwn(replacements, url)) return {format:'module', shortCircuit:true, source:replacements[url]};" +
      'return nextLoad(url, context);}});\n',
  );
  return spawnSync(
    process.execPath,
    ['--import', hook, fileURLToPath(new URL('../scripts/hostinger-entry.js', import.meta.url))],
    { cwd, env: hostValues, encoding: 'utf8', timeout: 10_000 },
  );
}

test('actual Hostinger wrapper honors private config before example defaults and preserves host values', () =>
  sandbox((cwd) => {
    writeFileSync(
      join(cwd, '.example.env'),
      'NODE_ENV=development\nMONGODB_URI=mongodb://example-only\nPUBLIC_APP_URL=\nPORT=3001\n',
    );
    writeFileSync(
      join(cwd, '.env'),
      'NODE_ENV=production\nMONGODB_URI=mongodb://private-only\nPUBLIC_APP_URL=https://workspace.example.test\nPORT=4001\n',
    );
    const result = hostingerCli(cwd, { PORT: '5001' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      mode: 'production',
      nodeEnv: 'production',
      uri: 'mongodb://private-only',
      origin: 'https://workspace.example.test',
      port: '5001',
    });
  }));

test('actual Hostinger wrapper retains the populated .example.env workflow', () =>
  sandbox((cwd) => {
    writeFileSync(
      join(cwd, '.example.env'),
      'NODE_ENV=production\nMONGODB_URI=mongodb://example-configured\nPUBLIC_APP_URL=https://workspace.example.test\nPORT=4101\n',
    );
    const result = hostingerCli(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).uri, 'mongodb://example-configured');
    assert.equal(JSON.parse(result.stdout).port, '4101');
  }));

test('actual Hostinger wrapper selects isolated synthetic inputs from the selected file', () =>
  sandbox((cwd) => {
    writeFileSync(join(cwd, '.example.env'), 'MONGODB_URI=mongodb://persistent-example\n');
    writeFileSync(
      join(cwd, '.env'),
      'IV_PREVIEW_MODE=disposable-synthetic\nNODE_ENV=production\nIV_PREVIEW_MONGODB_URI=mongodb://preview-only\n',
    );
    const result = hostingerCli(cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      mode: 'synthetic',
      nodeEnv: 'production',
      previewUri: 'mongodb://preview-only',
    });
  }));

test('actual Hostinger wrapper refuses an invalid mode without disclosing its value', () =>
  sandbox((cwd) => {
    writeFileSync(join(cwd, '.example.env'), 'IV_PREVIEW_MODE=private-invalid-value\n');
    const result = hostingerCli(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown preview mode/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('private-invalid-value'), false);
  }));
