import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime packages give an actionable missing-tests error without claiming success', () => {
  const root = mkdtempSync(join(tmpdir(), 'iv-test-runner-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../scripts/test.mjs', import.meta.url), join(root, 'scripts', 'test.mjs'));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deployment package omits the development tests/);
    assert.match(result.stderr, /https:\/\/github.com\/pirento\/pirento-iv/);
    assert.match(result.stderr, /npm ci --include=dev, then npm test/);
    mkdirSync(join(root, 'tests'));
    const empty = spawnSync(process.execPath, [join(root, 'scripts', 'test.mjs')], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No tests found; refusing to report a passing empty run/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
