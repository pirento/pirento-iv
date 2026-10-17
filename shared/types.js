/**
 * Core business constants and calculations shared by server and browser: document and status
 * labels, units, Indian states, payment methods, default formats, totals/GST calculation,
 * balances and installment allocation. The server is always the source of truth for saved totals.
 */

import { decimal } from './decimal.js';
import { legacyLinePriceBreakdown } from './legacy-pricing.js';

// Group company legal name: seeded as the workspace name and the legal name of group businesses.
export const COMPANY_NAME = 'Venturecore Solutions Private Limited';
// Document kind -> display name.
export const DOCUMENT_LABELS = {
  invoice: 'Invoice',
  quotation: 'Quotation',
  proforma: 'Proforma invoice',
  delivery_note: 'Delivery challan',
};
// Document status -> display name.
export const STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  paid: 'Paid',
  partially_paid: 'Partially paid',
  accepted: 'Accepted',
  declined: 'Declined',
  cancelled: 'Cancelled',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
};
// Units offered for catalog items and line items.
export const CATALOG_UNITS = [
  'Nos',
  'Unit',
  'Piece',
  'Kg',
  'Gram',
  'Meter',
  'Sq ft',
  'Hour',
  'Day',
  'Month',
  'Year',
  'Visit',
  'Project',
  'Service',
  'Set',
  'Lot',
  'Person',
  'Shift',
  'Lift',
  'Seat',
  'Room',
  'Case',
  'Draft',
  'Sq m',
  'Carat',
  'Milligram',
  'License',
  'User',
];
// Empty shipping details for a new document.
export const blankShipping = () => ({
  recipientName: '',
  address: '',
  stateCode: '',
  phone: '',
  carrier: '',
  trackingNumber: '',
  vehicleNumber: '',
  dispatchDate: '',
  deliveryDate: '',
  reference: '',
  notes: '',
});
// Receipt payment methods -> display names.
export const PAYMENT_METHODS = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
/** The built-in "Standard" format for a business (used when a document has no saved format). */
export function defaultFormatFor(organization) {
  return {
    id: `${organization.id}-standard`,
    organizationId: organization.id,
    name: 'Standard',
    layout: organization.template,
    accentColor: organization.accentColor,
    density: 'comfortable',
    showLogo: true,
    showHsn: true,
    showUnit: true,
    showGstRate: true,
    showBankDetails: true,
    showSignature: true,
    showAmountInWords: true,
    footerText: 'Thank you for your business.',
    isDefault: true,
    createdAt: '',
    updatedAt: '',
    pageSize: 'A4',
    orientation: 'portrait',
    fontSize: 9,
    logoWidth: 72,
    pageMargin: 14,
    tableStyle: 'ruled',
    logoUrl: '',
    showPaymentQr: true,
    paymentQrWidth: 110,
    signatureWidth: 140,
    showSecondarySignature: true,
    showStamp: true,
    stampWidth: 110,
  };
}
/** The format saved with a document, on top of the defaults (older documents lack newer fields). */
export function getDocumentFormat(document) {
  return {
    ...defaultFormatFor(document.organizationSnapshot),
    ...document.formatSnapshot,
  };
}
// Amount received on an invoice (older paid invoices may lack amountPaid).
export const paidAmount = (document) =>
  document.amountPaid ??
  (document.kind === 'invoice' && document.status === 'paid' ? document.totals.total : 0);
// Amount still owed on an invoice (0 for other document kinds).
export const balanceDue = (document) =>
  document.kind === 'invoice'
    ? (document.balanceDue ??
      Math.max(0, Math.round((document.totals.total - paidAmount(document)) * 100) / 100))
    : 0;
