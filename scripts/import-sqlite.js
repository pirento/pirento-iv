/**
 * `npm run db:import-sqlite` - one-time import of the old TypeScript app's SQLite database
 * (schema v5) into a new, empty MongoDB database. See docs/MIGRATION.md.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COLLECTIONS } from '../src/config/database.js';
import { loadEnvironment } from '../src/config/environment.js';
import {
  DatabaseCommandError,
  readStableFile,
  validateDatabaseName,
  connectEmptyDestination,
  commitImportedCollections,
} from './database.js';

const BUSINESS_TABLES = new Set([
  'organizations',
  'customers',
  'documents',
  'catalog',
  'formats',
  'payments',
  'document_events',
  'business_products',
]);
const REQUIRED_TABLES = [...BUSINESS_TABLES, 'sequences', 'workspace_settings'];
const LEGACY_TABLES = new Set(
  COLLECTIONS.filter((name) => !['workspace_metadata', 'transaction_locks'].includes(name)),
);
const DOCUMENT_KINDS = new Set(['invoice', 'quotation', 'proforma', 'delivery_note']);

// Help text printed for --help or invalid arguments.
export const IMPORT_HELP = `Import an existing Venturecore SQLite version 5 workspace into MongoDB

  npm run db:import-sqlite -- --source=/private/existing.sqlite --database=NEW_EMPTY_NAME --confirm-import
  npm run db:import-sqlite -- --help

Requires Node.js 24 or later and MONGODB_URI for a replica set or sharded cluster.
Configuration loads directly from .example.env; hosting environment values take precedence.
The target database is mandatory and must be empty. Existing documents are never overwritten.

Stop the old application first and obtain a checkpointed, complete SQLite database copy.
An active/nonempty -wal or -journal sidecar is rejected: checkpoint using the old application
or its backup command, then supply the resulting standalone file. Never delete a live WAL.
The importer opens the source only for reading and inspects a private, byte-for-byte copy
with SQLite readOnly mode. Its integrity, foreign keys and version 5 are checked before
MongoDB is opened. An unsupported nonempty table or conflicting record stops the import.

Original IDs, document numbers, snapshots, amounts, provider records and audit history are
preserved. Business JSON becomes native MongoDB documents. Import commits atomically;
duplicate keys roll it back. Sessions and reset tokens are invalidated. Queued messages
are held and password-reset payloads cleared. Application startup remains blocked pending
operator reconciliation of accounts, document numbering, gateway activity and email delivery.

After reconciliation:
  npm run db:resume -- --database=NEW_EMPTY_NAME --acknowledge-reconciled

Set MONGODB_DATABASE to the imported name when ready. Resume does not resend held messages.
Keep the original SQLite database and a verified MongoDB backup for your migration records.
`;

function parseJson(value, table, field, array = false) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DatabaseCommandError(`The ${table}.${field} field contains invalid JSON.`);
  }
  if (!parsed || (array ? !Array.isArray(parsed) : typeof parsed !== 'object' || Array.isArray(parsed)))
    throw new DatabaseCommandError(`The ${table}.${field} field has an unsupported JSON shape.`);
  return parsed;
}

function assertValue(actual, expected, table, field) {
  if (actual !== expected)
    throw new DatabaseCommandError(
      `The ${table} record disagrees with its ${field} column. Resolve the source inconsistency first.`,
    );
}

/** Preserve the canonical business snapshot instead of reconstructing its fields. */
function businessRecord(table, row) {
  const record = parseJson(row.data, table, 'data');
  if (typeof row.id !== 'string' || !row.id || Object.hasOwn(record, '_id'))
    throw new DatabaseCommandError(`The ${table} record has an invalid identity.`);
  assertValue(record.id, row.id, table, 'id');
  const columns = {
    organization_id: 'organizationId',
    document_id: 'documentId',
    customer_id: 'customerId',
    request_id: 'requestId',
    number: 'number',
    kind: 'kind',
    sku: 'sku',
    code: 'code',
  };
  for (const [column, field] of Object.entries(columns)) {
    if (Object.hasOwn(row, column)) assertValue(record[field], row[column], table, column);
  }
  if (Object.hasOwn(row, 'is_default'))
    assertValue(record.isDefault, row.is_default === 1, table, 'is_default');
  if (Object.hasOwn(row, 'amount_paise')) {
    if (!Number.isSafeInteger(row.amount_paise) || row.amount_paise <= 0 || !Number.isFinite(record.amount))
      throw new DatabaseCommandError('A legacy payment contains an invalid amount.');
    assertValue(Math.round((record.amount + Number.EPSILON) * 100), row.amount_paise, table, 'amount_paise');
  }
  return record;
}

function convertRow(table, row) {
  if (BUSINESS_TABLES.has(table)) return businessRecord(table, row);
  if (table === 'workspace_settings') {
    const settings = parseJson(row.data, table, 'data');
    if (
      row.id !== 1 ||
      Object.hasOwn(settings, '_id') ||
      (Object.hasOwn(settings, 'id') && settings.id !== 1)
    )
      throw new DatabaseCommandError('Workspace settings have an invalid identity.');
    return { ...settings, id: 1 };
  }
  if (table === 'sequences') {
    if (
      typeof row.organization_id !== 'string' ||
      !DOCUMENT_KINDS.has(row.kind) ||
      typeof row.fiscal_year !== 'string' ||
      !Number.isSafeInteger(row.value) ||
      row.value < 0
    )
      throw new DatabaseCommandError('A document-number sequence contains invalid values.');
    return {
      organizationId: row.organization_id,
      kind: row.kind,
      fiscalYear: row.fiscal_year,
      value: row.value,
    };
  }
  const record = { ...row };
  if (table === 'auth_users') {
    record.organization_ids = parseJson(row.organization_ids, table, 'organization_ids', true);
    if (!record.organization_ids.every((id) => typeof id === 'string'))
      throw new DatabaseCommandError('An account has invalid organization assignments.');
  }
  if (table === 'auth_audit') record.details = parseJson(row.details, table, 'details');
  if (table === 'email_outbox') record.payload = parseJson(row.payload, table, 'payload');
  if (['auth_sessions', 'auth_password_resets'].includes(table)) {
    if (!Number.isSafeInteger(row.expires_at) || !Number.isFinite(new Date(row.expires_at).getTime()))
      throw new DatabaseCommandError('A legacy authentication token has an invalid expiration.');
    record.expiresOn = new Date(row.expires_at);
  }
  return record;
}

