/**
 * `npm run db:backup | db:restore | db:resume` - command-line database backup and recovery.
 *
 * backup: verified snapshot into DATABASE_BACKUP_DIR (or --verify=<id> an existing one).
 * restore: loads a snapshot into a NEW empty database and puts it on a recovery hold.
 * resume: releases the hold after an operator has reconciled payments and emails.
 * See docs/MIGRATION.md for the full procedure.
 */

import { MongoClient, BSON } from 'mongodb';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectDatabase } from '../src/config/database.js';
import { isTransactionCoordinationRow } from '../src/config/transaction-scopes.js';
import { loadEnvironment } from '../src/config/environment.js';
import {
  createDatabaseBackupService,
  parseDatabaseBackupConfig,
  readSnapshot,
  DatabaseBackupError,
} from '../src/services/operations/database-backup.js';
import { prepareRestoredDatabase, acknowledgeDatabaseRecovery } from '../src/services/operations/recovery.js';

const { EJSON } = BSON;
const BACKUP_ID =
  /^snapshot-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INDEX_OPTIONS = [
  'name',
  'unique',
  'sparse',
  'expireAfterSeconds',
  'partialFilterExpression',
  'collation',
  'wildcardProjection',
  'hidden',
  'weights',
  'default_language',
  'language_override',
  'textIndexVersion',
  '2dsphereIndexVersion',
  'bits',
  'min',
  'max',
  'bucketSize',
  'storageEngine',
];

/** A user-facing command error (bad arguments, unsafe path, existing target database ...). */
export class DatabaseCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseCommandError';
  }
}

// Help text printed for --help or invalid arguments.
export const DATABASE_HELP = `Venturecore MongoDB backup and recovery

Commands:
  npm run db:backup -- [--database=NAME] [--directory=/private/backups]
  npm run db:backup -- --list [--directory=/private/backups]
  npm run db:backup -- --verify=SNAPSHOT_ID [--directory=/private/backups]
  npm run db:restore -- --file=/private/database.ejson --manifest=/private/manifest.json --database=NEW_EMPTY_NAME
  npm run db:resume -- --database=RESTORED_NAME --acknowledge-reconciled

Configuration is read from .example.env; hosting environment values take precedence.
MONGODB_URI must identify a replica set or sharded cluster. --database chooses a database
name, not a file. Backup files must remain outside public/application assets.

Restore verifies the complete snapshot, file size and SHA-256 before writing. Its target
must be empty. Existing documents are never overwritten. Original BSON values, document
numbers, payment histories and compatible indexes are preserved. Sessions and reset
links are invalidated, pending emails are held, and application startup remains blocked
until an operator reconciles account access, document numbering, gateway activity and
email delivery and runs db:resume. Resume leaves held emails held for individual review.

Stop the application during restore and recovery review. Point MONGODB_DATABASE to the
restored name only after review. On POSIX systems keep snapshot/manifest permissions 600
and their private folder 700. --acknowledge-reconciliation is accepted as a legacy alias.
Use --help without database credentials to display these instructions.
`;

/** Database names: 1-63 letters, digits, underscores or hyphens. */
export function validateDatabaseName(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,63}$/.test(value))
    throw new DatabaseCommandError(
      'Provide a database name containing 1–63 letters, digits, underscores or hyphens.',
    );
  return value;
}

/** Backup/restore files must not be inside the app's code or public folders. */
export function assertPrivateLocation(target, cwd = process.cwd()) {
  for (const name of ['public', 'shared', 'src', 'views', 'scripts']) {
    const child = relative(resolve(cwd, name), resolve(target));
    if (!child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
      throw new DatabaseCommandError('Database files must remain outside application/public assets.');
  }
}

/** Read one stable file descriptor; neither its pathname nor contents are modified. */
export function readStableFile(filename, { privateMode = false, maxBytes = Infinity, cwd } = {}) {
  if (!isAbsolute(filename || '') || filename.includes('\0'))
    throw new DatabaseCommandError('Use an absolute source file path.');
  assertPrivateLocation(filename, cwd);
  const before = lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new DatabaseCommandError('The source must be a regular file, not a symbolic or hard link.');
  if (privateMode && process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    throw new DatabaseCommandError('Snapshot and manifest files must have private permissions (600).');
  if (before.size < 1 || before.size > maxBytes)
    throw new DatabaseCommandError('The source file is empty or exceeds the supported size.');
  const descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor);
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new DatabaseCommandError('The source file changed while it was opened.');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size)
      throw new DatabaseCommandError('The source file changed while it was read.');
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), stat: after };
  } finally {
    closeSync(descriptor);
  }
}

