/**
 * API route table: every /api URL and the controller handler that serves it.
 *
 * Request pipeline for /api (in order): security headers -> payment-provider webhooks
 * (raw body, no session) -> query validation -> same-origin and JSON checks -> body parser
 * -> /api/auth routes -> health probes -> session + CSRF + organization access checks
 * -> resource handlers -> 404 -> JSON error handler (src/middleware/api-errors.js).
 *
 * To add an endpoint: write the handler in src/controllers/api/<resource>.controller.js,
 * then register the path here.
 */

import express from 'express';
import { securityHeaders, validateResourceQueries } from '../middleware/http-security.js';
import { createAccessGuard } from '../middleware/access.js';
import { HttpError } from '../middleware/errors.js';

/** Registers all /api middleware and routes on the Express app, in the order shown above. */
export function registerApiRoutes(app, context) {
  const { controllers, auth, online, db, environment, errorHandler } = context;
  app.use(securityHeaders(environment.NODE_ENV === 'production'));
  app.post(
    '/api/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.razorpay,
  );
  app.post(
    '/api/webhooks/razorpay/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.razorpayForOrganization,
  );
  app.post(
    '/api/webhooks/cashfree/:organizationId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    controllers.webhooks.cashfreeForOrganization,
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
  app.get('/api/health', controllers.health.status);
  app.get('/api/ready', controllers.health.ready);
  if (auth)
    app.use('/api', auth.requireSession, auth.mutationGuard, auth.requireTwoStepSetup, createAccessGuard(db));
  if (auth) app.use('/api/backups', auth.requireAdmin);
  app.use('/api', online.router);
  app.get('/api/backups/status', controllers.backups.status);
  app.get('/api/backups', controllers.backups.list);
  app.post('/api/backups', controllers.backups.create);
  app.get('/api/backups/:id/download', controllers.backups.download);
  app.get('/api/backups/:id/manifest', controllers.backups.manifest);
  app.get('/api/integrations/status', controllers.integrations.status);
  app.get('/api/ledger', controllers.ledger.list);
  app.get('/api/ledger/export', controllers.ledger.exportBalances);
  app.get('/api/ledger/:customerId/export', controllers.ledger.exportStatement);
  app.get('/api/ledger/:customerId', controllers.ledger.statement);
  app.get('/api/reminders', controllers.reminders.list);
  app.get('/api/reminders/history', controllers.reminders.history);
  app.get('/api/reminders/policy', controllers.reminders.getPolicy);
  app.put('/api/reminders/policy', controllers.reminders.updatePolicy);
  app.get('/api/documents/:id/reminder-preview', controllers.reminders.preview);
  app.post('/api/documents/:id/reminders', controllers.reminders.queue);
  app.get('/api/recurring-invoices', controllers.recurring.list);
  app.get('/api/recurring-invoices/sources', controllers.recurring.sources);
  app.get('/api/recurring-invoices/:id', controllers.recurring.show);
  app.post('/api/recurring-invoices', controllers.recurring.create);
  app.put('/api/recurring-invoices/:id', controllers.recurring.update);
  app.post('/api/recurring-invoices/:id/status', controllers.recurring.setStatus);
  app.post('/api/recurring-invoices/:id/generate', controllers.recurring.generate);
  app.get('/api/documents/:id/messages', controllers.documents.listMessages);
  app.post('/api/documents/:id/email', controllers.documents.sendEmail);
  app.post('/api/messages/:id/retry', controllers.messages.retry);
  app.get('/api/workspace-settings', controllers.workspaceSettings.get);
  app.put('/api/workspace-settings', controllers.workspaceSettings.update);
  app.get('/api/organizations', controllers.organizations.list);
  app.post('/api/organizations', controllers.organizations.create);
  app.put('/api/organizations/:id', controllers.organizations.update);
  app.get('/api/business-products', controllers.businessProducts.list);
  app.post('/api/business-products', controllers.businessProducts.create);
  app.put('/api/business-products/:id', controllers.businessProducts.update);
  app.get('/api/catalog/lookup', controllers.catalog.lookup);
  app.get('/api/catalog/export', controllers.catalog.export);
  app.get('/api/catalog', controllers.catalog.list);
  app.post('/api/catalog', controllers.catalog.create);
  app.put('/api/catalog/:id', controllers.catalog.update);
  app.get('/api/formats', controllers.formats.list);
  app.post('/api/formats', controllers.formats.create);
  app.put('/api/formats/:id', controllers.formats.update);
  app.delete('/api/formats/:id', controllers.formats.remove);
  app.get('/api/customers/lookup', controllers.customers.lookup);
  app.get('/api/customers/export', controllers.customers.export);
  app.get('/api/customers', controllers.customers.list);
  app.post('/api/customers', controllers.customers.create);
  app.put('/api/customers/:id', controllers.customers.update);
  app.delete('/api/customers/:id', controllers.customers.remove);
  app.get('/api/documents', controllers.documents.list);
  app.post('/api/documents', controllers.documents.create);
  app.put('/api/documents/:id', controllers.documents.update);
  app.delete('/api/documents/:id', controllers.documents.remove);
  app.post('/api/documents/:id/convert', controllers.documents.convert);
  app.post('/api/documents/:id/delivery-note', controllers.documents.createDeliveryNote);
  app.get('/api/documents/:id/payments', controllers.documents.listPayments);
  app.put('/api/documents/:id/installments', controllers.documents.updateInstallments);
  app.post('/api/documents/:id/payments', controllers.documents.recordPayment);
  app.post('/api/payments/:id/void', controllers.payments.voidPayment);
  app.post('/api/documents/:id/finalize', controllers.documents.finalize);
  app.get('/api/gst/captcha', controllers.gst.captcha);
  app.post('/api/gst/lookup', controllers.gst.lookup);
  app.get('/api/gst/:gstin', controllers.gst.lookupByGstin);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found.')));
  app.use(errorHandler);
}