function assertCheckpointedSource(source) {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = `${source}${suffix}`;
    if (existsSync(sidecar) && lstatSync(sidecar).size > 0)
      throw new DatabaseCommandError(
        'The SQLite source has an active WAL or journal. Stop the old application and provide a checkpointed backup; do not delete live sidecars.',
      );
  }
}

/**
 * Only this offline utility imports node:sqlite. Application runtime remains MongoDB-only.
 * Reading a private copy also prevents SQLite from creating sidecars next to the source.
 */
export function readLegacyDatabase(source, options = {}) {
  assertCheckpointedSource(source);
  const original = readStableFile(source, options);
  if (original.bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0')
    throw new DatabaseCommandError('The source is not a SQLite database.');
  const temporary = mkdtempSync(join(tmpdir(), 'venturecore-sqlite-import-'));
  let sqlite;
  try {
    const copy = join(temporary, 'source.sqlite');
    writeFileSync(copy, original.bytes, { mode: 0o600, flag: 'wx' });
    sqlite = new DatabaseSync(copy, { readOnly: true });
    sqlite.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN;');
    const version = sqlite.prepare('PRAGMA user_version').get().user_version;
    if (version !== 5)
      throw new DatabaseCommandError(
        'The source must use SQLite schema version 5. Upgrade and back it up using the original application first.',
      );
    const integrity = sqlite.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok')
      throw new DatabaseCommandError(
        'SQLite integrity_check failed. Repair or recover the original database before importing.',
      );
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length)
      throw new DatabaseCommandError(
        'SQLite foreign_key_check failed. Resolve missing references before importing.',
      );
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    if (!REQUIRED_TABLES.every((name) => tables.includes(name)))
      throw new DatabaseCommandError('The version 5 source is missing a required workspace table.');
    for (const name of tables.filter((name) => !LEGACY_TABLES.has(name))) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      if (sqlite.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get())
        throw new DatabaseCommandError(
          'The source contains an unsupported nonempty table. Review it before migrating so no data is silently discarded.',
        );
    }
    const collections = COLLECTIONS.filter((name) => LEGACY_TABLES.has(name) && tables.includes(name)).map(
      (name) => {
        // Known, fixed table names only. Ordered inserts preserve legacy row order.
        const rows = sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
        return { name, documents: rows.map((row) => convertRow(name, row)), indexes: [] };
      },
    );
    sqlite.exec('ROLLBACK');
    sqlite.close();
    sqlite = undefined;
    assertCheckpointedSource(source);
    if (readStableFile(source, options).sha256 !== original.sha256)
      throw new DatabaseCommandError(
        'The SQLite source changed during inspection. Stop the application and use an offline backup.',
      );
    return { collections, sha256: original.sha256, sourceVersion: version };
  } finally {
    if (sqlite) sqlite.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Entry point: validates arguments, reads the SQLite file and writes every record to MongoDB. */
export async function runImportCommand(arguments_ = [], options = {}) {
  const { values } = parseArgs({
    args: arguments_,
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: 'string' },
      database: { type: 'string' },
      'confirm-import': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return { help: IMPORT_HELP };
  if (!values.source || !values.database || !values['confirm-import'])
    throw new DatabaseCommandError(
      'Import requires --source=/absolute/existing.sqlite, --database=NEW_EMPTY_NAME and --confirm-import.',
    );
  validateDatabaseName(values.database);
  const source = readLegacyDatabase(values.source, { cwd: options.cwd });
  const context = await connectEmptyDestination(options.environment ?? process.env, values.database);
  try {
    const now = (options.now ?? (() => new Date()))();
    const counts = await commitImportedCollections(
      context,
      source.collections,
      source.sha256,
      {
        migration: { source: 'sqlite-v5', sourceSha256: source.sha256, importedAt: now.toISOString() },
      },
      now,
    );
    return {
      ok: true,
      operation: 'import-sqlite',
      database: values.database,
      sourceVersion: source.sourceVersion,
      sourceSha256: source.sha256,
      collections: counts,
      recoveryRequired: true,
      note: 'Original source unchanged. Accounts and operational history imported; sessions invalidated and pending email held. Reconcile accounts, numbering, payments and email before db:resume.',
    };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (
      !process.argv.slice(2).length ||
      process.argv.slice(2).some((value) => ['--help', '-h'].includes(value))
    ) {
      console.log(IMPORT_HELP);
    } else {
      const { environment } = loadEnvironment();
      console.log(JSON.stringify(await runImportCommand(process.argv.slice(2), { environment }), null, 2));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof DatabaseCommandError
            ? error.message
            : 'SQLite import stopped safely. Check the source, connection and command options; no existing MongoDB records were overwritten.',
      }),
    );
    process.exitCode = 1;
  }
}
