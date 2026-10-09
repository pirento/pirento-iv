import { backup, DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const FORMAT_VERSION = 1;
const MANIFEST_LIMIT = 2048;
const ID_PATTERN =
  /^snapshot-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const directoryQueues = new Map<string, Promise<unknown>>();

export class DatabaseBackupError extends Error {
  constructor(
    public readonly code: 'configuration' | 'unsafe_path' | 'not_found' | 'verification' | 'backup_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseBackupError';
  }
}

export interface DatabaseBackupConfig {
  enabled: boolean;
  directory: string;
  intervalMinutes: number;
  retention: number;
}

export interface BackupMetadata {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  sqliteUserVersion: number;
  byteLength: number;
  sha256: string;
  verified: true;
  retentionWarning?: string;
}

interface BackupManifest {
  schemaVersion: 1;
  kind: 'venturecore-sqlite-backup';
  id: string;
  createdAt: string;
  sqliteUserVersion: number;
  database: { file: 'database.sqlite'; byteLength: number; sha256: string };
}

export interface DatabaseBackupOptions {
  database: DatabaseSync;
  directory: string;
  retention?: number;
  now?: () => Date;
}

export interface DatabaseBackupService {
  createBackup(): Promise<BackupMetadata>;
  listBackups(): Promise<BackupMetadata[]>;
  verifyBackup(id: string): Promise<BackupMetadata>;
  /** Server-only path. Never include this path in an HTTP response. */
  getVerifiedDatabasePath(id: string): Promise<string>;
  waitForIdle(): Promise<void>;
}

function integerSetting(value: string | undefined, fallback: number, maximum: number, label: string) {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim()))
    throw new DatabaseBackupError('configuration', `${label} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new DatabaseBackupError('configuration', `${label} is outside its allowed range.`);
  return number;
}

export function parseDatabaseBackupConfig(
  environment: Record<string, string | undefined>,
  databasePath = '.data/workspace.sqlite',
): DatabaseBackupConfig {
  const enabled = environment.BACKUP_ENABLED?.trim().toLowerCase() || 'false';
  if (enabled !== 'true' && enabled !== 'false')
    throw new DatabaseBackupError('configuration', 'BACKUP_ENABLED must be true or false.');
  const configuredDirectory = environment.DATABASE_BACKUP_DIR?.trim();
  if (configuredDirectory?.includes('\0'))
    throw new DatabaseBackupError('configuration', 'DATABASE_BACKUP_DIR is invalid.');
  const directory = resolve(configuredDirectory || join(dirname(resolve(databasePath)), 'backups'));
  const source = resolve(databasePath);
  if (process.platform === 'win32' ? directory.toLowerCase() === source.toLowerCase() : directory === source)
    throw new DatabaseBackupError('configuration', 'The backup directory cannot be the database file.');
  return {
    enabled: enabled === 'true',
    directory,
    intervalMinutes: integerSetting(
      environment.BACKUP_INTERVAL_MINUTES,
      1440,
      10080,
      'BACKUP_INTERVAL_MINUTES',
    ),
    retention: integerSetting(environment.BACKUP_RETENTION_COUNT, 7, 365, 'BACKUP_RETENTION_COUNT'),
  };
}

function safeError(error: unknown, code: DatabaseBackupError['code'], message: string): never {
  if (error instanceof DatabaseBackupError) throw error;
  throw new DatabaseBackupError(code, message);
}

function safeDirectory(directory: string, create: boolean) {
  if (
    !isAbsolute(directory) ||
    directory.includes('\0') ||
    (process.platform !== 'win32' && directory.includes('\\'))
  )
    throw new DatabaseBackupError('unsafe_path', 'The backup directory is invalid.');
  const root = parse(directory).root;
  let current = root;
  for (const component of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && create) {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      else safeError(error, 'unsafe_path', 'The backup directory could not be accessed safely.');
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new DatabaseBackupError('unsafe_path', 'The backup directory contains an unsafe path.');
  }
  if (directory === root)
    throw new DatabaseBackupError('unsafe_path', 'The filesystem root cannot be used for backups.');
  if (create) chmodSync(directory, 0o700);
  else if ((lstatSync(directory).mode & 0o077) !== 0)
    throw new DatabaseBackupError('unsafe_path', 'The backup directory must be private.');
  return true;
}

function validId(id: string) {
  if (!ID_PATTERN.test(id)) throw new DatabaseBackupError('unsafe_path', 'The backup identifier is invalid.');
}

function regularPrivateFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new DatabaseBackupError('unsafe_path', 'The backup contains an unsafe file.');
  return stat;
}

function syncFile(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function digestFile(path: string) {
  regularPrivateFile(path);
  const hash = createHash('sha256');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = createReadStream(path, { fd: descriptor, autoClose: true });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function checkDatabase(path: string) {
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = snapshot.prepare('PRAGMA quick_check').all();
    if (
      checks.length !== 1 ||
      checks[0].quick_check !== 'ok' ||
      snapshot.prepare('PRAGMA foreign_key_check').get()
    )
      throw new DatabaseBackupError('verification', 'The backup failed database integrity verification.');
    const version = snapshot.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0)
      throw new DatabaseBackupError('verification', 'The backup database version is invalid.');
    return version;
  } finally {
    snapshot.close();
  }
}

function readManifest(path: string, id: string): BackupManifest {
  const before = regularPrivateFile(path);
  if (before.size < 1 || before.size > MANIFEST_LIMIT)
    throw new DatabaseBackupError('verification', 'The backup manifest is invalid.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (stat.size > MANIFEST_LIMIT || stat.ino !== before.ino || stat.dev !== before.dev)
      throw new DatabaseBackupError('verification', 'The backup manifest changed during verification.');
    manifest = JSON.parse(readFileSync(descriptor, 'utf8'));
  } finally {
    closeSync(descriptor);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new DatabaseBackupError('verification', 'The backup manifest is invalid.');
  const value = manifest as Record<string, unknown>;
  const database = value.database as Record<string, unknown> | undefined;
  if (
    Object.keys(value).sort().join(',') !== 'createdAt,database,id,kind,schemaVersion,sqliteUserVersion' ||
    value.schemaVersion !== FORMAT_VERSION ||
    value.kind !== 'venturecore-sqlite-backup' ||
    value.id !== id ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    id.slice('snapshot-'.length, 'snapshot-'.length + 19) !== value.createdAt.replace(/[-:.]/g, '') ||
    typeof value.sqliteUserVersion !== 'number' ||
    !Number.isSafeInteger(value.sqliteUserVersion) ||
    value.sqliteUserVersion < 0 ||
    !database ||
    typeof database !== 'object' ||
    Array.isArray(database) ||
    Object.keys(database).sort().join(',') !== 'byteLength,file,sha256' ||
    database.file !== 'database.sqlite' ||
    typeof database.byteLength !== 'number' ||
    !Number.isSafeInteger(database.byteLength) ||
    database.byteLength < 512 ||
    typeof database.sha256 !== 'string' ||
    !SHA_PATTERN.test(database.sha256)
  )
    throw new DatabaseBackupError('verification', 'The backup manifest is invalid.');
  return manifest as BackupManifest;
}

function toMetadata(manifest: BackupManifest): BackupMetadata {
  return {
    id: manifest.id,
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    sqliteUserVersion: manifest.sqliteUserVersion,
    byteLength: manifest.database.byteLength,
    sha256: manifest.database.sha256,
    verified: true,
  };
}

export function createDatabaseBackupService(options: DatabaseBackupOptions): DatabaseBackupService {
  const directory = resolve(options.directory);
  const retention = options.retention ?? 7;
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > 365)
    throw new DatabaseBackupError(
      'configuration',
      'The backup retention count is outside its allowed range.',
    );
  if (!options.directory.trim() || options.directory.includes('\0'))
    throw new DatabaseBackupError('configuration', 'The backup directory is invalid.');
  const now = options.now ?? (() => new Date());

  function queued<T>(operation: () => Promise<T>): Promise<T> {
    const previous = directoryQueues.get(directory) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    directoryQueues.set(directory, current);
    void current
      .finally(() => {
        if (directoryQueues.get(directory) === current) directoryQueues.delete(directory);
      })
      .catch(() => undefined);
    return current;
  }

  async function verify(id: string) {
    validId(id);
    try {
      if (!safeDirectory(directory, false))
        throw new DatabaseBackupError('not_found', 'The backup was not found.');
      const snapshotDirectory = join(directory, id);
      const stat = lstatSync(snapshotDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new DatabaseBackupError('unsafe_path', 'The backup contains an unsafe directory.');
      if (readdirSync(snapshotDirectory).sort().join(',') !== 'database.sqlite,manifest.json')
        throw new DatabaseBackupError('verification', 'The backup contains unexpected files.');
      const databasePath = join(snapshotDirectory, 'database.sqlite');
      const manifest = readManifest(join(snapshotDirectory, 'manifest.json'), id);
      const before = regularPrivateFile(databasePath);
      if (
        before.size !== manifest.database.byteLength ||
        (await digestFile(databasePath)) !== manifest.database.sha256
      )
        throw new DatabaseBackupError('verification', 'The backup checksum does not match its manifest.');
      if (checkDatabase(databasePath) !== manifest.sqliteUserVersion)
        throw new DatabaseBackupError(
          'verification',
          'The backup database version does not match its manifest.',
        );
      const after = regularPrivateFile(databasePath);
      if (
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new DatabaseBackupError('verification', 'The backup changed during verification.');
      if (readdirSync(snapshotDirectory).sort().join(',') !== 'database.sqlite,manifest.json')
        throw new DatabaseBackupError('verification', 'The backup contains unexpected files.');
      return toMetadata(manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new DatabaseBackupError('not_found', 'The backup was not found.');
      safeError(error, 'verification', 'The backup could not be verified safely.');
    }
  }

  async function list() {
    try {
      if (!safeDirectory(directory, false)) return [];
      const identifiers = readdirSync(directory).filter((name) => ID_PATTERN.test(name));
      const snapshots: BackupMetadata[] = [];
      for (const id of identifiers) snapshots.push(await verify(id));
      return snapshots.sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
    } catch (error) {
      safeError(error, 'verification', 'The backup list could not be verified safely.');
    }
  }

  async function create() {
    let temporaryDirectory: string | undefined;
    try {
      if (!options.database.isOpen || options.database.isTransaction)
        throw new DatabaseBackupError(
          'backup_failed',
          'A backup requires an open database outside a transaction.',
        );
      safeDirectory(directory, true);
      const createdAt = now().toISOString();
      const id = `snapshot-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`;
      validId(id);
      temporaryDirectory = join(directory, `.pending-${randomUUID()}`);
      mkdirSync(temporaryDirectory, { mode: 0o700 });
      const databasePath = join(temporaryDirectory, 'database.sqlite');
      const descriptor = openSync(
        databasePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
      await backup(options.database, databasePath);
      const copied = new DatabaseSync(databasePath);
      try {
        if (copied.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete')
          throw new DatabaseBackupError('verification', 'The backup could not be made self-contained.');
      } finally {
        copied.close();
      }
      chmodSync(databasePath, 0o600);
      const sqliteUserVersion = checkDatabase(databasePath);
      const manifest: BackupManifest = {
        schemaVersion: FORMAT_VERSION,
        kind: 'venturecore-sqlite-backup',
        id,
        createdAt,
        sqliteUserVersion,
        database: {
          file: 'database.sqlite',
          byteLength: regularPrivateFile(databasePath).size,
          sha256: await digestFile(databasePath),
        },
      };
      const manifestPath = join(temporaryDirectory, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      syncFile(databasePath);
      syncFile(manifestPath);
      syncFile(temporaryDirectory);
      safeDirectory(directory, false);
      const publishedDirectory = join(directory, id);
      if (existsSync(publishedDirectory))
        throw new DatabaseBackupError('backup_failed', 'The backup could not be published.');
      renameSync(temporaryDirectory, publishedDirectory);
      temporaryDirectory = undefined;
      syncFile(directory);
      const metadata = await verify(id);
      try {
        // Verify every managed snapshot before pruning any of them. Unknown or
        // unsafe entries are never deleted, and a failed verification stops pruning.
        const snapshots = await list();
        const retained = new Set([
          id,
          ...snapshots
            .filter((snapshot) => snapshot.id !== id)
            .slice(0, retention - 1)
            .map((snapshot) => snapshot.id),
        ]);
        for (const snapshot of snapshots.filter((snapshot) => !retained.has(snapshot.id))) {
          await verify(snapshot.id);
          rmSync(join(directory, snapshot.id), { recursive: true });
        }
        syncFile(directory);
      } catch {
        metadata.retentionWarning =
          'Retention stopped because an existing backup could not be verified safely.';
      }
      return metadata;
    } catch (error) {
      safeError(error, 'backup_failed', 'The database backup could not be completed safely.');
    } finally {
      if (temporaryDirectory) {
        try {
          // The private working directory is generated by this operation only.
          // Refuse cleanup if a local path has unexpectedly become a symlink.
          safeDirectory(directory, false);
          const stat = lstatSync(temporaryDirectory);
          if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(temporaryDirectory, { recursive: true });
        } catch {
          // A refused cleanup preserves the data rather than following an unsafe path.
        }
      }
    }
  }

  return {
    createBackup: () => queued(create),
    listBackups: () => queued(list),
    verifyBackup: (id) => queued(() => verify(id)),
    getVerifiedDatabasePath: (id) =>
      queued(async () => {
        await verify(id);
        return join(directory, id, 'database.sqlite');
      }),
    waitForIdle: async () => {
      await directoryQueues.get(directory)?.catch(() => undefined);
    },
  };
}
