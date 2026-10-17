/** Access to the page's server-provided data (<script id="page-data">) and workspace URL helpers. */

import { rememberNotice } from './optional-storage.js';

let cached;
/** The JSON data the server rendered into the page (read once, then cached). */
export function getPageData() {
  if (!cached) cached = JSON.parse(document.getElementById('page-data')?.textContent || '{}');
  return cached;
}

/** Only known local workspace URLs may be used for redirects. */
export function safeReturn(value, fallback = '/') {
  try {
    const target = new URL(value || '', location.origin);
    if (
      target.origin !== location.origin ||
      !/^\/workspace\/[a-zA-Z0-9_-]+\/[a-z_]+(?:\/[a-z]+(?:\/[a-zA-Z0-9_-]+)?)?$/.test(target.pathname)
    )
      return fallback;
    return target.pathname + target.search;
  } catch {
    return fallback;
  }
}

/** URL of a workspace page in the current business, e.g. workspacePath('invoices', 'edit', id). */
export function workspacePath(view, action, id, extra = {}) {
  const organizationId = getPageData().route?.organizationId;
  const path = `/workspace/${encodeURIComponent(organizationId)}/${view}${action ? `/${action}${id ? `/${encodeURIComponent(id)}` : ''}` : ''}`;
  const params = new URLSearchParams(extra);
  return path + (params.size ? `?${params}` : '');
}

/** Shows `message` as a toast after the next navigation. */
export function rememberToast(message) {
  rememberNotice(message);
}
