/**
 * MongoDB connection, collection/index setup and transactions.
 *
 * connectDatabase() opens one shared client, creates the collections and indexes the app needs,
 * seeds the starting businesses on first run, and returns the database context
 * ({ models, collection, transaction, close, ... }) used everywhere as `db`.
 * MongoDB must be a replica set because payments and numbering use transactions.
 */

import { MongoClient } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createModels } from '../models/repositories.js';
import { initializeWorkspace } from '../models/workspace-seed.js';
import {
  TRANSACTION_LOCK_IDS,
  assertNestedTransactionScope,
  transactionScope,
} from './transaction-scopes.js';

// Every MongoDB collection the application owns. Startup creates any that are missing.
export const COLLECTIONS = [
  'organizations',
  'customers',
  'documents',
  'document_requests',
  'sequences',
  'catalog',
  'formats',
  'payments',
  'document_events',
  'workspace_settings',
  'business_products',
  'auth_users',
  'auth_sessions',
  'auth_password_resets',
  'auth_audit',
  'auth_rate_limits',
  'email_outbox',
  'payment_reminder_policies',
  'recurring_invoice_schedules',
  'recurring_invoice_occurrences',
  'recurring_invoice_events',
  'online_payment_links',
  'online_verified_payments',
  'online_webhook_events',
  'online_failed_attempts',
  'cashfree_payment_links',
  'cashfree_verified_payments',
  'cashfree_link_orders',
  'cashfree_webhook_events',
  'cashfree_failed_attempts',
  'workspace_metadata',
  'transaction_locks',
  'ops_recovery_state',
  'images',
];

/**
 * One MongoClient and its driver-managed pool are shared by this server process.
 * Driver pool defaults remain in place until deployment measurements justify tuning.
 * A replica set (including a local one-node replica set) is required for ledger,
 * document-number, account-access and outbox transactions.
 */
export async function connectDatabase(options = {}) {
  const environment = options.environment ?? process.env;
  const uri = options.uri ?? environment.MONGODB_URI;
  const databaseName = options.databaseName ?? environment.MONGODB_DATABASE ?? 'venturecore_workspace';
  if (!uri && !options.client) throw new Error('Configure MONGODB_URI before starting the application.');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(databaseName))
    throw new Error('MONGODB_DATABASE has an invalid database name.');
  const ownsClient = !options.client;
  const client =
    options.client ?? new MongoClient(uri, { appName: 'venturecore-workspace', ignoreUndefined: true });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const topology = await database.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid')
      throw new Error(
        'MongoDB must run as a replica set or sharded cluster so financial and account changes remain atomic.',
      );
    const transactionStorage = new AsyncLocalStorage();
    const context = {
      client,
      database,
      collection: (name) => database.collection(name),
      options: () => {
        const session = transactionStorage.getStore()?.session;
        return session ? { session } : {};
      },
      async transaction(action, options) {
        if (typeof action !== 'function') throw new TypeError('A transaction callback is required.');
        const parent = transactionStorage.getStore();
        if (parent) {
          assertNestedTransactionScope(parent, options);
          return action();
        }
        const scope = transactionScope(options);
        const lockIds = scope.scope === 'workspace' ? TRANSACTION_LOCK_IDS : [scope.stripe];
        const session = client.startSession();
        try {
          return await session.withTransaction(
            () =>
              transactionStorage.run({ session, ...scope }, async () => {
                // Organization transactions share one fixed stripe. The default
                // workspace transaction takes every stripe, so unmigrated/global
                // workflows still exclude all scoped writers. Take them in stable
                // order before business reads; a conflict retries a fresh snapshot.
                for (const id of lockIds) {
                  const lock = await database
                    .collection('transaction_locks')
                    .updateOne({ _id: id }, { $inc: { revision: 1 } }, { session });
                  if (lock.matchedCount !== 1)
                    throw new Error(
                      'Transaction coordination is unavailable. Restart after reviewing the database.',
                    );
                }
                return action();
              }),
            {
              readConcern: { level: 'snapshot' },
              writeConcern: { w: 'majority' },
              readPreference: 'primary',
            },
          );
        } finally {
          await session.endSession();
        }
      },
      async close() {
        if (ownsClient) await client.close();
      },
    };
    await initializeCollections(context);
    context.models = createModels(context);
    if (options.seed !== false) await initializeWorkspace(context);
    return context;
  } catch (error) {
    if (ownsClient) await client.close().catch(() => {});
    throw error;
  }
}

