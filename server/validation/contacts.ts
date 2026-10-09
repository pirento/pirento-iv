import { z } from 'zod';
import { STATES } from '../../shared/types.ts';
import { CONTACT_ROLES } from '../../shared/contact-types.ts';
export { normalizeContact, isInvoiceRecipient } from '../../shared/contact-types.ts';

const stateCodes = new Set(STATES.map(([code]) => code));
const text = (max: number) => z.string().trim().max(max);

/** Spread into the existing customer schema; contacts keep the same IDs and table. */
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

/** Applied after the existing GST checksum and billing state validation. */
export function validateContactFields(value: { gstin: string; pan?: string }, ctx: z.RefinementCtx) {
  if (value.gstin && value.pan && value.gstin.slice(2, 12) !== value.pan) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pan'],
      message: 'PAN must match the PAN contained in the GSTIN.',
    });
  }
}
