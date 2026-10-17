/** Helpers for the document editor and preview: URLs, India dates, blank lines, form defaults, lock rules, pricing fields. */

import {
  blankShipping,
  CATALOG_UNITS,
  defaultDocumentBranding,
  DOCUMENT_LABELS,
  money,
  linePriceBreakdown,
  paidAmount,
} from '/shared/types.js';
import { BILLING_PROFILES, billingProfileFor, emptyJewelleryPricing } from '/shared/billing-presets.js';
import { escapeHtml } from '/js/core/api.js';

// Escapes any value (including null) for HTML.
export const escape = (value) => escapeHtml(String(value ?? ''));
// Document kind -> workspace URL section.
export const documentView = (kind) =>
  ({ invoice: 'invoices', quotation: 'quotations', proforma: 'proformas', delivery_note: 'shipping' })[kind];
/** URL of a document page, e.g. /workspace/<business>/invoices/preview/<id>. */
export function documentUrl(doc, action = 'preview') {
  return `/workspace/${encodeURIComponent(doc.organizationId)}/${documentView(doc.kind)}/${action}/${encodeURIComponent(doc.id)}`;
}
/** India date as YYYY-MM-DD, `offset` days from today. */
export function indiaDate(offset = 0) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
/** "5 Oct 2026" (optionally with time) in India time; returns the input if it is not a date. */
export function readableDate(value, time = false) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        ...(time ? { hour: 'numeric', minute: '2-digit' } : {}),
      }).format(date);
}
/** A new empty line item using the business's billing profile (jewellery / recurring pricing when relevant). */
export function blankLine(profile, delivery = false) {
  return {
    description: '',
    hsn: '',
    quantity: 1,
    rate: 0,
    gstRate: 0,
    unit: BILLING_PROFILES[profile].units[0],
    ...(!delivery && profile === 'jewellery'
      ? { pricing: emptyJewelleryPricing() }
      : !delivery && ['facility', 'elevator', 'ecosystem'].includes(profile)
        ? { pricing: { mode: 'recurring', periods: 1, periodUnit: 'Month' } }
        : {}),
  };
}
/** The editor's starting values: the saved document, or defaults for a new one (due in 30 days, default format). */
export function initialDocumentForm(data) {
  const org = data.organization;
  const existing = data.document;
  const kind =
    existing?.kind ||
    { invoices: 'invoice', quotations: 'quotation', proformas: 'proforma', shipping: 'delivery_note' }[
      data.route.view
    ];
  const formats = (data.formats || []).filter((format) => format.organizationId === org.id);
  return {
    customerId: existing?.customerId || '',
    status: existing?.status || 'draft',
    issueDate: existing?.issueDate || indiaDate(),
    dueDate: existing?.dueDate ?? (kind === 'delivery_note' ? '' : indiaDate(30)),
    title: existing?.title ?? DOCUMENT_LABELS[kind],
    discountPercent: existing?.discountPercent ?? 0,
    placeOfSupply: existing?.placeOfSupply || '',
    notes: existing?.notes || '',
    terms: existing?.terms ?? (kind === 'delivery_note' ? '' : org.terms || ''),
    formatId: existing ? existing.formatId : (formats.find((format) => format.isDefault) || formats[0])?.id,
    businessProductId: existing?.businessProductId,
    gstRegistrationId: existing?.gstRegistrationId,
    branding: existing?.branding ? structuredClone(existing.branding) : undefined,
    installmentPlan: existing?.installmentPlan
      ? structuredClone(existing.installmentPlan)
      : existing?.installmentPlan,
    organizationId: org.id,
    kind,
    items: existing?.items
      ? structuredClone(existing.items)
      : [blankLine(billingProfileFor(org), kind === 'delivery_note')],
    shipping: { ...blankShipping(), ...existing?.shipping },
  };
}
// Financial fields are locked once a document is issued, converted, finalized or (invoice) has receipts.
export const documentLocked = (doc) =>
  Boolean(
    doc &&
    (doc.finalizedAt ||
      doc.convertedInvoiceId ||
      doc.status !== 'draft' ||
      (doc.kind === 'invoice' && paidAmount(doc) > 0)),
  );
