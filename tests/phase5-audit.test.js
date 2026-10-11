import test from 'node:test';
import assert from 'node:assert/strict';
import { auditProject } from '../scripts/phase5-audit.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('phase 5 audit provides actionable structured findings', () => {
  const result = auditProject();
  assert.equal(result.project, 'venturecore-workspace-mvc');
  assert.ok(Array.isArray(result.findings));
  assert.ok(result.checkedDependencies > 0);
  assert.ok(result.findings.every((item) => item.level && item.code && item.detail));
});

test('readiness audit blocks duplicate or filled release settings without returning their contents', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'venturecore-audit-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'audit-fixture', engines: { node: '>=24.5.0 <27' }, dependencies: {} }),
  );
  for (const name of ['src', 'tests', 'scripts']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'server.js'), '');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(root, '.example.env'),
    'INITIAL_ADMIN_PASSWORD="synthetic-private-value"\nINITIAL_ADMIN_PASSWORD=\n',
  );
  const report = auditProject(root);
  assert.ok(report.findings.some((row) => row.code === 'ENV_DUPLICATE' && row.level === 'BLOCKER'));
  assert.ok(report.findings.some((row) => row.code === 'ENV_NON_TEMPLATE' && row.level === 'BLOCKER'));
  assert.equal(JSON.stringify(report).includes('synthetic-private-value'), false);
});
