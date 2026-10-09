import express, { type ErrorRequestHandler } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { businessDateInIndia } from '../shared/business-date.ts';
import { createAuth, type AuthOptions } from './auth/auth.ts';
import { createAccessGuard } from './auth/access.ts';
import { securityHeaders, validateResourceQueries } from './http/http-security.ts';
import { parseTrustedProxy } from './http/trusted-proxy.ts';
import type { AuthUser } from '../shared/auth-types.ts';
import { normalizeContact, isInvoiceRecipient } from './validation/contacts.ts';
import { createMailer, EmailQueueError } from './integrations/email/mailer.ts';
import { OnlinePaymentError } from './integrations/payments/online-payments.ts';
import { createPaymentGateways } from './integrations/payments/payment-gateways.ts';
import {
  integrationEnvironmentPrefix,
  isIndependentBusiness,
  organizationForRegistration,
  organizationGateway,
} from '../shared/business-identity.ts';
import { renderInvoiceAttachment } from './documents/invoice-pdf.ts';
import { existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  blankShipping,
  DOCUMENT_LABELS,
  calculateTotals,
  getDocumentFormat,
  type Organization,
  type Customer,
  type DocumentInput,
  type BusinessDocument,
  type CatalogItem,
  type CatalogInput,
  type InvoiceFormat,
  type PaymentRecord,
  type PaymentDetails,
  type DocumentEvent,
  type BusinessProduct,
  type BusinessProductInput,
  type InstallmentPlan,
  type WorkspaceSettings,
} from '../shared/types.ts';
import { billingProfileFor } from '../shared/billing-presets.ts';
import { initDb, seedDefaultFormat, transaction } from './db/db.ts';
import {
  organizationSchema,
  customerSchema,
  documentSchema,
  catalogSchema,
  formatSchema,
  paymentSchema,
  voidPaymentSchema,
  workspaceSettingsSchema,
  businessProductSchema,
  installmentPlanSchema,
  lookupResultSchema,
  validGstin,
} from './validation/validation.ts';
import { createGstPortal, PortalError, readLimited } from './integrations/gst/gst-portal.ts';
import { createSandboxGst, SandboxGstError } from './integrations/gst/sandbox-gst.ts';
import {
  createDatabaseBackupService,
  parseDatabaseBackupConfig,
  DatabaseBackupError,
} from './operations/database-backup.ts';
import { createBackupManager } from './operations/backup-scheduler.ts';
import { assertDatabaseRecoveryReviewed } from './operations/recovery.ts';
import {
  documentExportRows,
  getDocumentPage,
  getDocumentSummary,
  parseDocumentFilters,
} from './documents/document-list.ts';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type AppOptions = {
  auth?: false | AuthOptions;
  environment?: NodeJS.ProcessEnv;
  paymentFetch?: typeof globalThis.fetch;
  emailFetch?: typeof globalThis.fetch;
  db?: DatabaseSync;
  gstLookupUrl?: string;
  gstApiKey?: string;
  fetch?: typeof globalThis.fetch;
  distPath?: string;
  now?: () => Date;
};

type Row = { data: string };
const decode = <T>(row: Row) => JSON.parse(row.data) as T;

