import { rememberNotice } from './optional-storage.js';

let cached;
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

export function workspacePath(view, action, id, extra = {}) {
  const organizationId = getPageData().route?.organizationId;
  const path = `/workspace/${encodeURIComponent(organizationId)}/${view}${action ? `/${action}${id ? `/${encodeURIComponent(id)}` : ''}` : ''}`;
  const params = new URLSearchParams(extra);
  return path + (params.size ? `?${params}` : '');
}

export function rememberToast(message) {
  rememberNotice(message);
}
