/**
 * Composition root: creates every service once and wires them together.
 *
 * Order: database -> logging/readiness -> backups -> GST provider -> workspace service ->
 * mailer -> accounts (auth) -> payment gateways -> ledger, reminders, recurring invoices ->
 * page data -> API controllers and routes. The resulting object (app + services + close())
 * is used by src/app.js, the tests and the preview launcher.
 */

import { createApiControllers } from '../controllers/api/index.js';
import { registerApiRoutes } from '../routes/api.js';
import { createWorkspaceService } from './workspace-service.js';
import { createErrorReporter, createRequestDiagnostics } from '../middleware/errors.js';
import { createApiErrorHandler } from '../middleware/api-errors.js';
export { HttpError } from '../middleware/errors.js';
import express from 'express';
import { createHash } from 'node:crypto';
import { createAuth } from './auth/auth.js';
import { createWorkspacePageData } from './pages/workspace-data.js';
import { createMailer } from './integrations/email/mailer.js';
import { createPaymentGateways } from './integrations/payments/payment-gateways.js';
import { renderInvoiceAttachment } from './documents/invoice-pdf.js';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { initDb } from '../config/database.js';
import { configureTrustedProxy } from '../config/trusted-proxy.js';
import { paymentSchema } from './validation/validation.js';
import { createGstIntegration } from './integrations/gst/gst-config.js';
import { createDatabaseBackupService, parseDatabaseBackupConfig } from './operations/database-backup.js';
import { createBackupManager } from './operations/backup-scheduler.js';
import { assertDatabaseRecoveryReviewed } from './operations/recovery.js';
import { createLogger } from './operations/logger.js';
import { createReadiness } from './operations/readiness.js';
import { createAutomationRunner } from './operations/automation-runner.js';
import { createCustomerLedger } from './ledger/customer-ledger.js';
import { createPaymentReminders } from './integrations/email/payment-reminders.js';
import { createRecurringInvoices } from './recurring/recurring-invoices.js';
import { migrateStoredImages } from '../models/image-store.js';
import { migrateFormatsToTeal } from '../models/workspace-seed.js';
import { createAiAssistant } from './integrations/ai/openai.js';

/**
 * Builds the API application: returns the Express app with the services on app.locals.services
 * and startup work on app.locals.initialize(). createBackend() below wraps it for callers.
 */
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
  const fetcher = options.fetch ?? globalThis.fetch;
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
  const { portal, sandboxGst, gstProvider, gstStatus, lookupUrl, apiKey } = createGstIntegration({
    environment,
    fetcher,
    now,
    lookupUrl: options.gstLookupUrl,
    apiKey: options.gstApiKey,
  });
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
  const { getOrganization, getDocument, activePaidPaise, paymentDetails, recordPayment } = workspace;
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
    await db.models.email.compactSent();
    await migrateStoredImages(db);
    await migrateFormatsToTeal(db);
    const owner = await auth?.initializeOwner();
    await backups.initialize();
    readiness.markReady();
    return owner ?? null;
  };
  const ai = createAiAssistant({
    db,
    environment,
    production: environment.NODE_ENV === 'production',
    fetcher: options.aiFetch,
  });
  const pageData = createWorkspacePageData({
    ai,
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
  app.locals.gstr1Export = pageData.exportGstr1;
  app.locals.expenseExport = pageData.exportExpenses;
  app.locals.financeExport = pageData.exportFinance;
  app.locals.ledgerExport = (user, organizationId, route) =>
    route.id
      ? ledger.exportStatement(user, organizationId, route.id, route.query)
      : ledger.exportCustomers(user, organizationId, route.query);
  app.locals.getDocument = getDocument;
  app.locals.paymentDetails = paymentDetails;
  const errorHandler = createApiErrorHandler(reportError);
  app.locals.errorHandler = errorHandler;
  const controllerContext = {
    ai,
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
    // Controllers destructure the workspace helpers they need (getDocument, saveDocument, ...).
    ...workspace,
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
