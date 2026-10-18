/**
 * Input validation (zod schemas) for everything the API accepts.
 *
 * Every request body is parsed with one of these schemas before any business logic runs:
 * strings are trimmed and length-limited, numbers range-checked, and Indian business rules
 * applied (state codes, GSTIN check digit, financial amounts in whole paise).
 * A failed parse becomes a 400 response listing each invalid field (src/middleware/api-errors.js).
 */

import { contactFieldSchemas, validateContactFields } from './contacts.js';
import { z } from 'zod';
import './messages.js';
import { COMPANY_NAME, STATES, calculateLineAmount } from '../../../shared/types.js';
import { wholePaise } from '../../../shared/money.js';
// Group company legal name (same as COMPANY_NAME).
export const LEGAL_NAME = COMPANY_NAME;
const stateCodes = new Set(STATES.map(([code]) => code));
// Building blocks: trimmed text with a maximum length; requiredText also rejects empty strings.
const text = (max = 200) => z.string().trim().max(max);
const requiredText = (max = 200) => text(max).min(1, 'This field is required.');
// Two-digit Indian state/UT code from shared/types.js STATES, or empty.
export const stateCode = text(2).refine(
  (value) => value === '' || stateCodes.has(value),
  'Choose a valid Indian state or union territory.',
);
/** True for a correctly formed 15-character GSTIN with a valid state code and check digit. */
export function validGstin(value) {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value) || !stateCodes.has(value.slice(0, 2)))
    return false;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  let factor = 2;
  for (let index = 13; index >= 0; index--) {
    const product = alphabet.indexOf(value[index]) * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  return alphabet[(36 - (sum % 36)) % 36] === value[14];
}
// GSTIN field: upper-cased, empty or valid.
export const gstin = text(15)
  .transform((value) => value.toUpperCase())
  .refine((value) => value === '' || validGstin(value), 'Enter a valid GSTIN, including its check digit.');