/** True when the edit changes anything that affects money (customer, dates, items, discount, tax, product). */
export function financialChange(form, existing) {
  return Boolean(
    existing &&
    (['customerId', 'issueDate', 'items', 'discountPercent', 'placeOfSupply', 'businessProductId'].some(
      (key) => JSON.stringify(form[key]) !== JSON.stringify(existing[key]),
    ) ||
      (form.gstRegistrationId || '') !== (existing.gstRegistrationId || '')),
  );
}
/** Checks recurring/jewellery pricing inputs; returns an error message, or '' when valid. */
export function validatePricing(pricing) {
  if (!pricing || pricing.mode === 'standard') return '';
  if (pricing.mode === 'recurring')
    return !Number.isFinite(pricing.periods) || pricing.periods <= 0 || pricing.periods > 1200
      ? 'Enter periods above zero and no more than 1,200.'
      : '';
  const j = pricing.jewellery;
  if (!j) return 'Add the jewellery weight and making details.';
  if (!Number.isFinite(j.grossWeight) || j.grossWeight <= 0 || j.grossWeight > 1000000)
    return 'Gross weight per item must be above zero and no more than 1,000,000 g.';
  if (!Number.isFinite(j.stoneWeight) || j.stoneWeight < 0 || j.stoneWeight >= j.grossWeight)
    return 'Stone weight must be non-negative and less than gross weight.';
  if (
    [j.makingCharge, j.stoneAmount, j.otherCharges].some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100000000,
    )
  )
    return 'Making, stone and other charges must be between zero and ₹10 crore.';
  if (
    !Number.isFinite(j.wastagePercent) ||
    j.wastagePercent < 0 ||
    j.wastagePercent > 100 ||
    (j.makingChargeType === 'percent' && j.makingCharge > 100)
  )
    return 'Wastage and percentage making charges must be between 0% and 100%.';
  return '';
}
function input(label, path, value, attrs = '') {
  return `<label>${escape(label)}<input data-pricing="${path}" value="${escape(value)}" ${attrs}></label>`;
}
/** HTML for a line's pricing method fields (standard, recurring or jewellery). */
export function pricingFields(line, index, disabled = false, roundingPolicy) {
  const mode = line.pricing?.mode || 'standard';
  const p = line.pricing || {};
  const j = p.jewellery || emptyJewelleryPricing().jewellery;
  const detail = linePriceBreakdown(line, roundingPolicy);
  const modeOptions = [
    ['standard', 'Standard · quantity × rate'],
    ['recurring', 'Recurring · units × periods × rate'],
    ['jewellery', 'Jewellery · metal + making + charges'],
  ];
  let fields = `<div class="pricing-mode-row"><label for="line-${index}-mode">Pricing method</label><select id="line-${index}-mode" data-pricing="mode">${modeOptions.map(([key, label]) => `<option value="${key}" ${mode === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`;
  if (mode === 'recurring') {
    fields += `<div class="pricing-fields-grid">${input('Number of periods', 'periods', p.periods ?? 1, 'type="number" min="0.001" max="1200" step="any"')}<label>Period unit<select data-pricing="periodUnit">${['Hour', 'Day', 'Month', 'Year'].map((unit) => `<option ${p.periodUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></label></div>`;
  } else if (mode === 'jewellery') {
    const amountAttrs = 'type="number" min="0" max="100000000" step="any"';
    fields += `<div class="pricing-fields-grid">${input('Gross weight per item (g)', 'jewellery.grossWeight', j.grossWeight, 'type="number" min="0.000001" max="1000000" step="any"')}${input('Stone weight per item (g)', 'jewellery.stoneWeight', j.stoneWeight, 'type="number" min="0" max="1000000" step="any"')}<label>Net metal weight<output data-net-weight>${escape(Number(detail.netWeight.toFixed(6)))} g</output></label>${input('Purity / hallmark', 'jewellery.purity', j.purity, 'maxlength="100" placeholder="22K / 916"')}<label>Making charge method<select data-pricing="jewellery.makingChargeType">${[
      ['per_gram', 'Per gram of net metal'],
      ['fixed', 'Fixed per item'],
      ['percent', '% of metal value'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${j.makingChargeType === value ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></label>${input('Making charge', 'jewellery.makingCharge', j.makingCharge, amountAttrs)}${input('Wastage (%)', 'jewellery.wastagePercent', j.wastagePercent, 'type="number" min="0" max="100" step="any"')}${input('Stone amount per item (₹)', 'jewellery.stoneAmount', j.stoneAmount, amountAttrs)}${input('Other charges per item (₹)', 'jewellery.otherCharges', j.otherCharges, amountAttrs)}</div>`;
  } else fields += '<p class="pricing-hint">The item quantity is multiplied by its rate per unit.</p>';
  fields += `<p class="pricing-formula" data-pricing-summary>${pricingSummary(line, roundingPolicy)}</p>`;
  return `<fieldset class="pricing-fields" data-line-index="${index}" ${disabled ? 'disabled' : ''}>${fields}</fieldset>`;
}
/** HTML formula showing how a line total is calculated, e.g. "2 × ₹1,500 = ₹3,000". */
export function pricingSummary(line, roundingPolicy) {
  const details = linePriceBreakdown(line, roundingPolicy);
  if (line.pricing?.mode === 'jewellery')
    return `Metal ${money(details.base)} · Making ${money(details.making)} · Wastage ${money(details.wastage)} · Stones ${money(details.stones)} · Other ${money(details.other)} = <strong>${money(details.total)}</strong>`;
  if (line.pricing?.mode === 'recurring')
    return `${escape(line.quantity)} ${escape(line.unit || 'units')} × ${escape(line.pricing.periods ?? 1)} ${escape(line.pricing.periodUnit || 'Month')} × ${money(line.rate)} = <strong>${money(details.total)}</strong>`;
  return `${escape(line.quantity)} × ${money(line.rate)} = <strong>${money(details.total)}</strong>`;
}
/** Reads a PNG/JPG/WebP file (max 500 KB) into a data URL after checking it decodes as an image. */
export async function readBrandImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 500 * 1024)
    throw new Error('Choose a PNG, JPG or WebP image up to 500 KB.');
  const value = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Image could not be read.'));
    reader.readAsDataURL(file);
  });
  await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = () => reject(new Error('Choose a valid image file.'));
    image.src = value;
  });
  return value;
}
export { CATALOG_UNITS, defaultDocumentBranding };
