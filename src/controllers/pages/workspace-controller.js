/**
 * Page controller for all server-rendered screens (login pages and /workspace/...).
 *
 * For a workspace URL it: checks the session, parses the route
 * (/workspace/<businessId>/<view>/<action>/<id>), enforces admin-only pages, loads the
 * page data (src/services/pages/workspace-data.js), picks the EJS view and its
 * stylesheets, and renders views/layouts/workspace.ejs. CSV downloads are streamed here too.
 */

import { helpers } from './view-helpers.js';
import { readWorkspaceRoute, safeWorkspaceReturn } from '../../../public/js/core/workspace-route.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Browser tab / page heading for each workspace view.
const titles = {
  overview: 'Overview',
  invoices: 'Invoices',
  quotations: 'Quotations',
  proformas: 'Proforma invoices',
  shipping: 'Delivery challans',
  customers: 'Contacts',
  ledger: 'Customer ledger',
  gst_returns: 'GST returns (GSTR-1)',
  expenses: 'Expenses',
  credit_notes: 'Credit notes',
  reports: 'Reports',
  reminders: 'Payment reminders',
  recurring: 'Recurring invoices',
  organizations: 'Businesses',
  catalog: 'Products & services',
  formats: 'Document formats',
  business_products: 'Business products',
  team: 'Team access',
  sessions: 'My sessions',
  security: 'Security activity',
  integrations: 'Payments & email',
  backups: 'Database backups',
  business_settings: 'Business settings',
  dashboard_branding: 'Workspace branding',
  help: 'Workspace help',
};
// Views only administrators may open.
const adminViews = new Set([
  'team',
  'security',
  'backups',
  'business_settings',
  'dashboard_branding',
  'integrations',
]);
// Document screens share one ordered set; the order matches the former single documents.css cascade.
const documentStyles = [
  'documents/editor',
  'documents/paper',
  'documents/pages',
  'documents/pricing',
  'documents/payments',
  'documents/online-payments',
  'documents/messaging',
  'documents/forms',
];
/** Page-specific stylesheets, loaded after the global app.css and management.css. */
const pageStylesheets = {
  'documents/editor': documentStyles,
  'documents/preview': documentStyles,
  'documents/email': documentStyles,
  'payments/panel': documentStyles,
  'workspace/documents': ['document-list'],
  'ledger/index': ['receivables'],
  'gst/gstr1': ['receivables'],
  'expenses/index': ['receivables'],
  'credit-notes/index': ['receivables'],
  'credit-notes/print': ['receivables'],
  'reports/index': ['receivables'],
  'ledger/statement': ['receivables'],
  'reminders/index': ['receivables'],
  'recurring/index': ['recurring'],
  'team/index': ['security'],
  'security/sessions': ['security'],
  'security/activity': ['security'],
};
// Workspace sections that show documents, mapped to the stored document kind.
const documentKinds = {
  invoices: 'invoice',
  quotations: 'quotation',
  proformas: 'proforma',
  shipping: 'delivery_note',
};

