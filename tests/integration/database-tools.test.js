/** Integration tests: MongoDB backup/restore with recovery review, and SQLite import. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MongoClient, BSON } from 'mongodb';
import { connectDatabase } from '../../src/config/database.js';
import { createBackend } from '../../src/services/backend.js';
import { assertDatabaseRecoveryReviewed } from '../../src/services/operations/recovery.js';
import { runDatabaseCommand, verifyPortableSnapshot } from '../../scripts/database.js';
import { readLegacyDatabase, runImportCommand } from '../../scripts/import-sqlite.js';

const enabled = Boolean(process.env.MONGODB_TEST_URI);
const timestamp = '2026-06-01T12:00:00.000Z';
const fixedNow = () => new Date(timestamp);

/** Cleanup is restricted to random test database names, never the URI default. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'venturecore-tools-test-'));
  const client = new MongoClient(process.env.MONGODB_TEST_URI);
  await client.connect();
  const databases = [];
  const environment = {
    NODE_ENV: 'test',
    MONGODB_URI: process.env.MONGODB_TEST_URI,
    BACKUP_ENABLED: 'false',
    DATABASE_BACKUP_DIR: directory,
  };
  t.after(async () => {
    try {
      for (const name of databases) {
        assert.match(name, /^venturecore_tools_[a-f0-9]{32}$/);
        await client.db(name).dropDatabase();
      }
    } finally {
      await client.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    directory,
    client,
    environment,
    options: { environment, now: fixedNow },
    target() {
      const name = `venturecore_tools_${randomUUID().replaceAll('-', '')}`;
      databases.push(name);
      return name;
    },
  };
}

function outbox(id, kind, status) {
  return {
    id,
    event_key: id,
    document_id: kind === 'password_reset' ? null : 'document-old',
    kind,
    recipient: 'owner@example.test',
    subject: 'Existing message',
    status,
    attempts: 1,
    created_at: timestamp,
    updated_at: timestamp,
    sent_at: status === 'sent' ? timestamp : null,
    next_attempt_at: timestamp,
    lease_until: timestamp,
    first_attempt_at: timestamp,
    last_error: '',
    provider_id: status === 'sent' ? 'provider-receipt' : '',
    has_payment_link: 0,
    payload: { document: { number: 'BR/2026/000042' }, secretLink: 'old-reset-token' },
  };
}

async function createSource(f) {
  const name = f.target();
  const context = await connectDatabase({ environment: f.environment, databaseName: name, seed: false });
  try {
    await context
      .collection('workspace_metadata')
      .insertOne({ _id: 'schema', version: 1, initializedAt: timestamp });
    await context.collection('organizations').insertOne({ id: 'org-old', name: 'Original organization' });
    await context.collection('documents').insertOne({
      id: 'document-old',
      organizationId: 'org-old',
      kind: 'invoice',
      customerId: 'customer-old',
      number: 'BR/2026/000042',
      status: 'issued',
      seller: { name: 'Historical seller' },
      totals: { total: 123.45 },
      amountPaid: 23.45,
    });
    await context
      .collection('sequences')
      .insertOne({ organizationId: 'org-old', kind: 'invoice', fiscalYear: '2026-27', value: 42 });
    await context.collection('payments').insertOne({
      id: 'payment-old',
      documentId: 'document-old',
      organizationId: 'org-old',
      requestId: 'idempotency-original',
      amount: 23.45,
      reference: 'external-payment',
      voidedAt: null,
    });
    await context.collection('auth_sessions').insertOne({
      token_hash: 'old-session',
      user_id: 'user-old',
      created_at: 1700000000000,
      expires_at: 4102444800000,
      expiresOn: new Date('2100-01-01'),
    });
    await context.collection('auth_password_resets').insertOne({
      token_hash: 'old-reset',
      user_id: 'user-old',
      created_at: 1700000000000,
      expires_at: 4102444800000,
      expiresOn: new Date('2100-01-01'),
    });
    await context
      .collection('email_outbox')
      .insertMany([
        outbox('queued-email', 'invoice', 'queued'),
        outbox('sending-email', 'invoice', 'sending'),
        outbox('sent-email', 'invoice', 'sent'),
        outbox('reset-email', 'password_reset', 'queued'),
      ]);
    await context.collection('online_verified_payments').insertOne({
      provider_payment_id: 'pay-verified',
      link_id: 'link-old',
      amount_paise: 2345,
      ledger_payment_id: 'payment-old',
      created_at: timestamp,
    });
    await context.collection('payment_reminder_policies').insertOne({
      _id: 'org-old',
      organizationId: 'org-old',
      enabled: true,
      offsets: [0, 7],
      version: 3,
    });
    await context.collection('recurring_invoice_schedules').insertMany([
      {
        id: 'recurring-active',
        organizationId: 'org-old',
        requestId: 'schedule-create-active',
        status: 'active',
        version: 2,
        nextDate: '2026-10-01',
        generatedCount: 1,
      },
      {
        id: 'recurring-completed',
        organizationId: 'org-old',
        requestId: 'schedule-create-completed',
        status: 'completed',
        version: 8,
        generatedCount: 6,
      },
    ]);
    await context.collection('recurring_invoice_occurrences').insertOne({
      id: 'occurrence-old',
      organizationId: 'org-old',
      scheduleId: 'recurring-active',
      scheduledDate: '2026-09-01',
      documentId: 'document-old',
      status: 'generated',
    });
    await context.collection('recurring_invoice_events').insertOne({
      id: 'recurring-event-old',
      organizationId: 'org-old',
      scheduleId: 'recurring-active',
      type: 'generated',
      at: timestamp,
    });
    await context.collection('historical_extra').insertOne({
      _id: new BSON.ObjectId(),
      code: 'preserved',
      at: new Date(timestamp),
      precise: BSON.Long.fromString('9223372036854775806'),
      decimal: BSON.Decimal128.fromString('1234567890.123456789'),
      bytes: new BSON.Binary(Buffer.from([0, 1, 255])),
    });
    await context
      .collection('historical_extra')
      .createIndex({ code: 1 }, { name: 'historic_code', unique: true });
  } finally {
    await context.close();
  }
  return name;
}

async function rewriteSnapshot(file, manifest, mutate) {
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  mutate(snapshot);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const metadata = JSON.parse(await readFile(manifest, 'utf8'));
  metadata.database.byteLength = bytes.length;
  metadata.database.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(file, bytes, { mode: 0o600 });
  await writeFile(manifest, JSON.stringify(metadata), { mode: 0o600 });
}

test(
  'MongoDB backup/restore preserves BSON and histories, then requires recovery review',
  { skip: !enabled },
  async (t) => {
    const f = await fixture(t);
    const source = await createSource(f);
    const backup = await runDatabaseCommand('backup', [`--database=${source}`], f.options);
    assert.equal(backup.backup.verified, true);
    const listed = await runDatabaseCommand('backup', ['--list'], f.options);
    assert.equal(listed.backups[0].id, backup.backup.id);
    const verified = await runDatabaseCommand('backup', [`--verify=${backup.backup.id}`], f.options);
    assert.equal(verified.backup.sha256, backup.backup.sha256);
    assert.ok(verifyPortableSnapshot(backup.file, backup.manifest).collections.length > 20);

    const target = f.target();
    const restored = await runDatabaseCommand(
      'restore',
      [`--file=${backup.file}`, `--manifest=${backup.manifest}`, `--database=${target}`],
      f.options,
    );
    assert.equal(restored.recoveryRequired, true);
    const destination = f.client.db(target);
    assert.equal(
      (await destination.collection('documents').findOne({ id: 'document-old' })).number,
      'BR/2026/000042',
    );
    assert.deepEqual(
      await destination.collection('payments').findOne({ id: 'payment-old' }),
      await f.client.db(source).collection('payments').findOne({ id: 'payment-old' }),
    );
    assert.equal((await destination.collection('sequences').findOne({})).value, 42);
    assert.equal(
      (await destination.collection('online_verified_payments').findOne({})).provider_payment_id,
      'pay-verified',
    );
    const originalBson = await f.client.db(source).collection('historical_extra').findOne({});
    const restoredBson = await destination.collection('historical_extra').findOne({});
    assert.deepEqual(
      BSON.EJSON.serialize(restoredBson, { relaxed: false }),
      BSON.EJSON.serialize(originalBson, { relaxed: false }),
    );
    assert.ok(
      (await destination.collection('historical_extra').listIndexes().toArray()).some(
        (index) => index.name === 'historic_code' && index.unique,
      ),
    );
    for (const name of ['auth_sessions', 'auth_password_resets'])
      assert.equal(await destination.collection(name).countDocuments(), 0);
    for (const id of ['queued-email', 'sending-email']) {
      const row = await destination.collection('email_outbox').findOne({ id });
      assert.equal(row.status, 'held');
      assert.equal(row.next_attempt_at, null);
      assert.equal(row.lease_until, null);
      assert.equal(row.claim_token, null);
    }
    const sent = await destination.collection('email_outbox').findOne({ id: 'sent-email' });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.provider_id, 'provider-receipt');
    const reset = await destination.collection('email_outbox').findOne({ id: 'reset-email' });
    assert.equal(reset.status, 'failed');
    assert.deepEqual(reset.payload, {});
    const reminderPolicy = await destination
      .collection('payment_reminder_policies')
      .findOne({ _id: 'org-old' });
    assert.equal(reminderPolicy.enabled, false);
    assert.equal(reminderPolicy.version, 4);
    const recurring = await destination
      .collection('recurring_invoice_schedules')
      .findOne({ id: 'recurring-active' });
    assert.equal(recurring.status, 'paused');
    assert.equal(recurring.version, 3);
    assert.equal(recurring.nextDate, '2026-10-01');
    assert.equal(recurring.generatedCount, 1);
    const completed = await destination
      .collection('recurring_invoice_schedules')
      .findOne({ id: 'recurring-completed' });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.version, 8);
    for (const name of ['recurring_invoice_occurrences', 'recurring_invoice_events'])
      assert.deepEqual(
        await destination.collection(name).findOne({}),
        await f.client.db(source).collection(name).findOne({}),
      );
    assert.equal(
      (await f.client.db(source).collection('payment_reminder_policies').findOne({})).enabled,
      true,
    );
    await assert.rejects(
      createBackend({ auth: false, environment: { ...f.environment, MONGODB_DATABASE: target } }),
      /held for recovery review/,
    );
    await assert.rejects(
      runDatabaseCommand('resume', [`--database=${target}`], f.options),
      /acknowledge-reconciled/,
    );
    const resumed = await runDatabaseCommand(
      'resume',
      [`--database=${target}`, '--acknowledge-reconciled'],
      f.options,
    );
    assert.equal(resumed.recoveryReviewed, true);
    assert.equal((await destination.collection('payment_reminder_policies').findOne({})).enabled, false);
    assert.equal(
      (await destination.collection('recurring_invoice_schedules').findOne({ id: 'recurring-active' }))
        .status,
      'paused',
    );
    assert.equal((await destination.collection('ops_recovery_state').findOne({ id: 1 })).status, 'reviewed');
    assert.equal(
      (await destination.collection('email_outbox').findOne({ id: 'queued-email' })).status,
      'held',
    );
    const context = await connectDatabase({ environment: f.environment, databaseName: target, seed: false });
    try {
      await assertDatabaseRecoveryReviewed(context);
    } finally {
      await context.close();
    }
    await assert.rejects(
      runDatabaseCommand('resume', [`--database=${target}`, '--acknowledge-reconciled'], f.options),
      /no pending recovery/,
    );
  },
);

test(
  'restore rejects modified files and nonempty targets; duplicate conflicts roll back every record',
  { skip: !enabled },
  async (t) => {
    const f = await fixture(t);
    const source = await createSource(f);
    const backup = await runDatabaseCommand('backup', [`--database=${source}`], f.options);
    const occupied = f.target();
    await f.client.db(occupied).collection('sentinel').insertOne({ privateRecord: 'leave unchanged' });
    await assert.rejects(
      runDatabaseCommand(
        'restore',
        [`--file=${backup.file}`, `--manifest=${backup.manifest}`, `--database=${occupied}`],
        f.options,
      ),
      /not empty/,
    );
    assert.equal(await f.client.db(occupied).collection('sentinel').countDocuments(), 1);
    assert.deepEqual(
      (await f.client.db(occupied).listCollections().toArray()).map((row) => row.name),
      ['sentinel'],
    );

    const target = f.target();
    const bytes = await readFile(backup.file);
    await writeFile(backup.file, Buffer.concat([bytes, Buffer.from(' ')]));
    await assert.rejects(
      runDatabaseCommand(
        'restore',
        [`--file=${backup.file}`, `--manifest=${backup.manifest}`, `--database=${target}`],
        f.options,
      ),
      /checksum/,
    );
    assert.equal((await f.client.db(target).listCollections().toArray()).length, 0);
    await writeFile(backup.file, bytes);
    await rewriteSnapshot(backup.file, backup.manifest, (snapshot) => {
      const documents = snapshot.collections.find(
        (collection) => collection.name === 'organizations',
      ).documents;
      documents.push({ ...documents[0], _id: { $oid: new BSON.ObjectId().toHexString() } });
    });
    await assert.rejects(
      runDatabaseCommand(
        'restore',
        [`--file=${backup.file}`, `--manifest=${backup.manifest}`, `--database=${target}`],
        f.options,
      ),
      /No business records were committed/,
    );
    for (const row of await f.client.db(target).listCollections().toArray()) {
      if (row.name !== 'transaction_locks')
        assert.equal(await f.client.db(target).collection(row.name).countDocuments(), 0, row.name);
    }
    assert.equal((await f.client.db(target).collection('transaction_locks').findOne({})).revision, 0);
  },
);

/** A standalone version-5 fixture with every original business and operational table. */
function legacyFixture(filename) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA user_version = 5;');
  const organization = { id: 'legacy-org', name: 'Historical name', currency: 'INR' };
  const customer = {
    id: 'legacy-customer',
    organizationId: organization.id,
    name: 'Historical buyer',
    gstTreatment: 'unregistered',
  };
  const document = {
    id: 'legacy-doc-2',
    organizationId: organization.id,
    customerId: customer.id,
    kind: 'invoice',
    number: 'OLD/2026/000042',
    status: 'issued',
    amountPaid: 23.45,
    seller: { name: 'Frozen seller', address: { city: 'Pune' } },
    customerSnapshot: customer,
    items: [
      {
        description: 'Historical recurring price',
        pricing: { model: 'recurring', plan: 'monthly', unitPrice: 123.45 },
      },
    ],
    totals: { total: 123.45 },
    installmentPlan: [{ dueOn: '2026-07-01', amount: 100 }],
  };
  const secondDocument = { ...document, id: 'legacy-doc-1', number: 'OLD/2026/000043' };
  const payment = {
    id: 'legacy-payment',
    documentId: document.id,
    organizationId: organization.id,
    requestId: 'keep-request-id',
    amount: 23.45,
    method: 'upi',
    reference: 'provider-original',
    voidedAt: null,
    createdAt: timestamp,
  };
  const records = {
    organizations: [{ id: organization.id, data: JSON.stringify(organization) }],
    customers: [{ id: customer.id, organization_id: organization.id, data: JSON.stringify(customer) }],
    documents: [document, secondDocument].map((record) => ({
      id: record.id,
      organization_id: record.organizationId,
      customer_id: record.customerId,
      kind: record.kind,
      number: record.number,
      data: JSON.stringify(record),
    })),
    sequences: [{ organization_id: organization.id, kind: 'invoice', fiscal_year: '2026-27', value: 43 }],
    catalog: [
      {
        id: 'legacy-item',
        organization_id: organization.id,
        sku: 'SKU-42',
        data: JSON.stringify({
          id: 'legacy-item',
          organizationId: organization.id,
          sku: 'SKU-42',
          name: 'Legacy catalog',
          pricing: { model: 'standard', rate: 11.11 },
        }),
      },
    ],
    formats: [
      {
        id: 'legacy-format',
        organization_id: organization.id,
        is_default: 1,
        data: JSON.stringify({
          id: 'legacy-format',
          organizationId: organization.id,
          isDefault: true,
          name: 'Historical layout',
          style: { accentColor: '#123456' },
        }),
      },
    ],
    payments: [
      {
        id: payment.id,
        document_id: document.id,
        organization_id: organization.id,
        request_id: payment.requestId,
        amount_paise: 2345,
        data: JSON.stringify(payment),
      },
    ],
    document_events: [
      {
        id: 'legacy-event',
        document_id: document.id,
        data: JSON.stringify({
          id: 'legacy-event',
          documentId: document.id,
          type: 'issued',
          at: timestamp,
          description: 'Original issuance',
        }),
      },
    ],
    workspace_settings: [
      { id: 1, data: JSON.stringify({ name: 'Original workspace', logoDataUrl: '', theme: 'dark' }) },
    ],
    business_products: [
      {
        id: 'legacy-product',
        organization_id: organization.id,
        code: 'PRODUCT-42',
        data: JSON.stringify({
          id: 'legacy-product',
          organizationId: organization.id,
          code: 'PRODUCT-42',
          name: 'Original product',
          isActive: true,
        }),
      },
    ],
    auth_users: [
      {
        id: 'legacy-admin',
        name: 'Admin',
        email: 'admin@example.test',
        company: 'Company',
        password_hash: 'existing-scrypt-hash',
        role: 'admin',
        status: 'active',
        organization_ids: JSON.stringify([organization.id]),
        created_at: timestamp,
        updated_at: timestamp,
        last_login_at: null,
      },
    ],
    auth_sessions: [
      {
        token_hash: 'legacy-session',
        user_id: 'legacy-admin',
        expires_at: 4102444800000,
        created_at: 1700000000000,
      },
    ],
    auth_password_resets: [
      {
        token_hash: 'legacy-reset',
        user_id: 'legacy-admin',
        expires_at: 4102444800000,
        created_at: 1700000000000,
      },
    ],
    auth_audit: [
      {
        id: 'legacy-audit',
        actor_id: 'legacy-admin',
        action: 'account_updated',
        user_id: 'legacy-admin',
        details: JSON.stringify({ organizationIds: [organization.id], role: 'admin' }),
        created_at: timestamp,
      },
    ],
    email_outbox: [
      outbox('legacy-queued', 'invoice', 'queued'),
      outbox('legacy-sent', 'invoice', 'sent'),
      outbox('legacy-reset-message', 'password_reset', 'queued'),
    ].map((row) => ({ ...row, payload: JSON.stringify(row.payload) })),
    online_payment_links: [
      {
        id: 'legacy-online',
        document_id: document.id,
        provider_id: 'plink_original',
        reference_id: 'link-ref-original',
        amount_paise: 12345,
        initial_paid_paise: 0,
        url: 'https://example.test/payment',
        state: 'partially_paid',
        review_reason: '',
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    online_verified_payments: [
      {
        provider_payment_id: 'pay_original',
        link_id: 'legacy-online',
        amount_paise: 2345,
        ledger_payment_id: payment.id,
        created_at: timestamp,
      },
    ],
    online_webhook_events: [
      {
        event_key: 'evt_original',
        payload_hash: 'a'.repeat(64),
        event_type: 'payment.captured',
        status: 'processed',
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    online_failed_attempts: [
      { provider_payment_id: 'pay_failed', link_id: 'legacy-online', created_at: timestamp },
    ],
    cashfree_payment_links: [
      {
        id: 'legacy-cashfree',
        organization_id: organization.id,
        document_id: document.id,
        reference_id: 'cf-ref-original',
        provider_id: 'cf-link-original',
        amount_paise: 10000,
        initial_paid_paise: 2345,
        url: 'https://example.test/cashfree',
        state: 'paid',
        review_reason: '',
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    cashfree_verified_payments: [
      {
        organization_id: organization.id,
        provider_payment_id: 'cf-payment-original',
        link_id: 'legacy-cashfree',
        amount_paise: 10000,
        ledger_payment_id: payment.id,
        created_at: timestamp,
      },
    ],
    cashfree_link_orders: [
      {
        organization_id: organization.id,
        provider_order_id: 'cf-order-original',
        link_id: 'legacy-cashfree',
      },
    ],
    cashfree_webhook_events: [
      {
        organization_id: organization.id,
        event_key: 'cf-event-original',
        payload_hash: 'b'.repeat(64),
        event_type: 'SUCCESS',
        status: 'processed',
        created_at: timestamp,
        updated_at: timestamp,
      },
    ],
    cashfree_failed_attempts: [
      {
        organization_id: organization.id,
        provider_payment_id: 'cf-failed',
        link_id: 'legacy-cashfree',
        created_at: timestamp,
      },
    ],
    ops_recovery_state: [
      {
        id: 1,
        status: 'reviewed',
        restored_at: timestamp,
        backup_sha256: 'c'.repeat(64),
        reviewed_at: timestamp,
      },
    ],
  };
  for (const [name, rows] of Object.entries(records)) {
    const keys = Object.keys(rows[0]);
    const columns = keys.map(
      (key) =>
        `"${key}" ${typeof rows[0][key] === 'number' ? 'INTEGER' : 'TEXT'}${key === 'id' ? ' PRIMARY KEY' : ''}`,
    );
    if (name === 'customers') columns.push('FOREIGN KEY (organization_id) REFERENCES organizations(id)');
    if (name === 'documents')
      columns.push(
        'FOREIGN KEY (customer_id) REFERENCES customers(id)',
        'FOREIGN KEY (organization_id) REFERENCES organizations(id)',
      );
    if (name === 'payments') columns.push('FOREIGN KEY (document_id) REFERENCES documents(id)');
    sqlite.exec(`CREATE TABLE "${name}" (${columns.join(', ')})`);
    const insert = sqlite.prepare(
      `INSERT INTO "${name}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    );
    for (const row of rows) insert.run(...keys.map((key) => row[key]));
  }
  sqlite.close();
  return { records, document, payment };
}

test(
  'SQLite import retains all native business data, provider idempotency and account history without changing source',
  { skip: !enabled },
  async (t) => {
    const f = await fixture(t);
    const source = join(f.directory, 'legacy.sqlite');
    const expected = legacyFixture(source);
    await chmod(source, 0o400);
    const bytes = await readFile(source);
    const inspected = readLegacyDatabase(source);
    const sessions = inspected.collections.find(
      (collection) => collection.name === 'auth_sessions',
    ).documents;
    assert.equal(sessions[0].expiresOn.toISOString(), '2100-01-01T00:00:00.000Z');
    assert.equal(inspected.collections.length, 25);
    const target = f.target();
    await assert.rejects(
      runImportCommand([`--source=${source}`, `--database=${target}`], f.options),
      /confirm-import/,
    );
    const result = await runImportCommand(
      [`--source=${source}`, `--database=${target}`, '--confirm-import'],
      f.options,
    );
    assert.equal(result.recoveryRequired, true);
    assert.deepEqual(await readFile(source), bytes);
    const database = f.client.db(target);
    const { _id, ...document } = await database.collection('documents').findOne({ id: expected.document.id });
    assert.deepEqual(document, expected.document);
    const { _id: paymentId, ...payment } = await database
      .collection('payments')
      .findOne({ id: expected.payment.id });
    assert.deepEqual(payment, expected.payment);
    assert.deepEqual(
      (await database.collection('documents').find().sort({ _id: 1 }).toArray()).map((row) => row.id),
      ['legacy-doc-2', 'legacy-doc-1'],
    );
    const sequence = await database.collection('sequences').findOne({});
    assert.equal(sequence.value, 43);
    assert.equal(sequence.organizationId, 'legacy-org');
    assert.equal(sequence.fiscalYear, '2026-27');
    assert.equal(
      (await database.collection('workspace_settings').findOne({ id: 1 })).name,
      'Original workspace',
    );
    assert.deepEqual((await database.collection('auth_users').findOne({})).organization_ids, ['legacy-org']);
    assert.deepEqual((await database.collection('auth_audit').findOne({})).details, {
      organizationIds: ['legacy-org'],
      role: 'admin',
    });
    for (const name of Object.keys(expected.records).filter(
      (name) => name.startsWith('online_') || name.startsWith('cashfree_'),
    )) {
      const rows = await database.collection(name).find().toArray();
      assert.deepEqual(
        rows.map(({ _id, ...row }) => row),
        expected.records[name],
        name,
      );
    }
    const held = await database.collection('email_outbox').findOne({ id: 'legacy-queued' });
    assert.equal(held.status, 'held');
    assert.equal(typeof held.payload, 'object');
    assert.equal((await database.collection('email_outbox').findOne({ id: 'legacy-sent' })).status, 'sent');
    assert.deepEqual(
      (await database.collection('email_outbox').findOne({ id: 'legacy-reset-message' })).payload,
      {},
    );
    assert.equal(await database.collection('auth_sessions').countDocuments(), 0);
    assert.equal(await database.collection('auth_password_resets').countDocuments(), 0);
    const recovery = await database.collection('ops_recovery_state').findOne({ id: 1 });
    assert.equal(recovery.status, 'pending');
    assert.equal(recovery.backup_sha256, result.sourceSha256);
    const marker = await database.collection('workspace_metadata').findOne({ _id: 'schema' });
    assert.equal(marker.version, 1);
    assert.equal(marker.migration.source, 'sqlite-v5');
    await assert.rejects(
      createBackend({ auth: false, environment: { ...f.environment, MONGODB_DATABASE: target } }),
      /held for recovery review/,
    );
    // Opening the imported database must not reseed demo organizations or formats.
    assert.equal(await database.collection('organizations').countDocuments(), 1);
    assert.equal(await database.collection('formats').countDocuments(), 1);
    await assert.rejects(
      runImportCommand([`--source=${source}`, `--database=${target}`, '--confirm-import'], f.options),
      /not empty/,
    );
    await runDatabaseCommand('resume', [`--database=${target}`, '--acknowledge-reconciled'], f.options);
    assert.equal((await database.collection('ops_recovery_state').findOne({ id: 1 })).status, 'reviewed');
  },
);

test(
  'SQLite source checks happen before Mongo writes and duplicate imported records roll back',
  { skip: !enabled },
  async (t) => {
    const f = await fixture(t);
    const source = join(f.directory, 'invalid-source.sqlite');
    legacyFixture(source);
    const target = f.target();
    const args = [`--source=${source}`, `--database=${target}`, '--confirm-import'];
    const change = (statement) => {
      const sqlite = new DatabaseSync(source);
      try {
        sqlite.exec(statement);
      } finally {
        sqlite.close();
      }
    };
    change('PRAGMA user_version = 4');
    await assert.rejects(runImportCommand(args, f.options), /schema version 5/);
    change(
      "PRAGMA user_version = 5; PRAGMA foreign_keys = OFF; UPDATE customers SET organization_id='missing'",
    );
    await assert.rejects(runImportCommand(args, f.options), /foreign_key_check/);
    change(
      "UPDATE customers SET organization_id='legacy-org'; CREATE TABLE custom_history (id TEXT); INSERT INTO custom_history VALUES ('must-keep')",
    );
    await assert.rejects(runImportCommand(args, f.options), /unsupported nonempty table/);
    change('DROP TABLE custom_history');
    await writeFile(`${source}-wal`, 'uncheckpointed');
    await assert.rejects(runImportCommand(args, f.options), /active WAL/);
    await rm(`${source}-wal`);
    assert.equal((await f.client.db(target).listCollections().toArray()).length, 0);
    // Legacy custom collations can permit records that conflict with MongoDB's indexes.
    const sqlite = new DatabaseSync(source);
    try {
      const original = sqlite.prepare('SELECT * FROM documents ORDER BY rowid LIMIT 1').get();
      const snapshot = JSON.parse(original.data);
      snapshot.id = 'duplicate-number';
      sqlite
        .prepare('INSERT INTO documents VALUES (?,?,?,?,?,?)')
        .run(
          snapshot.id,
          original.organization_id,
          original.customer_id,
          original.kind,
          original.number,
          JSON.stringify(snapshot),
        );
    } finally {
      sqlite.close();
    }
    await assert.rejects(runImportCommand(args, f.options), /No business records were committed/);
    for (const row of await f.client.db(target).listCollections().toArray()) {
      if (row.name !== 'transaction_locks')
        assert.equal(await f.client.db(target).collection(row.name).countDocuments(), 0, row.name);
    }
  },
);
