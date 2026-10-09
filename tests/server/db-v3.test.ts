import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, seedDefaultFormat } from '../../server/db/db.ts';
import {
  COMPANY_NAME,
  defaultFormatFor,
  type BusinessDocument,
  type Customer,
  type DocumentEvent,
  type InvoiceFormat,
  type Organization,
  type PaymentRecord,
} from '../../shared/types.ts';
import { TEMPLATE_PRESETS } from '../../shared/template-presets.ts';

const organization: Organization = {
  id: 'existing-division',
  name: 'Existing custom division',
  legalName: COMPANY_NAME,
  gstin: '',
  email: '',
  phone: '',
  address: 'Saved address',
  stateCode: '',
  accentColor: '#987654',
  logoUrl: '',
  invoicePrefix: 'EXIN',
  quotationPrefix: 'EXQT',
  bankName: 'Saved bank',
  accountName: '',
  accountNumber: '',
  ifsc: '',
  terms: 'Saved terms',
  signature: '',
  template: 'classic',
};
const customer: Customer = {
  id: 'existing-customer',
  organizationId: organization.id,
  name: 'Saved customer',
  email: '',
  phone: '',
  gstin: '',
  address: 'Saved customer address',
  stateCode: '',
  contactPerson: '',
};
const timestamp = '2026-02-03T04:05:06.000Z';
const standard: InvoiceFormat = {
  ...defaultFormatFor(organization),
  name: 'My old Standard',
  isDefault: false,
  createdAt: timestamp,
  updatedAt: timestamp,
  footerText: 'Saved custom footer',
};
const custom: InvoiceFormat = {
  ...standard,
  id: 'custom-format',
  name: 'Custom default',
  layout: 'minimal',
  isDefault: true,
};