function fiscalYear(issueDate: string) {
  const year = Number(issueDate.slice(0, 4));
  const start = Number(issueDate.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
}

function configuredLookupUrl(template: string | undefined) {
  if (!template || !template.includes('{gstin}')) return undefined;
  try {
    const url = new URL(template.replaceAll('{gstin}', '27AAACR5055K1Z7'));
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return template;
  } catch {
    return undefined;
  }
}

export function createApp(options: AppOptions = {}) {
  const environment = options.environment ?? process.env;
  const trustedProxy = parseTrustedProxy(environment.TRUSTED_PROXY);
  const db = options.db ?? initDb(environment.DATABASE_PATH);
  assertDatabaseRecoveryReviewed(db);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustedProxy);
  app.use(securityHeaders(environment.NODE_ENV === 'production'));
  app.post(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res, next) => online.webhookHandler(req, res, next),
  );
  app.post(
    '/api/webhooks/razorpay/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res, next) => online.razorpayWebhookHandler(req, res, next),
  );
  app.post(
    '/api/webhooks/cashfree/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req, res, next) => online.cashfreeWebhookHandler(req, res, next),
  );
  app.use('/api', validateResourceQueries);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.get('Sec-Fetch-Site') === 'cross-site')
      return next(new HttpError(403, 'Cross-site API requests are not allowed.'));
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json'))
      return next(new HttpError(415, 'Send request data as application/json.'));
    next();
  });
  // Account forms contain no images. Reject oversized authentication bodies before
  // the broader invoice upload parser or password hashing receives them.
  app.use('/api/auth', express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '12mb' }));
  const lookupUrl = configuredLookupUrl(options.gstLookupUrl ?? environment.GST_LOOKUP_URL);
  const apiKey = options.gstApiKey ?? environment.GST_API_KEY;
  const fetcher = options.fetch ?? globalThis.fetch;
  const portal = createGstPortal(fetcher);
  const now = options.now ?? (() => new Date());
  const backupConfig = parseDatabaseBackupConfig(
    environment,
    db.location() ?? join(tmpdir(), `venture-memory-${randomUUID()}`, 'workspace.sqlite'),
  );
  for (const root of [
    options.distPath ?? resolve('dist'),
    ...['public', 'src', 'server', 'shared', 'scripts'].map((name) => resolve(name)),
  ]) {
    const child = relative(resolve(root), backupConfig.directory);
    if (!child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
      throw new Error('Database backups require a private directory outside application and public assets.');
  }
  const backupStorage = createDatabaseBackupService({
    database: db,
    directory: backupConfig.directory,
    retention: backupConfig.retention,
    now,
  });
  const backups = createBackupManager({ service: backupStorage, ...backupConfig, now });
  const requestedGstProvider = environment.GST_PROVIDER?.trim().toLowerCase();
  if (requestedGstProvider && !['portal', 'generic', 'sandbox'].includes(requestedGstProvider))
    throw new Error('GST_PROVIDER must be portal, generic or sandbox.');
  const gstProvider = requestedGstProvider || (lookupUrl ? 'generic' : 'portal');
  const sandboxGst = createSandboxGst({ environment, fetch: fetcher, now: () => now().getTime() });
  const gstStatus = () =>
    gstProvider === 'sandbox'
      ? sandboxGst.status()
      : {
          provider: gstProvider,
          mode: gstProvider === 'generic' ? 'custom' : 'captcha',
          configured: gstProvider === 'generic' && Boolean(lookupUrl),
          keyConfigured: gstProvider === 'generic' && Boolean(apiKey),
          secretConfigured: false,
        };

  function getOrganization(id: string): Organization {
    const row = db.prepare('SELECT data FROM organizations WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Organization not found.');
    return decode<Organization>(row);
  }
  function getCustomer(id: string): Customer {
    const row = db.prepare('SELECT data FROM customers WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Customer not found.');
    return normalizeContact(decode<Customer>(row));
  }
  function getDocument(id: string): BusinessDocument {
    const row = db.prepare('SELECT data FROM documents WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Document not found.');
    return decode<BusinessDocument>(row);
  }
  function getPayment(id: string): PaymentRecord {
    const row = db.prepare('SELECT data FROM payments WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Payment not found.');
    return decode<PaymentRecord>(row);
  }
  function activePaidPaise(documentId: string): number {
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM payments WHERE document_id = ? AND json_extract(data, '$.voidedAt') IS NULL",
      )
      .get(documentId) as { paid: number };
    return row.paid;
  }
  function addEvent(documentId: string, type: string, description: string) {
    const event: DocumentEvent = { id: randomUUID(), documentId, at: now().toISOString(), type, description };
    db.prepare('INSERT INTO document_events (id, document_id, data) VALUES (?, ?, ?)').run(
      event.id,
      documentId,
      JSON.stringify(event),
    );
  }
  function paymentDetails(documentId: string): PaymentDetails {
    return {
      document: getDocument(documentId),
      payments: (
        db
          .prepare('SELECT data FROM payments WHERE document_id = ? ORDER BY rowid DESC')
          .all(documentId) as Row[]
      ).map((row) => decode<PaymentRecord>(row)),
      events: (
        db
          .prepare('SELECT data FROM document_events WHERE document_id = ? ORDER BY rowid DESC')
          .all(documentId) as Row[]
      ).map((row) => decode<DocumentEvent>(row)),
    };
  }
  function updatePaymentBalance(document: BusinessDocument, finalize = false, reopening = false) {
    const paid = activePaidPaise(document.id);
    const total = Math.round(document.totals.total * 100);
    const fullyPaid = paid === total;
    const previousPaymentState = ['paid', 'partially_paid'].includes(document.status);
    const status =
      fullyPaid && (paid > 0 || finalize)
        ? 'paid'
        : paid > 0
          ? 'partially_paid'
          : previousPaymentState || reopening
            ? 'sent'
            : document.status;
    const timestamp = now().toISOString();
    const finalizing = fullyPaid && finalize && !document.finalizedAt;
    const updated: BusinessDocument = {
      ...document,
      amountPaid: paid / 100,
      balanceDue: (total - paid) / 100,
      status,
      finalizedAt: reopening ? null : finalizing ? timestamp : (document.finalizedAt ?? null),
      updatedAt: timestamp,
    };
    saveDocument(updated);
    if (finalizing)
      addEvent(
        document.id,
        'invoice_finalized',
        `Invoice ${document.number} finalized after full payment. The invoice number is unchanged.`,
      );
    return updated;
  }
  function getCatalogItem(id: string): CatalogItem {
    const row = db.prepare('SELECT data FROM catalog WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Product or service not found.');
    return decode<CatalogItem>(row);
  }
  function getBusinessProduct(id: string): BusinessProduct {
    const row = db.prepare('SELECT data FROM business_products WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Business product not found.');
    return decode<BusinessProduct>(row);
  }
  function selectBusinessProduct(
    organization: Organization,
    productId?: string,
    previousId?: string,
    requireSelection = true,
  ): BusinessProduct | null {
    if (!productId) {
      if (
        requireSelection &&
        organization.enableProductSelection &&
        db
          .prepare(
            "SELECT id FROM business_products WHERE organization_id = ? AND json_extract(data, '$.active') = 1 LIMIT 1",
          )
          .get(organization.id)
      )
        throw new HttpError(400, 'Choose a business product for this document.');
      return null;
    }
    const product = getBusinessProduct(productId);
    if (product.organizationId !== organization.id)
      throw new HttpError(400, 'The business product belongs to a different organization.');
    if (!product.active && product.id !== previousId)
      throw new HttpError(400, 'Archived business products cannot be selected for new records.');
    return product;
  }
  function assertProductCodeAvailable(input: BusinessProductInput, excludedId = '') {
    if (
      input.code &&
      db
        .prepare(
          'SELECT id FROM business_products WHERE organization_id = ? AND code = ? COLLATE NOCASE AND id != ?',
        )
        .get(input.organizationId, input.code, excludedId)
    )
      throw new HttpError(
        409,
        'This business product code is already used in this organization, including archived products.',
      );
  }
  function validateInstallmentTotal(plan: InstallmentPlan | null | undefined, total: number) {
    if (
      plan &&
      plan.installments.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) !==
        Math.round(total * 100)
    )
      throw new HttpError(
        400,
        'Installments must add up exactly to the full document total. Update or remove the plan when changing financial details.',
      );
  }
  function recordPlanChange(
    documentId: string,
    previous: InstallmentPlan | null | undefined,
    next: InstallmentPlan | null | undefined,
  ) {
    addEvent(
      documentId,
      'installment_plan_changed',
      `Installment schedule changed. Previous: ${JSON.stringify(previous ?? null)}. New: ${JSON.stringify(next ?? null)}. Existing payment receipts are unchanged.`,
    );
  }
  function getFormat(id: string): InvoiceFormat {
    const row = db.prepare('SELECT data FROM formats WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Invoice format not found.');
    return decode<InvoiceFormat>(row);
  }
  function selectFormat(organizationId: string, formatId?: string): InvoiceFormat {
    let format: InvoiceFormat;
    if (formatId) format = getFormat(formatId);
    else {
      const row = db
        .prepare('SELECT data FROM formats WHERE organization_id = ? AND is_default = 1')
        .get(organizationId) as Row | undefined;
      if (!row)
        throw new HttpError(409, 'Choose a default invoice format in Formats before saving a document.');
      format = decode<InvoiceFormat>(row);
    }
    if (format.organizationId !== organizationId)
      throw new HttpError(400, 'The format belongs to a different organization.');
    return format;
  }
  function assertSkuAvailable(input: CatalogInput, excludedId = '') {
    if (!input.sku) return;
    const row = db
      .prepare('SELECT id FROM catalog WHERE organization_id = ? AND sku = ? COLLATE NOCASE AND id != ?')
      .get(input.organizationId, input.sku, excludedId);
    if (row)
      throw new HttpError(409, 'This SKU is already used in this organization, including archived items.');
  }
  function validateCatalogReferences(input: DocumentInput, current?: BusinessDocument) {
    const previous = new Set(current?.items.map((item) => item.catalogItemId).filter(Boolean));
    for (const item of input.items) {
      if (!item.catalogItemId) continue;
      const catalog = getCatalogItem(item.catalogItemId);
      if (catalog.organizationId !== input.organizationId)
        throw new HttpError(400, 'Products and services must belong to this organization.');
      if (!catalog.active && !previous.has(catalog.id))
        throw new HttpError(400, 'Archived products and services cannot be added to new documents.');
      const retained =
        previous.has(catalog.id) && (current?.businessProductId || '') === (input.businessProductId || '');
      if (catalog.businessProductId && catalog.businessProductId !== input.businessProductId && !retained)
        throw new HttpError(
          400,
          'This catalog item belongs to a different business product. Select its matching product.',
        );
    }
  }
  function saveFormat(format: InvoiceFormat) {
    if (format.isDefault) {
      const previous = db
        .prepare('SELECT data FROM formats WHERE organization_id = ? AND is_default = 1 AND id != ?')
        .get(format.organizationId, format.id) as Row | undefined;
      if (previous) {
        const previousFormat = {
          ...decode<InvoiceFormat>(previous),
          isDefault: false,
          updatedAt: format.updatedAt,
        };
        db.prepare('UPDATE formats SET is_default = 0, data = ? WHERE id = ?').run(
          JSON.stringify(previousFormat),
          previousFormat.id,
        );
      }
    }
    db.prepare(
      `INSERT INTO formats (id, organization_id, is_default, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET is_default = excluded.is_default, data = excluded.data`,
    ).run(format.id, format.organizationId, Number(format.isDefault), JSON.stringify(format));
  }
  function scopedOrganization(value: unknown) {
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'organizationId is required.');
    return getOrganization(value);
  }
  function assertPrefixesAvailable(organization: Omit<Organization, 'id'>, excludedId?: string) {
    const organizations = (db.prepare('SELECT data FROM organizations').all() as Row[]).map((row) =>
      decode<Organization>(row),
    );
    const incoming = new Set([organization.invoicePrefix, organization.quotationPrefix]);
    for (const other of organizations) {
      if (
        other.id !== excludedId &&
        (incoming.has(other.invoicePrefix) || incoming.has(other.quotationPrefix))
      ) {
        throw new HttpError(409, 'Document prefixes must be unique across all divisions.');
      }
    }
    // A retired prefix remains reserved so older financial records never collide.
    const previous = db.prepare('SELECT organization_id, number FROM documents').all() as {
      organization_id: string;
      number: string;
    }[];
    if (
      previous.some((row) => row.organization_id !== excludedId && incoming.has(row.number.split('/')[0]))
    ) {
      throw new HttpError(409, 'This prefix was already used by another division. Choose a new prefix.');
    }
  }
  function validateTax(input: DocumentInput, organization: Organization) {
    if (
      input.items.some((item) => item.gstRate > 0) &&
      (!organization.gstin || !organization.stateCode || !input.placeOfSupply)
    ) {
      throw new HttpError(
        400,
        'To charge GST, save the organization GSTIN and state in Settings, then select the place of supply.',
      );
    }
  }
  function nextNumber(organization: Organization, kind: DocumentInput['kind'], issueDate: string) {
    const year = fiscalYear(issueDate);
    const prefix = kind === 'quotation' ? organization.quotationPrefix : organization.invoicePrefix;
    const marker = kind === 'proforma' ? 'P' : kind === 'delivery_note' ? 'D' : '';
    // Called only inside an IMMEDIATE transaction, so failed saves do not consume a number.
    for (;;) {
      const row = db
        .prepare(
          `INSERT INTO sequences (organization_id, kind, fiscal_year, value) VALUES (?, ?, ?, 1)
        ON CONFLICT(organization_id, kind, fiscal_year) DO UPDATE SET value = value + 1 RETURNING value`,
        )
        .get(organization.id, kind, year) as { value: number };
      if (row.value > (marker ? 99999 : 999999))
        throw new HttpError(409, 'The document sequence for this financial year is exhausted.');
      const number = `${prefix}/${year}/${marker}${String(row.value).padStart(4, '0')}`;
      if (!db.prepare('SELECT id FROM documents WHERE number = ?').get(number)) return number;
    }
  }
  function saveDocument(document: BusinessDocument) {
    db.prepare(
      `INSERT INTO documents (id, organization_id, customer_id, kind, number, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET customer_id = excluded.customer_id, data = excluded.data`,
    ).run(
      document.id,
      document.organizationId,
      document.customerId,
      document.kind,
      document.number,
      JSON.stringify(document),
    );
  }
  function sellerRegistration(organization: Organization, registrationId?: string) {
    try {
      return organizationForRegistration(organization, registrationId);
    } catch {
      throw new HttpError(400, 'Choose a GST registration saved in this organization.');
    }
  }
  function newDocument(
    input: DocumentInput,
    organization: Organization,
    customer: Customer,
    source: BusinessDocument | null = null,
  ): BusinessDocument {
    if (!source) organization = sellerRegistration(organization, input.gstRegistrationId);
    validateTax(input, organization);
    if (customer.organizationId !== organization.id)
      throw new HttpError(400, 'The customer belongs to a different organization.');
    if (['paid', 'partially_paid'].includes(input.status))
      throw new HttpError(
        400,
        'Record invoice payments in Payments; paid status is calculated from the payment ledger.',
      );
    if (!source && !isInvoiceRecipient(customer))
      throw new HttpError(400, 'Select an active customer, vendor or B2B buyer from this organization.');
    if (!source) validateCatalogReferences(input);
    const businessProductSnapshot = source
      ? (source.businessProductSnapshot ?? null)
      : selectBusinessProduct(organization, input.businessProductId);
    const formatSnapshot = source
      ? (source.formatSnapshot ?? getDocumentFormat(source))
      : selectFormat(organization.id, input.formatId);
    const timestamp = now().toISOString();
    const totals =
      source && input.kind === 'invoice'
        ? source.totals
        : calculateTotals(input.items, input.discountPercent, organization.stateCode !== input.placeOfSupply);
    validateInstallmentTotal(input.installmentPlan, totals.total);
    const document: BusinessDocument = {
      ...input,
      id: randomUUID(),
      number: nextNumber(getOrganization(organization.id), input.kind, input.issueDate),
      createdAt: timestamp,
      updatedAt: timestamp,
      customerSnapshot: customer,
      organizationSnapshot: organization,
      totals,
      sourceQuotationId: source?.kind === 'quotation' ? source.id : null,
      convertedInvoiceId: null,
      formatId: formatSnapshot.id,
      formatSnapshot,
      sourceDocumentId: source?.id ?? null,
      deliveryNoteId: null,
      amountPaid: 0,
      balanceDue: input.kind === 'invoice' ? totals.total : 0,
      finalizedAt: null,
      businessProductId: source?.businessProductId ?? input.businessProductId,
      businessProductSnapshot,
    };
    saveDocument(document);
    emailIssuedDocument(document);
    if (document.installmentPlan) recordPlanChange(document.id, null, document.installmentPlan);
    return document;
  }

  const mailer = createMailer(db, {
    env: environment,
    fetch: options.emailFetch,
    now,
    renderInvoiceAttachment,
    getOrganization,
    resolveInvoicePaymentUrl: async (queued) => {
      const current = getDocument(queued.id);
      if (current.status === 'cancelled' || current.status === 'draft')
        throw new Error('The document is no longer issued for payment.');
      if (current.finalizedAt || Math.round(current.totals.total * 100) === activePaidPaise(current.id))
        return { document: current };
      const result = await online.createPaymentLink(current.id);
      const paymentUrl = result.links.find((link) => ['created', 'partially_paid'].includes(link.state))?.url;
      if (!paymentUrl) throw new Error('No verified payment link is available yet.');
      return { document: getDocument(current.id), paymentUrl };
    },
  });
  const auth =
    options.auth === false
      ? null
      : createAuth(db, {
          environment,
          now: () => now().getTime(),
          ...(options.auth || {}),
          ...(mailer.status().configured && environment.PUBLIC_APP_URL
            ? {
                sendPasswordReset: async ({
                  to,
                  name,
                  token,
                }: {
                  to: string;
                  name: string;
                  token: string;
                }) => {
                  const resetUrl = `${new URL(environment.PUBLIC_APP_URL!).origin}/#reset-password?token=${encodeURIComponent(token)}`;
                  mailer.enqueuePasswordReset({
                    to,
                    name,
                    resetUrl,
                    eventKey: `password-reset:${createHash('sha256').update(token).digest('hex')}`,
                  });
                },
              }
            : {}),
        });
  const online = createPaymentGateways({
    db,
    env: environment,
    fetch: options.paymentFetch,
    now,
    getDocument,
    getOrganization,
    listOrganizations: () =>
      (db.prepare('SELECT data FROM organizations').all() as Row[]).map((row) => decode<Organization>(row)),
    recordVerifiedPayment: (input) =>
      recordPayment(
        input.documentId,
        paymentSchema.parse({ ...input, method: 'other', finalizeWhenPaid: true }),
      ).payment,
    notifyPayment: (notification) => {
      mailer.enqueuePayment(notification.document, {
        eventKey: notification.key,
        outcome:
          notification.event === 'payment_failed'
            ? 'failed'
            : notification.document.finalizedAt
              ? 'paid'
              : 'received',
        amount: notification.payment?.amount,
        reference: notification.payment?.reference,
        paymentUrl: notification.paymentUrl,
        automatic: true,
      });
    },
  });
  app.locals.services = { auth, mailer, online, db, backups };
  app.locals.initialize = async () => {
    const owner = await auth?.initializeOwner();
    await backups.initialize();
    return owner ?? null;
  };
  if (auth) app.use('/api/auth', auth.router);
  app.get('/api/health', (req, res) =>
    res.json(
      auth && !auth.getSessionUser(req)
        ? { ok: true }
        : {
            ok: true,
            gstConfigured: gstStatus().configured,
            gstMode: gstProvider === 'portal' ? 'portal' : 'provider',
            gstProvider,
            ...(gstProvider === 'sandbox' ? { gstEnvironment: sandboxGst.status().mode } : {}),
          },
    ),
  );
  if (auth) app.use('/api', auth.requireSession, auth.mutationGuard, createAccessGuard(db));
  if (auth) app.use('/api/backups', auth.requireAdmin);
  app.get('/api/backups/status', (_req, res) => res.json(backups.status()));
  app.get('/api/backups', async (_req, res) => res.json(await backupStorage.listBackups()));
  let lastManualBackupAt: number | undefined;
  app.post('/api/backups', async (_req, res) => {
    const time = now().getTime();
    if (!backups.status().running && lastManualBackupAt !== undefined && time - lastManualBackupAt < 60_000)
      throw new HttpError(429, 'Please wait one minute before creating another database backup.');
    lastManualBackupAt = time;
    res.status(201).json(await backups.create());
  });
  app.get('/api/backups/:id/download', async (req, res) => {
    const filename = await backupStorage.getVerifiedDatabasePath(req.params.id);
    res.download(filename, `${req.params.id}.sqlite`, (error) => {
      if (error && !res.headersSent)
        res.status(503).json({ error: 'The verified backup could not be downloaded. Please retry.' });
    });
  });
  app.get('/api/backups/:id/manifest', async (req, res) => {
    const metadata = await backupStorage.verifyBackup(req.params.id);
    res.attachment(`${metadata.id}.manifest.json`).json({
      schemaVersion: metadata.schemaVersion,
      kind: 'venturecore-sqlite-backup',
      id: metadata.id,
      createdAt: metadata.createdAt,
      sqliteUserVersion: metadata.sqliteUserVersion,
      database: { file: 'database.sqlite', byteLength: metadata.byteLength, sha256: metadata.sha256 },
    });
  });
  app.use('/api', online.router);
  app.get('/api/integrations/status', (req, res) => {
    const user = res.locals.user as AuthUser | undefined;
    const documentId =
      req.query.documentId === undefined ? undefined : z.string().min(1).parse(req.query.documentId);
    const document = documentId ? getDocument(documentId) : undefined;
    const requestedId =
      req.query.organizationId === undefined ? undefined : z.string().min(1).parse(req.query.organizationId);
    const firstId =
      auth && user?.role !== 'admin'
        ? user?.organizationIds[0]
        : (
            db.prepare('SELECT id FROM organizations ORDER BY rowid LIMIT 1').get() as
              { id: string } | undefined
          )?.id;
    const organizationId = requestedId ?? document?.organizationId ?? firstId;
    if (!organizationId) throw new HttpError(403, 'No organization is assigned to this account.');
    if (auth && user?.role !== 'admin' && !user?.organizationIds.includes(organizationId))
      throw new HttpError(403, 'This organization is outside your access.');
    if (document && document.organizationId !== organizationId)
      throw new HttpError(400, 'The document belongs to a different organization.');
    const organization = getOrganization(organizationId);
    const payment = online.getStatus(organizationId, documentId);
    res.json({
      email: mailer.status(organizationId),
      payment,
      razorpay: payment,
      gst: gstStatus(),
      environmentPrefix: integrationEnvironmentPrefix(organization),
      webhookPath: payment.provider === 'none' ? '' : `/api/webhooks/${payment.provider}/${organizationId}`,
    });
  });
  app.get('/api/documents/:id/messages', (req, res) => {
    getDocument(req.params.id);
    res.json(mailer.listMessages(req.params.id));
  });
  app.post('/api/documents/:id/email', async (req, res) => {
    const input = z
      .object({ includePaymentLink: z.boolean().default(false), requestId: z.string().uuid() })
      .parse(req.body);
    let document = getDocument(req.params.id);
    if (document.status === 'draft' || document.status === 'cancelled' || document.kind === 'delivery_note')
      throw new HttpError(409, 'Issue a financial document before emailing it.');
    if (!mailer.status(document.organizationId).configured)
      throw new HttpError(503, mailer.status(document.organizationId).reason);
    if (!z.string().email().safeParse(document.customerSnapshot.email).success)
      throw new HttpError(400, 'The saved invoice recipient needs a valid email address.');
    let paymentUrl: string | undefined;
    if (input.includePaymentLink) {
      const links = await online.createPaymentLink(document.id);
      paymentUrl = links.links.find((link) => ['created', 'partially_paid'].includes(link.state))?.url;
      if (!paymentUrl)
        throw new HttpError(409, 'No payable link is available. Review online payments before sending.');
      document = getDocument(document.id);
    }
    const message = mailer.enqueueInvoice(document, {
      eventKey: `invoice-manual:${document.id}:${input.requestId}`,
      paymentUrl,
    });
    res.status(202).json({ message });
  });
  app.post('/api/messages/:id/retry', (req, res) => {
    const message = mailer.get(req.params.id);
    if (!message) throw new HttpError(404, 'Email not found.');
    const user = res.locals.user as AuthUser | undefined;
    if (
      auth &&
      user?.role !== 'admin' &&
      (!message.documentId || !user?.organizationIds.includes(getDocument(message.documentId).organizationId))
    )
      throw new HttpError(403, 'This email is outside your organization access.');
    res.json({ message: mailer.retry(message.id) });
  });
  function emailIssuedDocument(document: BusinessDocument) {
    if (document.status !== 'sent' || document.kind === 'delivery_note') return;
    mailer.enqueueInvoice(document, {
      eventKey: `invoice-issued:${document.id}`,
      automatic: true,
      resolvePaymentLink:
        document.kind === 'invoice' && online.getStatus(document.organizationId, document.id).configured,
    });
  }
  app.get('/api/workspace-settings', (_req, res) => {
    res.json(
      decode<WorkspaceSettings>(db.prepare('SELECT data FROM workspace_settings WHERE id = 1').get() as Row),
    );
  });
  app.put('/api/workspace-settings', (req, res) => {
    const settings = workspaceSettingsSchema.parse(req.body);
    db.prepare('UPDATE workspace_settings SET data = ? WHERE id = 1').run(JSON.stringify(settings));
    res.json(settings);
  });
  app.get('/api/organizations', (_req, res) => {
    const user = res.locals.user as AuthUser | undefined;
    const rows = (db.prepare('SELECT data FROM organizations ORDER BY rowid').all() as Row[]).map((row) =>
      decode<Organization>(row),
    );
    res.json(
      auth && user?.role !== 'admin' ? rows.filter((org) => user?.organizationIds.includes(org.id)) : rows,
    );
  });
  app.post('/api/organizations', (req, res) => {
    const input = organizationSchema.parse(req.body);
    const organization = transaction(db, () => {
      assertPrefixesAvailable(input);
      const base = { ...input, id: randomUUID() };
      const profile = billingProfileFor(base);
      const result = {
        ...base,
        billingProfile: profile,
        enableProductSelection: input.enableProductSelection ?? profile === 'ecosystem',
      };
      db.prepare('INSERT INTO organizations (id, data) VALUES (?, ?)').run(result.id, JSON.stringify(result));
      seedDefaultFormat(db, result, now().toISOString());
      return result;
    });
    res.status(201).json(organization);
  });
  app.put('/api/organizations/:id', (req, res) => {
    const input = organizationSchema.parse(req.body);
    const organization = transaction(db, () => {
      const current = getOrganization(req.params.id);
      assertPrefixesAvailable(input, current.id);
      const result = { ...current, ...input, id: current.id };
      if (
        organizationGateway(result) !== organizationGateway(current) ||
        isIndependentBusiness(result) !== isIndependentBusiness(current)
      ) {
        const rows = db.prepare('SELECT id FROM documents WHERE organization_id = ?').all(current.id) as {
          id: string;
        }[];
        for (const row of rows) online.assertManualChangesAllowed(row.id);
      }
      if (current.id === 'shri-sarraf') result.businessType = 'independent';
      db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(JSON.stringify(result), current.id);
      return result;
    });
    res.json(organization);
  });

  app.get('/api/business-products', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(
      (
        db
          .prepare('SELECT data FROM business_products WHERE organization_id = ? ORDER BY rowid')
          .all(organization.id) as Row[]
      ).map((row) => decode<BusinessProduct>(row)),
    );
  });
  app.post('/api/business-products', (req, res) => {
    const input = businessProductSchema.parse(req.body);
    const product = transaction(db, () => {
      getOrganization(input.organizationId);
      assertProductCodeAvailable(input);
      const timestamp = now().toISOString();
      const result: BusinessProduct = {
        ...input,
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      db.prepare('INSERT INTO business_products (id, organization_id, code, data) VALUES (?, ?, ?, ?)').run(
        result.id,
        result.organizationId,
        result.code,
        JSON.stringify(result),
      );
      return result;
    });
    res.status(201).json(product);
  });
  app.put('/api/business-products/:id', (req, res) => {
    const input = businessProductSchema.parse(req.body);
    const product = transaction(db, () => {
      const current = getBusinessProduct(req.params.id);
      if (current.organizationId !== input.organizationId)
        throw new HttpError(400, 'Business products cannot be moved between organizations.');
      assertProductCodeAvailable(input, current.id);
      const result: BusinessProduct = { ...current, ...input, updatedAt: now().toISOString() };
      db.prepare('UPDATE business_products SET code = ?, data = ? WHERE id = ?').run(
        result.code,
        JSON.stringify(result),
        result.id,
      );
      return result;
    });
    res.json(product);
  });

  app.get('/api/catalog', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(
      (
        db
          .prepare('SELECT data FROM catalog WHERE organization_id = ? ORDER BY rowid DESC')
          .all(organization.id) as Row[]
      ).map((row) => decode<CatalogItem>(row)),
    );
  });
  app.post('/api/catalog', (req, res) => {
    const input = catalogSchema.parse(req.body);
    const item = transaction(db, () => {
      const organization = getOrganization(input.organizationId);
      selectBusinessProduct(organization, input.businessProductId, undefined, false);
      assertSkuAvailable(input);
      const timestamp = now().toISOString();
      const result: CatalogItem = { ...input, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp };
      db.prepare('INSERT INTO catalog (id, organization_id, sku, data) VALUES (?, ?, ?, ?)').run(
        result.id,
        result.organizationId,
        result.sku,
        JSON.stringify(result),
      );
      return result;
    });
    res.status(201).json(item);
  });
  app.put('/api/catalog/:id', (req, res) => {
    const input = catalogSchema.parse(req.body);
    const item = transaction(db, () => {
      const current = getCatalogItem(req.params.id);
      if (input.organizationId !== current.organizationId)
        throw new HttpError(400, 'A product or service cannot be moved between organizations.');
      selectBusinessProduct(
        getOrganization(current.organizationId),
        input.businessProductId,
        current.businessProductId,
        false,
      );
      assertSkuAvailable(input, current.id);
      const result: CatalogItem = { ...current, ...input, updatedAt: now().toISOString() };
      db.prepare('UPDATE catalog SET sku = ?, data = ? WHERE id = ?').run(
        result.sku,
        JSON.stringify(result),
        result.id,
      );
      return result;
    });
    res.json(item);
  });

  app.get('/api/formats', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(
      (
        db
          .prepare('SELECT data FROM formats WHERE organization_id = ? ORDER BY is_default DESC, rowid')
          .all(organization.id) as Row[]
      ).map((row) => decode<InvoiceFormat>(row)),
    );
  });
  app.post('/api/formats', (req, res) => {
    const input = formatSchema.parse(req.body);
    const format = transaction(db, () => {
      getOrganization(input.organizationId);
      const timestamp = now().toISOString();
      const result: InvoiceFormat = {
        ...input,
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      saveFormat(result);
      return result;
    });
    res.status(201).json(format);
  });
  app.put('/api/formats/:id', (req, res) => {
    const input = formatSchema.parse(req.body);
    const format = transaction(db, () => {
      const current = getFormat(req.params.id);
      if (input.organizationId !== current.organizationId)
        throw new HttpError(400, 'An invoice format cannot be moved between organizations.');
      if (current.isDefault && !input.isDefault)
        throw new HttpError(409, 'Set another format as default before removing this default.');
      const result: InvoiceFormat = { ...current, ...input, updatedAt: now().toISOString() };
      saveFormat(result);
      return result;
    });
    res.json(format);
  });
  app.delete('/api/formats/:id', (req, res) => {
    transaction(db, () => {
      const current = getFormat(req.params.id);
      const count = db
        .prepare('SELECT COUNT(*) AS count FROM formats WHERE organization_id = ?')
        .get(current.organizationId) as { count: number };
      if (count.count <= 1)
        throw new HttpError(409, 'Keep at least one invoice format for this organization.');
      if (current.isDefault)
        throw new HttpError(409, 'Set another format as default before deleting this format.');
      db.prepare('DELETE FROM formats WHERE id = ?').run(current.id);
    });
    res.json({ ok: true });
  });

  app.get('/api/customers', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(
      (
        db
          .prepare('SELECT data FROM customers WHERE organization_id = ? ORDER BY rowid DESC')
          .all(organization.id) as Row[]
      ).map((row) => normalizeContact(decode<Customer>(row))),
    );
  });
  app.post('/api/customers', (req, res) => {
    const input = customerSchema.parse(req.body);
    getOrganization(input.organizationId);
    const customer = { ...input, id: randomUUID() };
    db.prepare('INSERT INTO customers (id, organization_id, data) VALUES (?, ?, ?)').run(
      customer.id,
      customer.organizationId,
      JSON.stringify(customer),
    );
    res.status(201).json(customer);
  });
  app.put('/api/customers/:id', (req, res) => {
    const input = customerSchema.parse(req.body);
    const current = getCustomer(req.params.id);
    if (input.organizationId !== current.organizationId)
      throw new HttpError(400, 'A customer cannot be moved between organizations.');
    const customer = { ...input, id: current.id };
    db.prepare('UPDATE customers SET data = ? WHERE id = ?').run(JSON.stringify(customer), customer.id);
    res.json(customer);
  });
  app.delete('/api/customers/:id', (req, res) => {
    getCustomer(req.params.id);
    if (db.prepare('SELECT id FROM documents WHERE customer_id = ? LIMIT 1').get(req.params.id))
      throw new HttpError(409, 'This customer is used by a saved document and cannot be deleted.');
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/documents', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    const result = getDocumentPage(db, organization.id, businessDateInIndia(now()), {
      ...req.query,
      pageSize: req.query.pageSize ?? '100',
    });
    res.set({
      'X-Total-Count': String(result.total),
      'X-Page': String(result.page),
      'X-Page-Size': String(result.pageSize),
    });
    res.json(result.items);
  });
  app.get('/api/documents/page', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(getDocumentPage(db, organization.id, businessDateInIndia(now()), req.query));
  });
  app.get('/api/documents/summary', (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    res.json(getDocumentSummary(db, organization.id, businessDateInIndia(now())));
  });
  app.get('/api/documents/export.csv', async (req, res) => {
    const organization = scopedOrganization(req.query.organizationId);
    const filters = parseDocumentFilters(req.query);
    const asOf = businessDateInIndia(now());
    res.type('text/csv; charset=utf-8');
    res.attachment(`documents-${filters.kind ?? 'all'}-${asOf}.csv`);
    const csvRow = (values: unknown[]) =>
      values
        .map((value) => {
          let text = String(value ?? '');
          if (/^\s*[=+@-]/.test(text)) text = "'" + text;
          return '"' + text.replaceAll('"', '""') + '"';
        })
        .join(',') + '\r\n';
    res.write(
      '\uFEFF' +
        csvRow([
          'Number',
          'Type',
          'Business product',
          'Customer',
          'Date',
          'Due date',
          'Status',
          'Taxable (INR)',
          'GST (INR)',
          'Total (INR)',
          'Received (INR)',
          'Balance (INR)',
          'Finalized',
        ]),
    );
    for (const { document: item, status } of documentExportRows(db, organization.id, asOf, filters)) {
      if (res.destroyed || res.writableEnded) return;
      const paid =
        item.amountPaid ?? (item.kind === 'invoice' && item.status === 'paid' ? item.totals.total : 0);
      const balance =
        item.kind === 'invoice'
          ? (item.balanceDue ?? Math.max(0, Math.round((item.totals.total - paid) * 100) / 100))
          : 0;
      if (
        !res.write(
          csvRow([
            item.number,
            item.kind,
            item.businessProductSnapshot?.name ?? '',
            item.customerSnapshot.name,
            item.issueDate,
            item.dueDate,
            status,
            item.totals.taxable,
            item.totals.cgst + item.totals.sgst + item.totals.igst,
            item.kind === 'delivery_note' ? '' : item.totals.total,
            paid,
            balance,
            item.finalizedAt ?? '',
          ]),
        )
      ) {
        await new Promise<void>((resolve) => {
          const finished = () => {
            res.off('drain', finished);
            res.off('close', finished);
            resolve();
          };
          res.once('drain', finished);
          res.once('close', finished);
        });
      }
    }
    res.end();
  });
  app.get('/api/documents/:id', (req, res) => {
    const document = getDocument(req.params.id);
    if (
      req.query.organizationId !== undefined &&
      scopedOrganization(req.query.organizationId).id !== document.organizationId
    )
      throw new HttpError(404, 'Document not found in the selected organization.');
    res.json(document);
  });
  app.post('/api/documents', async (req, res) => {
    const input = documentSchema.parse(req.body);
    const document = transaction(db, () =>
      newDocument(input, getOrganization(input.organizationId), getCustomer(input.customerId)),
    );
    res.status(201).json(document);
  });
  app.put('/api/documents/:id', async (req, res) => {
    const input = documentSchema.parse(req.body);
    const result = transaction(db, () => {
      const current = getDocument(req.params.id);
      if (input.organizationId !== current.organizationId || input.kind !== current.kind)
        throw new HttpError(400, 'Document kind and organization cannot be changed.');
      if (current.finalizedAt)
        throw new HttpError(
          409,
          'This invoice is finalized and locked. Void an incorrect payment with a reason to reopen its balance.',
        );
      if (current.convertedInvoiceId)
        throw new HttpError(409, 'This document was converted to an invoice and can no longer be edited.');
      const businessProductId =
        input.businessProductId === undefined ? current.businessProductId : input.businessProductId;
      const productChange = (businessProductId || '') !== (current.businessProductId || '');
      const gstRegistrationId =
        input.gstRegistrationId === undefined ? current.gstRegistrationId : input.gstRegistrationId;
      const registrationChange = (gstRegistrationId || '') !== (current.gstRegistrationId || '');
      const brandingChange =
        input.branding !== undefined && JSON.stringify(input.branding) !== JSON.stringify(current.branding);
      if (brandingChange && current.status !== 'draft')
        throw new HttpError(
          409,
          'Document logos, signatures and stamps can be customized only while the document is a draft.',
        );
      const installmentPlan =
        input.installmentPlan === undefined ? current.installmentPlan : input.installmentPlan;
      const planChange =
        JSON.stringify(installmentPlan ?? null) !== JSON.stringify(current.installmentPlan ?? null);
      if (planChange && current.status !== 'draft')
        throw new HttpError(
          409,
          'Use the installment schedule action to change a plan on an issued invoice.',
        );
      const immutable = ['customerId', 'issueDate', 'items', 'discountPercent', 'placeOfSupply'] as const;
      const financialChange =
        productChange ||
        registrationChange ||
        immutable.some((key) => JSON.stringify(input[key]) !== JSON.stringify(current[key]));
      const paid = current.kind === 'invoice' ? activePaidPaise(current.id) : 0;
      if (paid > 0 && (financialChange || ['draft', 'cancelled'].includes(input.status)))
        throw new HttpError(
          409,
          'Invoices with active payments cannot change financial details, return to draft or be cancelled.',
        );
      if (
        current.kind === 'invoice' &&
        input.status !== current.status &&
        (['paid', 'partially_paid'].includes(input.status) ||
          ['paid', 'partially_paid'].includes(current.status))
      )
        throw new HttpError(
          409,
          'Payment status is calculated from recorded payments. Use Payments to record or void a payment.',
        );
      if (current.status !== 'draft') {
        if (input.status === 'draft')
          throw new HttpError(409, 'An issued document cannot be returned to draft.');
        if (financialChange)
          throw new HttpError(
            409,
            'Financial details of an issued document are locked. Only status, title, due date, notes and terms can be updated.',
          );
      }
      if (fiscalYear(input.issueDate) !== fiscalYear(current.issueDate))
        throw new HttpError(
          400,
          'The issue date must stay within the financial year of the assigned document number.',
        );
      if (input.customerId !== current.customerId && !isInvoiceRecipient(getCustomer(input.customerId)))
        throw new HttpError(400, 'Select an active customer, vendor or B2B buyer.');
      if (financialChange || input.status !== current.status) online.assertManualChangesAllowed(current.id);
      const customerSnapshot = financialChange ? getCustomer(input.customerId) : current.customerSnapshot;
      if (customerSnapshot.organizationId !== current.organizationId)
        throw new HttpError(400, 'The customer belongs to a different organization.');
      const organizationSnapshot = financialChange
        ? sellerRegistration(getOrganization(current.organizationId), gstRegistrationId)
        : current.organizationSnapshot;
      validateTax(input, organizationSnapshot);
      validateCatalogReferences({ ...input, businessProductId }, current);
      const selectedProduct = selectBusinessProduct(
        getOrganization(current.organizationId),
        businessProductId,
        current.businessProductId,
        financialChange,
      );
      const businessProductSnapshot =
        !productChange && current.businessProductSnapshot ? current.businessProductSnapshot : selectedProduct;
      const formatSnapshot =
        input.formatId && input.formatId !== current.formatId
          ? selectFormat(current.organizationId, input.formatId)
          : (current.formatSnapshot ?? getDocumentFormat(current));
      const totals = financialChange
        ? calculateTotals(
            input.items,
            input.discountPercent,
            organizationSnapshot.stateCode !== input.placeOfSupply,
          )
        : current.totals;
      validateInstallmentTotal(installmentPlan, totals.total);
      const document: BusinessDocument = {
        ...current,
        ...input,
        customerSnapshot,
        organizationSnapshot,
        updatedAt: now().toISOString(),
        formatId: formatSnapshot.id,
        formatSnapshot,
        totals,
        amountPaid: paid / 100,
        balanceDue: input.kind === 'invoice' ? (Math.round(totals.total * 100) - paid) / 100 : 0,
        businessProductId,
        businessProductSnapshot,
        installmentPlan,
        gstRegistrationId,
      };
      saveDocument(document);
      if (planChange) recordPlanChange(document.id, current.installmentPlan, installmentPlan);
      if (current.status === 'draft' && document.status === 'sent') emailIssuedDocument(document);
      return document;
    });
    res.json(result);
  });
  app.delete('/api/documents/:id', (req, res) => {
    const document = getDocument(req.params.id);
    if (
      document.finalizedAt ||
      db.prepare('SELECT id FROM payments WHERE document_id = ? LIMIT 1').get(document.id)
    )
      throw new HttpError(409, 'Invoices with payment history or finalization cannot be deleted.');
    if (document.status !== 'draft') throw new HttpError(409, 'Only draft documents can be deleted.');
    if (
      document.sourceQuotationId ||
      document.convertedInvoiceId ||
      document.sourceDocumentId ||
      document.deliveryNoteId
    )
      throw new HttpError(409, 'Documents linked by conversion or delivery cannot be deleted.');
    transaction(db, () => {
      db.prepare('DELETE FROM document_events WHERE document_id = ?').run(document.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(document.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/documents/:id/convert', (req, res) => {
    let created = false;
    const invoice = transaction(db, () => {
      const quotation = getDocument(req.params.id);
      if (!['quotation', 'proforma'].includes(quotation.kind))
        throw new HttpError(400, 'Only a quotation or proforma can be converted to an invoice.');
      if (quotation.convertedInvoiceId) return getDocument(quotation.convertedInvoiceId);
      if (['declined', 'cancelled'].includes(quotation.status))
        throw new HttpError(409, 'A declined or cancelled document cannot be converted.');
      const issueDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now());
      const paymentTermMilliseconds = quotation.dueDate
        ? Date.parse(`${quotation.dueDate}T00:00:00Z`) - Date.parse(`${quotation.issueDate}T00:00:00Z`)
        : 0;
      const dueDate = quotation.dueDate
        ? new Date(Date.parse(`${issueDate}T00:00:00Z`) + Math.max(0, paymentTermMilliseconds))
            .toISOString()
            .slice(0, 10)
        : '';
      const input: DocumentInput = {
        organizationId: quotation.organizationId,
        customerId: quotation.customerId,
        kind: 'invoice',
        status: 'draft',
        issueDate,
        dueDate,
        title: quotation.title === DOCUMENT_LABELS[quotation.kind] ? 'Invoice' : quotation.title,
        items: quotation.items,
        discountPercent: quotation.discountPercent,
        placeOfSupply: quotation.placeOfSupply,
        notes: quotation.notes,
        terms: quotation.terms,
        shipping: quotation.shipping,
        gstRegistrationId: quotation.gstRegistrationId,
        branding: quotation.branding,
        businessProductId: quotation.businessProductId,
        installmentPlan: quotation.installmentPlan,
      };
      // Conversion preserves the accepted customer, issuer and tax terms from the quotation.
      const result = newDocument(
        input,
        quotation.organizationSnapshot,
        quotation.customerSnapshot,
        quotation,
      );
      saveDocument({
        ...quotation,
        status: 'accepted',
        convertedInvoiceId: result.id,
        updatedAt: now().toISOString(),
      });
      created = true;
      return result;
    });
    res.status(created ? 201 : 200).json(invoice);
  });

  app.post('/api/documents/:id/delivery-note', (req, res) => {
    let created = false;
    const document = transaction(db, () => {
      const invoice = getDocument(req.params.id);
      if (invoice.kind !== 'invoice') throw new HttpError(400, 'Create a delivery challan from an invoice.');
      if (invoice.deliveryNoteId) return getDocument(invoice.deliveryNoteId);
      if (invoice.status === 'cancelled')
        throw new HttpError(409, 'A cancelled invoice cannot create a delivery challan.');
      const issueDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now());
      const shipping = invoice.shipping ?? {
        ...blankShipping(),
        recipientName: invoice.customerSnapshot.name,
        address: invoice.customerSnapshot.address,
        stateCode: invoice.customerSnapshot.stateCode,
        phone: invoice.customerSnapshot.phone,
        reference: invoice.number,
      };
      const input: DocumentInput = {
        organizationId: invoice.organizationId,
        customerId: invoice.customerId,
        kind: 'delivery_note',
        status: 'draft',
        issueDate,
        dueDate: '',
        title: 'Delivery challan',
        items: invoice.items.map(({ pricing: _pricing, ...item }) => ({ ...item, rate: 0, gstRate: 0 })),
        discountPercent: 0,
        placeOfSupply: invoice.placeOfSupply,
        notes: '',
        terms: '',
        shipping,
        gstRegistrationId: invoice.gstRegistrationId,
        branding: invoice.branding,
        businessProductId: invoice.businessProductId,
      };
      const result = newDocument(input, invoice.organizationSnapshot, invoice.customerSnapshot, invoice);
      saveDocument({ ...invoice, deliveryNoteId: result.id, updatedAt: now().toISOString() });
      addEvent(
        invoice.id,
        'delivery_note_created',
        `Delivery challan ${result.number} created from this invoice.`,
      );
      created = true;
      return result;
    });
    res.status(created ? 201 : 200).json(document);
  });

  app.get('/api/documents/:id/payments', (req, res) => {
    const document = getDocument(req.params.id);
    if (document.kind !== 'invoice')
      throw new HttpError(400, 'Payments can be recorded only against invoices.');
    res.json(paymentDetails(document.id));
  });
  app.put('/api/documents/:id/installments', (req, res) => {
    const { plan } = z.object({ plan: installmentPlanSchema.nullable() }).parse(req.body);
    const details = transaction(db, () => {
      const document = getDocument(req.params.id);
      if (document.kind !== 'invoice')
        throw new HttpError(400, 'This installment schedule action is available for invoices only.');
      if (document.finalizedAt || document.status === 'cancelled')
        throw new HttpError(409, 'Finalized or cancelled invoices cannot change their installment schedule.');
      validateInstallmentTotal(plan, document.totals.total);
      if (JSON.stringify(document.installmentPlan ?? null) !== JSON.stringify(plan)) {
        saveDocument({ ...document, installmentPlan: plan, updatedAt: now().toISOString() });
        recordPlanChange(document.id, document.installmentPlan, plan);
      }
      return paymentDetails(document.id);
    });
    res.json(details);
  });
  function recordPayment(documentId: string, input: z.infer<typeof paymentSchema>) {
    const document = getDocument(documentId);
    if (document.kind !== 'invoice')
      throw new HttpError(400, 'Payments can be recorded only against invoices.');
    const previous = db
      .prepare('SELECT data FROM payments WHERE document_id = ? AND request_id = ?')
      .get(document.id, input.requestId) as Row | undefined;
    if (previous) {
      const saved = decode<PaymentRecord>(previous);
      const comparable = paymentSchema.parse(saved);
      if (JSON.stringify(comparable) !== JSON.stringify(input))
        throw new HttpError(
          409,
          'This payment request ID was already used with different details. Review the existing payment before retrying.',
        );
      return { created: false, payment: saved, details: paymentDetails(document.id) };
    }
    if (document.status === 'cancelled')
      throw new HttpError(409, 'Payments cannot be recorded against a cancelled invoice.');
    if (document.finalizedAt) throw new HttpError(409, 'This invoice is already finalized and fully paid.');
    const paise = Math.round(input.amount * 100);
    const outstanding = Math.round(document.totals.total * 100) - activePaidPaise(document.id);
    if (paise > outstanding) throw new HttpError(409, 'Payment exceeds the outstanding balance.');
    const payment: PaymentRecord = {
      ...input,
      amount: paise / 100,
      id: randomUUID(),
      documentId: document.id,
      organizationId: document.organizationId,
      createdAt: now().toISOString(),
      voidedAt: null,
      voidReason: '',
    };
    db.prepare(
      'INSERT INTO payments (id, document_id, organization_id, request_id, amount_paise, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(payment.id, document.id, document.organizationId, input.requestId, paise, JSON.stringify(payment));
    addEvent(
      document.id,
      'payment_recorded',
      `Payment of INR ${payment.amount.toFixed(2)} recorded by ${payment.method.replaceAll('_', ' ')}${payment.reference ? `; reference ${payment.reference}` : ''}.`,
    );
    updatePaymentBalance(document, input.finalizeWhenPaid);
    return { created: true, payment, details: paymentDetails(document.id) };
  }
  app.post('/api/documents/:id/payments', (req, res) => {
    const input = paymentSchema.parse(req.body);
    const today = businessDateInIndia(now());
    if (input.paidOn > today) throw new HttpError(400, 'Payment date cannot be in the future.');
    if (/^(razorpay|cashfree):/.test(input.requestId))
      throw new HttpError(400, 'This receipt identifier is reserved for verified gateway payments.');
    const result = transaction(db, () => {
      online.assertManualChangesAllowed(req.params.id);
      const recorded = recordPayment(req.params.id, input);
      if (recorded.created)
        mailer.enqueuePayment(recorded.details.document, {
          eventKey: `receipt:${recorded.payment.id}`,
          outcome: recorded.details.document.balanceDue === 0 ? 'paid' : 'received',
          amount: recorded.payment.amount,
          reference: recorded.payment.reference,
          automatic: true,
        });
      return recorded;
    });
    res.status(result.created ? 201 : 200).json(result.details);
  });
  app.post('/api/payments/:id/void', (req, res) => {
    const { reason } = voidPaymentSchema.parse(req.body);
    const details = transaction(db, () => {
      const payment = getPayment(req.params.id);
      if (/^(razorpay|cashfree):/.test(payment.requestId))
        throw new HttpError(
          409,
          'Verified gateway receipts cannot be manually voided. Handle a refund with the payment provider and reconcile it separately.',
        );
      online.assertManualChangesAllowed(payment.documentId);
      const document = getDocument(payment.documentId);
      if (payment.voidedAt) {
        if (reason !== payment.voidReason)
          throw new HttpError(409, 'This payment is already voided. Its original reason is preserved.');
        return paymentDetails(document.id);
      }
      const voided: PaymentRecord = { ...payment, voidedAt: now().toISOString(), voidReason: reason };
      db.prepare('UPDATE payments SET data = ? WHERE id = ?').run(JSON.stringify(voided), payment.id);
      addEvent(
        document.id,
        'payment_voided',
        `Payment of INR ${payment.amount.toFixed(2)} voided. Reason: ${reason}`,
      );
      if (document.finalizedAt)
        addEvent(
          document.id,
          'invoice_reopened',
          'Finalized invoice reopened after a payment was voided. Prior finalization remains in this audit history.',
        );
      updatePaymentBalance(document, false, true);
      return paymentDetails(document.id);
    });
    res.json(details);
  });
  app.post('/api/documents/:id/finalize', (req, res) => {
    const details = transaction(db, () => {
      const document = getDocument(req.params.id);
      if (document.kind !== 'invoice') throw new HttpError(400, 'Only invoices can be finalized.');
      if (document.finalizedAt) return paymentDetails(document.id);
      if (document.status === 'cancelled')
        throw new HttpError(409, 'A cancelled invoice cannot be finalized.');
      if (activePaidPaise(document.id) !== Math.round(document.totals.total * 100))
        throw new HttpError(409, 'Record the full outstanding payment before finalizing this invoice.');
      const finalized = updatePaymentBalance(document, true);
      mailer.enqueuePayment(finalized, {
        eventKey: `invoice-finalized:${document.id}:${finalized.finalizedAt}`,
        outcome: 'paid',
        automatic: true,
      });
      return paymentDetails(document.id);
    });
    res.json(details);
  });

  app.get('/api/gst/captcha', async (req, res) => {
    res.json(await portal.captcha(req.ip ?? 'local'));
  });
  app.post('/api/gst/lookup', async (req, res) => {
    const input = z
      .object({
        gstin: z
          .string()
          .trim()
          .transform((value) => value.toUpperCase())
          .refine(validGstin, 'Enter a valid GSTIN.'),
        challengeId: z.string().uuid(),
        captcha: z
          .string()
          .trim()
          .regex(/^\d{6}$/, 'Enter the six digits shown in the CAPTCHA.'),
      })
      .parse(req.body);
    const result = await portal.lookup(req.ip ?? 'local', input.gstin, input.challengeId, input.captcha);
    const normalized = lookupResultSchema.safeParse(result);
    if (!normalized.success)
      throw new HttpError(
        502,
        'The GST public portal returned incomplete or invalid taxpayer details. Enter customer details manually.',
      );
    res.json(normalized.data);
  });
  app.get('/api/gst/:gstin', async (req, res) => {
    const number = req.params.gstin.trim().toUpperCase();
    if (!validGstin(number))
      throw new HttpError(400, 'Enter a valid 15-character GSTIN, including its check digit.');
    if (gstProvider === 'sandbox') {
      const user = res.locals.user as AuthUser | undefined;
      res.json(await sandboxGst.lookup(number, user?.id ?? req.ip ?? 'local'));
      return;
    }
    if (gstProvider !== 'generic' || !lookupUrl)
      throw new HttpError(
        503,
        'GST lookup is not configured yet. Add your GST provider endpoint in server settings, or enter the customer details manually.',
      );
    try {
      const response = await fetcher(lookupUrl.replaceAll('{gstin}', encodeURIComponent(number)), {
        headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (response.status === 404) throw new HttpError(404, 'No taxpayer was found for this GSTIN.');
      if (!response.ok)
        throw new HttpError(
          502,
          'The GST provider could not complete this lookup. Check the provider configuration or try again.',
        );
      const body = await readLimited(response, 128000);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      const wrapped =
        parsed && typeof parsed === 'object' && 'data' in parsed
          ? (parsed as { data: unknown }).data
          : parsed;
      const result = lookupResultSchema.parse(wrapped);
      if (result.gstin !== number) throw new Error('Provider returned another GSTIN');
      res.json(result);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(
        502,
        'The GST provider returned an invalid response or did not respond in time. You can enter customer details manually.',
      );
    }
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found.')));
  const dist = options.distPath ?? resolve('dist');
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
  }
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      // Close interrupted downloads without serializing errors into a started response.
      res.destroy();
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: error.issues.map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join(' '),
      });
    } else if (
      error instanceof HttpError ||
      error instanceof PortalError ||
      error instanceof SandboxGstError ||
      error instanceof EmailQueueError ||
      error instanceof OnlinePaymentError
    ) {
      res.status(error.status).json({ error: error.message });
    } else if (error instanceof DatabaseBackupError) {
      res.status(error.code === 'not_found' ? 404 : 503).json({ error: error.message });
    } else if (error instanceof URIError) {
      res.status(400).json({ error: 'The request URL contains an invalid identifier.' });
    } else if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: 'Request body must contain valid JSON.' });
    } else if (error && error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large.' });
    } else {
      // Do not reflect database paths, upstream responses or credentials into API errors.
      res.status(500).json({ error: 'Unable to complete the request. Please try again.' });
    }
  };
  app.use(errorHandler);
  return app;
}
