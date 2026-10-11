import { spawnSync } from 'node:child_process';
const tasks = [
  ['Project readiness audit', ['scripts/phase5-audit.js']],
  ['JavaScript and EJS syntax', ['scripts/check.js']],
  ['Phase 5 tests', ['--test', 'tests/phase5-audit.test.js']],
  [
    'Configuration and deployment regressions',
    ['--test', 'tests/phase6-environment.test.js', 'tests/deployment-tools.test.js'],
  ],
];
let failed = false;
for (const [name, args] of tasks) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