const email = text(254).refine(
  (value) => value === '' || z.string().email().safeParse(value).success,
  'Enter a valid email address.',
);
// Document number prefix: 1-4 letters/digits, stored upper-case (e.g. "ATEI").
const prefix = requiredText(4)
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9]{1,4}$/.test(value), 'Use 1–4 letters or digits for a document prefix.');
// Calendar date in YYYY-MM-DD between 2000 and 2199.
const date = text(10).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 4) < '2000' || value.slice(0, 4) > '2199')
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date between 2000 and 2199.');
// A business/contact's state must be the first two digits of its GSTIN.
function gstStateMatches(value, ctx) {
  if (value.gstin && value.stateCode !== value.gstin.slice(0, 2)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['stateCode'],
      message: 'State must match the first two digits of the GSTIN.',
    });
  }
}
// Uploaded image as inline PNG/JPEG/WebP data (max 500 KB, real image header) or empty.
const rasterImage = text(700000).refine((value) => {
  if (!value) return true;
  const image = /^data:image\/(png|jpeg|webp);base64,([a-z0-9+/]+={0,2})$/i.exec(value);
  if (image) {
    const bytes = Buffer.from(image[2], 'base64');
    if (bytes.length > 500 * 1024 || bytes.toString('base64') !== image[2]) return false;
    if (image[1].toLowerCase() === 'png')
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (image[1].toLowerCase() === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  }
  try {
    const url = new URL(value);
    return value.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Use an HTTPS logo URL or a PNG, JPEG or WebP image up to 500KB.');
// ---------------------------------------------------------------------------
// Schemas for each API resource
// ---------------------------------------------------------------------------
export const workspaceSettingsSchema = z.object({
  companyName: requiredText(200),
  dashboardLogoUrl: rasterImage,
});
// Business product (a brand/product line shown on documents).
export const businessProductSchema = z.object({
  organizationId: requiredText(100),
  name: requiredText(200),
  code: text(80),
  description: text(2000),
  logoUrl: rasterImage,
  active: z.boolean(),
});
// Extra GST registration of a business; the GSTIN must match the chosen state.
export const gstRegistrationSchema = z
  .object({
    id: requiredText(100),
    label: requiredText(120),
    gstin: gstin.refine((value) => value !== '', 'Enter the GSTIN for this registration.'),
    stateCode: stateCode.refine((value) => value !== '', 'Choose the registered state.'),
    address: text(2000),
  })
  .superRefine(gstStateMatches);
// A business: legal identity, address, GST registrations, prefixes, bank, branding and gateway choice.
export const organizationSchema = z
  .object({
    name: requiredText(120),
    legalName: requiredText(200),
    tradeName: text(200).optional(),
    businessConstitution: text(120).optional(),
    businessType: z.enum(['division', 'independent']).optional(),
    supportEmail: email.optional(),
    paymentGateway: z.enum(['razorpay', 'cashfree', 'none']).optional(),
    gstRegistrations: z
      .array(gstRegistrationSchema)
      .max(20, 'Save at most 20 additional GST registrations.')
      .optional(),
    gstin,
    email,
    phone: text(30),
    address: text(2000),
    stateCode,
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color.'),
    logoUrl: rasterImage,
    signatureImageUrl: rasterImage.optional(),
    paymentQrUrl: rasterImage.optional(),
    pan: text(10)
      .transform((value) => value.toUpperCase())
      .refine((value) => value === '' || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value), 'Enter a valid PAN.')
      .optional(),
    cin: text(21)
      .transform((value) => value.toUpperCase())
      .refine(
        (value) => value === '' || /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(value),
        'Enter a valid 21-character CIN.',
      )
      .optional(),
    bankBranch: text(200).optional(),
    accountType: text(40).optional(),
    billingProfile: z
      .enum(['general', 'legal', 'facility', 'elevator', 'space', 'jewellery', 'ecosystem'])
      .optional(),
    enableProductSelection: z.boolean().optional(),
    secondarySignatureLabel: text(200).optional(),
    secondarySignatureImageUrl: rasterImage.optional(),
    stampLabel: text(200).optional(),
    stampImageUrl: rasterImage.optional(),
    invoicePrefix: prefix,
    quotationPrefix: prefix,
    bankName: text(150),
    accountName: text(200),
    accountNumber: text(40),
    ifsc: text(11)
      .transform((value) => value.toUpperCase())
      .refine((value) => value === '' || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value), 'Enter a valid IFSC code.'),
    terms: text(10000),
    signature: text(200),
    template: z.enum(['modern', 'classic']),
  })
  .superRefine((value, ctx) => {
    gstStateMatches(value, ctx);
    const registrations = value.gstRegistrations || [];
    const expectedPan = value.pan || value.gstin.slice(2, 12) || registrations[0]?.gstin.slice(2, 12);
    if (value.gstin && expectedPan && value.gstin.slice(2, 12) !== expectedPan)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gstin'],
        message: 'GSTIN must belong to the registered business PAN.',
      });
    const ids = new Set();
    const gstins = new Set(value.gstin ? [value.gstin] : []);
    for (const [index, registration] of registrations.entries()) {
      if (ids.has(registration.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gstRegistrations', index, 'id'],
          message: 'Each GST registration needs a unique ID.',
        });
      if (gstins.has(registration.gstin))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gstRegistrations', index, 'gstin'],
          message: 'Each GST registration must have a different GSTIN, including the default registration.',
        });
      if (expectedPan && registration.gstin.slice(2, 12) !== expectedPan)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gstRegistrations', index, 'gstin'],
          message: 'All GST registrations must belong to the same legal business PAN.',
        });
      ids.add(registration.id);
      gstins.add(registration.gstin);
    }
    if (value.invoicePrefix === value.quotationPrefix)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quotationPrefix'],
        message: 'Invoice and quotation prefixes must be different.',
      });
  });
// A contact (customer / B2B buyer / vendor); field rules shared with contacts.js.
export const customerSchema = z
  .object({
    ...contactFieldSchemas,
    organizationId: requiredText(100),
    name: requiredText(200),
    email,
    phone: text(30),
    gstin,
    address: text(2000),
    stateCode,
    contactPerson: text(200),
  })
  .superRefine(gstStateMatches)
  .superRefine(validateContactFields);
const hsn = text(8).refine(
  (value) => value === '' || /^\d{4,8}$/.test(value),
  'HSN/SAC must have 4–8 digits.',
);
const rate = z.number().finite().min(0).max(100000000);
const gstRate = z.number().finite().min(0).max(40);
// How a line is priced: standard qty x rate, recurring period, or jewellery weight + making charges.
export const pricingSchema = z
  .discriminatedUnion('mode', [
    z.object({
      mode: z.literal('standard'),
    }),
    z.object({
      mode: z.literal('recurring'),
      periods: z.number().finite().positive().max(1200),
      periodUnit: z.enum(['Hour', 'Day', 'Month', 'Year']),
    }),
    z.object({
      mode: z.literal('jewellery'),
      jewellery: z.object({
        grossWeight: z.number().finite().positive().max(1000000),
        stoneWeight: z.number().finite().min(0).max(1000000),
        purity: text(100),
        makingChargeType: z.enum(['fixed', 'per_gram', 'percent']),
        makingCharge: rate,
        stoneAmount: rate,
        otherCharges: rate,
        wastagePercent: z.number().finite().min(0).max(100),
      }),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.mode !== 'jewellery') return;
    if (value.jewellery.stoneWeight >= value.jewellery.grossWeight)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jewellery', 'stoneWeight'],
        message: 'Stone weight must be less than gross weight so net metal weight is positive.',
      });
    if (value.jewellery.makingChargeType === 'percent' && value.jewellery.makingCharge > 100)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jewellery', 'makingCharge'],
        message: 'Making charge percentage cannot exceed 100.',
      });
  });
