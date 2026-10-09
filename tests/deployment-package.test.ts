import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { deploymentRoots, collectDeploymentFiles, createDeploymentPackages } = await import(
  new URL('../scripts/deployment-package.mjs', import.meta.url).href
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iv-package-test-'));
  for (const name of deploymentRoots) {
    if (['server', 'src', 'shared', 'dist', 'scripts'].includes(name)) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, name === 'dist' ? 'index.html' : 'fixture.ts'), '// test fixture');
    } else writeFileSync(join(root, name), '// test fixture');
  }
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { start: 'node --use-env-proxy --import tsx server/index.ts' } }),
  );
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  return root;
}

test('deployment allowlist excludes private workspace, Git, dependencies and test files', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.env'), 'PRIVATE_FIXTURE_ONLY=true');
    for (const directory of ['.data', '.preview-data', '.git', 'node_modules', 'tests']) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, 'private-fixture'), 'fixture only');
    }
    writeFileSync(join(root, 'server', 'fixture.test.ts'), '// exclude');
    writeFileSync(join(root, 'src', 'fixture.tsbuildinfo'), '// exclude');
    mkdirSync(join(root, 'src', 'backups'));
    writeFileSync(join(root, 'src', 'backups', 'BackupPage.tsx'), '// legitimate backup feature source');
    const files: string[] = collectDeploymentFiles(root);
    assert.ok(files.includes('.env.example'));
    assert.ok(files.includes('dist/index.html'));
    assert.ok(files.includes('hostinger-entry.mjs'));
    assert.ok(files.includes('src/backups/BackupPage.tsx'));
    assert.ok(!files.some((file) => /private-fixture|\.test\.ts$|\.tsbuildinfo$|^\.env$/.test(file)));
    assert.ok(!collectDeploymentFiles(root, { includeBuild: false }).includes('dist/index.html'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaging refuses secrets and databases accidentally added under application roots', () => {
  const root = fixture();
  try {
    for (const name of ['.env.local', 'workspace.sqlite', 'workspace.db-wal', 'merchant.key']) {
      const path = join(root, 'server', name);
      writeFileSync(path, 'private fixture only');
      assert.throws(() => collectDeploymentFiles(root), /Private files/);
      rmSync(path);
    }
    mkdirSync(join(root, 'scripts', '.data'));
    assert.throws(() => collectDeploymentFiles(root), /Private files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaging refuses symlinks instead of following private source targets', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'private-fixture'), 'fixture only');
    symlinkSync(join(root, 'private-fixture'), join(root, 'server', 'link.ts'));
    assert.throws(() => collectDeploymentFiles(root), /symbolic links/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistent and disposable artifacts use different startup commands and verified checksums', () => {
  const root = fixture();
  try {
    const persistent: string[] = createDeploymentPackages({ root });
    const disposable: string[] = createDeploymentPackages({ root, synthetic: true });
    assert.equal(persistent.length, 2);
    assert.equal(disposable.length, 3);
    const persistentPackage = JSON.parse(
      execFileSync('tar', ['-xOf', persistent[1], 'package.json'], { encoding: 'utf8' }),
    );
    assert.equal(persistentPackage.scripts.start, 'node --use-env-proxy --import tsx server/index.ts');
    const zip = disposable.find((path) => path.endsWith('.zip'))!;
    const disposablePackage = JSON.parse(
      execFileSync('unzip', ['-p', zip, 'package.json'], { encoding: 'utf8' }),
    );
    assert.equal(disposablePackage.scripts.start, 'node --use-env-proxy scripts/synthetic-preview-entry.mjs');
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.start,
      persistentPackage.scripts.start,
    );
    assert.equal(
      execFileSync('unzip', ['-p', zip, 'package-lock.json'], { encoding: 'utf8' }),
      readFileSync(join(root, 'package-lock.json'), 'utf8'),
    );
    assert.ok(!execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).includes('dist/'));
    for (const archive of [...persistent, ...disposable]) {
      const checksum = createHash('sha256').update(readFileSync(archive)).digest('hex');
      assert.equal(readFileSync(`${archive}.sha256`, 'utf8').split(' ')[0], checksum);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rebuilding a disposable zip removes stale entries from an earlier archive', () => {
  const root = fixture();
  try {
    const zip: string = createDeploymentPackages({ root, synthetic: true }).find((path: string) =>
      path.endsWith('.zip'),
    );
    writeFileSync(join(root, 'stale-fixture.txt'), 'fixture only');
    execFileSync('zip', ['-q', zip, 'stale-fixture.txt'], { cwd: root });
    assert.ok(execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).includes('stale-fixture.txt'));
    createDeploymentPackages({ root, synthetic: true });
    assert.ok(!execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).includes('stale-fixture.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
