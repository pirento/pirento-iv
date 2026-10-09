import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDb } from '../../server/db/db.ts';
import {
  COMPANY_NAME,
  type BusinessProduct,
  type Organization,
  type WorkspaceSettings,
} from '../../shared/types.ts';
import { ECOSYSTEM_PRODUCT_NAMES } from '../../shared/billing-presets.ts';

const ECOSYSTEM = 'pipeline2-ecosystem';
function filenameFor(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venturecore-v4-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'workspace.sqlite');
}
function rows<T>(db: DatabaseSync, table: string): T[] {
  return (db.prepare(`SELECT data FROM ${table} ORDER BY id`).all() as { data: string }[]).map(
    (row) => JSON.parse(row.data) as T,
  );
}
function v3Fixture(filename: string) {
  const db = initDb(filename);
  db.exec('DELETE FROM business_products; DROP TABLE workspace_settings; PRAGMA user_version = 3');
  for (const organization of rows<Organization>(db, 'organizations')) {
    delete organization.billingProfile;
    delete organization.enableProductSelection;
    db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(
      JSON.stringify(organization),
      organization.id,
    );
  }
  return db;
}

test('v4 seeds ten business identities without prices and assigns all six organization billing profiles', () => {
  const db = initDb(':memory:');
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
    assert.deepEqual(rows<WorkspaceSettings>(db, 'workspace_settings'), [
      { companyName: COMPANY_NAME, dashboardLogoUrl: '' },
    ]);
    const products = rows<BusinessProduct>(db, 'business_products');
    assert.equal(products.length, 10);
    assert.deepEqual(products.map((product) => product.name).sort(), [...ECOSYSTEM_PRODUCT_NAMES].sort());
    for (const [index, name] of ECOSYSTEM_PRODUCT_NAMES.entries()) {
      const product = products.find((item) => item.name === name)!;
      assert.equal(product.id, `ecosystem-product-${index + 1}`);
      assert.equal(product.organizationId, ECOSYSTEM);
      assert.equal(product.code, '');
      assert.equal(product.description, '');
      assert.equal(product.logoUrl, '');
      assert.equal(product.active, true);
      assert.ok(product.createdAt && product.updatedAt);
      assert.equal('rate' in product, false);
      assert.equal('price' in product, false);
    }
    assert.deepEqual(rows(db, 'catalog'), []);
    const organizations = rows<Organization>(db, 'organizations');
    assert.deepEqual(
      Object.fromEntries(organizations.map((organization) => [organization.id, organization.billingProfile])),
      {
        'at-elevators': 'elevator',
        'at-facilities': 'facility',
        'ingenio-space': 'space',
        'pipeline2-ecosystem': 'ecosystem',
        'pipeline2-legal': 'legal',
        'shri-sarraf': 'jewellery',
      },
    );
    assert.ok(
      organizations.every(
        (organization) => organization.enableProductSelection === (organization.id === ECOSYSTEM),
      ),
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('v4 keeps dashboard identity separate and preserves custom organization settings and documents exactly', (t) => {
  const filename = filenameFor(t);
  const oldDb = v3Fixture(filename);
  const organization = rows<Organization>(oldDb, 'organizations').find((item) => item.id === ECOSYSTEM)!;
  const customized: Organization = {
    ...organization,
    logoUrl: 'data:image/png;base64,ORGANIZATION',
    billingProfile: 'general',
    enableProductSelection: false,
    terms: 'Preserve agreed terms',
  };
  oldDb.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(JSON.stringify(customized), ECOSYSTEM);
  oldDb
    .prepare('INSERT INTO customers (id, organization_id, data) VALUES (?, ?, ?)')
    .run('historical-customer', ECOSYSTEM, JSON.stringify({ name: 'Historical customer' }));
  const historical = JSON.stringify({
    id: 'historical-invoice',
    organizationSnapshot: customized,
    customerSnapshot: { name: 'Old customer' },
    formatSnapshot: { logoUrl: 'data:image/png;base64,FORMAT' },
    totals: { total: 500 },
    amountPaid: 200,
    balanceDue: 300,
    finalizedAt: null,
  });
  oldDb
    .prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)')
    .run('historical-invoice', ECOSYSTEM, 'historical-customer', 'invoice', 'OLD/1', historical);
  oldDb.close();
  const migrated = initDb(filename);
  try {
    assert.deepEqual(rows<WorkspaceSettings>(migrated, 'workspace_settings'), [
      { companyName: COMPANY_NAME, dashboardLogoUrl: '' },
    ]);
    assert.deepEqual(
      rows<Organization>(migrated, 'organizations').find((item) => item.id === ECOSYSTEM),
      customized,
    );
    assert.equal(
      (
        migrated.prepare('SELECT data FROM documents WHERE id = ?').get('historical-invoice') as {
          data: string;
        }
      ).data,
      historical,
    );
    assert.equal(rows<BusinessProduct>(migrated, 'business_products').length, 10);
  } finally {
    migrated.close();
  }
});

test('v4 reuses existing product names, handles ID collisions, and never replaces saved workspace identity', (t) => {
  const filename = filenameFor(t);
  const oldDb = v3Fixture(filename);
  const oldTimestamp = '2025-01-02T03:04:05.000Z';
  const existing: BusinessProduct = {
    id: 'custom-legal-product',
    organizationId: ECOSYSTEM,
    name: '  pirento LEGAL  ',
    code: 'CUSTOM',
    description: 'Saved description',
    logoUrl: 'data:image/png;base64,PRODUCT',
    active: false,
    createdAt: oldTimestamp,
    updatedAt: oldTimestamp,
  };
  const collision: BusinessProduct = {
    ...existing,
    id: 'ecosystem-product-2',
    organizationId: 'pipeline2-legal',
    name: 'Other organization product',
  };
  for (const product of [existing, collision])
    oldDb
      .prepare('INSERT INTO business_products VALUES (?, ?, ?, ?)')
      .run(product.id, product.organizationId, product.code, JSON.stringify(product));
  const settings: WorkspaceSettings = {
    companyName: 'Existing workspace label',
    dashboardLogoUrl: 'data:image/png;base64,DASHBOARD',
  };
  oldDb.exec('CREATE TABLE workspace_settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)');
  oldDb.prepare('INSERT INTO workspace_settings VALUES (1, ?)').run(JSON.stringify(settings));
  oldDb.close();
  const migrated = initDb(filename);
  try {
    const products = rows<BusinessProduct>(migrated, 'business_products');
    assert.equal(products.filter((product) => product.organizationId === ECOSYSTEM).length, 10);
    assert.deepEqual(
      products.find((product) => product.id === existing.id),
      existing,
    );
    assert.deepEqual(
      products.find((product) => product.id === collision.id),
      collision,
    );
    const vault = products.find((product) => product.name === 'PIRENTO vault')!;
    assert.ok(vault);
    assert.notEqual(vault.id, collision.id);
    assert.match(vault.id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(rows<WorkspaceSettings>(migrated, 'workspace_settings'), [settings]);
  } finally {
    migrated.close();
  }
});

test('v4 runs once, preserving renamed, archived and removed products on repeated startup', (t) => {
  const filename = filenameFor(t);
  const oldDb = v3Fixture(filename);
  oldDb.close();
  const migrated = initDb(filename);
  const products = rows<BusinessProduct>(migrated, 'business_products');
  const changed = {
    ...products[0],
    name: 'Our renamed product',
    active: false,
    logoUrl: 'data:image/png;base64,NEW',
  };
  migrated
    .prepare('UPDATE business_products SET data = ? WHERE id = ?')
    .run(JSON.stringify(changed), changed.id);
  migrated.prepare('DELETE FROM business_products WHERE id = ?').run(products[1].id);
  const savedProducts = rows<BusinessProduct>(migrated, 'business_products');
  migrated.close();
  for (let start = 0; start < 2; start++) {
    const repeated = initDb(filename);
    try {
      assert.deepEqual(rows<BusinessProduct>(repeated, 'business_products'), savedProducts);
      assert.equal(rows<BusinessProduct>(repeated, 'business_products').length, 9);
      assert.deepEqual(repeated.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      repeated.close();
    }
  }
});

test('business product codes are unique per organization and workspace settings allow one row', () => {
  const db = initDb(':memory:');
  try {
    const insert = db.prepare('INSERT INTO business_products VALUES (?, ?, ?, ?)');
    insert.run('a', ECOSYSTEM, 'APP', '{}');
    assert.throws(() => insert.run('b', ECOSYSTEM, 'app', '{}'), /UNIQUE constraint/);
    insert.run('c', 'pipeline2-legal', 'app', '{}');
    insert.run('d', ECOSYSTEM, '', '{}');
    insert.run('e', ECOSYSTEM, '', '{}');
    assert.throws(() => insert.run('f', 'missing', '', '{}'), /FOREIGN KEY constraint/);
    assert.throws(
      () => db.prepare('INSERT INTO workspace_settings VALUES (?, ?)').run(2, '{}'),
      /CHECK constraint/,
    );
    assert.throws(
      () => db.prepare('INSERT INTO workspace_settings VALUES (?, ?)').run(1, '{}'),
      /UNIQUE constraint/,
    );
  } finally {
    db.close();
  }
});