// Per-document/per-format branding: logo choice and signature labels/images.
export const brandingSchema = z
  .object({
    logoMode: z.enum(['inherit', 'custom', 'none']),
    logoUrl: rasterImage,
    primarySignatureLabel: text(200),
    primarySignatureImageUrl: rasterImage,
    secondarySignatureLabel: text(200),
    secondarySignatureImageUrl: rasterImage,
    stampLabel: text(200),
    stampImageUrl: rasterImage,
    showSecondarySignature: z.boolean(),
    showStamp: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.logoMode === 'custom' && !value.logoUrl)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['logoUrl'],
        message: 'Upload a logo or choose inherit / no logo.',
      });
  });
// A rupee amount of at least ₹0.01 with at most two decimal places (stored as whole paise / 100).
const moneyAmount = z
  .number()
  .finite()
  .min(0.01, 'Amount must be at least ₹0.01.')
  .max(1400000000)
  .refine((value) => Number.isSafeInteger(wholePaise(value)), 'Amount must have at most two decimal places.')
  .transform((value) => wholePaise(value) / 100);
// Installment schedule for an invoice (its total must equal the invoice total; see workspace-service.js).
export const installmentPlanSchema = z
  .object({
    name: requiredText(200),
    installments: z
      .array(
        z.object({
          id: requiredText(100),
          label: requiredText(200),
          dueDate: date,
          amount: moneyAmount,
        }),
      )
      .min(1)
      .max(120),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.installments.map((entry) => entry.id)).size !== value.installments.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['installments'],
        message: 'Each installment must have a unique ID.',
      });
    if (
      value.installments.some(
        (entry, index) => index > 0 && entry.dueDate < value.installments[index - 1].dueDate,
      )
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['installments'],
        message: 'Installments must be ordered by due date.',
      });
  });
// A catalog product or service.
export const catalogSchema = z
  .object({
    organizationId: requiredText(100),
    type: z.enum(['product', 'service']),
    name: requiredText(200),
    description: text(2000),
    sku: text(80),
    hsn,
    unit: requiredText(20),
    rate,
    gstRate,
    active: z.boolean(),
    pricing: pricingSchema.optional(),
    businessProductId: text(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      calculateLineAmount({
        quantity: 1,
        rate: value.rate,
        pricing: value.pricing,
      }) > 1000000000
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricing'],
        message: 'A catalog unit amount cannot exceed ₹100 crore.',
      });
  });
// An invoice format (layout, colours, visible columns, paper and font settings).
export const formatSchema = z.object({
  organizationId: requiredText(100),
  name: requiredText(120),
  layout: z.enum(['modern', 'classic', 'minimal', 'ledger', 'sidebar']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color.'),
  density: z.enum(['comfortable', 'compact']),
  showLogo: z.boolean(),
  showHsn: z.boolean(),
  showUnit: z.boolean(),
  showGstRate: z.boolean(),
  showBankDetails: z.boolean(),
  showSignature: z.boolean(),
  showAmountInWords: z.boolean(),
  showPaymentQr: z.boolean().optional(),
  paymentQrWidth: z.number().int().min(70).max(160).optional(),
  signatureWidth: z.number().int().min(70).max(220).optional(),
  showSecondarySignature: z.boolean().optional(),
  showStamp: z.boolean().optional(),
  stampWidth: z.number().int().min(60).max(180).optional(),
  footerText: text(2000),
  isDefault: z.boolean(),
  presetKey: text(80).optional(),
  description: text(500).optional(),
  logoUrl: rasterImage.optional(),
  pageSize: z.enum(['A4', 'A5', 'LETTER']).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  fontSize: z.number().min(8).max(14).optional(),
  logoWidth: z.number().int().min(32).max(140).optional(),
  pageMargin: z.number().min(8).max(24).optional(),
  tableStyle: z.enum(['striped', 'ruled', 'plain']).optional(),
});
const optionalDate = z.union([z.literal(''), date]);
// Shipping / dispatch details printed on invoices and delivery challans.
export const shippingSchema = z
  .object({
    recipientName: text(200),
    address: text(2000),
    stateCode,
    phone: text(30),
    carrier: text(200),
    trackingNumber: text(200),
    vehicleNumber: text(40),
    dispatchDate: optionalDate,
    deliveryDate: optionalDate,
    reference: text(200),
    notes: text(2000),
  })
  .superRefine((value, ctx) => {
    if (value.dispatchDate && value.deliveryDate && value.deliveryDate < value.dispatchDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deliveryDate'],
        message: 'Delivery date cannot precede dispatch date.',
      });
  });