/** Reads the last selected business from the vc_organization cookie (validated ID or undefined). */
function rememberedOrganization(req) {
  const value = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('vc_organization='));
  if (!value) return undefined;
  try {
    const id = decodeURIComponent(value.slice('vc_organization='.length));
    return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the Express handlers used by src/routes/pages.js: home, authentication, workspace, notFound, error. */
export function createPageController(backend) {
  const { app, auth } = backend;
  const sessionUser = (req) =>
    auth
      ? auth.getSessionUser(req)
      : { id: 'test-user', name: 'Test administrator', role: 'admin', status: 'active', organizationIds: [] };
  const renderError = (res, status, message, data) => {
    const errorData = {
      ...data,
      pageTitle:
        status === 403
          ? 'Access unavailable'
          : status === 404
            ? 'Page not found'
            : 'Unable to open this page',
      status,
      message,
      ...(status >= 500 && typeof res.locals.requestId === 'string'
        ? { requestId: res.locals.requestId }
        : {}),
    };
    return res.status(status).render(data?.organization ? 'layouts/workspace' : 'layouts/public', {
      data: errorData,
      helpers,
      bodyView: 'workspace/error',
    });
  };

  async function home(req, res) {
    const user = await sessionUser(req);
    if (!user) return res.redirect('/login');
    const data = await app.locals.workspaceData(user, undefined, { view: 'home' });
    const remembered = rememberedOrganization(req);
    const selected = data.organizations.find((org) => org.id === remembered) || data.organization;
    return res.redirect(`/workspace/${encodeURIComponent(selected.id)}/overview`);
  }

  async function authentication(req, res) {
    const authView = req.path.slice(1);
    const user = await sessionUser(req);
    if (user && ['login', 'signup'].includes(authView))
      return res.redirect(safeWorkspaceReturn(String(req.query.returnTo || '')) || '/');
    const data = {
      authView,
      pageTitle: {
        login: 'Welcome back',
        signup: 'Create your account',
        'forgot-password': 'Reset your password',
        'reset-password': 'Set a new password',
      }[authView],
      returnTo: safeWorkspaceReturn(String(req.query.returnTo || '')) || '',
      token:
        typeof req.query.token === 'string' && /^[a-f0-9]{64}$/.test(req.query.token) ? req.query.token : '',
    };
    res.set('Cache-Control', 'no-store');
    return res.render('layouts/public', { data, helpers, bodyView: 'auth/index' });
  }

  async function workspace(req, res) {
    const user = await sessionUser(req);
    if (!user) return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    const [path, search = ''] = req.originalUrl.split('?');
    const route = readWorkspaceRoute(path, search);
    if (!route || route.view === 'not_found')
      return renderError(res, 404, 'This workspace address is not available.');
    // Administrators who must use two-step login are sent to My sessions until it is on.
    if (auth?.twoStepSetupRequired(user) && route.view !== 'sessions' && route.organizationId)
      return res.redirect(`/workspace/${encodeURIComponent(route.organizationId)}/sessions`);
    if (
      user.role !== 'admin' &&
      (adminViews.has(route.view) ||
        (route.view === 'organizations' && route.action) ||
        (route.view === 'recurring' && route.action === 'new'))
    ) {
      return renderError(res, 403, 'Administrator access is required for this page.');
    }
    let data;
    try {
      if (
        ((documentKinds[route.view] && !route.action) ||
          ['ledger', 'gst_returns', 'expenses'].includes(route.view)) &&
        req.query.download === 'csv'
      ) {
        const exportFile =
          {
            ledger: app.locals.ledgerExport,
            gst_returns: app.locals.gstr1Export,
            expenses: app.locals.expenseExport,
          }[route.view] ?? app.locals.documentExport;
        const exported = await exportFile(user, route.organizationId, {
          ...route,
          query: req.query,
        });
        res.set('Cache-Control', 'no-store');
        res.attachment(exported.filename);
        res.type('text/csv; charset=utf-8');
        await pipeline(Readable.from(exported.lines), res);
        return;
      }
      data = await app.locals.workspaceData(user, route.organizationId, { ...route, query: req.query });
      if (['sessions', 'security'].includes(route.view) && !auth)
        return renderError(res, 403, 'Account security requires an authenticated workspace.', data);
      if (route.view === 'sessions') {
        data.securitySessions = await auth.sessionPage(req);
        data.twoStepSetupRequired = auth.twoStepSetupRequired(user);
      }
      if (route.view === 'security') data.securityAudit = await auth.listAudit(user, req.query);
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        app.locals.reportError?.(error, req, 500);
        if (!res.destroyed) res.destroy();
        return;
      }
      const status = error.status >= 400 && error.status < 500 ? error.status : 500;
      app.locals.reportError?.(error, req, status);
      return renderError(
        res,
        status,
        status < 500 ? error.message : 'The workspace could not be loaded. Please retry.',
      );
    }
    Object.assign(data, { route: { ...route, entityId: route.id }, pageTitle: titles[route.view] });
    const returnTo = typeof req.query.returnTo === 'string' ? safeWorkspaceReturn(req.query.returnTo) : null;
    if (returnTo) data.returnTo = returnTo;
    let bodyView;
    if (documentKinds[route.view]) {
      if (route.id && !data.document)
        return renderError(res, 404, 'This document is unavailable in the selected business.', data);
      bodyView =
        {
          new: 'documents/editor',
          edit: 'documents/editor',
          preview: 'documents/preview',
          payments: 'payments/panel',
          email: 'documents/email',
          delete: 'workspace/delete-document',
        }[route.action] || 'workspace/documents';
    } else {
      bodyView = {
        overview: 'workspace/overview',
        customers: 'contacts/index',
        ledger: route.id ? 'ledger/statement' : 'ledger/index',
        gst_returns: 'gst/gstr1',
        expenses: 'expenses/index',
        credit_notes: route.id ? 'credit-notes/print' : 'credit-notes/index',
        reports: 'reports/index',
        reminders: 'reminders/index',
        recurring: 'recurring/index',
        organizations: 'organizations/index',
        business_settings: 'organizations/index',
        dashboard_branding: 'settings/branding',
        catalog: 'catalog/index',
        business_products: 'business-products/index',
        formats: 'formats/index',
        team: 'team/index',
        sessions: 'security/sessions',
        security: 'security/activity',
        backups: 'backups/index',
        integrations: 'integrations/index',
        help: 'workspace/help',
      }[route.view];
    }
    if (!bodyView) return renderError(res, 404, 'This page is not available.', data);
    res.set('Cache-Control', 'no-store');
    const stylesheets = (pageStylesheets[bodyView] || []).map((name) => `/css/${name}.css`);
    return res.render('layouts/workspace', { data, helpers, bodyView, stylesheets });
  }

  return {
    home,
    authentication,
    workspace,
    notFound: (_req, res) => renderError(res, 404, 'Check the address or return to your workspace.'),
    error(error, req, res, _next) {
      if (res.headersSent) return _next(error);
      if (req.path.startsWith('/api/')) return app.locals.errorHandler(error, req, res, _next);
      app.locals.reportError?.(error, req, error.status || 500);
      return renderError(
        res,
        error.status || 500,
        error.status && error.status < 500
          ? error.message
          : 'The workspace could not complete this request. Please retry.',
      );
    },
  };
}
