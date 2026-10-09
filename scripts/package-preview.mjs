import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  '.env.example',
  'README.md',
  'PREVIEW_DEPLOYMENT.md',
  'PLATFORM_SETUP.md',
  'ARCHITECTURE.md',
  'SECURITY.md',
  'index.html',
  'tsconfig.json',
  'vite.config.ts',
  'server',
  'src',
  'shared',
  'dist',
  'scripts',
];
for (const file of files) {
  if (!existsSync(join(root, file))) throw new Error(`Required deployment file is missing: ${file}`);
}
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('Build the frontend before packaging.');
const directory = join(root, 'release');
mkdirSync(directory, { recursive: true, mode: 0o700 });
// Explicit roots keep the private database, uploads, environment and Git metadata
// out of the package. Do not replace this with an archive of the whole checkout.
for (const [filename, included] of [
  ['venturecore-preview.tar.gz', files],
  ['venturecore-hostinger-source.tar.gz', files.filter((file) => file !== 'dist')],
]) {
  const archive = join(directory, filename);
  execFileSync(
    'tar',
    ['-czf', archive, '--exclude=*.test.ts', '--exclude=*.tsbuildinfo', '-C', root, ...included],
    { stdio: 'inherit' },
  );
  const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${checksum}  ${filename}\n`);
  console.log(`Created ${archive} (application only; private business data excluded).`);
}
