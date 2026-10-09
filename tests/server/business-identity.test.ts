import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initDb } from '../../server/db/db.ts';
import { documentSchema, organizationSchema } from '../../server/validation/validation.ts';
import { COMPANY_NAME, type Organization } from '../../shared/types.ts';

const SOURCE = 'pipeline2-legal';
const SHRI = 'shri-sarraf';
function read(db: DatabaseSync, id: string): Organization {
  return JSON.parse(
    (db.prepare('SELECT data FROM organizations WHERE id = ?').get(id) as { data: string }).data,
  ) as Organization;
}
function save(db: DatabaseSync, organization: Organization) {
  db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(
    JSON.stringify(organization),
    organization.id,
  );
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venturecore-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  const db = initDb(filename);
  for (const row of db.prepare('SELECT id FROM organizations').all() as { id: string }[]) {
    const organization = read(db, row.id);
    delete organization.businessType;
    delete organization.paymentGateway;
    delete organization.supportEmail;
    delete organization.gstRegistrations;
    if (row.id === SHRI) organization.legalName = COMPANY_NAME;
    save(db, organization);
  }
  db.exec('PRAGMA user_version = 4');
  return { db, filename };
}

test('v5 separates copied Shri identity and payments without changing historical documents or another organization', (t) => {
  const { db, filename } = fixture(t);
  const source: Organization = {
    ...read(db, SOURCE),
    gstin: '27AAPFU0939F1ZV',
    pan: 'AAPFU0939F',
    stateCode: '27',
    address: 'Example company office',
    email: 'accounts@company.example',
    phone: '1111111111',
    bankName: 'Example bank',
    accountName: COMPANY_NAME,
    accountNumber: '1234567890',
    ifsc: 'TEST0001234',
    bankBranch: 'Example branch',
    accountType: 'Current',
    paymentQrUrl: 'https://example.test/company-qr.png',
    signature: 'Company director',
    signatureImageUrl: 'https://example.test/company-signature.png',
    terms: 'Company agreement',
    gstRegistrations: [
      {
        id: 'company-up',
        label: 'UP registration',
        gstin: '09AAPFU0939F1ZT',
        stateCode: '09',
        address: 'Company UP office',
      },
    ],
  };
  save(db, source);
  const shri: Organization = {
    ...source,
    id: SHRI,
    name: 'Shri Sarraf',
    invoicePrefix: 'SSRI',
    quotationPrefix: 'SSRQ',
    logoUrl: 'https://example.test/shri-logo.png',
    secondarySignatureImageUrl: 'https://example.test/independent-signature.png',
  };
  save(db, shri);
  db.prepare('INSERT INTO customers VALUES (?, ?, ?)').run(
    'historic-buyer',
    SHRI,
    JSON.stringify({ name: 'Existing buyer' }),
  );
  const historical = JSON.stringify({
    id: 'historic-invoice',
    organizationSnapshot: shri,
    totals: { total: 1200 },
    amountPaid: 1200,
    balanceDue: 0,
    finalizedAt: '2026-01-01T00:00:00.000Z',
  });
  db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)').run(
    'historic-invoice',
    SHRI,
    'historic-buyer',
    'invoice',
    'OLD/2026/1',
    historical,
  );
  db.close();
  const upgraded = initDb(filename);
  try {
    const organization = read(upgraded, SHRI);
    assert.equal(organization.legalName, 'Shri Sarraf');
    assert.equal(organization.businessType, 'independent');
    assert.equal(organization.paymentGateway, 'cashfree');
    assert.equal(organization.supportEmail, 'support@shrisarraf.com');
    for (const key of [
      'gstin',
      'pan',
      'stateCode',
      'address',
      'email',
      'phone',
      'bankName',
      'accountName',
      'accountNumber',
      'ifsc',
      'bankBranch',
      'accountType',
      'paymentQrUrl',
      'signature',
      'signatureImageUrl',
      'terms',
    ] as const)
      assert.equal(organization[key], '', `${key} must not retain inherited company data`);
    assert.deepEqual(organization.gstRegistrations, []);
    assert.equal(organization.logoUrl, shri.logoUrl);
    assert.equal(organization.secondarySignatureImageUrl, shri.secondarySignatureImageUrl);
    assert.deepEqual(read(upgraded, SOURCE), {
      ...source,
      businessType: 'division',
      paymentGateway: 'razorpay',
      supportEmail: 'support@pirento.com',
    });
    assert.equal(
      (
        upgraded.prepare('SELECT data FROM documents WHERE id = ?').get('historic-invoice') as {
          data: string;
        }
      ).data,
      historical,
    );
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgraded.close();
  }
});

