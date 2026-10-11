/** Every request stays on this origin; credentials are never put in browser code. */
export async function api(path, options = {}) {
  const url = path.startsWith('/api/') ? path : `/api${path}`;
  if (!url.startsWith('/api/')) throw new Error('Invalid API path.');
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('vc-session-expired'));
    }
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.code;
    error.document = data.document;
    throw error;
  }
  return data;
}

export function sendJson(method, data) {
  return { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) };
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form));
}

export function escapeHtml(value = '') {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

export function showToast(message, type = 'success') {
  const container = document.getElementById('toast-region');
  if (!container) return;
  const notice = document.createElement('div');
  notice.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
  notice.textContent = message;
  container.append(notice);
  setTimeout(() => notice.remove(), 6000);
}

export function setBusy(element, busy, label) {
  if (!element) return;
  if (busy) {
    element.dataset.previousText = element.textContent;
    if (label) element.textContent = label;
  } else if (element.dataset.previousText) {
    element.textContent = element.dataset.previousText;
    delete element.dataset.previousText;
  }
  element.disabled = Boolean(busy);
  element.setAttribute('aria-busy', String(Boolean(busy)));
}

export function showError(form, message) {
  const box = form?.querySelector('[data-form-error]') || document.querySelector('[data-page-error]');
  if (!box) {
    showToast(message, 'error');
    return;
  }
  box.textContent = message;
  box.hidden = !message;
  if (message) {
    box.tabIndex = -1;
    box.focus();
  }
}

export function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