/** Verify exactly the bytes that will be restored, before opening the destination. */
export function verifyPortableSnapshot(file, manifestFile, options = {}) {
  const data = readStableFile(file, { ...options, privateMode: true });
  const manifestBytes = readStableFile(manifestFile, { ...options, privateMode: true, maxBytes: 2048 }).bytes;
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new DatabaseCommandError('The backup manifest is not valid JSON.');
  }
  const stamp = manifest?.createdAt;
  const date = new Date(stamp);
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(',') !== 'createdAt,database,databaseVersion,id,kind,schemaVersion' ||
    manifest.kind !== 'venturecore-mongodb-backup' ||
    manifest.schemaVersion !== 2 ||
    manifest.databaseVersion !== 1 ||
    !BACKUP_ID.test(manifest.id || '') ||
    typeof stamp !== 'string' ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== stamp ||
    manifest.id.slice('snapshot-'.length, 'snapshot-'.length + 19) !== stamp.replace(/[-:.]/g, '') ||
    !manifest.database ||
    Object.keys(manifest.database).sort().join(',') !== 'byteLength,file,sha256' ||
    manifest.database.file !== 'database.ejson' ||
    !Number.isSafeInteger(manifest.database.byteLength) ||
    manifest.database.byteLength !== data.bytes.length ||
    !/^[a-f0-9]{64}$/.test(manifest.database.sha256 || '') ||
    manifest.database.sha256 !== data.sha256
  )
    throw new DatabaseCommandError(
      'The snapshot size, checksum, version or identity does not match its manifest.',
    );

  // The existing snapshot validator accepts a path. A private temporary copy makes
  // its validation operate on the same immutable bytes whose checksum was checked.
  const temporary = mkdtempSync(join(tmpdir(), 'venturecore-verified-snapshot-'));
  let snapshot;
  try {
    const filename = join(temporary, 'database.ejson');
    writeFileSync(filename, data.bytes, { mode: 0o600, flag: 'wx' });
    snapshot = readSnapshot(filename);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (snapshot.createdAt !== stamp)
    throw new DatabaseCommandError('The snapshot creation date does not match its manifest.');
  const collections = snapshot.collections.map((collection) => {
    let documents;
    try {
      documents = collection.documents.map((record) => EJSON.deserialize(record, { relaxed: false }));
    } catch {
      throw new DatabaseCommandError('The snapshot contains invalid BSON Extended JSON.');
    }
    for (const record of documents)
      if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, '_id'))
        throw new DatabaseCommandError('The snapshot contains an invalid MongoDB document.');
    const indexes = collection.indexes
      .filter((index) => index.name !== '_id_')
      .map((index) => {
        if (
          !index ||
          typeof index !== 'object' ||
          !index.key ||
          typeof index.key !== 'object' ||
          Array.isArray(index.key) ||
          typeof index.name !== 'string'
        )
          throw new DatabaseCommandError('The snapshot contains an invalid index definition.');
        const settings = Object.fromEntries(
          INDEX_OPTIONS.filter((key) => Object.hasOwn(index, key)).map((key) => [key, index[key]]),
        );
        if (settings.collation) {
          const { version, ...collation } = settings.collation;
          settings.collation = collation;
        }
        return { key: index.key, settings };
      });
    return { name: collection.name, documents, indexes };
  });
  return { manifest, sha256: data.sha256, collections };
}