/** Creates missing collections and all indexes (unique keys, query indexes, TTL clean-up). */
async function initializeCollections(context) {
  const database = context.database;
  const existing = new Set(
    (await database.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name),
  );
  for (const name of COLLECTIONS) {
    if (!existing.has(name)) {
      try {
        await database.createCollection(name);
      } catch (error) {
        if (error.code !== 48) throw error;
      }
    }
  }
  const index = (name, key, settings = {}) => database.collection(name).createIndex(key, settings);
  const ids = [
    'organizations',
    'customers',
    'documents',
    'catalog',
    'formats',
    'payments',
    'document_events',
    'business_products',
    'auth_users',
    'auth_audit',
    'email_outbox',
    'recurring_invoice_schedules',
    'recurring_invoice_occurrences',
    'recurring_invoice_events',
    'online_payment_links',
    'cashfree_payment_links',
  ];
  for (const name of ids) await index(name, { id: 1 }, { unique: true });
  for (const name of ['customers', 'documents', 'catalog', 'formats', 'business_products'])
    await index(name, { organizationId: 1 });
  await index('documents', { number: 1 }, { unique: true });
  await index('documents', { customerId: 1 });
  await index('documents', { organizationId: 1, kind: 1 });
  await index('documents', { organizationId: 1, createdAt: -1, _id: -1 });
  await index('documents', { organizationId: 1, kind: 1, createdAt: -1, _id: -1 });
  await index('documents', { organizationId: 1, _id: -1 });
  await index('document_requests', { organizationId: 1, requestId: 1 }, { unique: true });
  await index('payments', { documentId: 1, requestId: 1 }, { unique: true });
  await index('payments', { organizationId: 1 });
  // Directory pages and editor lookups use stable name/id order and exact tenant IDs.
  // Simple collation must match queries: linguistic collation also broadens ID equality.
  for (const name of ['customers', 'catalog']) {
    await index(
      name,
      { organizationId: 1, name: 1, id: 1 },
      {
        name: `${name}_directory_name_v1`,
        collation: { locale: 'simple' },
      },
    );
  }
  await index('document_events', { documentId: 1 });
  await index('sequences', { organizationId: 1, kind: 1, fiscalYear: 1 }, { unique: true });
  await index(
    'formats',
    { organizationId: 1 },
    { unique: true, name: 'one_default_per_organization', partialFilterExpression: { isDefault: true } },
  );
  await index(
    'catalog',
    { organizationId: 1, sku: 1 },
    {
      unique: true,
      collation: { locale: 'en', strength: 2 },
      partialFilterExpression: { sku: { $type: 'string', $gt: '' } },
    },
  );
  await index(
    'business_products',
    { organizationId: 1, code: 1 },
    {
      unique: true,
      collation: { locale: 'en', strength: 2 },
      partialFilterExpression: { code: { $type: 'string', $gt: '' } },
    },
  );
  await index('auth_users', { email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
  for (const name of ['auth_sessions', 'auth_password_resets']) {
    await index(name, { token_hash: 1 }, { unique: true });
    await index(name, { user_id: 1 });
    await index(name, { expiresOn: 1 }, { expireAfterSeconds: 0 });
  }
  await index('auth_rate_limits', { expiresOn: 1 }, { expireAfterSeconds: 0 });
  await index('auth_audit', { created_at: -1, id: -1 });
  await index('auth_audit', { action: 1, created_at: -1, id: -1 });
  await index('auth_audit', { user_id: 1, created_at: -1, id: -1 });
  await index('auth_audit', { actor_id: 1, created_at: -1, id: -1 });
  await index('email_outbox', { event_key: 1 }, { unique: true });
  await index('email_outbox', { status: 1, next_attempt_at: 1 });
  await index('email_outbox', { status: 1, lease_until: 1 });
  await index('email_outbox', { document_id: 1, created_at: -1 });
  await index('payment_reminder_policies', { enabled: 1, organizationId: 1 });
  await index('email_outbox', { kind: 1, 'payload.organizationId': 1, created_at: -1, _id: -1 });
  await index('email_outbox', {
    kind: 1,
    'payload.organizationId': 1,
    'payload.reminder.automatic': 1,
    first_attempt_at: 1,
    status: 1,
  });
  await index('recurring_invoice_schedules', { organizationId: 1, requestId: 1 }, { unique: true });
  await index('recurring_invoice_schedules', { status: 1, nextDate: 1, nextEligibleAt: 1 });
  await index('recurring_invoice_schedules', { organizationId: 1, createdAt: -1, id: -1 });
  await index('recurring_invoice_occurrences', { scheduleId: 1, scheduledDate: 1 }, { unique: true });
  await index('recurring_invoice_occurrences', { organizationId: 1, scheduleId: 1, scheduledDate: -1 });
  await index('recurring_invoice_events', { organizationId: 1, scheduleId: 1, at: -1, id: -1 });
  await index('documents', { organizationId: 1, customerId: 1, kind: 1, issueDate: 1, id: 1 });
  await index('documents', { organizationId: 1, kind: 1, status: 1, dueDate: 1, _id: 1 });
  await index('documents', {
    organizationId: 1,
    kind: 1,
    status: 1,
    'installmentPlan.installments.dueDate': 1,
    _id: 1,
  });
  await index(
    'documents',
    { recurringScheduleId: 1, recurringScheduledDate: 1 },
    { unique: true, partialFilterExpression: { recurringScheduleId: { $type: 'string' } } },
  );
  const active = ['creating', 'created', 'partially_paid', 'needs_review', 'creation_unknown'];
  for (const prefix of ['online', 'cashfree']) {
    const scoped = prefix === 'cashfree';
    await index(`${prefix}_payment_links`, { reference_id: 1 }, { unique: true });
    await index(
      `${prefix}_payment_links`,
      scoped ? { organization_id: 1, provider_id: 1 } : { provider_id: 1 },
      { unique: true, partialFilterExpression: { provider_id: { $type: 'string' } } },
    );
    await index(
      `${prefix}_payment_links`,
      { document_id: 1 },
      {
        unique: true,
        name: 'one_active_link_per_document',
        partialFilterExpression: { state: { $in: active } },
      },
    );
    await index(`${prefix}_payment_links`, { document_id: 1, created_at: -1 });
    await index(
      `${prefix}_verified_payments`,
      scoped ? { organization_id: 1, provider_payment_id: 1 } : { provider_payment_id: 1 },
      { unique: true },
    );
    await index(`${prefix}_verified_payments`, { link_id: 1 });
    await index(
      `${prefix}_failed_attempts`,
      scoped ? { organization_id: 1, provider_payment_id: 1 } : { provider_payment_id: 1 },
      { unique: true },
    );
    await index(
      `${prefix}_webhook_events`,
      scoped ? { organization_id: 1, event_key: 1 } : { event_key: 1 },
      { unique: true },
    );
  }
  await index('cashfree_link_orders', { organization_id: 1, provider_order_id: 1 }, { unique: true });
  for (const id of TRANSACTION_LOCK_IDS)
    await database
      .collection('transaction_locks')
      .updateOne({ _id: id }, { $setOnInsert: { revision: 0 } }, { upsert: true });
}

// Short aliases used by older call sites.
export const initDb = connectDatabase;
export const transaction = (database, action, options) => database.transaction(action, options);
