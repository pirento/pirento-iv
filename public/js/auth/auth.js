/**
 * Login / signup / forgot-password / reset-password page (views/auth/index.ejs).
 * Shows/hides the password and submits the form to /api/auth/<mode>, then redirects or shows the result.
 * When two-step login is on, the server asks for the authenticator code and the field is shown.
 */

import { api, sendJson, formValues, showError, setBusy } from '../core/api.js';
import { getPageData, safeReturn, rememberToast } from '../core/page.js';
const data = getPageData();
const form = document.getElementById('auth-form');
const mode = form.dataset.mode;
document.querySelector('[data-password-toggle]')?.addEventListener('click', (event) => {
  const field = form.elements.password;
  const visible = field.type === 'password';
  field.type = visible ? 'text' : 'password';
  event.currentTarget.textContent = visible ? 'Hide' : 'Show';
  event.currentTarget.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(form, '');
  const values = formValues(form);
  if (values.confirmPassword !== undefined && values.confirmPassword !== values.password)
    return showError(form, 'Both passwords must match.');
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Please wait…');
  try {
    let payload;
    if (mode === 'login')
      payload = {
        email: values.email,
        password: values.password,
        ...(values.code ? { code: values.code } : {}),
      };
    if (mode === 'signup')
      payload = {
        name: values.name,
        email: values.email,
        company: values.company,
        password: values.password,
      };
    if (mode === 'forgot-password') payload = { email: values.email };
    if (mode === 'reset-password') payload = { token: data.token, password: values.password };
    const result = await api(`/auth/${mode}`, sendJson('POST', payload));
    if (mode === 'login') {
      location.replace(safeReturn(data.returnTo, '/'));
      return;
    }
    if (mode === 'reset-password') {
      rememberToast(result.message);
      location.replace('/login');
      return;
    }
    const notice = form.querySelector('[data-auth-success]');
    notice.textContent = result.message;
    notice.hidden = false;
    form.reset();
  } catch (error) {
    if (mode === 'login' && error.code === 'TWO_STEP_REQUIRED') {
      form.querySelector('[data-two-step]').hidden = false;
      form.elements.code.required = true;
      form.elements.code.value = '';
      form.elements.code.focus();
    }
    showError(form, error.message);
  } finally {
    setBusy(button, false);
  }
});
