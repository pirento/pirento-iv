export const CONTACT_ROLES = ['customer', 'vendor', 'b2b_buyer'] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  customer: 'Customer',
  vendor: 'Vendor',
  b2b_buyer: 'B2B buyer',
};

/** Optional fields keep existing customer records and document snapshots readable. */
export interface ContactDetails {
  roles?: ContactRole[];
  active?: boolean;
  pan?: string;
  shippingAddress?: string;
  shippingStateCode?: string;
  paymentTermsDays?: number;
  creditLimit?: number;
  notes?: string;
}

export function contactRoles(contact: ContactDetails): ContactRole[] {
  return [...new Set<ContactRole>(contact.roles ?? ['customer'])];
}

export function isInvoiceRecipient(contact: ContactDetails): boolean {
  return contact.active !== false && contactRoles(contact).some((role) => CONTACT_ROLES.includes(role));
}

export function normalizeContact<T extends ContactDetails>(
  contact: T,
): Omit<T, keyof ContactDetails> & Required<ContactDetails> {
  return {
    ...contact,
    roles: contactRoles(contact),
    active: contact.active !== false,
    pan: contact.pan ?? '',
    shippingAddress: contact.shippingAddress ?? '',
    shippingStateCode: contact.shippingStateCode ?? '',
    paymentTermsDays: contact.paymentTermsDays ?? 0,
    creditLimit: contact.creditLimit ?? 0,
    notes: contact.notes ?? '',
  };
}
