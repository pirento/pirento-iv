import { readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : entry.name.endsWith('.test.ts') ? [path] : [];
  });
}
const files = discover(join(root, 'tests')).sort();
if (!files.length) throw new Error('No tests found; refusing to report a passing empty run.');
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  { cwd: root, stdio: 'inherit', env: process.env },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