// A manual receipt. requestId makes a repeated submit return the same receipt.
export const paymentSchema = z.object({
  amount: moneyAmount,
  paidOn: date,
  method: z.enum(['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other']),
  reference: text(200),
  notes: text(2000),
  requestId: requiredText(100),
  finalizeWhenPaid: z.boolean().default(true),
});
// Expense categories shown on the Expenses page and in reports.
export const EXPENSE_CATEGORIES = [
  'Purchases / stock',
  'Rent',
  'Salaries & wages',
  'Utilities',
  'Travel & transport',
  'Office supplies',
  'Professional fees',
  'Repairs & maintenance',
  'Marketing',
  'Bank & finance charges',
  'Other',
];
// A purchase bill or expense: amount before GST, GST rate and whether the vendor is in another state.
export const expenseSchema = z
  .object({
    organizationId: requiredText(100),
    vendorId: text(100).default(''),
    vendorName: requiredText(200),
    vendorGstin: gstin.default(''),
    billNumber: text(60).default(''),
    billDate: date,
    category: z.enum(EXPENSE_CATEGORIES),
    description: text(500).default(''),
    taxable: moneyAmount,
    gstRate: z.union([0, 0.25, 3, 5, 12, 18, 28].map((value) => z.literal(value))),
    interstate: z.boolean().default(false),
    paidOn: optionalDate.default(''),
    paymentMethod: z.enum(['', 'bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other']).default(''),
    notes: text(2000).default(''),
  })
  .strict();
// Voiding a receipt requires a reason (kept in history).
export const voidPaymentSchema = z.object({
  reason: requiredText(2000),
});
// The IRN, acknowledgement and signed QR code the e-invoice portal returned for an invoice.
export const einvoiceSchema = z
  .object({
    irn: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{64}$/, 'The IRN has 64 letters and digits.'),
    ackNo: z
      .string()
      .trim()
      .regex(/^\d{10,20}$/, 'The acknowledgement number has 10 to 20 digits.'),
    ackDate: requiredText(30),
    signedQr: z.string().trim().min(20, 'Paste the signed QR code text.').max(5000),
  })
  .strict();
// Transport details for the e-way bill file (distance 0 lets the portal work it out from PIN codes).
export const ewayTransportSchema = z.object({
  mode: z.enum(['road', 'rail', 'air', 'ship']).default('road'),
  distanceKm: z.coerce.number().int().min(0).max(4000),
  vehicleNo: text(15)
    .default('')
    .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .refine((value) => value === '' || /^[A-Z0-9]{4,15}$/.test(value), 'Enter a valid vehicle number.'),
  transporterId: text(15).default(''),
  transporterName: text(100).default(''),
});
// The e-way bill number the portal generated for an invoice.
export const ewayBillSchema = z
  .object({
    number: z
      .string()
      .trim()
      .regex(/^\d{12}$/, 'The e-way bill number has 12 digits.'),
    date: requiredText(30),
    validUntil: text(30).default(''),
  })
  .strict();
// Stock added (positive) or removed (negative) for one catalog product.
export const stockAdjustmentSchema = z
  .object({
    organizationId: requiredText(100),
    catalogItemId: requiredText(100),
    date,
    quantity: z
      .number()
      .finite()
      .refine((value) => value !== 0 && Math.abs(value) <= 1000000, 'Enter a quantity other than 0.'),
    note: text(200).default(''),
  })
  .strict();
// Why a credit note is issued (the reasons GST returns used to ask for).
export const CREDIT_NOTE_REASONS = [
  'Sales return',
  'Discount after sale',
  'Deficiency in service',
  'Correction in invoice',
  'Other',
];
// A credit note against an issued invoice: one amount before GST at one of the invoice's GST rates.
export const creditNoteSchema = z
  .object({
    noteDate: date,
    reason: z.enum(CREDIT_NOTE_REASONS),
    taxable: moneyAmount,
    gstRate: z.union([0, 0.25, 3, 5, 12, 18, 28].map((value) => z.literal(value))),
    notes: text(500).default(''),
    requestId: z.guid(),
  })
  .strict();
