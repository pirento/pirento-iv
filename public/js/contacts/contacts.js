/**
 * Contacts page (views/contacts/index.ejs): list filters and CSV export, and the add/edit form
 * including GST lookup (portal CAPTCHA or configured provider) to fill a contact from its GSTIN.
 */

import { api, sendJson, formValues, showError, showToast, setBusy } from '../core/api.js';
import { getPageData, workspacePath, safeReturn, rememberToast } from '../core/page.js';
import { bindDirectoryFilters } from '../core/directory-filters.js';
import { CONTACT_HANDOFF_PARAM, completeContactHandoff } from '../documents/editor-state.js';
import { optionalSessionStorage } from '../core/optional-storage.js';
const data = getPageData();
const form = document.getElementById('contact-form');
const contacts = data.customers;
bindDirectoryFilters(
  document.querySelector('[data-directory-filters]'),
  document.querySelector('[data-export-contacts]'),
  data.organization.id,
  'customers',
);
document.querySelectorAll('[data-archive-contact]').forEach((button) =>
  button.addEventListener('click', async () => {
    const contact = contacts.find((c) => c.id === button.dataset.archiveContact);
    if (!contact) return;
    setBusy(button, true);
    try {
      await api(
        `/customers/${contact.id}`,
        sendJson('PUT', { ...contact, active: contact.active === false }),
      );
      rememberToast(contact.active === false ? 'Contact restored.' : 'Contact archived.');
      location.assign(workspacePath('customers') + (data.route.action ? '' : location.search));
    } catch (error) {
      showToast(error.message, 'error');
      setBusy(button, false);
    }
  }),
);
const resume = document.querySelector('[data-resume-document]');
const returnTo = data.returnTo;
if (resume && returnTo) {
  const target = safeReturn(returnTo, '');
  if (target) {
    resume.href = target;
    resume.hidden = false;
  }
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(form, '');
    const values = formValues(form);
    const roles = [...form.querySelectorAll('[name="roles"]:checked')].map((input) => input.value);
    if (!roles.length) return showError(form, 'Choose at least one contact role.');
    const input = {
      ...values,
      organizationId: data.organization.id,
      roles,
      active: form.elements.active.checked,
      paymentTermsDays: Number(values.paymentTermsDays),
      creditLimit: Number(values.creditLimit),
    };
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Saving…');
    try {
      const contact = await api(
        form.dataset.id ? `/customers/${form.dataset.id}` : '/customers',
        sendJson(form.dataset.id ? 'PUT' : 'POST', input),
      );
      const target = safeReturn(data.returnTo, workspacePath('customers'));
      const handoffToken = new URLSearchParams(location.search).get(CONTACT_HANDOFF_PARAM);
      const completed =
        !form.dataset.id &&
        completeContactHandoff(optionalSessionStorage(), handoffToken, {
          organizationId: contact.organizationId,
          returnTo: data.returnTo,
          contactId: contact.id,
        });
      rememberToast('Contact saved.');
      const destination = new URL(target, location.origin);
      if (completed) destination.searchParams.set(CONTACT_HANDOFF_PARAM, handoffToken);
      location.assign(destination.pathname + destination.search);
    } catch (error) {
      showError(form, error.message);
      setBusy(button, false);
    }
  });
  form.querySelector('[data-copy-billing]')?.addEventListener('click', () => {
    form.elements.shippingAddress.value = form.elements.address.value;
    form.elements.shippingStateCode.value = form.elements.stateCode.value;
  });
  form.elements.gstin.addEventListener('input', () => {
    form.elements.gstin.value = form.elements.gstin.value.toUpperCase();
  });
  let challenge;
  let health;
  let controller;
  const message = form.querySelector('[data-gst-message]');
  const captchaBox = form.querySelector('[data-gst-captcha]');
  function notify(text, error = false) {
    message.textContent = text;
    message.className = `full-width alert ${error ? 'alert-error' : 'alert-info'}`;
    message.hidden = false;
  }
  function apply(result) {
    for (const key of ['gstin', 'name', 'address', 'stateCode'])
      if (result[key] !== undefined) form.elements[key].value = result[key];
    captchaBox.hidden = true;
    notify(
      health?.gstProvider === 'sandbox' && health.gstEnvironment === 'test'
        ? 'Sandbox test details received. These are examples, not verified taxpayer details.'
        : `Business details fetched${result.status ? ' · ' + result.status : ''}. Review before saving.`,
    );
  }
  async function lookup(event) {
    const button = event.currentTarget;
    if (!form.elements.gstin.value.trim()) return notify('Enter a GSTIN first.', true);
    controller?.abort();
    controller = new AbortController();
    const current = controller;
    setBusy(button, true);
    captchaBox.hidden = true;
    try {
      health = await api('/health', { signal: current.signal });
      if (health.gstMode === 'portal') {
        challenge = await api('/gst/captcha', { signal: current.signal });
        form.querySelector('[data-captcha-image]').src = challenge.image;
        form.querySelector('[data-captcha-input]').value = '';
        captchaBox.hidden = false;
        notify('Enter the six digits from the GST portal CAPTCHA.');
      } else {
        apply(
          await api(`/gst/${encodeURIComponent(form.elements.gstin.value.trim())}`, {
            signal: current.signal,
          }),
        );
      }
    } catch (error) {
      if (error.name !== 'AbortError') notify(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }
  form.querySelector('[data-gst-lookup]').addEventListener('click', lookup);
  form.querySelector('[data-gst-refresh]').addEventListener('click', lookup);
  form.querySelector('[data-gst-verify]').addEventListener('click', async (event) => {
    if (!challenge) return;
    const button = event.currentTarget;
    setBusy(button, true);
    try {
      apply(
        await api(
          '/gst/lookup',
          sendJson('POST', {
            gstin: form.elements.gstin.value.trim(),
            challengeId: challenge.challengeId,
            captcha: form.querySelector('[data-captcha-input]').value.trim(),
          }),
        ),
      );
    } catch (error) {
      notify(error.message, true);
      captchaBox.hidden = true;
    } finally {
      setBusy(button, false);
    }
  });
}
