import { BSON } from 'mongodb';
const { EJSON } = BSON;
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
const FORMAT_VERSION = 2;
const MANIFEST_LIMIT = 2048;
const ID_PATTERN =
  /^snapshot-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const directoryQueues = new Map();
export class DatabaseBackupError extends Error {
  code;
  constructor(code, message) {
    (super(message), (this.code = code));
    this.name = 'DatabaseBackupError';
  }
}
function integerSetting(value, fallback, maximum, label) {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim()))
    throw new DatabaseBackupError('configuration', `${label} must be a whole number.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new DatabaseBackupError('configuration', `${label} is outside its allowed range.`);
  return number;
}
export function parseDatabaseBackupConfig(environment, databasePath = '.data/workspace.mongodb') {
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
function safeError(error, code, message) {
  if (error instanceof DatabaseBackupError) throw error;
  throw new DatabaseBackupError(code, message);
}
function safeDirectory(directory, create) {
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
      if (error.code === 'ENOENT' && create) {
        mkdirSync(current, {
          mode: 0o700,
        });
        stat = lstatSync(current);
      } else if (error.code === 'ENOENT') return false;
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
function validId(id) {
  if (!ID_PATTERN.test(id)) throw new DatabaseBackupError('unsafe_path', 'The backup identifier is invalid.');
}
function regularPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
    throw new DatabaseBackupError('unsafe_path', 'The backup contains an unsafe file.');
  return stat;
}
function syncFile(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
async function digestFile(path) {
  regularPrivateFile(path);
  const hash = createHash('sha256');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = createReadStream(path, {
    fd: descriptor,
    autoClose: true,
  });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}
/** Read a portable snapshot without interpreting any user-supplied code. */
export function readSnapshot(path) {
  regularPrivateFile(path);
  const source = JSON.parse(readFileSync(path, 'utf8'));
  if (
    source.kind !== 'venturecore-mongodb-backup' ||
    source.databaseVersion !== 1 ||
    !Array.isArray(source.collections) ||
    source.collections.length > 100
  )
    throw new DatabaseBackupError('verification', 'The MongoDB snapshot has an invalid format.');
  const names = new Set();
  for (const collection of source.collections) {
    if (
      !/^[a-z][a-z0-9_]{0,100}$/.test(collection.name) ||
      names.has(collection.name) ||
      !Array.isArray(collection.documents) ||
      !Array.isArray(collection.indexes)
    )
      throw new DatabaseBackupError('verification', 'The MongoDB snapshot contains an invalid collection.');
    names.add(collection.name);
    for (const value of collection.documents) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, '_id'))
        throw new DatabaseBackupError('verification', 'The snapshot contains an invalid document.');
    }
  }
  if (!['organizations', 'documents', 'sequences'].every((name) => names.has(name)))
    throw new DatabaseBackupError('verification', 'The backup is not a complete workspace snapshot.');
  return source;
}

function checkDatabase(path) {
  return readSnapshot(path).databaseVersion;
}

/** Snapshot reads share one MongoDB session so related financial records agree. */
async function snapshotDatabase(context, path, createdAt) {
  const database = context.database;
  const collectionInfo = await database.listCollections({}, { nameOnly: false }).toArray();
  const names = collectionInfo
    .map((row) => row.name)
    .filter((name) => /^[a-z][a-z0-9_]{0,100}$/.test(name))
    .sort();
  const indexes = new Map();
  for (const name of names) {
    indexes.set(name, await database.collection(name).listIndexes().toArray());
  }
  let collections;
  const session = context.client.startSession();
  try {
    await session.withTransaction(
      async () => {
        // The driver can retry the callback; rebuild the complete snapshot each time.
        collections = [];
        for (const name of names) {
          const documents = await database.collection(name).find({}, { session }).toArray();
          collections.push({
            name,
            indexes: indexes.get(name),
            documents: documents.map((value) => EJSON.serialize(value, { relaxed: false })),
          });
        }
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }
  writeFileSync(
    path,
    JSON.stringify({ kind: 'venturecore-mongodb-backup', databaseVersion: 1, createdAt, collections }),
    { mode: 0o600 },
  );
}

function readManifest(path, id) {
  const before = regularPrivateFile(path);
  if (before.size < 1 || before.size > MANIFEST_LIMIT)
    throw new DatabaseBackupError('verification', 'The backup manifest is invalid.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
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
  const value = manifest;
  const database = value.database;
  if (
    Object.keys(value).sort().join(',') !== 'createdAt,database,databaseVersion,id,kind,schemaVersion' ||
    value.schemaVersion !== FORMAT_VERSION ||
    value.kind !== 'venturecore-mongodb-backup' ||
    value.id !== id ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    id.slice('snapshot-'.length, 'snapshot-'.length + 19) !== value.createdAt.replace(/[-:.]/g, '') ||
    typeof value.databaseVersion !== 'number' ||
    !Number.isSafeInteger(value.databaseVersion) ||
    value.databaseVersion < 0 ||
    !database ||
    typeof database !== 'object' ||
    Array.isArray(database) ||
    Object.keys(database).sort().join(',') !== 'byteLength,file,sha256' ||
    database.file !== 'database.ejson' ||
    typeof database.byteLength !== 'number' ||
    !Number.isSafeInteger(database.byteLength) ||
    database.byteLength < 1 ||
    typeof database.sha256 !== 'string' ||
    !SHA_PATTERN.test(database.sha256)
  )
    throw new DatabaseBackupError('verification', 'The backup manifest is invalid.');
  return manifest;
}
function toMetadata(manifest, verified = true) {
  return {
    id: manifest.id,
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    databaseVersion: manifest.databaseVersion,
    byteLength: manifest.database.byteLength,
    sha256: manifest.database.sha256,
    verified,
    verification: verified ? 'verified' : 'on_download',
  };
}
export function createDatabaseBackupService(options) {
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
  function queued(operation) {
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
  async function verify(id) {
    validId(id);
    try {
      if (!safeDirectory(directory, false))
        throw new DatabaseBackupError('not_found', 'The backup was not found.');
      const snapshotDirectory = join(directory, id);
      const stat = lstatSync(snapshotDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
        throw new DatabaseBackupError('unsafe_path', 'The backup contains an unsafe directory.');
      if (readdirSync(snapshotDirectory).sort().join(',') !== 'database.ejson,manifest.json')
        throw new DatabaseBackupError('verification', 'The backup contains unexpected files.');
      const databasePath = join(snapshotDirectory, 'database.ejson');
      const manifest = readManifest(join(snapshotDirectory, 'manifest.json'), id);
      const before = regularPrivateFile(databasePath);
      if (
        before.size !== manifest.database.byteLength ||
        (await digestFile(databasePath)) !== manifest.database.sha256
      )
        throw new DatabaseBackupError('verification', 'The backup checksum does not match its manifest.');
      if (checkDatabase(databasePath) !== manifest.databaseVersion)
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
      if (readdirSync(snapshotDirectory).sort().join(',') !== 'database.ejson,manifest.json')
        throw new DatabaseBackupError('verification', 'The backup contains unexpected files.');
      return toMetadata(manifest);
    } catch (error) {
      if (error.code === 'ENOENT') throw new DatabaseBackupError('not_found', 'The backup was not found.');
      safeError(error, 'verification', 'The backup could not be verified safely.');
    }
  }
  async function list() {
    try {
      if (!safeDirectory(directory, false)) return [];
      const identifiers = readdirSync(directory).filter((name) => ID_PATTERN.test(name));
      const snapshots = [];
      for (const id of identifiers) snapshots.push(await verify(id));
      return snapshots.sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
      );
    } catch (error) {
      safeError(error, 'verification', 'The backup list could not be verified safely.');
    }
  }
  async function listMetadata() {
    try {
      if (!safeDirectory(directory, false)) return [];
      const snapshots = [];
      for (const id of readdirSync(directory).filter((name) => ID_PATTERN.test(name))) {
        try {
          const snapshotDirectory = join(directory, id);
          const directoryStat = lstatSync(snapshotDirectory);
          if (
            directoryStat.isSymbolicLink() ||
            !directoryStat.isDirectory() ||
            (directoryStat.mode & 0o077) !== 0
          )
            throw new DatabaseBackupError('unsafe_path', 'The backup contains an unsafe directory.');
          if (readdirSync(snapshotDirectory).sort().join(',') !== 'database.ejson,manifest.json')
            throw new DatabaseBackupError('verification', 'The backup contains unexpected files.');
          const manifest = readManifest(join(snapshotDirectory, 'manifest.json'), id);
          if (
            regularPrivateFile(join(snapshotDirectory, 'database.ejson')).size !==
            manifest.database.byteLength
          )
            throw new DatabaseBackupError('verification', 'The backup size does not match its manifest.');
          snapshots.push(toMetadata(manifest, false));
        } catch (error) {
          // Retention may remove a completed snapshot while this read-only inventory runs.
          if (error.code !== 'ENOENT') throw error;
        }
      }
      return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    } catch (error) {
      safeError(error, 'verification', 'The backup inventory could not be read safely.');
    }
  }
  async function create() {
    let temporaryDirectory;
    try {
      if (!options.database.client || !options.database.database)
        throw new DatabaseBackupError('backup_failed', 'A backup requires a connected MongoDB workspace.');
      safeDirectory(directory, true);
      const createdAt = now().toISOString();
      const id = `snapshot-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`;
      validId(id);
      temporaryDirectory = join(directory, `.pending-${randomUUID()}`);
      mkdirSync(temporaryDirectory, {
        mode: 0o700,
      });
      const databasePath = join(temporaryDirectory, 'database.ejson');
      const descriptor = openSync(
        databasePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
      await snapshotDatabase(options.database, databasePath, createdAt);
      chmodSync(databasePath, 0o600);
      const databaseVersion = checkDatabase(databasePath);
      const manifest = {
        schemaVersion: FORMAT_VERSION,
        kind: 'venturecore-mongodb-backup',
        id,
        createdAt,
        databaseVersion,
        database: {
          file: 'database.ejson',
          byteLength: regularPrivateFile(databasePath).size,
          sha256: await digestFile(databasePath),
        },
      };
      const manifestPath = join(temporaryDirectory, 'manifest.json');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
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
          rmSync(join(directory, snapshot.id), {
            recursive: true,
          });
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
          safeDirectory(directory, false);
          const stat = lstatSync(temporaryDirectory);
          if (stat.isDirectory() && !stat.isSymbolicLink())
            rmSync(temporaryDirectory, {
              recursive: true,
            });
        } catch {}
      }
    }
  }
  return {
    createBackup: () => queued(create),
    listBackups: () => queued(list),
    // Read only small manifests and filesystem metadata. Published snapshots are atomic;
    // this inventory need not wait behind a long-running snapshot/verification job.
    listBackupMetadata: listMetadata,
    verifyBackup: (id) => queued(() => verify(id)),
    getVerifiedDatabasePath: (id) =>
      queued(async () => {
        await verify(id);
        return join(directory, id, 'database.ejson');
      }),
    waitForIdle: async () => {
      await directoryQueues.get(directory)?.catch(() => undefined);
    },
  };
}
