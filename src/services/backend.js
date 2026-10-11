import { createApiControllers } from '../controllers/api/index.js';
import { registerApiRoutes } from '../routes/api.js';
import { createWorkspaceService } from './workspace-service.js';
import { HttpError, createErrorReporter, createRequestDiagnostics } from '../middleware/errors.js';
export { HttpError } from '../middleware/errors.js';
import express from 'express';
import { createHash } from 'node:crypto';
import { createAuth } from './auth/auth.js';
import { createWorkspacePageData } from './pages/workspace-data.js';
import { createMailer, EmailQueueError } from './integrations/email/mailer.js';
import { OnlinePaymentError } from './integrations/payments/online-payments.js';
import { createPaymentGateways } from './integrations/payments/payment-gateways.js';
import { renderInvoiceAttachment } from './documents/invoice-pdf.js';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import { initDb } from '../config/database.js';
import { configureTrustedProxy } from '../config/trusted-proxy.js';
import { paymentSchema } from './validation/validation.js';
import { createGstPortal, PortalError } from './integrations/gst/gst-portal.js';
import { createSandboxGst, SandboxGstError } from './integrations/gst/sandbox-gst.js';
import {
  createDatabaseBackupService,
  parseDatabaseBackupConfig,
  DatabaseBackupError,
} from './operations/database-backup.js';
import { createBackupManager } from './operations/backup-scheduler.js';
import { assertDatabaseRecoveryReviewed } from './operations/recovery.js';
import { createLogger } from './operations/logger.js';
import { createReadiness } from './operations/readiness.js';
import { createAutomationRunner } from './operations/automation-runner.js';
import { createCustomerLedger } from './ledger/customer-ledger.js';
import { createPaymentReminders } from './integrations/email/payment-reminders.js';
import { createRecurringInvoices } from './recurring/recurring-invoices.js';
function configuredLookupUrl(template) {
  if (!template || !template.includes('{gstin}')) return undefined;
  try {
    const url = new URL(template.replaceAll('{gstin}', '27AAACR5055K1Z7'));
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return template;
  } catch {
    return undefined;
  }
}
export async function createApp(options = {}) {
  const environment = options.environment ?? process.env;
  const db =
    options.db ??
    (await initDb({
      environment,
    }));
  try {
    return await initializeApplication(options, environment, db);
  } catch (error) {
    // The caller retains ownership of a supplied database context. A connection
    // opened here must be released even when recovery or configuration rejects startup.
    if (!options.db) await db.close().catch(() => {});
    throw error;
  }
}

