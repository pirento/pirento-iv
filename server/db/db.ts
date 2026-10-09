import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  COMPANY_NAME,
  defaultFormatFor,
  type BusinessDocument,
  type BusinessProduct,
  type DocumentEvent,
  type InvoiceFormat,
  type Organization,
  type PaymentRecord,
  type WorkspaceSettings,
} from '../../shared/types.ts';
import { presetFormatsFor } from '../../shared/template-presets.ts';
import { billingProfileFor, ECOSYSTEM_PRODUCT_NAMES } from '../../shared/billing-presets.ts';
import { LEGAL_NAME } from '../validation/validation.ts';

export function initDb(filename = '.data/workspace.sqlite') {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customers_organization ON customers(organization_id);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      kind TEXT NOT NULL CHECK(kind IN ('invoice', 'quotation', 'proforma', 'delivery_note')),
      number TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_organization ON documents(organization_id, kind);
    CREATE INDEX IF NOT EXISTS documents_customer ON documents(customer_id);
    CREATE TABLE IF NOT EXISTS sequences (
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      kind TEXT NOT NULL,
      fiscal_year TEXT NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY(organization_id, kind, fiscal_year)
    );
    CREATE TABLE IF NOT EXISTS catalog (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      sku TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_organization ON catalog(organization_id);
    CREATE UNIQUE INDEX IF NOT EXISTS catalog_sku ON catalog(organization_id, sku COLLATE NOCASE) WHERE sku != '';
    CREATE TABLE IF NOT EXISTS formats (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      is_default INTEGER NOT NULL CHECK(is_default IN (0, 1)),
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS formats_organization ON formats(organization_id);
    CREATE UNIQUE INDEX IF NOT EXISTS formats_one_default ON formats(organization_id) WHERE is_default = 1;
  `);
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version < 2) {
    const brands = [
      ['pipeline2-legal', 'Pirento legal', 'P2LI', 'P2LQ', '#587bcb'],
      ['pipeline2-ecosystem', 'Pirento ecosystem', 'P2EI', 'P2EQ', '#8265e5'],
      ['at-facilities', 'AT Facility', 'ATFI', 'ATFQ', '#17816e'],
      ['at-elevators', 'A T Elevator', 'ATEI', 'ATEQ', '#d39347'],
      ['ingenio-space', 'INZARIO SPACE', 'INSI', 'INSQ', '#a261ae'],
      ['shri-sarraf', 'Shri Sarraf', 'SSRI', 'SSRQ', '#ad852b'],
    ];
    transaction(db, () => {
      // Save historical appearance from each document's own issuer snapshot before
      // changing live company settings. Financial and customer snapshots stay intact.
      for (const row of db.prepare('SELECT id, data FROM documents').all() as {
        id: string;
        data: string;
      }[]) {
        const document = JSON.parse(row.data) as BusinessDocument;
        if (!document.formatSnapshot) {
          const snapshot = {
            ...defaultFormatFor(document.organizationSnapshot),
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
          };
          db.prepare('UPDATE documents SET data = ? WHERE id = ?').run(
            JSON.stringify({ ...document, formatId: snapshot.id, formatSnapshot: snapshot }),
            row.id,
          );
        }
      }
      const existing = (db.prepare('SELECT data FROM organizations').all() as { data: string }[]).map(
        (row) => JSON.parse(row.data) as Organization,
      );
      const reserved = new Set(existing.flatMap((org) => [org.invoicePrefix, org.quotationPrefix]));
      for (const row of db.prepare('SELECT number FROM documents').all() as { number: string }[])
        reserved.add(row.number.split('/')[0]);
      function availablePrefix(preferred: string) {
        let candidate = preferred;
        let suffix = 0;
        while (reserved.has(candidate)) {
          suffix++;
          const serial = suffix.toString(36).toUpperCase();
          if (serial.length > 4)
            throw new Error('No available document prefixes for organization migration.');
          candidate = preferred.slice(0, 4 - serial.length) + serial;
        }
        reserved.add(candidate);
        return candidate;
      }
      const names = new Map(brands.map(([id, name]) => [id, name]));
      for (const organization of existing) {
        const updated = {
          ...organization,
          legalName:
            organization.id === 'shri-sarraf' && organization.legalName !== LEGAL_NAME
              ? organization.legalName
              : LEGAL_NAME,
          name: names.get(organization.id) ?? organization.name,
        };
        db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(
          JSON.stringify(updated),
          organization.id,
        );
      }
      for (const [id, name, invoicePrefix, quotationPrefix, accentColor] of brands) {
        if (existing.some((org) => org.id === id)) continue;
        // The six starting organizations are installed once, so subsequent restarts
        // preserve user changes and do not re-create intentionally removed data.
        const organization: Organization = {
          id,
          name,
          legalName: id === 'shri-sarraf' ? 'Shri Sarraf' : LEGAL_NAME,
          businessType: id === 'shri-sarraf' ? 'independent' : 'division',
          paymentGateway: id === 'shri-sarraf' ? 'cashfree' : 'razorpay',
          supportEmail: id === 'shri-sarraf' ? 'support@shrisarraf.com' : 'support@pirento.com',
          gstRegistrations: [],
          invoicePrefix: availablePrefix(invoicePrefix),
          quotationPrefix: availablePrefix(quotationPrefix),
          accentColor,
          gstin: '',
          email: '',
          phone: '',
          address: '',
          stateCode: '',
          logoUrl: '',
          bankName: '',
          accountName: '',
          accountNumber: '',
          ifsc: '',
          terms: '',
          signature: '',
          template: 'modern',
        };
        db.prepare('INSERT INTO organizations (id, data) VALUES (?, ?)').run(
          id,
          JSON.stringify(organization),
        );
      }
      const organizations = (db.prepare('SELECT data FROM organizations').all() as { data: string }[]).map(
        (row) => JSON.parse(row.data) as Organization,
      );
      for (const organization of organizations) {
        const count = db
          .prepare('SELECT COUNT(*) AS count FROM formats WHERE organization_id = ?')
          .get(organization.id) as { count: number };
        if (count.count === 0) {
          // Keep pre-catalog organization styling when upgrading older workspaces.
          const timestamp = new Date().toISOString();
          const format = { ...defaultFormatFor(organization), createdAt: timestamp, updatedAt: timestamp };
          db.prepare('INSERT INTO formats (id, organization_id, is_default, data) VALUES (?, ?, 1, ?)').run(
            format.id,
            organization.id,
            JSON.stringify(format),
          );
        }
      }
      db.exec('PRAGMA user_version = 2');
    });
  }
  if (version.user_version < 3) {
    try {
      migrateV3(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  if (version.user_version < 4) {
    try {
      migrateV4(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  if (version.user_version < 5) {
    try {
      migrateV5(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return db;
}

export function seedDefaultFormat(
  db: DatabaseSync,
  organization: Organization,
  timestamp = new Date().toISOString(),
) {
  const rows = db
    .prepare('SELECT id, is_default, data FROM formats WHERE organization_id = ?')
    .all(organization.id) as { id: string; is_default: number; data: string }[];
  const formats = rows.map((row) => ({
    ...(JSON.parse(row.data) as InvoiceFormat),
    isDefault: row.is_default === 1,
  }));
  let defaultFormat = formats.find((format) => format.isDefault);
  for (const preset of presetFormatsFor(organization, timestamp)) {
    if (formats.some((format) => format.presetKey === preset.presetKey)) continue;
    // The original Standard format may already be customized or snapshotted.
    // Identify its preset without changing its appearance, ID or default status.
    const originalStandard =
      preset.presetKey === 'standard' &&
      formats.find((format) => format.id === `${organization.id}-standard` && !format.presetKey);
    if (originalStandard) {
      originalStandard.presetKey = 'standard';
      db.prepare('UPDATE formats SET data = ? WHERE id = ?').run(
        JSON.stringify(originalStandard),
        originalStandard.id,
      );
      continue;
    }
    let id = preset.id;
    let suffix = 1;
    while (db.prepare('SELECT id FROM formats WHERE id = ?').get(id)) id = `${preset.id}-${++suffix}`;
    const format = { ...preset, id, isDefault: !defaultFormat };
    db.prepare('INSERT INTO formats (id, organization_id, is_default, data) VALUES (?, ?, ?, ?)').run(
      id,
      organization.id,
      Number(format.isDefault),
      JSON.stringify(format),
    );
    formats.push(format);
    if (format.isDefault) defaultFormat = format;
  }
  if (!defaultFormat) {
    defaultFormat = formats.find((format) => format.presetKey === 'standard') ?? formats[0];
    defaultFormat.isDefault = true;
    db.prepare('UPDATE formats SET is_default = 1, data = ? WHERE id = ?').run(
      JSON.stringify(defaultFormat),
      defaultFormat.id,
    );
  }
  return defaultFormat;
}

function migrateV3(db: DatabaseSync) {
  // SQLite CHECK constraints require a rebuild. Disable FK enforcement outside
  // the transaction so existing dependent tables remain attached to documents.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE documents_v3 (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          customer_id TEXT NOT NULL REFERENCES customers(id),
          kind TEXT NOT NULL CHECK(kind IN ('invoice', 'quotation', 'proforma', 'delivery_note')),
          number TEXT NOT NULL UNIQUE,
          data TEXT NOT NULL
        );
        INSERT INTO documents_v3 (id, organization_id, customer_id, kind, number, data)
          SELECT id, organization_id, customer_id, kind, number, data FROM documents;
        DROP TABLE documents;
        ALTER TABLE documents_v3 RENAME TO documents;
        CREATE INDEX documents_organization ON documents(organization_id, kind);
        CREATE INDEX documents_customer ON documents(customer_id);
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          request_id TEXT NOT NULL,
          amount_paise INTEGER NOT NULL CHECK(typeof(amount_paise) = 'integer' AND amount_paise > 0),
          data TEXT NOT NULL,
          UNIQUE(document_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS payments_document ON payments(document_id);
        CREATE INDEX IF NOT EXISTS payments_organization ON payments(organization_id);
        CREATE TABLE IF NOT EXISTS document_events (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id),
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS document_events_document ON document_events(document_id);
      `);
      const timestamp = new Date().toISOString();
      const organizations = db.prepare('SELECT data FROM organizations').all() as { data: string }[];
      for (const row of organizations) seedDefaultFormat(db, JSON.parse(row.data) as Organization, timestamp);
      const documents = db.prepare('SELECT id, data FROM documents').all() as { id: string; data: string }[];
      for (const row of documents) {
        const document = JSON.parse(row.data) as BusinessDocument;
        const totalPaise = Math.round((document.totals.total + Number.EPSILON) * 100);
        if (!Number.isSafeInteger(totalPaise) || totalPaise < 0)
          throw new Error(`Cannot migrate invalid total for document ${row.id}.`);
        const legacyPaid =
          document.kind === 'invoice' && document.status === 'paid' && document.amountPaid === undefined;
        if (legacyPaid) {
          const requestId = `legacy-paid-${document.id}`;
          if (
            totalPaise > 0 &&
            !db
              .prepare('SELECT id FROM payments WHERE document_id = ? AND request_id = ?')
              .get(document.id, requestId)
          ) {
            const payment: PaymentRecord = {
              id: randomUUID(),
              documentId: document.id,
              organizationId: document.organizationId,
              amount: totalPaise / 100,
              paidOn: document.issueDate,
              method: 'other',
              reference: 'Legacy paid status',
              notes:
                'Imported from the previous invoice paid status. No payment proof, method or actual payment date was recorded; the invoice issue date is used as a migration placeholder.',
              requestId,
              finalizeWhenPaid: true,
              createdAt: document.updatedAt,
              voidedAt: null,
              voidReason: '',
            };
            db.prepare(
              'INSERT INTO payments (id, document_id, organization_id, request_id, amount_paise, data) VALUES (?, ?, ?, ?, ?, ?)',
            ).run(
              payment.id,
              document.id,
              document.organizationId,
              requestId,
              totalPaise,
              JSON.stringify(payment),
            );
          }
          const event: DocumentEvent = {
            id: randomUUID(),
            documentId: document.id,
            at: timestamp,
            type: 'legacy_payment_migrated',
            description:
              totalPaise > 0
                ? 'Imported a synthetic payment from the legacy paid status and preserved the invoice as finalized. No payment proof or actual payment date was originally recorded.'
                : 'Preserved the legacy paid status and finalized state for a zero-total invoice. No payment entry was needed; no payment proof was originally recorded.',
          };
          db.prepare('INSERT INTO document_events (id, document_id, data) VALUES (?, ?, ?)').run(
            event.id,
            document.id,
            JSON.stringify(event),
          );
        }
        const amountPaid =
          document.kind === 'invoice' ? (document.amountPaid ?? (legacyPaid ? totalPaise / 100 : 0)) : 0;
        const updated: BusinessDocument = {
          ...document,
          amountPaid,
          balanceDue:
            document.kind === 'invoice'
              ? (document.balanceDue ?? Math.max(0, totalPaise - Math.round(amountPaid * 100)) / 100)
              : 0,
          finalizedAt:
            document.finalizedAt !== undefined
              ? document.finalizedAt
              : legacyPaid
                ? document.updatedAt
                : null,
        };
        db.prepare('UPDATE documents SET data = ? WHERE id = ?').run(JSON.stringify(updated), row.id);
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length)
        throw new Error('Cannot migrate workspace: existing foreign-key relationships are invalid.');
      db.exec('PRAGMA user_version = 3');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function migrateV4(db: DatabaseSync) {
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_products (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        code TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS business_products_organization ON business_products(organization_id);
      CREATE UNIQUE INDEX IF NOT EXISTS business_products_code ON business_products(organization_id, code COLLATE NOCASE) WHERE code != '';
    `);
    // Workspace identity has its own logo. An organization's invoice branding
    // must never become the dashboard logo as a side effect of migration.
    const settings: WorkspaceSettings = { companyName: COMPANY_NAME, dashboardLogoUrl: '' };
    db.prepare('INSERT OR IGNORE INTO workspace_settings (id, data) VALUES (1, ?)').run(
      JSON.stringify(settings),
    );
    for (const row of db.prepare('SELECT id, data FROM organizations').all() as {
      id: string;
      data: string;
    }[]) {
      const organization = JSON.parse(row.data) as Organization;
      const billingProfile = organization.billingProfile ?? billingProfileFor(organization);
      const updated: Organization = {
        ...organization,
        billingProfile,
        enableProductSelection: organization.enableProductSelection ?? billingProfile === 'ecosystem',
      };
      db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(JSON.stringify(updated), row.id);
    }
    // These are business-product identities, not billable catalog items. Prices
    // and services are entered separately by the user for each product.
    const organizationId = 'pipeline2-ecosystem';
    if (db.prepare('SELECT id FROM organizations WHERE id = ?').get(organizationId)) {
      const existing = (
        db.prepare('SELECT data FROM business_products WHERE organization_id = ?').all(organizationId) as {
          data: string;
        }[]
      ).map((row) => JSON.parse(row.data) as BusinessProduct);
      const names = new Set(existing.map((product) => product.name.trim().toLowerCase()));
      const timestamp = new Date().toISOString();
      for (const [index, name] of ECOSYSTEM_PRODUCT_NAMES.entries()) {
        if (names.has(name.trim().toLowerCase())) continue;
        let id = `ecosystem-product-${index + 1}`;
        while (db.prepare('SELECT id FROM business_products WHERE id = ?').get(id)) id = randomUUID();
        const product: BusinessProduct = {
          id,
          organizationId,
          name,
          code: '',
          description: '',
          logoUrl: '',
          active: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        db.prepare('INSERT INTO business_products (id, organization_id, code, data) VALUES (?, ?, ?, ?)').run(
          id,
          organizationId,
          product.code,
          JSON.stringify(product),
        );
        names.add(name.trim().toLowerCase());
      }
    }
    db.exec('PRAGMA user_version = 4');
  });
}

function migrateV5(db: DatabaseSync) {
  transaction(db, () => {
    const organizations = (
      db.prepare('SELECT id, data FROM organizations').all() as { id: string; data: string }[]
    ).map((row) => JSON.parse(row.data) as Organization);
    const companySources = organizations.filter(
      (organization) =>
        organization.id !== 'shri-sarraf' &&
        organization.businessType !== 'independent' &&
        organization.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase(),
    );
    for (const organization of organizations) {
      const updated: Organization = {
        ...organization,
        businessType: organization.businessType ?? 'division',
        paymentGateway: organization.paymentGateway ?? 'razorpay',
        supportEmail: organization.supportEmail ?? 'support@pirento.com',
        gstRegistrations: organization.gstRegistrations ?? [],
      };
      if (organization.id === 'shri-sarraf') {
        updated.businessType = 'independent';
        updated.paymentGateway = 'cashfree';
        updated.supportEmail = 'support@shrisarraf.com';
        if (updated.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase())
          updated.legalName = 'Shri Sarraf';
        // Remove only values that can be identified as copies of another live
        // Venturecore organization. Distinct business details are never replaced.
        const inherited = (key: keyof Organization) =>
          typeof organization[key] === 'string' &&
          organization[key] !== '' &&
          companySources.some((source) => source[key] === organization[key]);
        const ownGstin = Boolean(organization.gstin) && !inherited('gstin');
        const ownBankAccount = Boolean(organization.accountNumber) && !inherited('accountNumber');
        const bankKeys = new Set<keyof Organization>([
          'bankName',
          'accountName',
          'accountNumber',
          'ifsc',
          'bankBranch',
          'accountType',
        ]);
        const copiedKeys = [
          'tradeName',
          'businessConstitution',
          'gstin',
          'pan',
          'cin',
          'email',
          'phone',
          'address',
          'stateCode',
          'bankName',
          'accountName',
          'accountNumber',
          'ifsc',
          'bankBranch',
          'accountType',
          'paymentQrUrl',
          'signature',
          'signatureImageUrl',
          'secondarySignatureLabel',
          'secondarySignatureImageUrl',
          'stampLabel',
          'stampImageUrl',
          'terms',
        ] as const;
        for (const key of copiedKeys) {
          // A custom GSTIN/account can legitimately share a state or bank branch.
          if ((key === 'stateCode' && ownGstin) || (bankKeys.has(key) && ownBankAccount)) continue;
          if (inherited(key)) updated[key] = '';
        }
        const companyGstins = new Set(
          companySources
            .flatMap((source) => [
              source.gstin,
              ...(source.gstRegistrations || []).map((registration) => registration.gstin),
            ])
            .filter(Boolean),
        );
        updated.gstRegistrations = (organization.gstRegistrations || []).filter(
          (registration) => !companyGstins.has(registration.gstin),
        );
      }
      db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(
        JSON.stringify(updated),
        organization.id,
      );
    }
    // Historical organization snapshots, payment accounts and document totals
    // are deliberately untouched. This migration affects future documents only.
    db.exec('PRAGMA user_version = 5');
  });
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