test('v5 preserves custom independent identity, bank account and QR even when a state or branch matches Venturecore', (t) => {
  const { db, filename } = fixture(t);
  const source: Organization = {
    ...read(db, SOURCE),
    gstin: '09AAPFU0939F1ZT',
    pan: 'AAPFU0939F',
    stateCode: '09',
    bankName: 'Shared bank',
    accountName: COMPANY_NAME,
    accountNumber: '1111111111',
    ifsc: 'TEST0001234',
    bankBranch: 'Shared branch',
    accountType: 'Current',
  };
  save(db, source);
  const customized: Organization = {
    ...read(db, SHRI),
    legalName: 'Independent proprietor',
    tradeName: 'Independent jewellers',
    gstin: '09AABCU9603R1ZL',
    pan: 'AABCU9603R',
    stateCode: '09',
    address: 'Independent shop',
    bankName: 'Shared bank',
    accountName: 'Independent proprietor',
    accountNumber: '2222222222',
    ifsc: 'TEST0001234',
    bankBranch: 'Shared branch',
    accountType: 'Current',
    paymentQrUrl: 'https://example.test/own-qr.png',
    signatureImageUrl: 'https://example.test/own-signature.png',
    email: 'accounts@jewellers.example',
    gstRegistrations: [
      {
        id: 'own-ka',
        label: 'Karnataka branch',
        gstin: '29AABCU9603R1ZJ',
        stateCode: '29',
        address: 'Independent branch',
      },
    ],
  };
  save(db, customized);
  db.close();
  const upgraded = initDb(filename);
  const expected: Organization = {
    ...customized,
    businessType: 'independent',
    paymentGateway: 'cashfree',
    supportEmail: 'support@shrisarraf.com',
  };
  try {
    assert.deepEqual(read(upgraded, SHRI), expected);
  } finally {
    upgraded.close();
  }
  const restarted = initDb(filename);
  try {
    save(restarted, { ...expected, supportEmail: 'changed@jewellers.example', paymentGateway: 'none' });
  } finally {
    restarted.close();
  }
  const again = initDb(filename);
  try {
    assert.deepEqual(read(again, SHRI), {
      ...expected,
      supportEmail: 'changed@jewellers.example',
      paymentGateway: 'none',
    });
  } finally {
    again.close();
  }
});

test('fresh workspace seeds five Venturecore divisions and one empty independent Shri business', () => {
  const db = initDb(':memory:');
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
    const shri = read(db, SHRI);
    assert.equal(shri.legalName, 'Shri Sarraf');
    assert.equal(shri.paymentGateway, 'cashfree');
    assert.equal(shri.supportEmail, 'support@shrisarraf.com');
    for (const key of [
      'gstin',
      'address',
      'email',
      'phone',
      'bankName',
      'accountName',
      'accountNumber',
      'ifsc',
      'signature',
    ] as const)
      assert.equal(shri[key], '');
    assert.equal(shri.paymentQrUrl || '', '');
    assert.equal(organizationSchema.safeParse(shri).success, true);
    for (const row of db.prepare('SELECT id FROM organizations WHERE id != ?').all(SHRI) as {
      id: string;
    }[]) {
      const organization = read(db, row.id);
      assert.equal(organization.legalName, COMPANY_NAME);
      assert.equal(organization.businessType, 'division');
      assert.equal(organization.paymentGateway, 'razorpay');
      assert.equal(organization.supportEmail, 'support@pirento.com');
    }
  } finally {
    db.close();
  }
});

