/** Shared helpers for the management pages (catalog, formats, business products, team, ...). */

import { api, sendJson, showToast } from '../core/api.js';
import { readWorkspaceRoute } from '../core/workspace-route.js';
import { rememberNotice } from '../core/optional-storage.js';

/** Shared browser helpers for ordinary forms and directory pages. */
export { api, sendJson, showToast };

/** Shows (or clears) the message in the container's [data-error] element. */
export function showError(message, container = document) {
  const element = container.querySelector('[data-error]');
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
  if (message) element.focus({ preventScroll: true });
}

/** Disables every control in `container` while `work()` runs, then restores their previous state. */
export async function withBusy(container, work) {
  if (container.dataset.busy === 'true') return;
  container.dataset.busy = 'true';
  const controls = [...container.querySelectorAll('button, input, select, textarea')];
  const previousStates = controls.map((control) => control.disabled);
  controls.forEach((control) => {
    control.disabled = true;
  });
  container.setAttribute('aria-busy', 'true');
  try {
    return await work();
  } finally {
    controls.forEach((control, index) => {
      control.disabled = previousStates[index];
    });
    container.dataset.busy = 'false';
    container.removeAttribute('aria-busy');
  }
}

/** A saved record without id/createdAt/updatedAt, ready to send back as an update. */
export function asInput(record) {
  const { id, createdAt, updatedAt, ...input } = record;
  return input;
}

/** The ?returnTo= workspace URL (e.g. back to the invoice editor), or null when missing/unsafe. */
export function safeReturnUrl() {
  const raw = new URLSearchParams(location.search).get('returnTo');
  if (!raw || !raw.startsWith('/workspace/') || raw.startsWith('//')) return null;
  try {
    const url = new URL(raw, location.origin);
    const route = readWorkspaceRoute(url.pathname, url.search);
    return url.origin === location.origin && route && route.view !== 'not_found' ? url : null;
  } catch {
    return null;
  }
}

/** Keeps ?returnTo= on navigation links and shows "Resume document" when one is set. */
export function preserveReturnLinks() {
  const returnUrl = safeReturnUrl();
  if (!returnUrl) return;
  document.querySelectorAll('a[data-manager-link]').forEach((anchor) => {
    const url = new URL(anchor.href, location.origin);
    url.searchParams.set('returnTo', returnUrl.pathname + returnUrl.search);
    anchor.href = url.pathname + url.search;
  });
  document.querySelectorAll('[data-resume-document]').forEach((anchor) => {
    anchor.href = returnUrl.pathname + returnUrl.search;
    anchor.hidden = false;
  });
}

/** After saving: remember a toast and go back to returnTo (with the new record's ID) or to `fallback`. */
export function afterSave(fallback, key, record) {
  const message =
    key === 'formatId'
      ? 'Invoice format saved'
      : key === 'businessProductId'
        ? 'Business product saved'
        : key === 'catalogId'
          ? `${record?.type === 'product' ? 'Product' : 'Service'} saved`
          : 'Changes saved';
  rememberNotice(message);
  const returnUrl = safeReturnUrl();
  if (returnUrl) {
    if (key && record?.id) returnUrl.searchParams.set(key, record.id);
    location.assign(returnUrl.pathname + returnUrl.search);
    return;
  }
  location.assign(fallback);
}

/** Read and decode an image before storing the data URL in a form. */
export async function readLogo(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPG or WebP image.');
  if (file.size > 500 * 1024) throw new Error('Your logo must be smaller than 500 KB.');
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read this image.'));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = () => reject(new Error('This file could not be opened as an image.'));
    image.src = dataUrl;
  });
  return dataUrl;
}

/** Two-letter initials for a logo placeholder. */
export function initials(name, fallback = 'BP') {
  return (
    String(name || '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] || '')
      .join('')
      .toUpperCase() || fallback
  );
}

/** Readable date (and time) in India time, or "Not yet". */
export function dateTime(value, includeTime = true) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat('en-IN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'Asia/Kolkata',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

/** Shows or hides a status message element. */
export function setMessage(element, message) {
  if (!element) return;
  element.textContent = message || '';
  element.hidden = !message;
}
