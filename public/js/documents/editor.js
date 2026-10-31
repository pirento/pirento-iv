/**
 * Document editor page (views/documents/editor.ejs) for invoices, quotations, proformas and
 * delivery challans.
 *
 * The server renders the form; this script keeps a `form` object in sync with the inputs,
 * recalculates totals live (same functions as the server: shared/types.js), picks contacts and
 * catalog items (directory-picker.js), validates, and saves to /api/documents.
 *
 * Safety features: unsaved edits survive reloads (editor-state.js); a new document carries a
 * requestId so a retried save never creates a duplicate; a save from an outdated tab is refused
 * with a conflict message instead of overwriting newer changes.
 */

import { api, sendJson, downloadText } from '/js/core/api.js';
import { getPageData } from '/js/core/page.js';
import { createDirectoryPicker, fetchDirectoryRecords, replaceDirectoryRows } from './directory-picker.js';
import {
  blankShipping,
  calculateLineAmount,
  calculateTotals,
  documentRoundingPolicy,
  DECIMAL_ROUNDING_POLICY,
  linePriceBreakdown,
  defaultFormatFor,
  DOCUMENT_LABELS,
  money,
  STATES,
} from '/shared/types.js';
import { BILLING_PROFILES, billingProfileFor, emptyJewelleryPricing } from '/shared/billing-presets.js';
import { contactRoles, CONTACT_ROLE_LABELS, isInvoiceRecipient } from '/shared/contact-types.js';
import { organizationForRegistration } from '/shared/business-identity.js';
import {
  blankLine,
  defaultDocumentBranding,
  documentLocked,
  documentUrl,
  escape,
  financialChange,
  initialDocumentForm,
  pricingFields,
  pricingSummary,
  validatePricing,
} from './document-ui.js';
import { readImage } from '/js/core/images.js';
import {
  CONTACT_HANDOFF_PARAM,
  beginContactHandoff,
  canRestoreDraft,
  consumeContactHandoff,
  peekContactHandoff,
  discardLocalDraft,
  readStoredDraft,
  removeStoredDraft,
  writeStoredDraft,
} from './editor-state.js';

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------
const data = getPageData();
const organization = data.organization;
const existing = data.document;
const profile = billingProfileFor(organization);
const finalized = Boolean(existing?.finalizedAt || existing?.convertedInvoiceId);
const locked = documentLocked(existing);
const editor = document.querySelector('#document-editor-form');
const resetDraftButton = document.querySelector('[data-reset-draft]');
const resetDraftDialog = document.querySelector('#doc-reset-dialog');
const draftKey = `vc:document-draft:${location.pathname}`;
let form = initialDocumentForm(data);
let pendingProductId = null;
let contactRole = 'all';
let saving = false;
let initializing = true;
let initializationFailed = false;
let contactPicker;
let catalogPicker;
let uploadCount = 0;
let draftId = crypto.randomUUID();
let requestId = existing ? null : crypto.randomUUID();
let pendingCreate = null;
let saveConflict = false;
let draftStorage;
try {
  draftStorage = sessionStorage;
} catch {
  /* Saving explains when a browser cannot retain a request safely. */
}
// Records sent by the server for this business (contacts and catalog: first page + records used by the draft).
const catalog = data.catalog || [];
const formats = (data.formats || []).filter((format) => format.organizationId === organization.id);
const products = (data.businessProducts || []).filter(
  (product) => product.organizationId === organization.id && product.active,
);
const customers = (data.customers || []).filter(
  (customer) =>
    customer.organizationId === organization.id &&
    (isInvoiceRecipient(customer) || customer.id === existing?.customerId),
);
let contactPageIds = new Set((data.customers || []).slice(0, 20).map((item) => item.id));
let catalogPageIds = new Set((data.catalog || []).slice(0, 20).map((item) => item.id));
const registrations = organization.gstRegistrations || [];
const delivery = form.kind === 'delivery_note';
const financialKeys = new Set([
  'customerId',
  'issueDate',
  'items',
  'discountPercent',
  'placeOfSupply',
  'businessProductId',
  'gstRegistrationId',
  'branding',
]);

// Drafts and an unresolved creation request survive EJS navigation and browser reloads.
// Never restore an older local draft over a newer server revision.
const savedDraft = readStoredDraft(draftStorage, draftKey);
if (!locked && canRestoreDraft(savedDraft, existing, organization.id, form.kind)) {
  form = { ...form, ...savedDraft.draft };
  draftId = savedDraft.draftId || draftId;
  requestId = existing ? null : savedDraft.requestId || requestId;
  if (!existing && savedDraft.pendingCreate && savedDraft.draft.requestId === requestId)
    pendingCreate = structuredClone(savedDraft.draft);
} else if (savedDraft?.draft && savedDraft.draft.organizationId === organization.id) {
  // Keep a recovery copy when the user explicitly opens the newer saved version.
  writeStoredDraft(draftStorage, `${draftKey}:recovery`, savedDraft);
}

// ---------------------------------------------------------------------------
// Small helpers: current seller, customer, totals; feedback, draft saving, field errors
// ---------------------------------------------------------------------------
const field = (name) => editor.elements.namedItem(name);
const currentBranding = () => ({
  ...defaultDocumentBranding(existing?.organizationSnapshot || organization),
  ...form.branding,
});
const changedFinancially = () => financialChange(form, existing);
const registrationAvailable = () =>
  !form.gstRegistrationId || registrations.some((registration) => registration.id === form.gstRegistrationId);
const currentSeller = () =>
  existing && (!changedFinancially() || !registrationAvailable())
    ? existing.organizationSnapshot
    : registrationAvailable()
      ? organizationForRegistration(organization, form.gstRegistrationId)
      : organization;
const currentCustomer = () =>
  existing && !changedFinancially()
    ? existing.customerSnapshot
    : customers.find((customer) => customer.id === form.customerId);
const currentTotals = () =>
  existing && !changedFinancially()
    ? existing.totals
    : calculateTotals(
        form.items,
        form.discountPercent,
        Boolean(
          currentSeller().stateCode && form.placeOfSupply && currentSeller().stateCode !== form.placeOfSupply,
        ),
      );
const linePolicy = () =>
  existing && !changedFinancially() ? documentRoundingPolicy(existing) : DECIMAL_ROUNDING_POLICY;