test('business validation accepts independent legal names and normalizes GST registrations while rejecting invalid identity combinations', () => {
  const db = initDb(':memory:');
  const organization = {
    ...read(db, SHRI),
    legalName: '  Independent Proprietor  ',
    tradeName: 'Independent shop',
    businessConstitution: 'Proprietorship',
    pan: 'AAPFU0939F',
    gstin: '27AAPFU0939F1ZV',
    stateCode: '27',
    gstRegistrations: [
      {
        id: 'up',
        label: 'Uttar Pradesh',
        gstin: '09aapfu0939f1zt',
        stateCode: '09',
        address: 'Shop address',
      },
    ],
  };
  db.close();
  const parsed = organizationSchema.parse(organization);
  assert.equal(parsed.legalName, 'Independent Proprietor');
  assert.equal(parsed.gstRegistrations?.[0].gstin, '09AAPFU0939F1ZT');
  const invalid = (change: object, message: RegExp) => {
    const result = organizationSchema.safeParse({ ...organization, ...change });
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  };
  invalid({ legalName: ' ' }, /required/);
  invalid({ supportEmail: 'not-an-email' }, /email/);
  invalid({ paymentGateway: 'unknown' }, /Invalid enum/);
  invalid({ pan: 'AABCU9603R' }, /PAN/);
  invalid(
    { gstRegistrations: [{ ...organization.gstRegistrations[0], stateCode: '27' }] },
    /State must match/,
  );
  invalid(
    { gstRegistrations: [{ ...organization.gstRegistrations[0], gstin: '09AAPFU0939F1ZA' }] },
    /check digit/,
  );
  invalid(
    {
      gstRegistrations: [{ ...organization.gstRegistrations[0], gstin: '27AAPFU0939F1ZV', stateCode: '27' }],
    },
    /different GSTIN/,
  );
  invalid(
    {
      gstRegistrations: [
        organization.gstRegistrations[0],
        { ...organization.gstRegistrations[0], gstin: '07AAPFU0939F1ZX', stateCode: '07' },
      ],
    },
    /unique ID/,
  );
  invalid(
    {
      gstRegistrations: [{ ...organization.gstRegistrations[0], gstin: '29AABCU9603R1ZJ', stateCode: '29' }],
    },
    /same legal business PAN/,
  );
  invalid(
    {
      pan: '',
      gstin: '',
      stateCode: '',
      gstRegistrations: [
        organization.gstRegistrations[0],
        { id: 'ka', label: 'Karnataka', gstin: '29AABCU9603R1ZJ', stateCode: '29', address: '' },
      ],
    },
    /same legal business PAN/,
  );
  invalid(
    {
      gstRegistrations: Array.from({ length: 21 }, (_, index) => ({
        ...organization.gstRegistrations[0],
        id: String(index),
      })),
    },
    /at most 20/,
  );
});

test('document validation retains a selected seller GST registration or an explicit default selection', () => {
  const input = {
    organizationId: SOURCE,
    customerId: 'buyer',
    kind: 'invoice',
    status: 'draft',
    issueDate: '2026-10-08',
    dueDate: '',
    title: 'Invoice',
    items: [{ description: 'Service', hsn: '', quantity: 1, rate: 100, gstRate: 18 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
  };
  assert.equal(documentSchema.parse({ ...input, gstRegistrationId: 'up' }).gstRegistrationId, 'up');
  assert.equal(documentSchema.parse({ ...input, gstRegistrationId: '' }).gstRegistrationId, '');
  assert.equal(documentSchema.parse(input).gstRegistrationId, undefined);
  assert.equal(documentSchema.safeParse({ ...input, gstRegistrationId: 'a'.repeat(101) }).success, false);
});
