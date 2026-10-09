import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  createDatabaseBackupService,
  DatabaseBackupError,
  parseDatabaseBackupConfig,
} from '../../server/operations/database-backup.ts';

function fixture(t: TestContext, retention = 7) {
  const root = mkdtempSync(join(tmpdir(), 'venturecore-backup-test-'));
  const filename = join(root, 'live.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    PRAGMA foreign_keys=ON;
    PRAGMA user_version=5;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE customers (id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organizations(id), name TEXT);
    INSERT INTO organizations VALUES ('synthetic-org');
    INSERT INTO customers VALUES ('synthetic-customer', 'synthetic-org', 'Synthetic customer data');
  `);
  let time = Date.parse('2026-10-09T12:00:00.000Z');
  const directory = join(root, 'backups');
  const service = createDatabaseBackupService({
    database: db,
    directory,
    retention,
    now: () => new Date(time++),
  });
  t.after(async () => {
    await service.waitForIdle();
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, filename, directory, service };
}

test('backup configuration is opt-in, bounded, and independent of secrets', () => {
  assert.deepEqual(parseDatabaseBackupConfig({}, '/tmp/example/workspace.sqlite'), {
    enabled: false,
    directory: '/tmp/example/backups',
    intervalMinutes: 1440,
    retention: 7,
  });
  assert.deepEqual(
    parseDatabaseBackupConfig({
      BACKUP_ENABLED: 'true',
      BACKUP_INTERVAL_MINUTES: '60',
      BACKUP_RETENTION_COUNT: '14',
      DATABASE_BACKUP_DIR: '/tmp/private-snapshots',
    }),
    {
      enabled: true,
      directory: '/tmp/private-snapshots',
      intervalMinutes: 60,
      retention: 14,
    },
  );
  for (const [key, values] of [
    ['BACKUP_ENABLED', ['yes', '1', 'false-with-value']],
    ['BACKUP_INTERVAL_MINUTES', ['0', '-1', '1.5', '10081', '9007199254740992']],
    ['BACKUP_RETENTION_COUNT', ['0', '-1', '2.5', '366', 'NaN']],
    ['DATABASE_BACKUP_DIR', ['\0invalid']],
  ] as const) {
    for (const value of values)
      assert.throws(() => parseDatabaseBackupConfig({ [key]: value }), DatabaseBackupError);
  }
  assert.throws(
    () =>
      parseDatabaseBackupConfig(
        { DATABASE_BACKUP_DIR: '/tmp/example/workspace.sqlite' },
        '/tmp/example/workspace.sqlite',
      ),
    DatabaseBackupError,
  );
});

test('online snapshot contains committed WAL rows and can be reopened without source or sidecars', async (t) => {
  const { db, filename, directory, service } = fixture(t);
  assert.ok(existsSync(`${filename}-wal`));
  const metadata = await service.createBackup();
  assert.equal(metadata.sqliteUserVersion, 5);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.verified, true);
  const path = await service.getVerifiedDatabasePath(metadata.id);
  const snapshot = new DatabaseSync(path, { readOnly: true });
  assert.equal(snapshot.prepare('SELECT name FROM customers').get()?.name, 'Synthetic customer data');
  assert.equal(snapshot.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  snapshot.close();
  assert.deepEqual(readdirSync(join(directory, metadata.id)).sort(), ['database.sqlite', 'manifest.json']);
  assert.equal(metadata.sha256, createHash('sha256').update(readFileSync(path)).digest('hex'));
  assert.equal(metadata.byteLength, lstatSync(path).size);
  const manifestText = readFileSync(join(directory, metadata.id, 'manifest.json'), 'utf8');
  assert.ok(!manifestText.includes('Synthetic customer data'));
  assert.ok(!manifestText.includes(filename));
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(directory, metadata.id)).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(directory, metadata.id, 'manifest.json')).mode & 0o777, 0o600);
  db.exec("UPDATE customers SET name='Changed after backup'");
  db.close();
  const independent = new DatabaseSync(path, { readOnly: true });
  assert.equal(independent.prepare('SELECT name FROM customers').get()?.name, 'Synthetic customer data');
  independent.close();
  assert.deepEqual(await service.verifyBackup(metadata.id), metadata);
});

test('backup creation is serialized across service instances and retention preserves the live database', async (t) => {
  const { db, filename, directory, service } = fixture(t, 2);
  const second = createDatabaseBackupService({ database: db, directory, retention: 2 });
  const snapshots = await Promise.all([
    service.createBackup(),
    second.createBackup(),
    service.createBackup(),
  ]);
  const remaining = await service.listBackups();
  assert.equal(remaining.length, 2);
  assert.ok(new Set(snapshots.map((snapshot) => snapshot.id)).size === 3);
  assert.ok(existsSync(filename));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get()?.count, 1);
  assert.ok(!readdirSync(directory).some((name) => name.startsWith('.pending-')));
});

test('retention never removes unknown paths and stops on tampered managed snapshots', async (t) => {
  const { directory, service } = fixture(t, 1);
  const first = await service.createBackup();
  const unknown = join(directory, 'unrelated-archive');
  mkdirSync(unknown, { mode: 0o700 });
  writeFileSync(join(unknown, 'keep.txt'), 'Unrelated private data');
  writeFileSync(join(directory, first.id, 'database.sqlite'), 'tampered data', { mode: 0o600 });
  await assert.rejects(
    service.verifyBackup(first.id),
    (error: unknown) => error instanceof DatabaseBackupError && error.code === 'verification',
  );
  const second = await service.createBackup();
  assert.match(second.retentionWarning || '', /Retention stopped/);
  assert.ok(existsSync(join(directory, first.id)));
  assert.ok(existsSync(join(directory, second.id)));
  assert.equal(readFileSync(join(unknown, 'keep.txt'), 'utf8'), 'Unrelated private data');
  assert.equal((await service.verifyBackup(second.id)).verified, true);
  await assert.rejects(service.listBackups(), DatabaseBackupError);
});

test('snapshot checks reject extra metadata, oversized manifests, insecure permissions, and unknown files', async (t) => {
  const { directory, service } = fixture(t);
  const snapshot = await service.createBackup();
  const base = join(directory, snapshot.id);
  const manifestPath = join(base, 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...JSON.parse(original), secret: 'synthetic-invalid-metadata' }),
  );
  await assert.rejects(service.verifyBackup(snapshot.id), DatabaseBackupError);
  writeFileSync(manifestPath, ' '.repeat(2049));
  await assert.rejects(service.verifyBackup(snapshot.id), DatabaseBackupError);
  writeFileSync(manifestPath, original);
  chmodSync(manifestPath, 0o644);
  await assert.rejects(
    service.verifyBackup(snapshot.id),
    (error: unknown) => error instanceof DatabaseBackupError && error.code === 'unsafe_path',
  );
  chmodSync(manifestPath, 0o600);
  writeFileSync(join(base, 'extra.txt'), 'unexpected');
  await assert.rejects(service.verifyBackup(snapshot.id), DatabaseBackupError);
  rmSync(join(base, 'extra.txt'));
  assert.equal((await service.verifyBackup(snapshot.id)).verified, true);
});

test('backup service refuses traversal and symlinks without following or changing their targets', async (t) => {
  const { db, root, directory, service } = fixture(t);
  for (const id of ['../live.sqlite', '.', '/tmp', 'snapshot-invalid', ''])
    await assert.rejects(
      service.verifyBackup(id),
      (error: unknown) => error instanceof DatabaseBackupError && error.code === 'unsafe_path',
    );
  const target = join(root, 'symlink-target');
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, 'preserve.txt'), 'safe target');
  const linkedDirectory = join(root, 'linked-backups');
  symlinkSync(target, linkedDirectory, 'dir');
  const unsafe = createDatabaseBackupService({ database: db, directory: linkedDirectory });
  await assert.rejects(unsafe.createBackup(), DatabaseBackupError);
  assert.deepEqual(readdirSync(target), ['preserve.txt']);
  const first = await service.createBackup();
  const firstDirectory = join(directory, first.id);
  rmSync(firstDirectory, { recursive: true });
  symlinkSync(target, firstDirectory, 'dir');
  await assert.rejects(
    service.verifyBackup(first.id),
    (error: unknown) => error instanceof DatabaseBackupError && error.code === 'unsafe_path',
  );
  const next = await service.createBackup();
  assert.ok(next.retentionWarning);
  assert.equal(readFileSync(join(target, 'preserve.txt'), 'utf8'), 'safe target');
  if (process.platform !== 'win32') {
    // POSIX backslashes are literal filename characters. Refuse them rather
    // than inspecting a different path when both separator styles are split.
    const unusualLink = join(root, 'nested\\backups');
    symlinkSync(target, unusualLink, 'dir');
    const unusual = createDatabaseBackupService({ database: db, directory: unusualLink });
    await assert.rejects(unusual.createBackup(), DatabaseBackupError);
    assert.equal(readFileSync(join(target, 'preserve.txt'), 'utf8'), 'safe target');
  }
});

test('integrity checks reject foreign-key violations and remove failed working snapshots', async (t) => {
  const { db, directory, service } = fixture(t);
  db.exec(
    "PRAGMA foreign_keys=OFF; INSERT INTO customers VALUES ('orphan', 'missing-org', 'Synthetic orphan');",
  );
  await assert.rejects(
    service.createBackup(),
    (error: unknown) => error instanceof DatabaseBackupError && error.code === 'verification',
  );
  assert.deepEqual(readdirSync(directory), []);
  db.exec("DELETE FROM customers WHERE id='orphan'; PRAGMA foreign_keys=ON;");
  assert.equal((await service.createBackup()).verified, true);
});

test('closed source errors are sanitized and do not poison the serialization queue', async (t) => {
  const { db, filename, directory, service } = fixture(t);
  db.close();
  await assert.rejects(service.createBackup(), (error: unknown) => {
    assert.ok(error instanceof DatabaseBackupError);
    assert.equal(error.code, 'backup_failed');
    assert.ok(!error.message.includes(filename));
    return true;
  });
  assert.equal(existsSync(directory), false);
  assert.deepEqual(await service.listBackups(), []);
  await assert.rejects(
    service.verifyBackup('snapshot-20261009T120000000Z-00000000-0000-4000-8000-000000000000'),
    (error: unknown) => error instanceof DatabaseBackupError && error.code === 'not_found',
  );
});

test('retention remains exact when multiple backups have the same timestamp', async (t) => {
  const { db, directory } = fixture(t);
  const service = createDatabaseBackupService({
    database: db,
    directory,
    retention: 2,
    now: () => new Date('2026-10-09T12:00:00.000Z'),
  });
  const snapshots = await Promise.all(Array.from({ length: 5 }, () => service.createBackup()));
  const remaining = await service.listBackups();
  assert.equal(remaining.length, 2);
  assert.ok(remaining.some((snapshot) => snapshot.id === snapshots.at(-1)?.id));
});

test('uncommitted source transactions are refused without hanging or capturing partial records', async (t) => {
  const { db, directory, service } = fixture(t);
  db.exec("BEGIN; INSERT INTO customers VALUES ('uncommitted', 'synthetic-org', 'Uncommitted customer');");
  await assert.rejects(service.createBackup(), DatabaseBackupError);
  assert.equal(existsSync(directory), false);
  db.exec('ROLLBACK');
  const snapshot = await service.createBackup();
  const restored = new DatabaseSync(await service.getVerifiedDatabasePath(snapshot.id), { readOnly: true });
  assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM customers').get()?.count, 1);
  restored.close();
});

test('verification refuses a linked database file and leaves its external target untouched', async (t) => {
  const { root, directory, service } = fixture(t);
  const metadata = await service.createBackup();
  const databasePath = join(directory, metadata.id, 'database.sqlite');
  const external = join(root, 'external.sqlite');
  writeFileSync(external, readFileSync(databasePath), { mode: 0o600 });
  rmSync(databasePath);
  symlinkSync(external, databasePath);
  await assert.rejects(service.verifyBackup(metadata.id), DatabaseBackupError);
  assert.ok(lstatSync(databasePath).isSymbolicLink());
  rmSync(databasePath);
  linkSync(external, databasePath);
  await assert.rejects(service.verifyBackup(metadata.id), DatabaseBackupError);
  assert.ok(existsSync(external));
});

test('online backup remains consistent while the source connection commits WAL writes', async (t) => {
  const { db, service } = fixture(t);
  db.exec('CREATE TABLE padded_records (id INTEGER PRIMARY KEY, revision INTEGER, payload BLOB); BEGIN;');
  const insert = db.prepare('INSERT INTO padded_records VALUES (?, 0, zeroblob(8192))');
  for (let index = 0; index < 600; index++) insert.run(index);
  db.exec('COMMIT');
  const snapshotPromise = service.createBackup();
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      db.exec('BEGIN; UPDATE padded_records SET revision=1; COMMIT;');
      resolve();
    }),
  );
  const metadata = await snapshotPromise;
  const snapshot = new DatabaseSync(await service.getVerifiedDatabasePath(metadata.id), { readOnly: true });
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM padded_records').get()?.count, 600);
  assert.equal(
    snapshot.prepare('SELECT COUNT(DISTINCT revision) AS count FROM padded_records').get()?.count,
    1,
  );
  assert.equal(db.prepare('SELECT MIN(revision) AS revision FROM padded_records').get()?.revision, 1);
  snapshot.close();
});