function feedback(message = '', error = true) {
  const target = document.querySelector('#doc-editor-feedback');
  target.textContent = message;
  target.classList.toggle('doc-save-error', error);
}
function saveDraft() {
  if (finalized) return false;
  return writeStoredDraft(draftStorage, draftKey, {
    updatedAt: existing?.updatedAt || '',
    version: existing?.version ?? 0,
    draftId,
    requestId,
    // Store the payload once: branding images can be large.
    draft: pendingCreate || form,
    pendingCreate: Boolean(pendingCreate),
  });
}
function update(key, value) {
  if (initializing || finalized || saving || pendingCreate || (locked && financialKeys.has(key))) return;
  form[key] = value;
  clearError(key);
  if (!saveConflict) feedback();
  saveDraft();
  refreshDerived();
}
function clearError(key) {
  for (const node of editor.querySelectorAll('[data-error-for]'))
    if (node.dataset.errorFor === key) {
      node.textContent = '';
      node.hidden = true;
    }
  field(key)?.removeAttribute?.('aria-invalid');
}
function showErrors(errors) {
  for (const node of editor.querySelectorAll('[data-error-for]')) {
    const message = errors[node.dataset.errorFor] || '';
    node.textContent = message;
    node.hidden = !message;
    if (message) field(node.dataset.errorFor)?.setAttribute?.('aria-invalid', 'true');
  }
  if (errors.shipping) document.querySelector('#doc-shipping').open = true;
  if (errors.branding) document.querySelector('#doc-branding').open = true;
}
function syncFields() {
  for (const [key, value] of Object.entries(form)) {
    const element = field(key);
    if (element && ['string', 'number'].includes(typeof value)) element.value = value;
  }
  for (const element of editor.querySelectorAll('[data-shipping]'))
    element.value = form.shipping?.[element.dataset.shipping] || '';
  const branding = currentBranding();
  for (const element of editor.querySelectorAll('[data-branding]')) {
    const value = branding[element.dataset.branding];
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value;
  }
}
// ---------------------------------------------------------------------------
// Rendering: contact picker, business product, catalog picker, line items, branding, totals
// ---------------------------------------------------------------------------
function renderContacts() {
  const search = document.querySelector('#doc-contact-search').value.trim().toLowerCase();
  const filtered = customers.filter(
    (customer) =>
      contactPageIds.has(customer.id) &&
      (contactRole === 'all' || contactRoles(customer).includes(contactRole)) &&
      [
        customer.name,
        customer.contactPerson,
        customer.phone,
        customer.email,
        customer.gstin,
        customer.pan,
        customer.address,
      ]
        .join(' ')
        .toLowerCase()
        .includes(search),
  );
  const current = customers.find((customer) => customer.id === form.customerId) || currentCustomer();
  const retained = current && !filtered.some((customer) => customer.id === current.id) ? [current] : [];
  field('customerId').innerHTML =
    '<option value="">Select a saved contact</option>' +
    [...retained, ...filtered]
      .map(
        (customer) =>
          `<option value="${escape(customer.id)}">${escape(customer.name)} · ${escape(
            contactRoles(customer)
              .map((role) => CONTACT_ROLE_LABELS[role])
              .join(' / '),
          )}${customer.gstin ? ` · ${escape(customer.gstin)}` : ''}${customer.active === false ? ' · Archived' : ''}</option>`,
      )
      .join('');
  field('customerId').value = form.customerId;
}
function chooseCustomer(id) {
  if (locked) return;
  const customer = customers.find((item) => item.id === id);
  const previous = customers.find((item) => item.id === form.customerId);
  const shipping = { ...blankShipping(), ...form.shipping };
  const previousShipping = previous && {
    recipientName: previous.name,
    address: previous.shippingAddress || previous.address,
    stateCode: previous.shippingStateCode || previous.stateCode,
    phone: previous.phone,
  };
  const inherited =
    previousShipping && Object.entries(previousShipping).every(([key, value]) => shipping[key] === value);
  if (customer && (!shipping.address || inherited))
    Object.assign(shipping, {
      recipientName: customer.name,
      address: customer.shippingAddress || customer.address,
      stateCode: customer.shippingStateCode || customer.stateCode,
      phone: customer.phone,
    });
  if (!existing && !delivery && customer?.paymentTermsDays) {
    const dueDate = new Date(`${form.issueDate}T12:00:00Z`);
    dueDate.setUTCDate(dueDate.getUTCDate() + customer.paymentTermsDays);
    form.dueDate = dueDate.toISOString().slice(0, 10);
  }
  form.shipping = shipping;
  form.placeOfSupply = customer?.stateCode || form.placeOfSupply;
  update('customerId', id);
  clearError('placeOfSupply');
  syncFields();
  void loadCustomerSummary();
}

