import { readdirSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.data', '.git'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
let count = 0;
for (const path of files(process.cwd())) {
  if (['.ts', '.tsx', '.jsx'].includes(extname(path)))
    throw new Error(`Unexpected non-JavaScript source: ${path}`);
  if (extname(path) === '.js') {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exitCode = 1;
    }
    count++;
  }
  if (extname(path) === '.ejs') {
    ejs.compile(readFileSync(path, 'utf8'), { filename: path });
    count++;
  }
}
if (!process.exitCode)
  console.log(
    `Checked ${count} JavaScript modules and EJS templates. No TypeScript or JSX build is required.`,
  );
