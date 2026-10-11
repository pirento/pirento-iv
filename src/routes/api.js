import express from 'express';
import { securityHeaders, validateResourceQueries } from '../middleware/http-security.js';
import { createAccessGuard } from '../middleware/access.js';
import { HttpError } from '../middleware/errors.js';
export function registerApiRoutes(app, context) {
  const { controllers, auth, online, db, environment, errorHandler } = context;
  app.use(securityHeaders(environment.NODE_ENV === 'production'));
  app.post(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.postWebhooksRazorpay,
  );
  app.post(
    '/api/webhooks/razorpay/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.postWebhooksRazorpayOrganizationId,
  );
  app.post(
    '/api/webhooks/cashfree/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.postWebhooksCashfreeOrganizationId,
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
  app.use('/api/auth', express.json({ limit: '16kb' }));
  app.use(express.json({ limit: '12mb' }));
  if (auth) app.use('/api/auth', auth.router);
  app.get('/api/health', controllers.health.getHealth);
  app.get('/api/ready', controllers.health.getReady);
  if (auth) app.use('/api', auth.requireSession, auth.mutationGuard, createAccessGuard(db));
  if (auth) app.use('/api/backups', auth.requireAdmin);
  app.use('/api', online.router);
  app.get('/api/backups/status', controllers.backups.getBackupsStatus);
  app.get('/api/backups', controllers.backups.getBackups);
  app.post('/api/backups', controllers.backups.postBackups);
  app.get('/api/backups/:id/download', controllers.backups.getBackupsIdDownload);
  app.get('/api/backups/:id/manifest', controllers.backups.getBackupsIdManifest);
  app.get('/api/integrations/status', controllers.integrations.getIntegrationsStatus);
  app.get('/api/ledger', controllers.ledger.getLedger);
  app.get('/api/ledger/export', controllers.ledger.exportLedger);
  app.get('/api/ledger/:customerId/export', controllers.ledger.exportLedgerCustomer);
  app.get('/api/ledger/:customerId', controllers.ledger.getLedgerCustomer);
  app.get('/api/reminders', controllers.reminders.getReminders);
  app.get('/api/reminders/history', controllers.reminders.getRemindersHistory);
  app.get('/api/reminders/policy', controllers.reminders.getRemindersPolicy);
  app.put('/api/reminders/policy', controllers.reminders.putRemindersPolicy);
  app.get('/api/documents/:id/reminder-preview', controllers.reminders.getDocumentsIdReminderPreview);
  app.post('/api/documents/:id/reminders', controllers.reminders.postDocumentsIdReminders);
  app.get('/api/recurring-invoices', controllers.recurring.getRecurringInvoices);
  app.get('/api/recurring-invoices/sources', controllers.recurring.getRecurringSources);
  app.get('/api/recurring-invoices/:id', controllers.recurring.getRecurringInvoicesId);
  app.post('/api/recurring-invoices', controllers.recurring.postRecurringInvoices);
  app.put('/api/recurring-invoices/:id', controllers.recurring.putRecurringInvoicesId);
  app.post('/api/recurring-invoices/:id/status', controllers.recurring.postRecurringInvoicesIdStatus);
  app.post('/api/recurring-invoices/:id/generate', controllers.recurring.postRecurringInvoicesIdGenerate);
  app.get('/api/documents/:id/messages', controllers.documents.getDocumentsIdMessages);
  app.post('/api/documents/:id/email', controllers.documents.postDocumentsIdEmail);
  app.post('/api/messages/:id/retry', controllers.messages.postMessagesIdRetry);
  app.get('/api/workspace-settings', controllers.workspaceSettings.getWorkspaceSettings);
  app.put('/api/workspace-settings', controllers.workspaceSettings.putWorkspaceSettings);
  app.get('/api/organizations', controllers.organizations.getOrganizations);
  app.post('/api/organizations', controllers.organizations.postOrganizations);
  app.put('/api/organizations/:id', controllers.organizations.putOrganizationsId);
  app.get('/api/business-products', controllers.businessProducts.getBusinessProducts);
  app.post('/api/business-products', controllers.businessProducts.postBusinessProducts);
  app.put('/api/business-products/:id', controllers.businessProducts.putBusinessProductsId);
  app.get('/api/catalog/lookup', controllers.catalog.lookup);
  app.get('/api/catalog/export', controllers.catalog.export);
  app.get('/api/catalog', controllers.catalog.getCatalog);
  app.post('/api/catalog', controllers.catalog.postCatalog);
  app.put('/api/catalog/:id', controllers.catalog.putCatalogId);
  app.get('/api/formats', controllers.formats.getFormats);
  app.post('/api/formats', controllers.formats.postFormats);
  app.put('/api/formats/:id', controllers.formats.putFormatsId);
  app.delete('/api/formats/:id', controllers.formats.deleteFormatsId);
  app.get('/api/customers/lookup', controllers.customers.lookup);
  app.get('/api/customers/export', controllers.customers.export);
  app.get('/api/customers', controllers.customers.getCustomers);
  app.post('/api/customers', controllers.customers.postCustomers);
  app.put('/api/customers/:id', controllers.customers.putCustomersId);
  app.delete('/api/customers/:id', controllers.customers.deleteCustomersId);
  app.get('/api/documents', controllers.documents.getDocuments);
  app.post('/api/documents', controllers.documents.postDocuments);
  app.put('/api/documents/:id', controllers.documents.putDocumentsId);
  app.delete('/api/documents/:id', controllers.documents.deleteDocumentsId);
  app.post('/api/documents/:id/convert', controllers.documents.postDocumentsIdConvert);
  app.post('/api/documents/:id/delivery-note', controllers.documents.postDocumentsIdDeliveryNote);
  app.get('/api/documents/:id/payments', controllers.documents.getDocumentsIdPayments);
  app.put('/api/documents/:id/installments', controllers.documents.putDocumentsIdInstallments);
  app.post('/api/documents/:id/payments', controllers.documents.postDocumentsIdPayments);
  app.post('/api/payments/:id/void', controllers.payments.postPaymentsIdVoid);
  app.post('/api/documents/:id/finalize', controllers.documents.postDocumentsIdFinalize);
  app.get('/api/gst/captcha', controllers.gst.getGstCaptcha);
  app.post('/api/gst/lookup', controllers.gst.postGstLookup);
  app.get('/api/gst/:gstin', controllers.gst.getGstGstin);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found.')));
  app.use(errorHandler);
}
