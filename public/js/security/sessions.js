/**
 * My sessions page (views/security/sessions.ejs): confirm and sign out one session or all other
 * sessions, and change your own password.
 */

import { getPageData } from '../core/page.js';
import { api, sendJson, showError, withBusy, dateTime } from '../management/common.js';

const data = getPageData();
const root = document.getElementById('sessions-page');
const dialog = root.querySelector('[data-session-dialog]');
const form = dialog.querySelector('[data-session-confirm]');
let request = null;

root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-session-revoke], [data-sessions-revoke-others]');
  if (!button || button.disabled) return;
  const others = button.hasAttribute('data-sessions-revoke-others');
  const session = data.securitySessions.sessions.find((item) => item.id === button.dataset.sessionRevoke);
  if (!others && !session) return;
  request = {
    path: others ? '/auth/sessions/revoke-others' : `/auth/sessions/${encodeURIComponent(session.id)}/revoke`,
  };
  dialog.querySelector('[data-session-title]').textContent = others
    ? 'Sign out your other sessions?'
    : session.current
      ? 'Sign out this session?'
      : 'Sign out this other session?';
  dialog.querySelector('[data-session-description]').textContent = others
    ? 'Your other active sessions across this workspace will end. You will stay signed in here.'
    : `This will end the session signed in on ${dateTime(session.createdAt)} IST.`;
  dialog.querySelector('[data-session-effect]').textContent = session?.current
    ? 'You will return to the sign-in page and need to sign in again to continue.'
    : 'The signed-out sessions can be opened again by signing in with your account.';
  dialog.querySelector('[data-session-submit]').textContent = others
    ? 'Sign out other sessions'
    : 'Sign out session';
  showError('', form);
  dialog.showModal();
});

dialog.querySelector('[data-session-cancel]').addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', (event) => {
  if (form.dataset.busy === 'true') event.preventDefault();
});
dialog.addEventListener('close', () => {
  request = null;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!request) return;
  const selected = request;
  showError('', form);
  await withBusy(form, async () => {
    try {
      const result = await api(selected.path, sendJson('POST', {}));
      if (result.signedOut) {
        location.assign('/login');
        return;
      }
      // Session controls still succeed when browser storage is unavailable.
      try {
        sessionStorage.setItem('vc:toast', result.message || 'Sessions updated.');
      } catch {}
      location.reload();
    } catch (error) {
      if (error.status === 401) location.assign('/login');
      else showError(error.message, form);
    }
  });
});

const passwordForm = root.querySelector('[data-password-form]');
passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(passwordForm));
  if (values.newPassword !== values.confirmPassword) {
    showError('The new password and its confirmation do not match.', passwordForm);
    return;
  }
  showError('', passwordForm);
  await withBusy(passwordForm, async () => {
    try {
      const result = await api(
        '/auth/password',
        sendJson('POST', { currentPassword: values.currentPassword, newPassword: values.newPassword }),
      );
      try {
        sessionStorage.setItem('vc:toast', result.message);
      } catch {}
      location.reload();
    } catch (error) {
      if (error.status === 401) location.assign('/login');
      else showError(error.message, passwordForm);
    }
  });
});
