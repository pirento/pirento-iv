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
import { inspectExampleTemplate } from './environment-template.js';

export const deploymentRoots = [
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.prettierrc.json',
  '.prettierignore',
  '.example.env',
  'README.md',
  'compose.yml',
  'server.js',
  'docs',
  'src',
  'shared',
  'views',
  'public',
  'scripts',
  'tests',
];

export const optionalDeploymentRoots = ['.github', 'eslint.config.js', 'playwright.config.js'];

/** A directly loaded config file may contain secrets; refuse to package a filled copy. */
export function assertBlankExample(contents) {
  if (inspectExampleTemplate(contents).length)
    throw new Error(
      'The .example.env file contains private or non-template settings, duplicate keys or malformed assignments. Package only the blank distributed template; retain populated configuration separately.',
    );
}

/** Allowlisted source only. Private data, symlinks and local credentials cannot be included. */
export function collectDeploymentFiles(root) {
  const directory = realpathSync(root);
  const files = [];
  function visit(relative) {
    const filename = join(directory, relative);
    const name = basename(filename);
    if (
      (/(^|\.)env($|\.)/i.test(name) && name !== '.example.env') ||
      ['.data', '.preview-data', '.git', 'node_modules', 'release'].includes(name) ||
      /\.(?:sqlite|db)(?:-wal|-shm)?$|\.(?:ejson|pem|key|p12|pfx)$/i.test(name)
    )
      throw new Error(
        'A private file is present in an allowlisted source directory. Move it outside the application before packaging.',
      );
    const metadata = lstatSync(filename);
    if (metadata.isSymbolicLink()) throw new Error('Deployment sources must not contain symbolic links.');
    if (metadata.isDirectory()) {
      for (const child of readdirSync(filename).sort()) visit(`${relative}/${child}`);
    } else if (metadata.isFile()) {
      if (name === '.example.env') assertBlankExample(readFileSync(filename, 'utf8'));
      files.push(relative);
    } else throw new Error('Deployment source contains a nonregular file.');
  }
  for (const relative of deploymentRoots) {
    if (!existsSync(join(directory, relative)))
      throw new Error(`Required project entry is missing: ${relative}`);
    visit(relative);
  }
  for (const relative of optionalDeploymentRoots) if (existsSync(join(directory, relative))) visit(relative);
  return files;
}

export function createDeploymentPackages({ root, synthetic = false }) {
  const applicationRoot = realpathSync(root);
  const files = collectDeploymentFiles(applicationRoot);
  const output = join(applicationRoot, 'release');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const staged = mkdtempSync(join(tmpdir(), 'venturecore-package-'));
  try {
    // Both archives have one clear project directory. The normal checkout is never mutated.
    const archiveRoot = join(staged, 'venturecore-mvc');
    mkdirSync(archiveRoot, { mode: 0o700 });
    for (const file of files) {
      const destination = join(archiveRoot, file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(join(applicationRoot, file), destination);
    }
    // Validate the copied release too, so a template changed during staging
    // cannot enter an archive after passing validation in the source directory.
    collectDeploymentFiles(archiveRoot);
    if (synthetic) {
      const packagePath = join(archiveRoot, 'package.json');
      const package_ = JSON.parse(readFileSync(packagePath, 'utf8'));
      package_.scripts.start = package_.scripts['start:synthetic-preview'];
      writeFileSync(packagePath, `${JSON.stringify(package_, null, 2)}\n`, { mode: 0o600 });
    }
    const label = synthetic
      ? 'venturecore-disposable-synthetic-mvc'
      : 'venturecore-ejs-javascript-mongodb-mvc';
    const included = files.map((file) => `venturecore-mvc/${file}`);
    const created = [];
    for (const extension of ['zip', 'tar.gz']) {
      const archive = join(output, `${label}.${extension}`);
      rmSync(archive, { force: true });
      if (extension === 'zip')
        execFileSync('zip', ['-q', archive, ...included], { cwd: staged, stdio: 'inherit' });
      else
        execFileSync('tar', ['-czf', archive, '--no-recursion', '-C', staged, ...included], {
          stdio: 'inherit',
        });
      chmodSync(archive, 0o600);
      const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
      writeFileSync(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`, { mode: 0o600 });
      created.push(archive);
    }
    return created;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
