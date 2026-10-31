/**
 * Business settings page (views/organizations/index.ejs): tabbed settings form, GST registrations
 * (add/remove), logo/signature/QR uploads and save.
 */

import { api, sendJson, formValues, showError, setBusy } from '../core/api.js';
import { getPageData, rememberToast } from '../core/page.js';
import { bindImageFields } from '../core/images.js';
import { COMPANY_NAME } from '/shared/types.js';
const data = getPageData();
const form = document.getElementById('organization-form');

if (form) {
  const source = data.organizations.find((org) => org.id === form.dataset.id);
  const parent =
    data.organizations.find(
      (org) =>
        org.businessType !== 'independent' &&
        org.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase() &&
        org.id !== source?.id,
    ) ||
    data.organizations.find(
      (org) =>
        org.businessType !== 'independent' &&
        org.legalName.trim().toLowerCase() === COMPANY_NAME.toLowerCase(),
    );
  const identityKeys = [
    'legalName',
    'tradeName',
    'businessConstitution',
    'gstin',
    'email',
    'phone',
    'address',
    'stateCode',
    'signatureImageUrl',
    'paymentQrUrl',
    'pan',
    'cin',
    'bankName',
    'accountName',
    'accountNumber',
    'ifsc',
    'bankBranch',
    'accountType',
    'terms',
    'signature',
    'supportEmail',
    'financeEmail',
    'emailFrom',
    'paymentGateway',
  ];
  bindImageFields(form, (message) => showError(form, message));
  function showTab(name) {
    form.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== name;
    });
    form.querySelectorAll('[data-settings-tab]').forEach((button) => {
      const active = button.dataset.settingsTab === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
  }
  form
    .querySelectorAll('[data-settings-tab]')
    .forEach((button) => button.addEventListener('click', () => showTab(button.dataset.settingsTab)));
  form.addEventListener(
    'invalid',
    (event) => {
      const panel = event.target.closest('[data-settings-panel]');
      if (panel) showTab(panel.dataset.settingsPanel);
    },
    true,
  );
  const registrations = form.querySelector('#gst-registrations');
  function addRegistration(input = {}) {
    const fragment = document.getElementById('registration-template').content.cloneNode(true);
    const wrapper = fragment.querySelector('[data-registration-id]');
    wrapper.dataset.registrationId = input.id || crypto.randomUUID();
    for (const field of wrapper.querySelectorAll('[data-registration-field]'))
      field.value = input[field.dataset.registrationField] || '';
    registrations.append(fragment);
  }
  form.querySelector('[data-add-registration]').addEventListener('click', () => {
    if (registrations.children.length >= 20)
      return showError(form, 'Save at most 20 additional registrations.');
    addRegistration();
  });
  registrations.addEventListener('click', (event) => {
    event.target.closest('[data-remove-registration]')?.closest('[data-registration-id]').remove();
  });
  registrations.addEventListener('input', (event) => {
    if (event.target.dataset.registrationField === 'gstin')
      event.target.value = event.target.value.toUpperCase();
  });
  const copyButton = form.querySelector('[data-use-company]');
  function syncCopy() {
    copyButton.hidden = !parent || form.elements.businessType.value === 'independent';
  }
  syncCopy();
  form.elements.businessType.addEventListener('change', () => {
    if (!source && form.elements.businessType.value === 'independent') {
      for (const key of [
        ...identityKeys,
        'secondarySignatureLabel',
        'secondarySignatureImageUrl',
        'stampLabel',
        'stampImageUrl',
      ])
        if (form.elements[key]) form.elements[key].value = key === 'paymentGateway' ? 'none' : '';
      registrations.replaceChildren();
      form.querySelectorAll('[data-image-field] img').forEach((img) => {
        img.hidden = true;
      });
    }
    syncCopy();
  });
  copyButton.addEventListener('click', () => {
    if (!parent || form.elements.businessType.value === 'independent') return;
    for (const key of identityKeys)
      if (form.elements[key]) {
        form.elements[key].value = parent[key] || '';
        form.elements[key].dispatchEvent(new Event('input'));
      }
    registrations.replaceChildren();
    for (const registration of parent.gstRegistrations || [])
      addRegistration({ ...registration, id: crypto.randomUUID() });
  });
  for (const key of ['gstin', 'pan', 'cin', 'ifsc', 'invoicePrefix', 'quotationPrefix'])
    form.elements[key].addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase();
    });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(form, '');
    const values = formValues(form);
    const input = {
      ...values,
      enableProductSelection: form.elements.enableProductSelection.checked,
      gstRegistrations: [...registrations.querySelectorAll('[data-registration-id]')].map((wrapper) => ({
        id: wrapper.dataset.registrationId,
        ...Object.fromEntries(
          [...wrapper.querySelectorAll('[data-registration-field]')].map((field) => [
            field.dataset.registrationField,
            field.value,
          ]),
        ),
      })),
    };
    const button = form.querySelector('[type="submit"]');
    setBusy(button, true, 'Saving…');
    try {
      const saved = await api(
        source ? `/organizations/${source.id}` : '/organizations',
        sendJson(source ? 'PUT' : 'POST', input),
      );
      rememberToast('Business settings saved.');
      location.assign(`/workspace/${encodeURIComponent(saved.id)}/organizations`);
    } catch (error) {
      showError(form, error.message);
      setBusy(button, false);
    }
  });
}
