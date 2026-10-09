import type { ContactDetails } from './contact-types';

export type DocumentKind = 'invoice' | 'quotation' | 'proforma' | 'delivery_note';
export type DocumentStatus =
  | 'draft'
  | 'sent'
  | 'paid'
  | 'partially_paid'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'dispatched'
  | 'delivered';
export const COMPANY_NAME = 'Venturecore Solutions Private Limited';
export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  invoice: 'Invoice',
  quotation: 'Quotation',
  proforma: 'Proforma invoice',
  delivery_note: 'Delivery challan',
};
export const STATUS_LABELS: Record<DocumentStatus, string> = {
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

export type CatalogType = 'product' | 'service';
export type BillingProfile =
  'general' | 'legal' | 'facility' | 'elevator' | 'space' | 'jewellery' | 'ecosystem';
export interface WorkspaceSettings {
  companyName: string;
  dashboardLogoUrl: string;
}
export interface BusinessProduct {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string;
  logoUrl: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
export type BusinessProductInput = Omit<BusinessProduct, 'id' | 'createdAt' | 'updatedAt'>;
export interface PricingDetails {
  mode: 'standard' | 'recurring' | 'jewellery';
  periods?: number;
  periodUnit?: 'Hour' | 'Day' | 'Month' | 'Year';
  jewellery?: {
    grossWeight: number;
    stoneWeight: number;
    purity: string;
    makingChargeType: 'fixed' | 'per_gram' | 'percent';
    makingCharge: number;
    stoneAmount: number;
    otherCharges: number;
    wastagePercent: number;
  };
}
export interface DocumentBranding {
  logoMode: 'inherit' | 'custom' | 'none';
  logoUrl: string;
  primarySignatureLabel: string;
  primarySignatureImageUrl: string;
  secondarySignatureLabel: string;
  secondarySignatureImageUrl: string;
  stampLabel: string;
  stampImageUrl: string;
  showSecondarySignature: boolean;
  showStamp: boolean;
}
export interface Installment {
  id: string;
  label: string;
  dueDate: string;
  amount: number;
}
export interface InstallmentPlan {
  name: string;
  installments: Installment[];
}
export interface CatalogItem {
  id: string;
  organizationId: string;
  type: CatalogType;
  name: string;
  description: string;
  sku: string;
  hsn: string;
  unit: string;
  rate: number;
  gstRate: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  pricing?: PricingDetails;
  businessProductId?: string;
}
export type CatalogInput = Omit<CatalogItem, 'id' | 'createdAt' | 'updatedAt'>;

export interface InvoiceFormat {
  id: string;
  organizationId: string;
  name: string;
  layout: 'modern' | 'classic' | 'minimal' | 'ledger' | 'sidebar';
  accentColor: string;
  density: 'comfortable' | 'compact';
  showLogo: boolean;
  showHsn: boolean;
  showUnit: boolean;
  showGstRate: boolean;
  showBankDetails: boolean;
  showSignature: boolean;
  showAmountInWords: boolean;
  showPaymentQr?: boolean;
  paymentQrWidth?: number;
  signatureWidth?: number;
  showSecondarySignature?: boolean;
  showStamp?: boolean;
  stampWidth?: number;
  footerText: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  presetKey?: string;
  description?: string;
  logoUrl?: string;
  pageSize?: 'A4' | 'A5' | 'LETTER';
  orientation?: 'portrait' | 'landscape';
  fontSize?: number;
  logoWidth?: number;
  pageMargin?: number;
  tableStyle?: 'striped' | 'ruled' | 'plain';
}
export type FormatInput = Omit<InvoiceFormat, 'id' | 'createdAt' | 'updatedAt'>;

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
] as const;

export interface GstRegistration {
  id: string;
  label: string;
  gstin: string;
  stateCode: string;
  address: string;
}

export interface Organization {
  id: string;
  name: string;
  legalName: string;
  tradeName?: string;
  businessConstitution?: string;
  businessType?: 'division' | 'independent';
  supportEmail?: string;
  paymentGateway?: 'razorpay' | 'cashfree' | 'none';
  gstRegistrations?: GstRegistration[];
  gstin: string;
  email: string;
  phone: string;
  address: string;
  stateCode: string;
  accentColor: string;
  logoUrl: string;
  signatureImageUrl?: string;
  paymentQrUrl?: string;
  pan?: string;
  cin?: string;
  bankBranch?: string;
  accountType?: string;
  billingProfile?: BillingProfile;
  enableProductSelection?: boolean;
  secondarySignatureLabel?: string;
  secondarySignatureImageUrl?: string;
  stampLabel?: string;
  stampImageUrl?: string;
  invoicePrefix: string;
  quotationPrefix: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  terms: string;
  signature: string;
  template: 'modern' | 'classic';
}

export interface Customer extends ContactDetails {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  phone: string;
  gstin: string;
  address: string;
  stateCode: string;
  contactPerson: string;
}

export interface LineItem {
  description: string;
  hsn: string;
  quantity: number;
  rate: number;
  gstRate: number;
  unit?: string;
  catalogItemId?: string;
  itemType?: CatalogType;
  pricing?: PricingDetails;
}

export interface DocumentInput {
  gstRegistrationId?: string;
  organizationId: string;
  customerId: string;
  kind: DocumentKind;
  status: DocumentStatus;
  issueDate: string;
  dueDate: string;
  title: string;
  items: LineItem[];
  discountPercent: number;
  placeOfSupply: string;
  notes: string;
  terms: string;
  formatId?: string;
  shipping?: ShippingDetails;
  branding?: DocumentBranding;
  businessProductId?: string;
  installmentPlan?: InstallmentPlan | null;
}

export interface ShippingDetails {
  recipientName: string;
  address: string;
  stateCode: string;
  phone: string;
  carrier: string;
  trackingNumber: string;
  vehicleNumber: string;
  dispatchDate: string;
  deliveryDate: string;
  reference: string;
  notes: string;
}
export const blankShipping = (): ShippingDetails => ({
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

export type PaymentMethod = 'bank_transfer' | 'upi' | 'cash' | 'card' | 'cheque' | 'other';
export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  card: 'Card',
  cheque: 'Cheque',
  other: 'Other',
};
export interface PaymentInput {
  amount: number;
  paidOn: string;
  method: PaymentMethod;
  reference: string;
  notes: string;
  requestId: string;
  finalizeWhenPaid?: boolean;
}
export interface PaymentRecord extends PaymentInput {
  id: string;
  documentId: string;
  organizationId: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string;
}
export interface DocumentEvent {
  id: string;
  documentId: string;
  at: string;
  type: string;
  description: string;
}
export interface PaymentDetails {
  document: BusinessDocument;
  payments: PaymentRecord[];
  events: DocumentEvent[];
}

export interface DocumentTotals {
  subtotal: number;
  discount: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

export interface BusinessDocument extends DocumentInput {
  id: string;
  number: string;
  createdAt: string;
  updatedAt: string;
  customerSnapshot: Customer;
  organizationSnapshot: Organization;
  totals: DocumentTotals;
  sourceQuotationId: string | null;
  convertedInvoiceId: string | null;
  formatSnapshot?: InvoiceFormat;
  amountPaid?: number;
  balanceDue?: number;
  finalizedAt?: string | null;
  sourceDocumentId?: string | null;
  deliveryNoteId?: string | null;
  businessProductSnapshot?: BusinessProduct | null;
}

export function defaultFormatFor(organization: Organization): InvoiceFormat {
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

export function getDocumentFormat(document: BusinessDocument): InvoiceFormat {
  return { ...defaultFormatFor(document.organizationSnapshot), ...document.formatSnapshot };
}

export const paidAmount = (document: BusinessDocument) =>
  document.amountPaid ??
  (document.kind === 'invoice' && document.status === 'paid' ? document.totals.total : 0);
export const balanceDue = (document: BusinessDocument) =>
  document.kind === 'invoice'
    ? (document.balanceDue ??
      Math.max(0, Math.round((document.totals.total - paidAmount(document)) * 100) / 100))
    : 0;

export interface GstLookupResult {
  gstin: string;
  name: string;
  address: string;
  stateCode: string;
  status?: string;
}

export const STATES: [string, string][] = [
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

export const money = (value: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(
    value,
  );

export function calculateTotals(
  items: LineItem[],
  discountPercent: number,
  interstate: boolean,
): DocumentTotals {
  const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const subtotal = round(items.reduce((sum, item) => sum + calculateLineAmount(item), 0));
  const discount = round((subtotal * discountPercent) / 100);
  const taxable = round(subtotal - discount);
  const tax = round(
    items.reduce(
      (sum, item) =>
        sum + round((calculateLineAmount(item) * (1 - discountPercent / 100) * item.gstRate) / 100),
      0,
    ),
  );
  const cgst = interstate ? 0 : round(tax / 2);
  const sgst = interstate ? 0 : round(tax - cgst);
  return { subtotal, discount, taxable, cgst, sgst, igst: interstate ? tax : 0, total: round(taxable + tax) };
}

export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export function linePriceBreakdown(item: Pick<LineItem, 'quantity' | 'rate' | 'pricing'>) {
  const quantity = Number.isFinite(item.quantity) ? item.quantity : 0;
  const rate = Number.isFinite(item.rate) ? item.rate : 0;
  const pricing = item.pricing;
  const jewellery = pricing?.mode === 'jewellery' ? pricing.jewellery : undefined;
  const periods = pricing?.mode === 'recurring' ? (pricing.periods ?? 1) : 1;
  const netWeight = jewellery ? Math.max(0, jewellery.grossWeight - jewellery.stoneWeight) : 0;
  const base = roundMoney(quantity * (jewellery ? netWeight : periods) * rate);
  const making = jewellery
    ? roundMoney(
        jewellery.makingChargeType === 'percent'
          ? (base * jewellery.makingCharge) / 100
          : quantity * jewellery.makingCharge * (jewellery.makingChargeType === 'per_gram' ? netWeight : 1),
      )
    : 0;
  const wastage = jewellery ? roundMoney((base * jewellery.wastagePercent) / 100) : 0;
  const stones = jewellery ? roundMoney(quantity * jewellery.stoneAmount) : 0;
  const other = jewellery ? roundMoney(quantity * jewellery.otherCharges) : 0;
  return {
    base,
    making,
    wastage,
    stones,
    other,
    netWeight,
    periods,
    total: roundMoney(base + making + wastage + stones + other),
  };
}
export const calculateLineAmount = (item: Pick<LineItem, 'quantity' | 'rate' | 'pricing'>) =>
  linePriceBreakdown(item).total;
export function pricingDescription(item: LineItem): string {
  const p = item.pricing;
  const b = linePriceBreakdown(item);
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
export function defaultDocumentBranding(org: Organization): DocumentBranding {
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
export const getDocumentBranding = (doc: BusinessDocument): DocumentBranding => ({
  ...defaultDocumentBranding(doc.organizationSnapshot),
  ...doc.branding,
});
export function installmentBalances(
  doc: BusinessDocument,
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
            ? ('paid' as const)
            : entry.dueDate < asOf
              ? ('overdue' as const)
              : paid > 0
                ? ('partially_paid' as const)
                : ('pending' as const),
      };
    });
}
