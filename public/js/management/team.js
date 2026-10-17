/**
 * Team access page (views/team/index.ejs, admin only): approve/disable accounts, set role and
 * assigned businesses and staff permission, sign out a member's sessions and set a new password.
 */

import { getPageData } from '../core/page.js';
import { api, sendJson, showError, withBusy, initials, dateTime, setMessage } from './common.js';

const data = getPageData();
const root = document.getElementById('team-page');
if (data.user.role === 'admin') {
  let users = data.teamUsers || [];
  const container = root.querySelector('[data-team-users]');
  const template = document.getElementById('team-user-template');
  const search = root.querySelector('[data-search]');
  const statusFilter = root.querySelector('[data-status-filter]');
  let sequence = 0;
  const sessionsDialog = root.querySelector('[data-session-dialog]');
  const sessionsForm = sessionsDialog.querySelector('[data-session-confirm]');
  let sessionTarget = null;

  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-user-revoke-sessions]');
    if (!button) return;
    const card = button.closest('[data-user-card]');
    const member = users.find((user) => user.id === card?.dataset.userCard);
    if (!member) return;
    sessionTarget = member;
    sessionsDialog.querySelector('[data-session-title]').textContent = 'Sign out all account sessions?';
    sessionsDialog.querySelector('[data-session-description]').textContent =
      `All active sessions for ${member.name} (${member.email}) will end across the workspace.`;
    sessionsDialog.querySelector('[data-session-effect]').textContent =
      member.id === data.user.id
        ? 'This includes your current session. You will need to sign in again to continue.'
        : 'This person can sign in again with their existing account access.';
    sessionsDialog.querySelector('[data-session-submit]').textContent = 'Sign out all sessions';
    showError('', sessionsForm);
    sessionsDialog.showModal();
  });
  sessionsDialog
    .querySelector('[data-session-cancel]')
    .addEventListener('click', () => sessionsDialog.close());
  sessionsDialog.addEventListener('cancel', (event) => {
    if (sessionsForm.dataset.busy === 'true') event.preventDefault();
  });
  sessionsDialog.addEventListener('close', () => {
    sessionTarget = null;
  });
  sessionsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sessionTarget) return;
    const selected = sessionTarget;
    showError('', sessionsForm);
    await withBusy(sessionsForm, async () => {
      try {
        const result = await api(
          `/auth/users/${encodeURIComponent(selected.id)}/revoke-sessions`,
          sendJson('POST', {}),
        );
        if (result.signedOut) {
          location.assign('/login');
          return;
        }
        setMessage(root.querySelector('[data-notice]'), `${selected.name}: ${result.message}`);
        sessionsDialog.close();
      } catch (error) {
        if (error.status === 401) location.assign('/login');
        else showError(error.message, sessionsForm);
      }
    });
  });

  function readDraft(form) {
    return {
      status: form.elements.namedItem('status').value,
      role: form.elements.namedItem('role').value,
      permission: form.elements.namedItem('permission').value,
      organizationIds: [...form.querySelectorAll('[name="organizationIds"]:checked')].map(
        (input) => input.value,
      ),
    };
  }

  function updateAccess(card, user) {
    const form = card.querySelector('[data-access-form]');
    const draft = readDraft(form);
    const changed =
      draft.role !== user.role ||
      draft.status !== user.status ||
      (draft.role === 'staff' && draft.permission !== user.permission) ||
      [...draft.organizationIds].sort().join(',') !== [...user.organizationIds].sort().join(',');
    const organizationRequired =
      draft.role === 'staff' && draft.status === 'active' && !draft.organizationIds.length;
    card.querySelector('[data-admin-note]').hidden = draft.role !== 'admin';
    card.querySelector('[data-organization-options]').hidden = draft.role === 'admin';
    card.querySelector('[data-permission-field]').hidden = draft.role === 'admin';
    const save = card.querySelector('[data-save-access]');
    save.disabled = !changed || organizationRequired;
    save.textContent =
      user.status === 'pending' && draft.status === 'active' ? 'Approve account' : 'Save access';
    const hint = organizationRequired
      ? 'Select at least one organization to activate this staff account.'
      : user.id === data.user.id && changed
        ? 'Updating your own access will end your session. Log in again after saving.'
        : draft.status === 'disabled'
          ? 'Disabled accounts cannot log in. Existing sessions end when this is saved.'
          : draft.status === 'pending'
            ? 'Pending accounts cannot open the workspace until approved.'
            : 'Saved access changes end this person’s existing sessions.';
    card.querySelector('[data-access-hint]').textContent = hint;
  }

  function bindCard(card, user) {
    const form = card.querySelector('[data-access-form]');
    form.addEventListener('change', () => {
      updateAccess(card, user);
      showError('', form);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const draft = readDraft(form);
      if (draft.role === 'staff' && draft.status === 'active' && !draft.organizationIds.length) {
        showError('Select at least one organization to activate this staff account.', form);
        return;
      }
      showError('', form);
      await withBusy(form, async () => {
        try {
          const saved = await api(
            `/auth/users/${encodeURIComponent(user.id)}`,
            sendJson('PATCH', {
              ...draft,
              organizationIds: draft.role === 'admin' ? [] : draft.organizationIds,
              permission: draft.role === 'admin' ? 'full' : draft.permission,
            }),
          );
          users = users.map((user) => (user.id === saved.id ? saved : user));
          setMessage(root.querySelector('[data-notice]'), `${saved.name}’s access has been saved.`);
          if (saved.id === data.user.id) {
            location.assign('/login');
            return;
          }
          card.replaceWith(createCard(saved));
          filterCards();
        } catch (error) {
          showError(error.message, form);
        }
      });
    });
    updateAccess(card, user);
    const passwordForm = card.querySelector('[data-password-form]');
    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      showError('', passwordForm);
      await withBusy(passwordForm, async () => {
        try {
          const result = await api(
            `/auth/users/${encodeURIComponent(user.id)}/password`,
            sendJson('POST', { password: passwordForm.elements.namedItem('password').value }),
          );
          passwordForm.reset();
          setMessage(root.querySelector('[data-notice]'), `${user.name}: ${result.message}`);
        } catch (error) {
          if (error.status === 401) location.assign('/login');
          else showError(error.message, passwordForm);
        }
      });
    });
  }

  function createCard(user) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.userCard = user.id;
    card.querySelector('[data-user-initials]').textContent = initials(user.name, 'U');
    card.querySelector('[data-user-name]').textContent = user.name;
    card.querySelector('[data-user-email]').textContent = user.email;
    card.querySelector('[data-user-self]').hidden = user.id !== data.user.id;
    card.querySelector('[data-password-form]').hidden = user.id === data.user.id;
    card.querySelector('[data-user-status]').textContent =
      user.status === 'pending' ? 'Awaiting approval' : user.status === 'active' ? 'Active' : 'Disabled';
    const company = card.querySelector('[data-user-company]');
    company.textContent = `Company / team: ${user.company || ''}`;
    company.hidden = !user.company;
    card.querySelector('[data-user-created]').textContent = `Requested ${dateTime(user.createdAt, false)}`;
    card.querySelector('[data-user-last-login]').textContent =
      `Last login: ${dateTime(user.lastLoginAt, false)}`;
    const form = card.querySelector('[data-access-form]');
    form.elements.namedItem('status').value = user.status;
    form.elements.namedItem('role').value = user.role;
    form.elements.namedItem('permission').value = user.permission;
    form.querySelectorAll('[name="organizationIds"]').forEach((input) => {
      input.checked = user.organizationIds.includes(input.value);
    });
    bindCard(card, user);
    return card;
  }

  function filterCards() {
    const query = search.value.trim().toLowerCase();
    users.sort(
      (a, b) =>
        Number(b.status === 'pending') - Number(a.status === 'pending') ||
        b.createdAt.localeCompare(a.createdAt),
    );
    const cards = new Map(
      [...container.querySelectorAll('[data-user-card]')].map((card) => [card.dataset.userCard, card]),
    );
    for (const user of users) if (cards.has(user.id)) container.append(cards.get(user.id));
    const visible = new Set(
      users
        .filter(
          (user) =>
            (statusFilter.value === 'all' || user.status === statusFilter.value) &&
            `${user.name} ${user.email} ${user.company}`.toLowerCase().includes(query),
        )
        .map((user) => user.id),
    );
    container.querySelectorAll('[data-user-card]').forEach((card) => {
      card.hidden = !visible.has(card.dataset.userCard);
    });
    root.querySelectorAll('[data-team-count]').forEach((element) => {
      element.textContent = users.filter((user) => user.status === element.dataset.teamCount).length;
    });
    root.querySelector('[data-empty]').hidden = visible.size > 0;
    const filtering = query || statusFilter.value !== 'all';
    root.querySelector('[data-empty-title]').textContent = filtering
      ? 'No matching accounts'
      : 'No account requests yet';
    root.querySelector('[data-empty-copy]').textContent = filtering
      ? 'Try another name, email or status filter.'
      : 'People can request access using Sign up on your Venturecore INV home page.';
  }

  async function load() {
    const current = ++sequence;
    const refresh = root.querySelector('[data-refresh]');
    refresh.disabled = true;
    container.setAttribute('aria-busy', 'true');
    showError('', root);
    try {
      const result = await api('/auth/users');
      if (current !== sequence) return;
      users = result.sort(
        (a, b) =>
          Number(b.status === 'pending') - Number(a.status === 'pending') ||
          b.createdAt.localeCompare(a.createdAt),
      );
      container.replaceChildren(...users.map(createCard));
      filterCards();
    } catch (error) {
      if (current === sequence) showError(error.message, root);
    } finally {
      if (current === sequence) {
        refresh.disabled = false;
        container.removeAttribute('aria-busy');
      }
    }
  }

  container.querySelectorAll('[data-user-card]').forEach((card) => {
    const user = users.find((user) => user.id === card.dataset.userCard);
    if (user) bindCard(card, user);
  });
  search.addEventListener('input', filterCards);
  statusFilter.addEventListener('change', filterCards);
  root.querySelector('[data-refresh]').addEventListener('click', load);
  filterCards();
  if (!Array.isArray(data.teamUsers)) void load();
}