function document(id: string, overrides: Partial<BusinessDocument> = {}): BusinessDocument {
  return {
    id,
    organizationId: organization.id,
    customerId: customer.id,
    kind: 'invoice',
    status: 'sent',
    number: `EXIN/2526/${id}`,
    issueDate: '2026-02-01',
    dueDate: '2026-02-15',
    title: 'Historical document',
    items: [{ description: 'Agreed item description', hsn: '998599', quantity: 1, rate: 123.45, gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '',
    notes: 'Historical notes',
    terms: 'Historical terms',
    createdAt: timestamp,
    updatedAt: timestamp,
    organizationSnapshot: { ...organization, name: 'Old issuer name' },
    customerSnapshot: { ...customer, name: 'Old customer name' },
    totals: { subtotal: 123.45, discount: 0, taxable: 123.45, cgst: 0, sgst: 0, igst: 0, total: 123.45 },
    sourceQuotationId: null,
    convertedInvoiceId: null,
    formatId: standard.id,
    formatSnapshot: { ...standard },
    ...overrides,
  };
}

function fileFor(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venturecore-v3-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'workspace.sqlite');
}

function makeV2(filename: string, documents: BusinessDocument[] = []) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE customers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), data TEXT NOT NULL);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      kind TEXT NOT NULL CHECK(kind IN ('invoice', 'quotation')),
      number TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL
    );
    CREATE TABLE sequences (organization_id TEXT NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL, fiscal_year TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (organization_id, kind, fiscal_year));
    CREATE TABLE catalog (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), sku TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE formats (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)), data TEXT NOT NULL);
    CREATE UNIQUE INDEX formats_one_default ON formats(organization_id) WHERE is_default = 1;
    CREATE TABLE saved_relations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id));
    PRAGMA user_version = 2;
  `);
  db.prepare('INSERT INTO organizations VALUES (?, ?)').run(organization.id, JSON.stringify(organization));
  db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(
    customer.id,
    organization.id,
    JSON.stringify(customer),
  );
  for (const format of [standard, custom])
    db.prepare('INSERT INTO formats VALUES (?, ?, ?, ?)').run(
      format.id,
      organization.id,
      Number(format.isDefault),
      JSON.stringify(format),
    );
  db.prepare('INSERT INTO catalog VALUES (?, ?, ?, ?)').run(
    'catalog-existing',
    organization.id,
    'SERVICE-1',
    JSON.stringify({ name: 'Existing service', rate: 123.45 }),
  );
  db.prepare('INSERT INTO sequences VALUES (?, ?, ?, ?)').run(organization.id, 'invoice', '2526', 91);
  db.prepare('INSERT INTO sequences VALUES (?, ?, ?, ?)').run(organization.id, 'quotation', '2526', 73);
  for (const saved of documents) {
    db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(
      saved.id,
      saved.organizationId,
      saved.customerId,
      saved.kind,
      saved.number,
      JSON.stringify(saved),
    );
    db.prepare('INSERT INTO saved_relations VALUES (?, ?)').run(`relation-${saved.id}`, saved.id);
  }
  db.close();
}

function read<T>(db: DatabaseSync, table: string, id: string): T {
  return JSON.parse(
    (db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }).data,
  ) as T;
}
function rows<T>(db: DatabaseSync, table: string): T[] {
  return (db.prepare(`SELECT data FROM ${table} ORDER BY id`).all() as { data: string }[]).map(
    (row) => JSON.parse(row.data) as T,
  );
}

test('v3 preserves related records, sequences, custom defaults and historical snapshots across two starts', (t) => {
  const filename = fileFor(t);
  const quote = document('quote', { kind: 'quotation', status: 'accepted', convertedInvoiceId: 'paid' });
  const paid = document('paid', { status: 'paid', sourceQuotationId: quote.id });
  const unpaid = document('unpaid');
  const partial = document('partial', {
    status: 'partially_paid',
    amountPaid: 20.1,
    balanceDue: 103.35,
    finalizedAt: null,
  });
  const zero = document('zero', {
    status: 'paid',
    totals: { subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 },
  });
  makeV2(filename, [quote, paid, unpaid, partial, zero]);
  const upgraded = initDb(filename);
  let upgradedDocuments: BusinessDocument[];
  let upgradedPayments: PaymentRecord[];
  let upgradedEvents: DocumentEvent[];
  let upgradedFormats: InvoiceFormat[];
  try {
    assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
    assert.equal((upgraded.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(read<Organization>(upgraded, 'organizations', organization.id), {
      ...organization,
      billingProfile: 'general',
      enableProductSelection: false,
      businessType: 'division',
      paymentGateway: 'razorpay',
      supportEmail: 'support@pirento.com',
      gstRegistrations: [],
    });
    assert.deepEqual(read<Customer>(upgraded, 'customers', customer.id), customer);
    assert.deepEqual(read(upgraded, 'catalog', 'catalog-existing'), {
      name: 'Existing service',
      rate: 123.45,
    });
    assert.equal(
      (upgraded.prepare('SELECT count(*) AS count FROM saved_relations').get() as { count: number }).count,
      5,
    );
    assert.deepEqual(
      upgraded
        .prepare('SELECT kind, value FROM sequences ORDER BY kind')
        .all()
        .map((row) => ({ ...row })),
      [
        { kind: 'invoice', value: 91 },
        { kind: 'quotation', value: 73 },
      ],
    );
    assert.deepEqual(read<InvoiceFormat>(upgraded, 'formats', standard.id), {
      ...standard,
      presetKey: 'standard',
    });
    assert.deepEqual(read<InvoiceFormat>(upgraded, 'formats', custom.id), custom);
    const formats = rows<InvoiceFormat>(upgraded, 'formats');
    assert.equal(formats.length, 16);
    assert.equal(formats.filter((format) => format.isDefault).length, 1);
    assert.equal(formats.find((format) => format.isDefault)?.id, custom.id);
    assert.deepEqual(
      formats
        .map((format) => format.presetKey)
        .filter(Boolean)
        .sort(),
      TEMPLATE_PRESETS.map((preset) => preset.key).sort(),
    );
    for (const saved of [quote, paid, unpaid, partial, zero]) {
      const { amountPaid: _paid, balanceDue: _balance, finalizedAt: _finalized, ...original } = saved;
      const {
        amountPaid: _newPaid,
        balanceDue: _newBalance,
        finalizedAt: _newFinalized,
        ...migrated
      } = read<BusinessDocument>(upgraded, 'documents', saved.id);
      assert.deepEqual(migrated, original);
    }
    assert.deepEqual(read<BusinessDocument>(upgraded, 'documents', partial.id), partial);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', unpaid.id).amountPaid, 0);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', unpaid.id).balanceDue, 123.45);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', unpaid.id).finalizedAt, null);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', quote.id).balanceDue, 0);
    const migratedPaid = read<BusinessDocument>(upgraded, 'documents', paid.id);
    assert.equal(migratedPaid.amountPaid, 123.45);
    assert.equal(migratedPaid.balanceDue, 0);
    assert.equal(migratedPaid.finalizedAt, paid.updatedAt);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', zero.id).amountPaid, 0);
    assert.equal(read<BusinessDocument>(upgraded, 'documents', zero.id).finalizedAt, zero.updatedAt);
    const [payment] = rows<PaymentRecord>(upgraded, 'payments');
    assert.equal(payment.amount, 123.45);
    assert.equal(payment.paidOn, paid.issueDate);
    assert.equal(payment.method, 'other');
    assert.equal(payment.reference, 'Legacy paid status');
    assert.equal(payment.requestId, `legacy-paid-${paid.id}`);
    assert.equal(payment.finalizeWhenPaid, true);
    assert.match(payment.notes, /No payment proof/);
    assert.equal(
      (upgraded.prepare('SELECT amount_paise FROM payments').get() as { amount_paise: number }).amount_paise,
      12345,
    );
    const events = rows<DocumentEvent>(upgraded, 'document_events');
    assert.equal(events.length, 2);
    assert.ok(
      events.every(
        (event) => event.type === 'legacy_payment_migrated' && /no payment proof/i.test(event.description),
      ),
    );
    upgradedDocuments = rows<BusinessDocument>(upgraded, 'documents');
    upgradedPayments = rows<PaymentRecord>(upgraded, 'payments');
    upgradedEvents = events;
    upgradedFormats = formats;
  } finally {
    upgraded.close();
  }
  const repeated = initDb(filename);
  try {
    assert.deepEqual(rows<BusinessDocument>(repeated, 'documents'), upgradedDocuments!);
    assert.deepEqual(rows<PaymentRecord>(repeated, 'payments'), upgradedPayments!);
    assert.deepEqual(rows<DocumentEvent>(repeated, 'document_events'), upgradedEvents!);
    assert.deepEqual(rows<InvoiceFormat>(repeated, 'formats'), upgradedFormats!);
    assert.deepEqual(repeated.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    repeated.close();
  }
});

test('fresh databases and new organizations support 15 presets and all four document kinds', () => {
  const db = initDb(':memory:');
  try {
    const organizations = rows<Organization>(db, 'organizations');
    assert.equal(organizations.length, 6);
    assert.equal(rows<InvoiceFormat>(db, 'formats').length, 90);
    db.prepare('INSERT INTO organizations VALUES (?, ?)').run(organization.id, JSON.stringify(organization));
    const seeded = seedDefaultFormat(db, organization, timestamp);
    assert.equal(seeded.presetKey, 'standard');
    assert.equal(seeded.isDefault, true);
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS count FROM formats WHERE organization_id = ?')
          .get(organization.id) as { count: number }
      ).count,
      15,
    );
    assert.deepEqual(seedDefaultFormat(db, organization, '2030-01-01T00:00:00.000Z'), seeded);
    assert.equal(
      (
        db
          .prepare('SELECT count(*) AS count FROM formats WHERE organization_id = ?')
          .get(organization.id) as { count: number }
      ).count,
      15,
    );
    db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(
      customer.id,
      organization.id,
      JSON.stringify(customer),
    );
    for (const kind of ['invoice', 'quotation', 'proforma', 'delivery_note']) {
      const saved = document(kind);
      db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(
        saved.id,
        organization.id,
        customer.id,
        kind,
        saved.number,
        JSON.stringify(saved),
      );
    }
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)')
          .run('invalid', organization.id, customer.id, 'unknown', 'invalid-number', '{}'),
      /CHECK constraint/,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('payment constraints enforce integer paise, request idempotency and valid relations', () => {
  const db = initDb(':memory:');
  try {
    const [org] = rows<Organization>(db, 'organizations');
    db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(customer.id, org.id, JSON.stringify(customer));
    db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(
      'invoice',
      org.id,
      customer.id,
      'invoice',
      'INV-1',
      '{}',
    );
    const insert = db.prepare(
      'INSERT INTO payments (id, document_id, organization_id, request_id, amount_paise, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('payment', 'invoice', org.id, 'request-1', 12345, '{}');
    assert.throws(
      () => insert.run('duplicate', 'invoice', org.id, 'request-1', 12345, '{}'),
      /UNIQUE constraint/,
    );
    for (const amount of [0, -1, 1.5])
      assert.throws(
        () => insert.run(`invalid-${amount}`, 'invoice', org.id, 'invalid', amount, '{}'),
        /CHECK constraint/,
      );
    assert.throws(() => insert.run('orphan', 'missing', org.id, 'orphan', 1, '{}'), /FOREIGN KEY constraint/);
    assert.throws(
      () => db.prepare('INSERT INTO document_events VALUES (?, ?, ?)').run('event', 'missing', '{}'),
      /FOREIGN KEY constraint/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM documents WHERE id = ?').run('invoice'),
      /FOREIGN KEY constraint/,
    );
  } finally {
    db.close();
  }
});

test('v3 migration rolls back schema and presets if historical totals are invalid', (t) => {
  const filename = fileFor(t);
  const invalid = document('invalid', {
    totals: { subtotal: -1, discount: 0, taxable: -1, cgst: 0, sgst: 0, igst: 0, total: -1 },
  });
  makeV2(filename, [invalid]);
  assert.throws(() => initDb(filename), /Cannot migrate invalid total/);
  const original = new DatabaseSync(filename);
  try {
    assert.equal((original.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    assert.deepEqual(read<BusinessDocument>(original, 'documents', invalid.id), invalid);
    assert.deepEqual(read<InvoiceFormat>(original, 'formats', standard.id), standard);
    assert.equal(rows<InvoiceFormat>(original, 'formats').length, 2);
    assert.equal(
      original
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'documents_v3' OR name = 'payments' OR name = 'document_events'",
        )
        .all().length,
      0,
    );
    assert.throws(
      () =>
        original
          .prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)')
          .run('new', organization.id, customer.id, 'proforma', 'new-number', '{}'),
      /CHECK constraint/,
    );
  } finally {
    original.close();
  }
});

test('upgraded workspaces preserve intentionally removed presets on subsequent startup', (t) => {
  const filename = fileFor(t);
  makeV2(filename);
  const migrated = initDb(filename);
  const removedId = `${organization.id}-preset-retail`;
  migrated.prepare('DELETE FROM formats WHERE id = ?').run(removedId);
  migrated.close();
  const repeated = initDb(filename);
  try {
    assert.equal(repeated.prepare('SELECT id FROM formats WHERE id = ?').get(removedId), undefined);
    assert.equal(rows<InvoiceFormat>(repeated, 'formats').length, 15);
  } finally {
    repeated.close();
  }
});

test('preset migration respects existing keys and preserves custom formats occupying seeded IDs', (t) => {
  const filename = fileFor(t);
  makeV2(filename);
  const legacy = new DatabaseSync(filename);
  const editedRetail: InvoiceFormat = {
    ...standard,
    id: 'my-retail-template',
    presetKey: 'retail',
    name: 'My customized retail template',
    accentColor: '#112233',
  };
  const occupiedId: InvoiceFormat = {
    ...standard,
    id: `${organization.id}-preset-corporate`,
    name: 'Saved custom template in a reserved ID',
  };
  for (const format of [editedRetail, occupiedId])
    legacy
      .prepare('INSERT INTO formats VALUES (?, ?, 0, ?)')
      .run(format.id, organization.id, JSON.stringify(format));
  legacy.close();
  const migrated = initDb(filename);
  try {
    assert.deepEqual(read<InvoiceFormat>(migrated, 'formats', editedRetail.id), editedRetail);
    assert.deepEqual(read<InvoiceFormat>(migrated, 'formats', occupiedId.id), occupiedId);
    const formats = rows<InvoiceFormat>(migrated, 'formats');
    assert.equal(formats.length, 17);
    assert.equal(formats.filter((format) => format.presetKey === 'retail').length, 1);
    const corporate = formats.find((format) => format.presetKey === 'corporate');
    assert.ok(corporate);
    assert.notEqual(corporate.id, occupiedId.id);
    assert.equal(corporate.isDefault, false);
    assert.equal(formats.find((format) => format.isDefault)?.id, custom.id);
  } finally {
    migrated.close();
  }
});