// Indian states and union territories: [GST state code, name].
export const STATES = [
  ['01', 'Jammu & Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra & Nagar Haveli and Daman & Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman & Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
];
// Formats a number as Indian rupees, e.g. 125000 -> "₹1,25,000.00".
export const money = (value) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(value);
// Rounding policy saved on documents: new documents use exact decimal; older ones keep their original display.
export const DECIMAL_ROUNDING_POLICY = 'decimal-half-up-v1';
export const LEGACY_ROUNDING_POLICY = 'legacy-binary-v1';

/** Unmarked historical totals keep their original line display on every render. */
export function documentRoundingPolicy(document) {
  return document?.totals?.roundingPolicy === DECIMAL_ROUNDING_POLICY
    ? DECIMAL_ROUNDING_POLICY
    : LEGACY_ROUNDING_POLICY;
}

/**
 * Keep the established pricing stages, using exact decimal half-up rounding:
 * line components -> subtotal -> document discount; GST is rounded per line
 * after its proportional discount. Intrastate CGST receives a half-paise tie,
 * and SGST is the exact remainder so the two always equal the saved tax.
 */
export function calculateTotals(items, discountPercent, interstate) {
  const lines = items.map((item) => ({ amount: decimal(calculateLineAmount(item)), gstRate: item.gstRate }));
  const subtotal = lines.reduce((sum, line) => sum.plus(line.amount), decimal(0)).round();
  const discount = subtotal.times(discountPercent).times(0.01).round();
  const taxable = subtotal.minus(discount).round();
  const discountFactor = decimal(1).minus(decimal(discountPercent).times(0.01));
  const tax = lines
    .reduce(
      (sum, line) => sum.plus(line.amount.times(discountFactor).times(line.gstRate).times(0.01).round()),
      decimal(0),
    )
    .round();
  const cgst = interstate ? decimal(0) : tax.times(0.5).round();
  const sgst = interstate ? decimal(0) : tax.minus(cgst).round();
  return {
    subtotal: subtotal.toNumber(),
    discount: discount.toNumber(),
    taxable: taxable.toNumber(),
    cgst: cgst.toNumber(),
    sgst: sgst.toNumber(),
    igst: interstate ? tax.toNumber() : 0,
    total: taxable.plus(tax).round().toNumber(),
    roundingPolicy: DECIMAL_ROUNDING_POLICY,
  };
}
// Rounds a rupee amount to 2 decimals (half-up, exact decimal) and returns a Number.
export const roundMoney = (value) => decimal(value).round().toNumber();
/**
 * Splits one line item into { base, making, wastage, stones, other, netWeight, periods, total }.
 * Normal lines: quantity x periods x rate. Jewellery lines: quantity x net weight x metal rate plus
 * making/wastage/stone/other charges. Old documents use the legacy (binary) rounding.
 */
export function linePriceBreakdown(item, roundingPolicy = DECIMAL_ROUNDING_POLICY) {
  if (roundingPolicy === LEGACY_ROUNDING_POLICY) return legacyLinePriceBreakdown(item);
  const quantity = decimal(Number.isFinite(item.quantity) ? item.quantity : 0);
  const rate = decimal(Number.isFinite(item.rate) ? item.rate : 0);
  const pricing = item.pricing;
  const jewellery = pricing?.mode === 'jewellery' ? pricing.jewellery : undefined;
  const periods = pricing?.mode === 'recurring' ? (pricing.periods ?? 1) : 1;
  const weight = jewellery ? decimal(jewellery.grossWeight).minus(jewellery.stoneWeight) : decimal(0);
  const netWeight = weight.isNegative() ? decimal(0) : weight;
  const base = quantity
    .times(jewellery ? netWeight : periods)
    .times(rate)
    .round();
  const making = jewellery
    ? (jewellery.makingChargeType === 'percent'
        ? base.times(jewellery.makingCharge).times(0.01)
        : quantity
            .times(jewellery.makingCharge)
            .times(jewellery.makingChargeType === 'per_gram' ? netWeight : 1)
      ).round()
    : decimal(0);
  const wastage = jewellery ? base.times(jewellery.wastagePercent).times(0.01).round() : decimal(0);
  const stones = jewellery ? quantity.times(jewellery.stoneAmount).round() : decimal(0);
  const other = jewellery ? quantity.times(jewellery.otherCharges).round() : decimal(0);
  return {
    base: base.toNumber(),
    making: making.toNumber(),
    wastage: wastage.toNumber(),
    stones: stones.toNumber(),
    other: other.toNumber(),
    netWeight: netWeight.toNumber(),
    periods,
    total: base.plus(making).plus(wastage).plus(stones).plus(other).round().toNumber(),
  };
}
// Line total only (see linePriceBreakdown).
export const calculateLineAmount = (item, roundingPolicy) => linePriceBreakdown(item, roundingPolicy).total;
// One-line explanation printed under a recurring or jewellery line; '' for normal lines.
export function pricingDescription(item, roundingPolicy) {
  const p = item.pricing;
  const b = linePriceBreakdown(item, roundingPolicy);
  if (p?.mode === 'recurring')
    return `${item.quantity} ${item.unit || 'unit'} × ${p.periods ?? 1} ${p.periodUnit || 'Month'} × ${money(item.rate)} per unit / ${(p.periodUnit || 'Month').toLowerCase()}`;
  if (p?.mode !== 'jewellery' || !p.jewellery) return '';
  const j = p.jewellery;
  return [
    j.purity,
    `Per item: gross ${j.grossWeight} g, stone ${j.stoneWeight} g, net ${Number(b.netWeight.toFixed(6))} g`,
    `Metal rate ${money(item.rate)}/g`,
    `Metal ${money(b.base)}`,
    `Making ${money(b.making)}`,
    ...(b.wastage ? [`Wastage ${money(b.wastage)} (${j.wastagePercent}%)`] : []),
    ...(b.stones ? [`Stones ${money(b.stones)}`] : []),
    ...(b.other ? [`Other ${money(b.other)}`] : []),
  ]
    .filter(Boolean)
    .join(' · ');
}
/** Default signatures and stamp labels for documents of a business. */
export function defaultDocumentBranding(org) {
  return {
    logoMode: 'inherit',
    logoUrl: '',
    primarySignatureLabel: org.signature || 'Authorised Signatory',
    primarySignatureImageUrl: org.signatureImageUrl || '',
    secondarySignatureLabel: org.secondarySignatureLabel || 'Secondary authorised signatory',
    secondarySignatureImageUrl: org.secondarySignatureImageUrl || '',
    stampLabel: org.stampLabel || 'Company stamp',
    stampImageUrl: org.stampImageUrl || '',
    showSecondarySignature: true,
    showStamp: true,
  };
}
// Document branding = business defaults overridden by the document's own branding.
export const getDocumentBranding = (doc) => ({
  ...defaultDocumentBranding(doc.organizationSnapshot),
  ...doc.branding,
});
/** Splits received money across installments, oldest due date first, and marks each paid/partial/overdue/pending. */
export function installmentBalances(
  doc,
  asOf = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()),
) {
  let available = Math.round(paidAmount(doc) * 100);
  return [...(doc.installmentPlan?.installments || [])]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((entry) => {
      const due = Math.round(entry.amount * 100);
      const paid = Math.min(available, due);
      available -= paid;
      const remaining = due - paid;
      return {
        ...entry,
        amountPaid: paid / 100,
        balanceDue: remaining / 100,
        status:
          remaining === 0
            ? 'paid'
            : entry.dueDate < asOf
              ? 'overdue'
              : paid > 0
                ? 'partially_paid'
                : 'pending',
      };
    });
}