async function initializeApplication(options, environment, db) {
  await assertDatabaseRecoveryReviewed(db);
  const app = express();
  configureTrustedProxy(app, environment);
  app.disable('x-powered-by');
  const logger = options.logger ?? createLogger();
  const readiness = createReadiness({ db, logger, timeoutMs: options.readinessTimeoutMs });
  const requestDiagnostics = createRequestDiagnostics(logger, readiness);
  const reportError = createErrorReporter(logger);
  app.locals.requestDiagnostics = requestDiagnostics;
  app.locals.reportError = reportError;
  app.use(requestDiagnostics);
  const lookupUrl = configuredLookupUrl(options.gstLookupUrl ?? environment.GST_LOOKUP_URL);
  const apiKey = options.gstApiKey ?? environment.GST_API_KEY;
  const fetcher = options.fetch ?? globalThis.fetch;
  const portal = createGstPortal(fetcher);
  const now = options.now ?? (() => new Date());
  const backupConfig = parseDatabaseBackupConfig(environment, undefined);
  for (const root of ['public', 'shared', 'src', 'views', 'scripts'].map((name) => resolve(name))) {
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
  const backups = createBackupManager({
    service: backupStorage,
    ...backupConfig,
    now,
    logger,
  });
  const requestedGstProvider = environment.GST_PROVIDER?.trim().toLowerCase();
  if (requestedGstProvider && !['portal', 'generic', 'sandbox'].includes(requestedGstProvider))
    throw new Error('GST_PROVIDER must be portal, generic or sandbox.');
  const gstProvider = requestedGstProvider || (lookupUrl ? 'generic' : 'portal');
  const sandboxGst = createSandboxGst({
    environment,
    fetch: fetcher,
    now: () => now().getTime(),
  });
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
  let mailer, online;
  const workspace = createWorkspaceService({
    db,
    now,
    get mailer() {
      return mailer;
    },
    get online() {
      return online;
    },
  });
  const {
    getOrganization,
    getCustomer,
    getDocument,
    getPayment,
    activePaidPaise,
    addEvent,
    paymentDetails,
    updatePaymentBalance,
    getCatalogItem,
    getBusinessProduct,
    selectBusinessProduct,
    assertProductCodeAvailable,
    validateInstallmentTotal,
    recordPlanChange,
    getFormat,
    selectFormat,
    assertSkuAvailable,
    validateCatalogReferences,
    saveFormat,
    scopedOrganization,
    assertPrefixesAvailable,
    validateTax,
    nextNumber,
    saveDocument,
    sellerRegistration,
    newDocument,
    emailIssuedDocument,
    recordPayment,
    fiscalYear,
  } = workspace;
  mailer = createMailer(db, {
    env: environment,
    fetch: options.emailFetch,
    now,
    renderInvoiceAttachment,
    getOrganization,
    resolveInvoicePaymentUrl: async (queued) => {
      const current = await getDocument(queued.id);
      if (current.status === 'cancelled' || current.status === 'draft')
        throw new Error('The document is no longer issued for payment.');
      if (
        current.finalizedAt ||
        Math.round(current.totals.total * 100) === (await activePaidPaise(current.id))
      )
        return {
          document: current,
        };
      const result = await online.createPaymentLink(current.id);
      const paymentUrl = result.links.find((link) => ['created', 'partially_paid'].includes(link.state))?.url;
      if (!paymentUrl) throw new Error('No verified payment link is available yet.');
      return {
        document: await getDocument(current.id),
        paymentUrl,
      };
    },
  });
  const auth =
    options.auth === false
      ? null
      : createAuth(db, {
          environment,
          logger,
          now: () => now().getTime(),
          ...(options.auth || {}),
          ...((await mailer.status()).configured && environment.PUBLIC_APP_URL
            ? {
                sendPasswordReset: async ({ to, name, token }) => {
                  const resetUrl = `${new URL(environment.PUBLIC_APP_URL).origin}/reset-password?token=${encodeURIComponent(token)}`;
                  await mailer.enqueuePasswordReset({
                    to,
                    name,
                    resetUrl,
                    eventKey: `password-reset:${createHash('sha256').update(token).digest('hex')}`,
                  });
                },
              }
            : {}),
        });
  online = createPaymentGateways({
    db,
    env: environment,
    fetch: options.paymentFetch,
    now,
    getDocument,
    getOrganization,
    listOrganizations: async () => await db.models.organizations.list(),
    recordVerifiedPayment: async (input) =>
      (
        await recordPayment(
          input.documentId,
          paymentSchema.parse({
            ...input,
            method: 'other',
            finalizeWhenPaid: true,
          }),
          { providerPaidAt: input.providerPaidAt },
        )
      ).payment,
    notifyPayment: async (notification) => {
      await mailer.enqueuePayment(notification.document, {
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
  const ledger = createCustomerLedger({ db, now, auth: Boolean(auth) });
  const reminders = createPaymentReminders({ db, mailer, now, logger });
  const recurringInvoices = createRecurringInvoices({ db, now, workspace, logger });
  const automations = createAutomationRunner({ recurringInvoices, reminders, logger });
  app.locals.services = {
    auth,
    mailer,
    online,
    db,
    backups,
    backupStorage,
    logger,
    readiness,
    ledger,
    reminders,
    recurringInvoices,
    automations,
  };
  app.locals.initialize = async () => {
    const owner = await auth?.initializeOwner();
    await backups.initialize();
    readiness.markReady();
    return owner ?? null;
  };
  const pageData = createWorkspacePageData({
    db,
    auth,
    online,
    mailer,
    backups,
    backupStorage,
    gstStatus,
    now,
    logger,
    ledger,
    reminders,
    recurringInvoices,
  });
  app.locals.workspaceData = pageData.load;
  app.locals.documentExport = pageData.exportDocuments;
  app.locals.ledgerExport = (user, organizationId, route) =>
    route.id
      ? ledger.exportStatement(user, organizationId, route.id, route.query)
      : ledger.exportCustomers(user, organizationId, route.query);
  app.locals.getDocument = getDocument;
  app.locals.paymentDetails = paymentDetails;
  const errorHandler = (error, req, res, _next) => {
    const sendError = (status, payload) => {
      reportError(error, req, status);
      if (res.headersSent) return res.destroy();
      res.status(status).json({ ...payload, ...(status >= 500 ? { requestId: req.requestId } : {}) });
    };
    if (error instanceof z.ZodError) {
      sendError(400, {
        error: error.issues
          .map(
            (issue) =>
              `${issue.path.join('.') || 'Input'}: ${issue.code === 'invalid_enum_value' ? 'Choose one of the supported values.' : issue.message}`,
          )
          .join(' '),
      });
    } else if (
      error instanceof HttpError ||
      error instanceof PortalError ||
      error instanceof SandboxGstError ||
      error instanceof EmailQueueError ||
      error instanceof OnlinePaymentError
    ) {
      sendError(error.status, {
        error: error.status === 500 ? 'Unable to complete the request. Please try again.' : error.message,
        ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
        ...(error instanceof HttpError && error.document ? { document: error.document } : {}),
      });
    } else if (error instanceof DatabaseBackupError) {
      sendError(error.code === 'not_found' ? 404 : 503, {
        error: error.message,
      });
    } else if (error?.code === 11000) {
      sendError(409, {
        error: 'A record with these unique details already exists. Refresh the workspace before retrying.',
      });
    } else if (error instanceof URIError) {
      sendError(400, {
        error: 'The request URL contains an invalid identifier.',
      });
    } else if (error instanceof SyntaxError && 'body' in error) {
      sendError(400, {
        error: 'Request body must contain valid JSON.',
      });
    } else if (error && error.type === 'entity.too.large') {
      sendError(413, {
        error: 'Request is too large.',
      });
    } else {
      sendError(500, {
        error: 'Unable to complete the request. Please try again.',
      });
    }
  };
  app.locals.errorHandler = errorHandler;
  const controllerContext = {
    environment,
    db,
    auth,
    mailer,
    online,
    portal,
    now,
    readiness,
    ledger,
    reminders,
    recurringInvoices,
    backupConfig,
    backupStorage,
    backups,
    gstProvider,
    sandboxGst,
    gstStatus,
    lookupUrl,
    apiKey,
    fetcher,
    getOrganization,
    getCustomer,
    getDocument,
    getPayment,
    activePaidPaise,
    addEvent,
    paymentDetails,
    updatePaymentBalance,
    getCatalogItem,
    getBusinessProduct,
    selectBusinessProduct,
    assertProductCodeAvailable,
    validateInstallmentTotal,
    recordPlanChange,
    getFormat,
    selectFormat,
    assertSkuAvailable,
    validateCatalogReferences,
    saveFormat,
    scopedOrganization,
    assertPrefixesAvailable,
    validateTax,
    nextNumber,
    saveDocument,
    sellerRegistration,
    newDocument,
    emailIssuedDocument,
    recordPayment,
    fiscalYear,
  };
  const controllers = createApiControllers(controllerContext);
  registerApiRoutes(app, {
    controllers,
    auth,
    online,
    db,
    environment,
    errorHandler,
  });
  return app;
}

/** The HTTP entry point adds EJS page routes after this API application. */
export async function createBackend(options = {}) {
  const app = await createApp(options);
  const services = app.locals.services;
  let closing;
  return {
    app,
    ...services,
    initialize: app.locals.initialize,
    beginShutdown: () => services.readiness.beginDrain(),
    close() {
      if (closing) return closing;
      services.readiness.beginDrain();
      closing = (async () => {
        const workers = await Promise.allSettled([
          services.automations.stop(),
          services.mailer.stop?.(),
          services.backups.stop(),
        ]);
        for (const result of workers)
          if (result.status === 'rejected')
            services.logger.error('shutdown_failed', { error: result.reason });
        try {
          if (!options.db) await services.db.close();
        } finally {
          services.readiness.markStopped();
        }
      })();
      return closing;
    },
  };
}
