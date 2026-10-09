import { DatabaseSync } from 'node:sqlite';
import {
  constants,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
  createReadStream,
} from 'node:fs';
import { isAbsolute, dirname, resolve, relative, parse, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createDatabaseBackupService,
  parseDatabaseBackupConfig,
} from '../server/operations/database-backup.ts';
import { prepareRestoredDatabase, acknowledgeDatabaseRecovery } from '../server/operations/recovery.ts';

function assertPrivateLocation(target, cwd) {
  for (const name of ['dist', 'public', 'src', 'server', 'shared', 'scripts']) {
    const child = relative(resolve(cwd, name), target);
    if (!child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
      throw new Error('Database files must remain outside application/public assets.');
  }
}

function safeDatabasePath(filename, cwd, createParent = false) {
  if (!isAbsolute(filename) || filename.includes('\0'))
    throw new Error('Use an absolute private database path.');
  const target = resolve(filename);
  assertPrivateLocation(target, cwd);
  const root = parse(target).root;
  let current = root;
  for (const component of dirname(target).slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, component);
    if (!existsSync(current)) {
      if (!createParent) throw new Error('The private database directory does not exist.');
      mkdirSync(current, { mode: 0o700 });
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('The database path is unsafe.');
  }
  if (process.platform !== 'win32' && (lstatSync(dirname(target)).mode & 0o077) !== 0)
    throw new Error('The database directory must be private.');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('The database file is unsafe.');
  }
  return target;
}

async function checksum(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function runDatabaseCommand(command, arguments_, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    allowPositionals: false,
    options: {
      database: { type: 'string' },
      directory: { type: 'string' },
      backup: { type: 'string' },
      target: { type: 'string' },
      list: { type: 'boolean' },
      verify: { type: 'string' },
      'acknowledge-reconciliation': { type: 'boolean' },
    },
  });
  if (!['backup', 'restore', 'resume'].includes(command))
    throw new Error('Choose backup, restore or resume.');
  const allowed =
    command === 'backup'
      ? ['database', 'directory', 'list', 'verify']
      : command === 'restore'
        ? ['database', 'directory', 'backup', 'target']
        : ['database', 'acknowledge-reconciliation'];
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new Error('The options do not match this database operation.');
  if (values.list && values.verify) throw new Error('Choose listing or verification, not both.');
  const databasePath = values.database ?? environment.DATABASE_PATH ?? resolve(cwd, '.data/workspace.sqlite');
  const config = parseDatabaseBackupConfig(
    { ...environment, ...(values.directory ? { DATABASE_BACKUP_DIR: values.directory } : {}) },
    databasePath,
  );
  assertPrivateLocation(config.directory, cwd);
  let database;
  let target;
  let created = false;
  try {
    if (command === 'resume') {
      if (!values['acknowledge-reconciliation'])
        throw new Error(
          'Review accounts, numbering, gateway payments and email history before acknowledging recovery.',
        );
      const filename = safeDatabasePath(databasePath, cwd);
      if (!existsSync(filename)) throw new Error('The recovery database does not exist.');
      database = new DatabaseSync(filename);
      acknowledgeDatabaseRecovery(database, true, now());
      return {
        ok: true,
        operation: 'resume',
        recoveryReviewed: true,
        note: 'Queued messages remain held; acknowledgement does not verify provider history.',
      };
    }
    database =
      command === 'backup' && !values.list && !values.verify
        ? new DatabaseSync(safeDatabasePath(databasePath, cwd), { readOnly: true })
        : new DatabaseSync(':memory:');
    const service = createDatabaseBackupService({
      database,
      directory: config.directory,
      retention: config.retention,
      now,
    });
    if (command === 'backup') {
      if (values.list) return { ok: true, operation: 'list', backups: await service.listBackups() };
      if (values.verify)
        return { ok: true, operation: 'verify', backup: await service.verifyBackup(values.verify) };
      return { ok: true, operation: 'backup', backup: await service.createBackup() };
    }
    if (!values.backup || !values.target)
      throw new Error('Restore requires a snapshot identifier and a new private target path.');
    const metadata = await service.verifyBackup(values.backup);
    if (metadata.sqliteUserVersion > 5) throw new Error('This backup requires a newer application version.');
    const source = await service.getVerifiedDatabasePath(values.backup);
    target = safeDatabasePath(values.target, cwd, true);
    if (existsSync(target) || existsSync(target + '-wal') || existsSync(target + '-shm'))
      throw new Error('Restore requires a new target. Existing databases are never overwritten.');
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    created = true;
    chmodSync(target, 0o600);
    if ((await checksum(target)) !== metadata.sha256)
      throw new Error('The restored copy failed checksum verification.');
    const recovered = new DatabaseSync(target);
    try {
      recovered.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;');
      if (
        Object.values(recovered.prepare('PRAGMA quick_check').get())[0] !== 'ok' ||
        recovered.prepare('PRAGMA foreign_key_check').all().length
      )
        throw new Error('The recovered database failed integrity checks.');
      prepareRestoredDatabase(recovered, metadata.sha256, now());
    } finally {
      recovered.close();
    }
    const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return {
      ok: true,
      operation: 'restore',
      backupId: metadata.id,
      recoveryRequired: true,
      note: 'New recovered file created. Server startup is held until account, payment and email reconciliation is acknowledged offline.',
    };
  } catch (error) {
    if (created && target) {
      for (const filename of [target, target + '-wal', target + '-shm', target + '-journal'])
        rmSync(filename, { force: true });
    }
    throw error;
  } finally {
    database?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (existsSync('.env')) process.loadEnvFile('.env');
    console.log(JSON.stringify(await runDatabaseCommand(process.argv[2], process.argv.slice(3)), null, 2));
  } catch {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          'Database operation stopped safely. Check private storage, verified snapshot, command options and recovery review requirements.',
      }),
    );
    process.exitCode = 1;
  }
}
