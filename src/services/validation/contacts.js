/**
 * Field rules for contacts (customers, B2B buyers, vendors), shared by the customer schema
 * and the contact normalization used when older records are read.
 */

import { z } from 'zod';
import { STATES } from '../../../shared/types.js';
import { CONTACT_ROLES } from '../../../shared/contact-types.js';
export { normalizeContact, isInvoiceRecipient } from '../../../shared/contact-types.js';
const stateCodes = new Set(STATES.map(([code]) => code));
const text = (max) => z.string().trim().max(max);
// Contact-only fields: roles, active, PAN, shipping address/state, payment terms (days) and credit limit.
export const contactFieldSchemas = {
  roles: z
    .array(z.enum(CONTACT_ROLES))
    .min(1, 'Select at least one contact role.')
    .max(3)
    .refine((roles) => new Set(roles).size === roles.length, 'Each contact role can only be selected once.')
    .default(['customer']),
  active: z.boolean().default(true),
  pan: text(10)
    .transform((value) => value.toUpperCase())
    .refine((value) => value === '' || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(value), 'Enter a valid PAN.')
    .default(''),
  shippingAddress: text(2000).default(''),
  shippingStateCode: text(2)
    .refine(
      (value) => value === '' || stateCodes.has(value),
      'Choose a valid shipping state or union territory.',
    )
    .default(''),
  paymentTermsDays: z.number().int().min(0).max(365, 'Payment terms cannot exceed 365 days.').default(0),
  creditLimit: z
    .number()
    .finite()
    .min(0)
    .max(1000000000)
    .refine(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001,
      'Credit limit must have at most two decimal places.',
    )
    .default(0),
  notes: text(4000).default(''),
};
/** Cross-field check used inside zod superRefine: a PAN must match characters 3-12 of the GSTIN. */
export function validateContactFields(value, ctx) {
  if (value.gstin && value.pan && value.gstin.slice(2, 12) !== value.pan) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pan'],
      message: 'PAN must match the PAN contained in the GSTIN.',
    });
  }
}