/** Every collection is checked, including collections outside the current schema. */
export async function assertEmptyDestination(database, sessionOptions = {}, collectionNames) {
  const names =
    collectionNames ||
    (await database.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name);
  for (const name of names) {
    if (name === 'transaction_locks') {
      const rows = database.collection(name).find({}, sessionOptions);
      try {
        for await (const row of rows)
          if (!isTransactionCoordinationRow(row))
            throw new DatabaseCommandError('Destination database contains an unexpected transaction lock.');
      } finally {
        await rows.close();
      }
    } else if (await database.collection(name).findOne({}, sessionOptions)) {
      throw new DatabaseCommandError('Destination database is not empty. Choose a new empty target.');
    }
  }
}

/** Preflight happens before schema initialization can add indexes to a database. */
export async function connectEmptyDestination(environment, name) {
  validateDatabaseName(name);
  if (!environment.MONGODB_URI)
    throw new DatabaseCommandError('Configure MONGODB_URI before importing or restoring.');
  const client = new MongoClient(environment.MONGODB_URI, {
    appName: 'venturecore-offline-import',
    ignoreUndefined: true,
  });
  try {
    await client.connect();
    await assertEmptyDestination(client.db(name));
    const context = await connectDatabase({ client, databaseName: name, environment, seed: false });
    context.close = () => client.close();
    return context;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

/** Insert-only migration. Duplicate keys abort the entire transaction. */
export async function commitImportedCollections(context, collections, checksum, metadata, now = new Date()) {
  for (const collection of collections) {
    if (
      !(await context.database.listCollections({ name: collection.name }, { nameOnly: true }).toArray())
        .length
    )
      await context.database.createCollection(collection.name);
    for (const index of collection.indexes || []) {
      try {
        await context.collection(collection.name).createIndex(index.key, index.settings);
      } catch {
        throw new DatabaseCommandError(
          'A snapshot index conflicts with the destination schema. No records were imported.',
        );
      }
    }
  }
  const names = (await context.database.listCollections({}, { nameOnly: true }).toArray()).map(
    (row) => row.name,
  );
  await assertEmptyDestination(context.database, {}, names);
  const counts = {};
  try {
    await context.transaction(async () => {
      await assertEmptyDestination(context.database, context.options(), names);
      for (const collection of collections) {
        // Synchronization revision is local to the new database, not a business record.
        if (collection.name === 'transaction_locks') continue;
        for (let start = 0; start < collection.documents.length; start += 500) {
          await context
            .collection(collection.name)
            .insertMany(collection.documents.slice(start, start + 500), {
              ...context.options(),
              ordered: true,
            });
        }
        counts[collection.name] = collection.documents.length;
      }
      if (!(await context.collection('workspace_metadata').findOne({ _id: 'schema' }, context.options()))) {
        await context.collection('workspace_metadata').insertOne(
          {
            _id: 'schema',
            version: 1,
            initializedAt: now.toISOString(),
            ...metadata,
          },
          context.options(),
        );
      }
      await prepareRestoredDatabase(context, checksum, now);
    });
  } catch (error) {
    if (error instanceof DatabaseCommandError) throw error;
    throw new DatabaseCommandError(
      'Destination constraints rejected the import. No business records were committed; resolve the source conflict and retry with an empty target.',
    );
  }
  return counts;
}

/** Entry point: runs backup, restore or resume with the parsed command-line arguments. */
export async function runDatabaseCommand(command, arguments_ = [], options = {}) {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    allowPositionals: false,
    options: {
      database: { type: 'string' },
      directory: { type: 'string' },
      file: { type: 'string' },
      manifest: { type: 'string' },
      list: { type: 'boolean' },
      verify: { type: 'string' },
      'acknowledge-reconciled': { type: 'boolean' },
      'acknowledge-reconciliation': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: DATABASE_HELP };
  if (!['backup', 'restore', 'resume'].includes(command))
    throw new DatabaseCommandError('Choose backup, restore or resume. Use --help for command examples.');
  const allowed =
    command === 'backup'
      ? ['database', 'directory', 'list', 'verify']
      : command === 'restore'
        ? ['file', 'manifest', 'database']
        : ['database', 'acknowledge-reconciled', 'acknowledge-reconciliation'];
  if (Object.keys(values).some((key) => !allowed.includes(key)))
    throw new DatabaseCommandError(
      'The options do not match this operation. Use --help for command examples.',
    );
  if (values.list && values.verify)
    throw new DatabaseCommandError('Choose listing or verification, not both.');
  let context;
  try {
    if (command === 'restore') {
      if (!values.file || !values.manifest || !values.database)
        throw new DatabaseCommandError('Restore requires --file, --manifest and --database=NEW_EMPTY_NAME.');
      validateDatabaseName(values.database);
      const snapshot = verifyPortableSnapshot(values.file, values.manifest, { cwd });
      context = await connectEmptyDestination(environment, values.database);
      const counts = await commitImportedCollections(
        context,
        snapshot.collections,
        snapshot.sha256,
        { restoredFrom: snapshot.manifest.id },
        now(),
      );
      return {
        ok: true,
        operation: 'restore',
        database: values.database,
        backupId: snapshot.manifest.id,
        collections: counts,
        recoveryRequired: true,
        note: 'Restored into the empty destination. Sessions were invalidated and pending messages held. Reconcile accounts, numbering, payments and email before db:resume.',
      };
    }
    if (command === 'resume') {
      if (!values.database || !(values['acknowledge-reconciled'] || values['acknowledge-reconciliation']))
        throw new DatabaseCommandError(
          'Resume requires --database and --acknowledge-reconciled after account, payment and email reconciliation.',
        );
      context = await connectDatabase({
        environment,
        databaseName: validateDatabaseName(values.database),
        seed: false,
      });
      try {
        await acknowledgeDatabaseRecovery(context, true, now());
      } catch {
        throw new DatabaseCommandError('This database has no pending recovery review to release.');
      }
      return {
        ok: true,
        operation: 'resume',
        database: values.database,
        recoveryReviewed: true,
        note: 'Recovery review acknowledged. Held emails remain held; this acknowledgement does not verify provider history.',
      };
    }
    if (values.directory && !isAbsolute(values.directory))
      throw new DatabaseCommandError('Use an absolute private backup directory.');
    const config = parseDatabaseBackupConfig({
      ...environment,
      ...(values.directory ? { DATABASE_BACKUP_DIR: values.directory } : {}),
    });
    assertPrivateLocation(config.directory, cwd);
    if (!values.list && !values.verify) {
      context = await connectDatabase({
        environment,
        databaseName: validateDatabaseName(
          values.database || environment.MONGODB_DATABASE || 'venturecore_workspace',
        ),
        seed: false,
      });
      if (!(await context.collection('workspace_metadata').findOne({ _id: 'schema' })))
        throw new DatabaseCommandError(
          'The configured database has not been initialized as a workspace. Check MONGODB_DATABASE.',
        );
    }
    const service = createDatabaseBackupService({
      database: context || {},
      directory: config.directory,
      retention: config.retention,
      now,
    });
    if (values.list) return { ok: true, operation: 'list', backups: await service.listBackups() };
    if (values.verify)
      return { ok: true, operation: 'verify', backup: await service.verifyBackup(values.verify) };
    const backup = await service.createBackup();
    return {
      ok: true,
      operation: 'backup',
      backup,
      file: join(config.directory, backup.id, 'database.ejson'),
      manifest: join(config.directory, backup.id, 'manifest.json'),
    };
  } finally {
    await context?.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || process.argv.slice(2).some((value) => ['--help', '-h', 'help'].includes(value))) {
      console.log(DATABASE_HELP);
    } else {
      const { environment } = loadEnvironment();
      const result = await runDatabaseCommand(process.argv[2], process.argv.slice(3), { environment });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof DatabaseCommandError || error instanceof DatabaseBackupError
            ? error.message
            : 'Database command stopped safely. Check the connection, command options and private source files; no existing records were overwritten.',
      }),
    );
    process.exitCode = 1;
  }
}
