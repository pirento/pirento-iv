/**
 * Workspace URL rules shared by the server (page routing) and the browser.
 * URL shape: /workspace/<businessId>/<view>/<action>/<id>?role=&itemType=&documentId=...
 */

// Every valid <view> in a workspace URL.
export const WORKSPACE_VIEWS = [
  'overview',
  'invoices',
  'quotations',
  'proformas',
  'shipping',
  'customers',
  'ledger',
  'gst_returns',
  'reminders',
  'recurring',
  'organizations',
  'catalog',
  'formats',
  'business_products',
  'team',
  'sessions',
  'security',
  'integrations',
  'backups',
  'business_settings',
  'dashboard_branding',
  'help',
];
// Browser event fired after changeLocation() switches the URL without a page load.
export const ROUTE_EVENT = 'venturecore:route';
const validPart = (value) => value.length <= 200 && /^[a-zA-Z0-9_-]+$/.test(value);
const managerViews = new Set(['customers', 'catalog', 'formats', 'business_products']);
const documentViews = new Set(['invoices', 'quotations', 'proformas', 'shipping']);
/**
 * Parses and validates a workspace URL into { organizationId, view, action?, id?, ...query }.
 * Returns null for auth pages and { view: 'not_found' } for anything invalid.
 */
export function readWorkspaceRoute(pathname, search = '') {
  if (pathname === '/' || ['/login', '/signup', '/forgot-password', '/reset-password'].includes(pathname))
    return null;
  let parts;
  try {
    parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return {
      organizationId: '',
      view: 'not_found',
    };
  }
  const organizationId = validPart(parts[1] || '') ? parts[1] : '';
  const invalid = {
    organizationId,
    view: 'not_found',
  };
  if (parts[0] !== 'workspace' || !organizationId || parts.length < 3 || parts.length > 5) return invalid;
  const view = parts[2];
  if (!WORKSPACE_VIEWS.includes(view)) return invalid;
  const action = parts[3];
  const id = parts[4];
  if (id && !validPart(id)) return invalid;
  if (action) {
    if (!['new', 'edit', 'preview', 'payments', 'email', 'delete'].includes(action)) return invalid;
    if (documentViews.has(view)) {
      if ((action === 'new' && id) || (action !== 'new' && !id)) return invalid;
      if (action === 'payments' && view !== 'invoices') return invalid;
    } else if (view === 'ledger') {
      if (action !== 'preview' || !id) return invalid;
    } else if (view === 'recurring') {
      if (!['new', 'edit'].includes(action) || (action === 'new' ? Boolean(id) : !id)) return invalid;
    } else if (managerViews.has(view) || view === 'organizations') {
      if (!['new', 'edit', 'delete'].includes(action) || (action !== 'new' && !id)) return invalid;
      if (view === 'organizations' && (action === 'delete' || (action === 'new' && id))) return invalid;
    } else return invalid;
  } else if (id) return invalid;
  const params = new URLSearchParams(search);
  const role = params.get('role');
  const itemType = params.get('itemType');
  const suggestion = params.get('suggestion');
  const businessProductId = params.get('businessProductId');
  const documentId = params.get('documentId');
  return {
    organizationId,
    view,
    ...(action
      ? {
          action,
        }
      : {}),
    ...(id
      ? {
          id,
        }
      : {}),
    ...(['customer', 'vendor', 'b2b_buyer'].includes(role || '')
      ? {
          role: role,
        }
      : {}),
    ...(itemType === 'product' || itemType === 'service'
      ? {
          itemType,
        }
      : {}),
    ...(suggestion && suggestion.length <= 200
      ? {
          suggestion,
        }
      : {}),
    ...(businessProductId && validPart(businessProductId)
      ? {
          businessProductId,
        }
      : {}),
    ...(documentId && validPart(documentId) ? { documentId } : {}),
  };
}
/** Builds a workspace URL from a route object (the reverse of readWorkspaceRoute). */
export function workspaceUrl(route) {
  const params = new URLSearchParams();
  for (const key of ['role', 'itemType', 'suggestion', 'businessProductId', 'documentId'])
    if (route[key]) params.set(key, route[key]);
  const path = `/workspace/${encodeURIComponent(route.organizationId)}/${route.view}${route.action ? `/${route.action}${route.id ? `/${encodeURIComponent(route.id)}` : ''}` : ''}`;
  return `${path}${params.size ? `?${params}` : ''}`;
}
/** A "returnTo" value is only accepted when it is a valid workspace URL; otherwise null. */
export function safeWorkspaceReturn(value) {
  if (!value.startsWith('/workspace/') || value.startsWith('//')) return null;
  const [path, query = ''] = value.split('?');
  const route = readWorkspaceRoute(path, query);
  return route && route.view !== 'not_found' ? workspaceUrl(route) : null;
}
/** Changes the URL within this site without reloading (history.pushState) and fires ROUTE_EVENT. */
export function changeLocation(url, replace = false) {
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin || !url.startsWith('/') || url.startsWith('//'))
    throw new Error('Invalid workspace navigation.');
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === url) return;
  const state = {
    workspaceFrom: `${window.location.pathname}${window.location.search}`,
  };
  window.history[replace ? 'replaceState' : 'pushState'](state, '', url);
  window.dispatchEvent(new Event(ROUTE_EVENT));
  window.scrollTo({
    top: 0,
    behavior: 'auto',
  });
}