// What the chosen contact still owes (with a credit-limit warning) and their last document's lines.
let customerSummary = null;
let lastDocument = null;
let summaryRequest = 0;
async function loadCustomerSummary() {
  const request = ++summaryRequest;
  customerSummary = null;
  lastDocument = null;
  renderCustomerSummary();
  if (!form.customerId) return;
  try {
    const summary = await api(
      `/customers/${encodeURIComponent(form.customerId)}/billing-summary?kind=${encodeURIComponent(form.kind)}`,
    );
    if (request !== summaryRequest) return;
    customerSummary = summary;
    lastDocument = !existing && !locked && summary.lastDocument?.items?.length ? summary.lastDocument : null;
  } catch {
    /* The summary is a hint only; the form works without it. */
  }
  renderCustomerSummary();
}
function renderCustomerSummary() {
  const box = document.querySelector('#doc-customer-summary');
  if (!box) return;
  box.hidden = !customerSummary;
  if (!customerSummary) return;
  const { outstanding, openInvoices, overdueInvoices, creditLimit } = customerSummary;
  const overLimit = creditLimit > 0 && outstanding + (existing ? 0 : currentTotals().total) > creditLimit;
  box.querySelector('[data-summary-text]').textContent = [
    outstanding > 0
      ? `Owes ${money(outstanding)} on ${openInvoices} invoice(s)${overdueInvoices ? `, ${overdueInvoices} overdue` : ''}.`
      : 'Nothing outstanding.',
    creditLimit > 0
      ? overLimit
        ? `Over the credit limit of ${money(creditLimit)} with this document.`
        : `Credit limit ${money(creditLimit)}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  box.classList.toggle('doc-customer-summary-warning', overLimit || overdueInvoices > 0);
  const copy = box.querySelector('[data-copy-last]');
  copy.hidden = !lastDocument;
  if (lastDocument)
    copy.textContent = `Copy ${lastDocument.items.length} item(s) from ${lastDocument.number} (${lastDocument.issueDate})`;
}
function copyLastDocumentItems() {
  if (!lastDocument || locked) return;
  const filled = form.items.some((line) => line.description.trim());
  if (filled && !confirm('Replace the items on this form with the items of the last document?')) return;
  const keys = [
    'description',
    'hsn',
    'quantity',
    'rate',
    'gstRate',
    'unit',
    'catalogItemId',
    'itemType',
    'pricing',
  ];
  update(
    'items',
    lastDocument.items.map((line) => ({
      ...blankLine(profile, delivery),
      ...Object.fromEntries(keys.filter((key) => line[key] !== undefined).map((key) => [key, line[key]])),
      pricing: line.pricing,
      ...(delivery ? { rate: 0, gstRate: 0 } : {}),
    })),
  );
  renderLines();
  feedback(`Items copied from ${lastDocument.number}. Check quantities and rates before saving.`, false);
}
function incompatibleLines(productId) {
  return form.items.filter((line) => {
    if (!line.catalogItemId) return false;
    const source = catalog.find((item) => item.id === line.catalogItemId);
    return source
      ? Boolean(source.businessProductId && source.businessProductId !== productId)
      : Boolean(form.businessProductId && form.businessProductId !== productId);
  });
}
function chooseProduct(id) {
  if (locked) return;
  const conflicts = incompatibleLines(id);
  if (conflicts.length) {
    pendingProductId = id;
    field('businessProductId').value = form.businessProductId || '';
    document.querySelector('#doc-product-change-copy').textContent =
      `Switching to ${products.find((product) => product.id === id)?.name || 'no product'} removes ${conflicts.length} catalog line(s) belonging to another product. Your other lines will stay.`;
    document.querySelector('#doc-product-change').hidden = false;
    return;
  }
  update('businessProductId', id || undefined);
  catalogPicker?.search({ immediate: true });
}
function renderCatalog() {
  const container = document.querySelector('#doc-catalog-results');
  if (!container) return;
  const search = document.querySelector('#doc-catalog-search').value.trim().toLowerCase();
  const type = document.querySelector('#doc-catalog-type').value;
  const active = catalog.filter(
    (item) =>
      item.organizationId === organization.id &&
      catalogPageIds.has(item.id) &&
      item.active &&
      (!item.businessProductId || item.businessProductId === form.businessProductId),
  );
  const matches = active.filter(
    (item) =>
      (type === 'all' || item.type === type) &&
      `${item.name} ${item.description} ${item.sku} ${item.hsn}`.toLowerCase().includes(search),
  );
  container.innerHTML = matches.length
    ? matches
        .map(
          (item) =>
            `<button type="button" class="doc-catalog-choice" data-catalog-id="${escape(item.id)}"><strong>${escape(item.name)}</strong><span>${escape(item.description || item.sku || item.hsn || item.type)}</span>${delivery ? '' : `<b>${money(item.rate)} / ${escape(item.unit)}</b><small>GST ${item.gstRate}%${item.pricing ? ` · ${escape(item.pricing.mode)} pricing` : ''}</small>`}<span>Add to document</span></button>`,
        )
        .join('')
    : '<p class="doc-help">No matching active catalog items. Change your search or add a manual line.</p>';
}
function renderLines() {
  const policy = linePolicy();
  document.querySelector('#doc-lines').innerHTML = form.items
    .map((line, index) => {
      const disabled = locked ? 'disabled' : '';
      const makeInput = (label, key, attrs = '') =>
        `<label class="doc-field">${label}<input data-line="${key}" value="${escape(line[key])}" ${attrs}></label>`;
      return `<article class="doc-line-card" data-line-index="${index}"><div class="doc-label-row"><strong>Item ${index + 1}</strong><button type="button" class="doc-text-button doc-delete" data-remove-line="${index}" ${disabled || (form.items.length === 1 ? 'disabled' : '')}>Remove</button></div><fieldset class="doc-line-fieldset" ${disabled}><div class="doc-form-grid"><label class="doc-field doc-wide">Description *<textarea data-line="description" rows="2" maxlength="2500" required>${escape(line.description)}</textarea></label>${makeInput('HSN / SAC', 'hsn', 'maxlength="8" inputmode="numeric"')}${makeInput('Quantity *', 'quantity', 'type="number" inputmode="decimal" min="0.001" max="1000000" step="any" required')}${makeInput('Unit', 'unit', 'list="doc-unit-options" maxlength="20"')}${delivery ? '' : `${makeInput(line.pricing?.mode === 'jewellery' ? 'Metal rate (₹/g)' : 'Rate (₹)', 'rate', 'type="number" inputmode="decimal" min="0" max="100000000" step="0.01"')}${makeInput('GST (%)', 'gstRate', 'type="number" inputmode="decimal" list="doc-gst-options" min="0" max="40" step="any"')}<label class="doc-field">Amount<output data-line-amount>${money(calculateLineAmount(line, policy))}</output></label>`}</div>${line.catalogItemId ? `<p class="doc-help">Added from the saved ${escape(line.itemType || 'item')} catalog.</p>` : ''}${delivery ? '' : `<details class="doc-line-pricing" ${line.pricing && line.pricing.mode !== 'standard' ? 'open' : ''}><summary>Pricing method · ${escape(line.pricing?.mode || 'standard')}</summary><div data-pricing-fields>${pricingFields(line, index, locked, policy)}</div></details>`}</fieldset></article>`;
    })
    .join('');
  document.querySelector('[data-action="add-line"]').disabled = locked || form.items.length >= 200;
}
function addCatalogItem(item) {
  if (
    locked ||
    saving ||
    pendingCreate ||
    form.items.length >= 200 ||
    !item ||
    item.organizationId !== organization.id ||
    !item.active ||
    (item.businessProductId && item.businessProductId !== form.businessProductId)
  )
    return;
  const line = {
    description: [item.name, item.description].filter(Boolean).join('\n'),
    hsn: item.hsn,
    quantity: 1,
    rate: delivery ? 0 : item.rate,
    gstRate: delivery ? 0 : item.gstRate,
    unit: item.unit,
    catalogItemId: item.id,
    itemType: item.type,
    ...(!delivery && item.pricing ? { pricing: structuredClone(item.pricing) } : {}),
  };
  const first = form.items[0];
  const blank = blankLine(profile, delivery);
  const isBlank =
    form.items.length === 1 &&
    !first.description.trim() &&
    !first.hsn.trim() &&
    !first.rate &&
    first.quantity === 1 &&
    !first.gstRate &&
    (!first.unit?.trim() || first.unit === blank.unit) &&
    JSON.stringify(first.pricing) === JSON.stringify(blank.pricing) &&
    !first.catalogItemId;
  update('items', isBlank ? [line] : [...form.items, line]);
  renderLines();
  document.querySelector('#doc-catalog-feedback').textContent =
    `${item.name} added. Edit its quantity${delivery ? ' and delivery details' : ', rate and pricing'} below.`;
}
function refreshBranding() {
  const branding = currentBranding();
  for (const imageArea of editor.querySelectorAll('[data-brand-preview]')) {
    const value = branding[imageArea.dataset.brandPreview];
    imageArea.replaceChildren();
    if (value) {
      const image = new Image();
      image.alt = 'Saved branding image';
      image.src = value;
      imageArea.append(image);
    }
  }
  editor.querySelector('[data-brand-section="logoUrl"]').hidden = branding.logoMode !== 'custom';
  const inherited = document.querySelector('#doc-inherited-logo');
  inherited.replaceChildren();
  const format =
    existing?.formatSnapshot && form.formatId === existing.formatId
      ? existing.formatSnapshot
      : formats.find((item) => item.id === form.formatId);
  const logo = format?.logoUrl || currentSeller().logoUrl;
  if (branding.logoMode === 'inherit' && logo) {
    const image = new Image();
    image.alt = 'Inherited document logo';
    image.src = logo;
    inherited.append(image);
  }
}
function refreshDerived() {
  const policy = linePolicy();
  const seller = currentSeller();
  document.querySelector('#doc-seller').innerHTML =
    `<span class="doc-seller-caption">SELLER / BUSINESS</span><strong>${escape(seller.legalName || seller.name)}</strong>${seller.name !== seller.legalName ? `<span>${escape(seller.name)}</span>` : ''}<p>${escape(seller.address || 'Add a billing address in organization settings.')}</p><small>${seller.gstin ? `GSTIN: ${escape(seller.gstin)}` : 'No GST registration selected'}${seller.stateCode ? ` · ${escape(STATES.find(([code]) => code === seller.stateCode)?.[1] || seller.stateCode)}` : ''}</small>`;
  const customer = currentCustomer();
  const card = document.querySelector('#doc-customer-card');
  card.hidden = !customer;
  if (customer)
    card.innerHTML = `<div><strong>${escape(customer.name)}</strong><small>${escape(
      contactRoles(customer)
        .map((role) => CONTACT_ROLE_LABELS[role])
        .join(' · '),
    )}</small><p>${escape(customer.address)}</p><small>${customer.gstin ? `GSTIN: ${escape(customer.gstin)} · ` : ''}${escape([customer.email, customer.phone].filter(Boolean).join(' · '))}</small></div>`;
  const totals = currentTotals();
  if (customerSummary) renderCustomerSummary();
  const footerTotal = editor.querySelector('[data-footer-total]');
  if (footerTotal) footerTotal.textContent = money(totals.total);
  for (const element of editor.querySelectorAll('[data-total]'))
    element.textContent = `${element.dataset.total === 'discount' ? '− ' : ''}${money(totals[element.dataset.total])}`;
  for (const card of editor.querySelectorAll('.doc-line-card')) {
    const line = form.items[Number(card.dataset.lineIndex)];
    // Removing a line updates state before its old DOM card is removed.
    if (!line) continue;
    const amount = card.querySelector('[data-line-amount]');
    if (amount) amount.textContent = money(calculateLineAmount(line, policy));
    const summary = card.querySelector('[data-pricing-summary]');
    if (summary) summary.innerHTML = pricingSummary(line, policy);
    const net = card.querySelector('[data-net-weight]');
    if (net) net.textContent = `${Number(linePriceBreakdown(line, policy).netWeight.toFixed(6))} g`;
  }
  const format =
    existing?.formatSnapshot && form.formatId === existing.formatId
      ? existing.formatSnapshot
      : formats.find((item) => item.id === form.formatId) || defaultFormatFor(seller);
  document.querySelector('#doc-format-details').textContent =
    `${format.name} · ${format.layout} layout · ${format.density} spacing · ${format.pageSize || 'A4'} ${format.orientation || 'portrait'}. ${existing?.formatSnapshot && form.formatId === existing.formatId ? 'Saved format snapshot is retained.' : 'Used for preview, print and PDF.'}`;
  const product =
    form.businessProductId === existing?.businessProductId
      ? existing?.businessProductSnapshot || products.find((item) => item.id === form.businessProductId)
      : products.find((item) => item.id === form.businessProductId);
  document.querySelector('#doc-product-hint').textContent =
    product?.description || 'The catalog includes this product’s items and shared organization services.';
  document.querySelector('#doc-billing-hint').textContent =
    `${BILLING_PROFILES[profile].label} · ${BILLING_PROFILES[profile].hint}`;
  document.querySelector('#doc-snapshot-note').textContent =
    existing && !changedFinancially()
      ? 'Saved seller, customer, business product and financial totals are retained unless financial details change.'
      : 'Seller identity, bank and contact details will be saved as snapshots with this document.';
  const plan = form.installmentPlan;
  document.querySelector('#doc-existing-plan').hidden = !plan || delivery;
  if (plan && !delivery) {
    const mismatch =
      plan.installments.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) !==
      Math.round(totals.total * 100);
    document.querySelector('#doc-plan-summary').innerHTML =
      `<strong>${escape(plan.name)}</strong><ul>${plan.installments.map((entry) => `<li>${escape(entry.label)} · ${escape(entry.dueDate)} · ${money(entry.amount)}</li>`).join('')}</ul>${mismatch ? '<p class="doc-field-error">The installment schedule does not match the edited total. Clear it, then create a revised plan in Payments.</p>' : ''}`;
  }
  if (field('dueDate')) field('dueDate').min = form.issueDate || '2000-01-01';
}
// ---------------------------------------------------------------------------
// Validation before save (returns field -> message)
// ---------------------------------------------------------------------------
function validate() {
  const errors = {};
  const seller = currentSeller();
  const totals = currentTotals();
  if (!form.customerId) errors.customerId = 'Choose a saved customer, B2B buyer or vendor.';
  if (!registrationAvailable() && (!existing || changedFinancially()))
    errors.gstRegistrationId = 'Choose a current seller GST registration.';
  if (!form.title.trim()) errors.title = 'Add a document title.';
  if (!form.issueDate) errors.issueDate = 'Choose an issue date.';
  if (form.dueDate && form.dueDate < form.issueDate)
    errors.dueDate = 'Choose a date on or after the issue date.';
  if (
    !form.items.length ||
    form.items.length > 200 ||
    form.items.some(
      (item) =>
        !item.description.trim() ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0 ||
        (!delivery &&
          (!Number.isFinite(item.rate) ||
            item.rate < 0 ||
            !Number.isFinite(item.gstRate) ||
            item.gstRate < 0 ||
            item.gstRate > 40)),
    )
  )
    errors.items = delivery
      ? 'Each item needs a description and quantity above zero.'
      : 'Each item needs a description, quantity above zero, non-negative rate and GST from 0% to 40%.';
  if (form.items.some((item) => item.hsn.trim() && !/^\d{4,8}$/.test(item.hsn.trim())))
    errors.items = 'HSN / SAC must contain 4–8 digits, or be blank.';
  if (
    !delivery &&
    (!Number.isFinite(form.discountPercent) || form.discountPercent < 0 || form.discountPercent > 100)
  )
    errors.discountPercent = 'Enter a discount between 0% and 100%.';
  const hasTax = !delivery && form.items.some((item) => item.gstRate > 0);
  if (hasTax && !form.placeOfSupply)
    errors.placeOfSupply = 'Choose place of supply to calculate CGST/SGST or IGST.';
  if (hasTax && (!seller.gstin || !seller.stateCode))
    errors.gstRegistrationId = 'Choose a registered seller GSTIN and state before charging GST.';
  if (
    form.shipping.dispatchDate &&
    form.shipping.deliveryDate &&
    form.shipping.deliveryDate < form.shipping.dispatchDate
  )
    errors.shipping = 'Delivery must be on or after dispatch.';
  if (
    (organization.enableProductSelection ?? profile === 'ecosystem') &&
    products.length &&
    (!existing || changedFinancially()) &&
    !form.businessProductId
  )
    errors.businessProductId = 'Choose the business product for this document.';
  if (pendingProductId !== null) errors.businessProductId = 'Confirm or cancel the pending product change.';
  if (!delivery) {
    form.items.forEach((item, index) => {
      const problem = validatePricing(item.pricing);
      if (problem) errors.items = `Item ${index + 1}: ${problem}`;
      if (item.pricing?.mode === 'jewellery' && !Number.isInteger(item.quantity))
        errors.items = `Item ${index + 1}: jewellery quantity must be a whole number of pieces.`;
    });
    if (totals.subtotal > 1000000000) errors.items = 'Document subtotal cannot exceed ₹100 crore.';
  }
  if (form.branding?.logoMode === 'custom' && !form.branding.logoUrl)
    errors.branding = 'Upload a custom logo, use the inherited logo, or select no logo.';
  if (
    form.installmentPlan &&
    form.installmentPlan.installments.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) !==
      Math.round(totals.total * 100)
  )
    errors.installmentPlan =
      'Clear the installment plan before saving this changed total, then create a revised plan from Payments.';
  return errors;
}
// ---------------------------------------------------------------------------
// User input: typing, dropdown changes, button clicks (add/remove line, choose item, ...)
// ---------------------------------------------------------------------------
editor.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'doc-contact-search') return contactPicker?.search();
  if (target.id === 'doc-catalog-search') return catalogPicker?.search();
  if (target.matches('[data-line]') && !locked) {
    const index = Number(target.closest('.doc-line-card').dataset.lineIndex);
    form.items[index][target.dataset.line] = target.type === 'number' ? Number(target.value) : target.value;
    clearError('items');
    saveDraft();
    refreshDerived();
    return;
  }
  if (target.matches('[data-pricing]') && target.dataset.pricing !== 'mode' && !locked) {
    const index = Number(target.closest('.doc-line-card').dataset.lineIndex);
    const key = target.dataset.pricing;
    const value = target.type === 'number' ? Number(target.value) : target.value;
    if (key.startsWith('jewellery.')) form.items[index].pricing.jewellery[key.split('.')[1]] = value;
    else form.items[index].pricing[key] = value;
    clearError('items');
    saveDraft();
    refreshDerived();
    return;
  }
  if (target.dataset.shipping)
    return update('shipping', { ...form.shipping, [target.dataset.shipping]: target.value });
  if (target.dataset.branding && !locked) {
    update('branding', {
      ...currentBranding(),
      [target.dataset.branding]: target.type === 'checkbox' ? target.checked : target.value,
    });
    refreshBranding();
    return;
  }
  if (
    target.name &&
    !['customerId', 'businessProductId', 'formatId', 'gstRegistrationId', 'status', 'placeOfSupply'].includes(
      target.name,
    )
  )
    update(target.name, target.type === 'number' ? Number(target.value) : target.value);
});
editor.addEventListener('change', async (event) => {
  const target = event.target;
  if (target.name === 'customerId') return chooseCustomer(target.value);
  if (target.name === 'businessProductId') return chooseProduct(target.value);
  if (target.id === 'doc-catalog-type') return catalogPicker?.search({ immediate: true });
  if (['formatId', 'gstRegistrationId', 'status', 'placeOfSupply'].includes(target.name)) {
    update(target.name, target.name === 'formatId' ? target.value || undefined : target.value);
    refreshBranding();
    updateSaveAvailability();
    return;
  }
  if (target.dataset.pricing === 'mode' && !locked) {
    const card = target.closest('.doc-line-card');
    const index = Number(card.dataset.lineIndex);
    form.items[index].pricing =
      target.value === 'standard'
        ? undefined
        : target.value === 'recurring'
          ? { mode: 'recurring', periods: 1, periodUnit: 'Month' }
          : emptyJewelleryPricing();
    if (target.value === 'jewellery') {
      form.items[index].unit = 'Piece';
      card.querySelector('[data-line="unit"]').value = 'Piece';
    }
    card.querySelector('[data-pricing-fields]').innerHTML = pricingFields(
      form.items[index],
      index,
      locked,
      linePolicy(),
    );
    saveDraft();
    refreshDerived();
    return;
  }
  if (target.dataset.brandUpload && !locked) {
    const file = target.files?.[0];
    target.value = '';
    if (!file) return;
    uploadCount += 1;
    updateSaveAvailability();
    try {
      const value = await readImage(file);
      update('branding', { ...currentBranding(), [target.dataset.brandUpload]: value });
      refreshBranding();
    } catch (error) {
      feedback(error.message);
    } finally {
      uploadCount -= 1;
      updateSaveAvailability();
    }
  }
});
editor.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || initializing || saving || finalized || pendingCreate) return;
  if (button.dataset.contactRole) {
    contactRole = button.dataset.contactRole;
    for (const item of editor.querySelectorAll('[data-contact-role]'))
      item.setAttribute('aria-pressed', String(item === button));
    return contactPicker?.search({ immediate: true });
  }
  if (button.dataset.catalogId)
    return addCatalogItem(catalog.find((item) => item.id === button.dataset.catalogId));
  if (button.dataset.removeLine !== undefined && !locked && form.items.length > 1) {
    update(
      'items',
      form.items.filter((_, index) => index !== Number(button.dataset.removeLine)),
    );
    renderLines();
    return;
  }
  if (button.dataset.removeBrand && !locked) {
    update('branding', { ...currentBranding(), [button.dataset.removeBrand]: '' });
    refreshBranding();
    return;
  }
  if (button.matches('[data-copy-last]')) return copyLastDocumentItems();
  switch (button.dataset.action) {
    case 'add-line':
      if (!locked && form.items.length < 200) {
        update('items', [...form.items, blankLine(profile, delivery)]);
        renderLines();
      }
      break;
    case 'keep-product':
      pendingProductId = null;
      document.querySelector('#doc-product-change').hidden = true;
      break;
    case 'confirm-product':
      if (!locked && pendingProductId !== null) {
        const incompatible = new Set(incompatibleLines(pendingProductId));
        form.items = form.items.filter((item) => !incompatible.has(item));
        if (!form.items.length) form.items = [blankLine(profile, delivery)];
        update('businessProductId', pendingProductId || undefined);
        pendingProductId = null;
        document.querySelector('#doc-product-change').hidden = true;
        syncFields();
        renderLines();
        catalogPicker?.search({ immediate: true });
      }
      break;
    case 'copy-logo':
      if (!locked) {
        update('branding', { ...currentBranding(), logoMode: 'custom', logoUrl: organization.logoUrl });
        syncFields();
        refreshBranding();
      }
      break;
    case 'copy-shipping': {
      const customer = currentCustomer();
      if (customer) {
        update('shipping', {
          ...form.shipping,
          recipientName: customer.name,
          address: customer.address,
          stateCode: customer.stateCode,
          phone: customer.phone,
        });
        syncFields();
      }
      break;
    }
    case 'clear-plan':
      if (!locked) update('installmentPlan', null);
      break;
  }
});
for (const link of editor.querySelectorAll('[data-manager-link]')) {
  const url = new URL(link.href, location.origin);
  url.searchParams.set('returnTo', location.pathname);
  if (form.businessProductId && url.pathname.includes('/catalog'))
    url.searchParams.set('businessProductId', form.businessProductId);
  link.href = url.pathname + url.search;
  link.addEventListener('click', (event) => {
    if (saving || uploadCount || locked || pendingCreate) {
      event.preventDefault();
      return;
    }
    if (!saveDraft()) {
      event.preventDefault();
      feedback('This browser could not keep your draft. Allow session storage before leaving this form.');
      return;
    }
    if (url.pathname.endsWith('/customers/new')) {
      const token = crypto.randomUUID();
      const started = beginContactHandoff(draftStorage, token, {
        organizationId: organization.id,
        draftId,
        returnTo: location.pathname,
      });
      if (!started) {
        event.preventDefault();
        feedback('This browser could not keep the return to this draft. Please allow session storage.');
        return;
      }
      url.searchParams.set(CONTACT_HANDOFF_PARAM, token);
      link.href = url.pathname + url.search;
    }
  });
}
// ---------------------------------------------------------------------------
// Save button state, "Start fresh" / discard draft dialog, save conflicts
// ---------------------------------------------------------------------------
function updateSaveAvailability() {
  if (resetDraftButton) {
    resetDraftButton.disabled = initializing || initializationFailed || saving || uploadCount > 0;
    document.querySelector('#doc-draft-status').textContent = pendingCreate
      ? 'An earlier save needs to be confirmed. Review it before starting a fresh draft.'
      : existing
        ? 'Unsaved changes stay in this browser tab. Discard reloads the latest saved document.'
        : 'Unsaved entries are kept in this browser tab. Start fresh clears this local draft.';
  }
  const issue = document.querySelector('#doc-issue-button');
  if (issue) {
    issue.hidden = Boolean(pendingCreate) || form.status !== 'draft';
    issue.disabled = initializing || initializationFailed || saving || uploadCount > 0 || saveConflict;
  }
  const button = document.querySelector('#doc-save-button');
  if (!button) return;
  button.disabled = initializing || initializationFailed || saving || uploadCount > 0 || saveConflict;
  button.textContent = initializing
    ? 'Loading saved details…'
    : saving
      ? 'Saving…'
      : uploadCount
        ? 'Reading images…'
        : pendingCreate
          ? 'Retry save'
          : `Save ${DOCUMENT_LABELS[form.kind].toLowerCase()}`;
}

function resetHasPendingCreation() {
  return Boolean(
    pendingCreate ||
    readStoredDraft(draftStorage, draftKey)?.pendingCreate ||
    readStoredDraft(draftStorage, `${draftKey}:recovery`)?.pendingCreate,
  );
}

function openDraftReset(forcePending = false) {
  if (!resetDraftDialog || finalized || saving || uploadCount) return;
  const pending = forcePending || resetHasPendingCreation();
  const confirmButton = resetDraftDialog.querySelector('[data-reset-confirm]');
  const retryButton = resetDraftDialog.querySelector('[data-reset-retry]');
  const latestLink = resetDraftDialog.querySelector('[data-reset-latest]');
  const error = resetDraftDialog.querySelector('[data-reset-error]');
  error.hidden = true;
  error.textContent = '';
  confirmButton.hidden = pending;
  retryButton.hidden = !pending || saveConflict;
  retryButton.textContent = pendingCreate ? 'Retry saved request' : 'Reload saved request';
  latestLink.hidden = !pending;
  latestLink.href =
    (saveConflict && document.querySelector('[data-open-latest]')?.getAttribute('href')) ||
    `/workspace/${encodeURIComponent(organization.id)}/${data.route.view}`;
  latestLink.textContent = saveConflict
    ? document.querySelector('[data-open-latest]').textContent
    : 'Open saved documents';
  document.querySelector('#doc-reset-title').textContent = pending
    ? 'Check the earlier save first'
    : existing
      ? 'Discard unsaved changes?'
      : `Start a fresh ${DOCUMENT_LABELS[form.kind].toLowerCase()}?`;
  document.querySelector('#doc-reset-copy').textContent = pending
    ? saveConflict
      ? 'This draft is linked to a save that needs review. Open the saved document in another tab and compare its details. This local draft and its saved request will be kept here.'
      : 'An earlier save may already have created this document. Check that same save before starting another draft. Its entries and saved request will be kept until the result is confirmed.'
    : existing
      ? 'The entries currently in this form will be discarded. The latest saved document will reopen so you can review it and continue editing.'
      : 'Your unsaved entries will be discarded and a blank document will open. Saved documents and receipts are unaffected.';
  confirmButton.textContent = existing ? 'Discard and reload latest' : 'Discard and start fresh';
  if (!resetDraftDialog.open) {
    document.body.classList.add('draft-dialog-open');
    resetDraftDialog.showModal();
  }
}

resetDraftButton?.addEventListener('click', () => openDraftReset());
resetDraftDialog?.querySelector('[data-reset-cancel]').addEventListener('click', () => {
  resetDraftDialog.close('cancel');
});
resetDraftDialog?.addEventListener('close', () => {
  document.body.classList.remove('draft-dialog-open');
  resetDraftButton.focus({ preventScroll: true });
});
resetDraftDialog?.addEventListener('click', (event) => {
  if (event.target !== resetDraftDialog) return;
  const bounds = resetDraftDialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    resetDraftDialog.close('cancel');
});
resetDraftDialog?.querySelector('[data-reset-confirm]').addEventListener('click', () => {
  if (saving || uploadCount || finalized) return;
  const result = discardLocalDraft(draftStorage, draftKey, { draftId, pendingCreate });
  if (!result.discarded) {
    if (result.reason === 'pending') return openDraftReset(true);
    const error = resetDraftDialog.querySelector('[data-reset-error]');
    error.textContent =
      result.reason === 'changed'
        ? 'A different local draft is now stored for this editor. Reload and review it before discarding.'
        : 'This browser could not clear the local draft safely. Allow session storage and try again.';
    error.hidden = false;
    return;
  }
  resetDraftDialog.close('discard');
  // A clean navigation also consumes old contact/catalog return parameters.
  location.replace(location.pathname);
});
resetDraftDialog?.querySelector('[data-reset-retry]').addEventListener('click', () => {
  if (saving || uploadCount || saveConflict) return;
  resetDraftDialog.close('retry');
  if (pendingCreate) editor.requestSubmit();
  else location.reload();
});

function showSaveConflict(error) {
  saveConflict = true;
  saveDraft();
  writeStoredDraft(draftStorage, `${draftKey}:recovery`, {
    updatedAt: existing?.updatedAt || '',
    version: existing?.version ?? 0,
    draft: form,
  });
  const panel = document.querySelector('#doc-save-conflict');
  panel.hidden = false;
  const latest = panel.querySelector('[data-open-latest]');
  const savedDocument = existing || error.document;
  latest.href = savedDocument
    ? documentUrl(savedDocument, 'edit')
    : `/workspace/${encodeURIComponent(organization.id)}/${data.route.view}`;
  latest.textContent = savedDocument ? 'Open latest saved version' : 'Open saved documents';
  feedback(
    error.code === 'DOCUMENT_REQUEST_CONFLICT'
      ? 'This draft has already been saved with different details. Your entries remain here. Open the saved document to review them.'
      : 'This document was updated after you opened it. Your unsaved entries remain here. Open the latest saved version in another tab and reapply the changes you want to keep.',
  );
  document.querySelector('#doc-editor-feedback').focus();
}

document.querySelector('[data-download-unsaved]')?.addEventListener('click', () => {
  downloadText(
    `${existing?.number || 'unsaved-document'}`.replace(/[^a-zA-Z0-9_-]/g, '-') + '-unsaved.json',
    JSON.stringify({ basedOnVersion: existing?.version ?? 0, document: form }, null, 2),
    'application/json;charset=utf-8',
  );
});

// ---------------------------------------------------------------------------
// Save: POST (new) or PUT (existing) to /api/documents, then open the saved document
// ---------------------------------------------------------------------------
editor.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (initializing || initializationFailed || saving || finalized || uploadCount || saveConflict) return;
  // "Save & issue" saves a new draft straight as sent (issued); the server then emails it if set up.
  if (event.submitter?.matches('[data-issue]') && form.status === 'draft') {
    update('status', 'sent');
    syncFields();
  }
  const errors = pendingCreate ? {} : validate();
  showErrors(errors);
  if (Object.keys(errors).length) {
    feedback('Please complete the highlighted fields.');
    document.querySelector('#doc-editor-feedback').focus();
    return;
  }
  saving = true;
  updateSaveAvailability();
  feedback();
  editor.querySelector('.doc-content-fieldset').disabled = true;
  try {
    const input = pendingCreate || {
      ...form,
      ...(existing ? { version: existing.version ?? 0 } : { requestId }),
      title: form.title.trim(),
      discountPercent: delivery ? 0 : form.discountPercent,
      items: form.items.map((item) => ({
        ...item,
        description: item.description.trim(),
        hsn: item.hsn.trim(),
        unit: item.unit?.trim(),
        ...(delivery ? { rate: 0, gstRate: 0, pricing: undefined } : {}),
      })),
    };
    if (!existing) {
      // Persist before sending. A lost response must retry these exact details under the same ID.
      const alreadyPending = Boolean(pendingCreate);
      pendingCreate = JSON.parse(JSON.stringify(input));
      if (!saveDraft()) {
        if (!alreadyPending) pendingCreate = null;
        throw new Error(
          'This browser could not keep the save request. Allow session storage or free some browser storage, then retry.',
        );
      }
    }
    const saved = await api(
      existing ? `/documents/${encodeURIComponent(existing.id)}` : '/documents',
      sendJson(existing ? 'PUT' : 'POST', input),
    );
    if (!saved.id || !saved.organizationId || !saved.kind)
      throw new Error('The save response could not be confirmed. Retry to check the same request.');
    removeStoredDraft(draftStorage, draftKey);
    location.assign(documentUrl(saved));
  } catch (error) {
    if (
      error.status === 409 &&
      ['DOCUMENT_VERSION_CONFLICT', 'DOCUMENT_REQUEST_CONFLICT'].includes(error.code)
    ) {
      showSaveConflict(error);
    } else {
      // These rejections happen before creation. Let the user correct the form without changing its ID.
      if (!existing && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status)) {
        pendingCreate = null;
        saveDraft();
      }
      feedback(
        pendingCreate
          ? 'The save result is not confirmed. Your entries are kept. Use Retry save to check the same request before editing or creating another document.'
          : error.message || 'Could not save this document. Please try again.',
      );
    }
  } finally {
    saving = false;
    editor.querySelector('.doc-content-fieldset').disabled = finalized || Boolean(pendingCreate);
    updateSaveAvailability();
  }
});
syncFields();
renderContacts();
renderLines();
renderCatalog();
refreshDerived();
refreshBranding();

// ---------------------------------------------------------------------------
// Contact and catalog pickers (only while the document can still be edited)
// ---------------------------------------------------------------------------
if (!locked) {
  contactPicker = createDirectoryPicker({
    kind: 'customers',
    organizationId: organization.id,
    initialPage: data.lookupPages?.customers,
    parameters: () => ({ q: document.querySelector('#doc-contact-search').value.trim(), role: contactRole }),
    status: document.querySelector('#doc-contact-status'),
    previous: document.querySelector('#doc-contact-previous'),
    next: document.querySelector('#doc-contact-next'),
    retry: document.querySelector('#doc-contact-retry'),
    onBusy: (busy) => {
      field('customerId').disabled = busy || initializing || saving || Boolean(pendingCreate);
    },
    onPage: (page) => {
      replaceDirectoryRows(customers, page.items, [form.customerId, existing?.customerId]);
      contactPageIds = new Set(page.items.map((item) => item.id));
      renderContacts();
      refreshDerived();
    },
  });
  catalogPicker = createDirectoryPicker({
    kind: 'catalog',
    organizationId: organization.id,
    initialPage: data.lookupPages?.catalog,
    parameters: () => ({
      q: document.querySelector('#doc-catalog-search').value.trim(),
      type: document.querySelector('#doc-catalog-type').value,
      product: form.businessProductId || 'shared',
    }),
    status: document.querySelector('#doc-catalog-status'),
    previous: document.querySelector('#doc-catalog-previous'),
    next: document.querySelector('#doc-catalog-next'),
    retry: document.querySelector('#doc-catalog-retry'),
    onBusy: (busy) => {
      document.querySelectorAll('[data-catalog-id]').forEach((button) => {
        button.disabled = busy || initializing || saving || Boolean(pendingCreate);
      });
    },
    onPage: (page) => {
      replaceDirectoryRows(
        catalog,
        page.items,
        form.items.map((line) => line.catalogItemId),
      );
      catalogPageIds = new Set(page.items.map((item) => item.id));
      renderCatalog();
    },
  });
}

// ---------------------------------------------------------------------------
// Startup: load pickers and referenced records, restore the draft, first render
// ---------------------------------------------------------------------------
async function initializeEditor() {
  editor.querySelector('.doc-content-fieldset').disabled = true;
  updateSaveAvailability();
  const params = new URLSearchParams(location.search);
  const scope = { organizationId: organization.id, draftId, returnTo: location.pathname };
  const token = params.get(CONTACT_HANDOFF_PARAM);
  const handoffId = !locked && !pendingCreate ? peekContactHandoff(draftStorage, token, scope) : '';
  const catalogReturn = params.get('catalogId');
  const newCatalogId =
    !locked && !pendingCreate && /^[a-zA-Z0-9_-]{1,100}$/.test(catalogReturn || '') ? catalogReturn : '';
  try {
    const wantedContacts = [form.customerId, handoffId].filter(
      (id) => id && !customers.some((item) => item.id === id),
    );
    const wantedCatalog = locked
      ? []
      : [...form.items.map((line) => line.catalogItemId), newCatalogId].filter(
          (id) => id && !catalog.some((item) => item.id === id),
        );
    const [restoredContacts, restoredCatalog] = await Promise.all([
      fetchDirectoryRecords('customers', organization.id, wantedContacts),
      fetchDirectoryRecords('catalog', organization.id, wantedCatalog),
    ]);
    replaceDirectoryRows(customers, [...customers, ...restoredContacts]);
    replaceDirectoryRows(catalog, [...catalog, ...restoredCatalog]);
    initializing = false;
    let handoffApplied = !handoffId;
    if (handoffId && customers.some((item) => item.id === handoffId && isInvoiceRecipient(item))) {
      const newContactId = consumeContactHandoff(draftStorage, token, scope);
      if (newContactId) {
        chooseCustomer(newContactId);
        handoffApplied = true;
      }
    }
    const newFormatId = params.get('formatId');
    if (newFormatId && formats.some((item) => item.id === newFormatId)) {
      update('formatId', newFormatId);
      syncFields();
      refreshBranding();
    }
    if (newCatalogId) addCatalogItem(catalog.find((item) => item.id === newCatalogId));
    for (const key of ['customerId', 'catalogId', 'formatId']) params.delete(key);
    if (handoffApplied) params.delete(CONTACT_HANDOFF_PARAM);
    history.replaceState(
      history.state,
      '',
      `${location.pathname}${params.size ? '?' + params : ''}${location.hash}`,
    );
    if (!handoffApplied)
      feedback('The saved contact could not be selected. Search for it, or reload to retry the return.');
    renderContacts();
    renderLines();
    renderCatalog();
    refreshDerived();
    void loadCustomerSummary();
    if (!locked && (form.businessProductId || '') !== (existing?.businessProductId || ''))
      catalogPicker.search({ immediate: true });
    saveDraft();
  } catch {
    initializationFailed = !pendingCreate;
    feedback(
      pendingCreate
        ? 'Your previous save is still protected. Use Retry save to check that same request.'
        : 'Saved draft details could not be loaded. Reload to retry; your saved local entries have been kept.',
    );
  } finally {
    initializing = false;
    editor.querySelector('.doc-content-fieldset').disabled =
      finalized || Boolean(pendingCreate) || initializationFailed;
    field('customerId').disabled = locked || Boolean(pendingCreate) || initializationFailed;
    updateSaveAvailability();
    if (pendingCreate)
      feedback(
        'A previous save has not been confirmed. Your entries are kept. Use Retry save to check that same request.',
      );
  }
}
void initializeEditor();
