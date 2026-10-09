import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const deploymentRoots = [
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  '.env.example',
  'README.md',
  'PREVIEW_DEPLOYMENT.md',
  'PREVIEW-START-HERE.md',
  'PLATFORM_SETUP.md',
  'ARCHITECTURE.md',
  'SECURITY.md',
  'DATABASE_OPERATIONS.md',
  'hostinger-entry.mjs',
  'production-entry.mjs',
  'index.html',
  'tsconfig.json',
  'vite.config.ts',
  'server',
  'src',
  'shared',
  'dist',
  'scripts',
];

/** File allowlist, with no symlink traversal or private storage in runtime roots. */
export function collectDeploymentFiles(root, { includeBuild = true } = {}) {
  const directory = realpathSync(root);
  const files = [];
  function visit(relative) {
    const path = join(directory, relative);
    const name = basename(path);
    if (
      (name.startsWith('.env') && name !== '.env.example') ||
      ['.data', '.preview-data', '.git', 'node_modules'].includes(name) ||
      /\.(?:sqlite|db)(?:-wal|-shm)?$|\.(?:pem|key|p12|pfx)$/i.test(name)
    )
      throw new Error('Private files must not be present in deployment source roots.');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Deployment files must not contain symbolic links.');
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(`${relative}/${child}`);
    } else if (stat.isFile()) {
      if (!name.endsWith('.test.ts') && !name.endsWith('.tsbuildinfo')) files.push(relative);
    } else throw new Error('Deployment source contains a nonregular file.');
  }
  for (const relative of deploymentRoots) {
    if (relative === 'dist' && !includeBuild) continue;
    if (!existsSync(join(directory, relative)))
      throw new Error(`Required deployment file is missing: ${relative}`);
    visit(relative);
  }
  if (includeBuild && !files.includes('dist/index.html'))
    throw new Error('Build the frontend before packaging.');
  return files;
}

export function createDeploymentPackages({ root, synthetic = false }) {
  const applicationRoot = realpathSync(root);
  const files = collectDeploymentFiles(applicationRoot);
  const sourceFiles = files.filter((file) => !file.startsWith('dist/'));
  const output = join(applicationRoot, 'release');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  let staged;
  try {
    let archiveRoot = applicationRoot;
    if (synthetic) {
      // Only this disposable artifact changes npm start. The development checkout
      // and persistent deployment retain their ordinary server startup command.
      staged = mkdtempSync(join(tmpdir(), 'iv-synthetic-package-'));
      chmodSync(staged, 0o700);
      for (const file of files) {
        const destination = join(staged, file);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(join(applicationRoot, file), destination);
      }
      const packagePath = join(staged, 'package.json');
      const package_ = JSON.parse(readFileSync(packagePath, 'utf8'));
      package_.scripts.start = 'node --use-env-proxy scripts/synthetic-preview-entry.mjs';
      writeFileSync(packagePath, `${JSON.stringify(package_, null, 2)}\n`, { mode: 0o600 });
      archiveRoot = staged;
    }
    const artifacts = synthetic
      ? [
          ['venturecore-disposable-synthetic-preview.tar.gz', files],
          ['venturecore-disposable-synthetic-hostinger-source.tar.gz', sourceFiles],
          ['venturecore-disposable-synthetic-hostinger-source.zip', sourceFiles],
        ]
      : [
          ['venturecore-preview.tar.gz', files],
          ['venturecore-hostinger-source.tar.gz', sourceFiles],
        ];
    const created = [];
    for (const [filename, included] of artifacts) {
      const archive = join(output, filename);
      // Zip updates an existing archive by default, so remove it first; stale
      // entries must never survive a new allowlisted release.
      rmSync(archive, { force: true });
      if (filename.endsWith('.zip'))
        execFileSync('zip', ['-q', archive, ...included], { cwd: archiveRoot, stdio: 'inherit' });
      else
        execFileSync('tar', ['-czf', archive, '--no-recursion', '-C', archiveRoot, ...included], {
          stdio: 'inherit',
        });
      chmodSync(archive, 0o600);
      const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
      writeFileSync(`${archive}.sha256`, `${checksum}  ${filename}\n`, { mode: 0o600 });
      created.push(archive);
    }
    return created;
  } finally {
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
}