// Why a debit note is issued: the buyer owes more than the invoice says.
export const DEBIT_NOTE_REASONS = ['Price increase', 'Short billing', 'Correction in invoice', 'Other'];
// A debit note against an issued invoice: one amount before GST at one of the invoice's GST rates.
export const debitNoteSchema = z
  .object({
    noteDate: date,
    dueDate: optionalDate.default(''),
    reason: z.enum(DEBIT_NOTE_REASONS),
    taxable: moneyAmount,
    gstRate: z.union([0, 0.25, 3, 5, 12, 18, 28].map((value) => z.literal(value))),
    notes: text(500).default(''),
    requestId: z.guid(),
  })
  .strict();
// Money paid back to the buyer for the part of a credit note above the invoice's balance due.
export const creditNoteRefundSchema = z
  .object({
    paidOn: date,
    method: z.enum(['bank_transfer', 'upi', 'cash', 'card', 'cheque', 'other']),
    reference: text(200).default(''),
  })
  .strict();
// A document as sent by the editor: header fields, line items, totals inputs, shipping and plan.
export const documentSchema = z
  .object({
    organizationId: requiredText(100),
    customerId: requiredText(100),
    gstRegistrationId: text(100).optional(),
    kind: z.enum(['invoice', 'quotation', 'proforma', 'delivery_note']),
    status: z.enum([
      'draft',
      'sent',
      'paid',
      'partially_paid',
      'accepted',
      'declined',
      'cancelled',
      'dispatched',
      'delivered',
    ]),
    issueDate: date,
    dueDate: z.union([z.literal(''), date]),
    title: requiredText(200),
    formatId: requiredText(100).optional(),
    items: z
      .array(
        z.object({
          description: requiredText(2500),
          hsn,
          quantity: z.number().finite().positive().max(1000000),
          rate,
          gstRate,
          unit: text(20).optional(),
          catalogItemId: requiredText(100).optional(),
          itemType: z.enum(['product', 'service']).optional(),
          pricing: pricingSchema.optional(),
        }),
      )
      .min(1, 'Add at least one line item.')
      .max(200),
    discountPercent: z.number().finite().min(0).max(100),
    placeOfSupply: stateCode,
    notes: text(10000),
    terms: text(10000),
    shipping: shippingSchema.optional(),
    branding: brandingSchema.optional(),
    businessProductId: text(100).optional(),
    installmentPlan: installmentPlanSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.dueDate && value.dueDate < value.issueDate)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dueDate'],
        message: 'Due/valid-until date cannot precede the issue date.',
      });
    const allowed =
      value.kind === 'invoice'
        ? ['draft', 'sent', 'paid', 'partially_paid', 'cancelled']
        : value.kind === 'delivery_note'
          ? ['draft', 'dispatched', 'delivered', 'cancelled']
          : ['draft', 'sent', 'accepted', 'declined', 'cancelled'];
    if (!allowed.includes(value.status))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `This status does not apply to a ${value.kind}.`,
      });
    if (
      value.kind === 'delivery_note' &&
      (value.discountPercent !== 0 ||
        value.items.some(
          (item) =>
            item.rate !== 0 || item.gstRate !== 0 || (item.pricing && item.pricing.mode !== 'standard'),
        ))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message:
          'Delivery challans track quantities only; rates, GST rates and discount must be zero and pricing must be standard.',
      });
    if (value.kind === 'delivery_note' && value.installmentPlan)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['installmentPlan'],
        message: 'Delivery challans cannot have an installment plan.',
      });
    for (const [index, item] of value.items.entries())
      if (item.pricing?.mode === 'jewellery' && !Number.isInteger(item.quantity))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'quantity'],
          message: 'Jewellery quantity is the number of pieces and must be a whole number.',
        });
    const subtotal = value.items.reduce((sum, item) => sum + calculateLineAmount(item), 0);
    if (!Number.isFinite(subtotal) || subtotal > 1000000000)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'Document subtotal cannot exceed ₹100 crore.',
      });
  });
// Normalized taxpayer details returned by a GST lookup provider.
export const lookupResultSchema = z
  .object({
    gstin: gstin.refine((value) => value !== ''),
    name: requiredText(200),
    address: text(2000),
    stateCode: stateCode.refine((value) => value !== ''),
    status: text(100).optional(),
  })
  .superRefine(gstStateMatches);
