import { api, sendJson, formValues, showError, setBusy } from '../core/api.js';
import { workspacePath, rememberToast } from '../core/page.js';
import { bindImageFields } from '../core/images.js';
const form = document.getElementById('branding-form');
bindImageFields(form, (message) => showError(form, message));
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(form, '');
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Saving…');
  try {
    await api('/workspace-settings', sendJson('PUT', formValues(form)));
    rememberToast('Workspace branding saved.');
    location.assign(workspacePath('overview'));
  } catch (error) {
    showError(form, error.message);
    setBusy(button, false);
  }
});
