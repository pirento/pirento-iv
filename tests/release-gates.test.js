/** Unit tests: the required integration run fails clearly when no test database is configured. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('required integration verification fails clearly when no test database is configured', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'venturecore-release-gate-'));
  const script = resolve('scripts/run-integration-tests.js');
  try {
    writeFileSync(join(cwd, '.example.env'), 'MONGODB_TEST_URI=\n');
    const environment = { ...process.env, MONGODB_TEST_URI: '' };
    const result = spawnSync(process.execPath, [script], { cwd, env: environment, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /integration tests did not run/);
    assert.match(result.stderr, /MONGODB_TEST_URI/);
    const optional = spawnSync(process.execPath, [script, '--optional'], {
      cwd,
      env: environment,
      encoding: 'utf8',
    });
    assert.equal(optional.status, 0);
    assert.match(optional.stderr, /did not run/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
