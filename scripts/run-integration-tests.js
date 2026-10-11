import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvironmentValues } from '../src/config/environment.js';

const environment = loadEnvironmentValues({ environment: { ...process.env } });
const optional = process.argv.includes('--optional');
if (!environment.MONGODB_TEST_URI?.trim()) {
  console.error(
    'MongoDB integration tests did not run: set MONGODB_TEST_URI to a dedicated test replica set.',
  );
  console.error(
    'Or run npm run verify:local with mongod installed. No production database is used automatically.',
  );
  process.exitCode = optional ? 0 : 1;
} else {
  const files = readdirSync(resolve('tests/integration'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => resolve('tests/integration', name));
  if (!files.length) throw new Error('No integration test files were found.');
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files], {
    env: environment,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  let pending = '';
  let total = 0;
  let skipped = 0;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (/^# tests \d+$/.test(line)) total = Number(line.split(' ').at(-1));
      if (/^# skipped \d+$/.test(line)) skipped = Number(line.split(' ').at(-1));
    }
  });
  child.on('error', () => {
    console.error('Unable to start the integration test process.');
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    if (!total || skipped) {
      console.error(`Integration verification is incomplete: ${total} tests reported, ${skipped} skipped.`);
      process.exitCode = 1;
    } else process.exitCode = code ?? 1;
  });
}
