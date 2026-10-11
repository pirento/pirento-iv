export const CONTACT_ROLES = ['customer', 'vendor', 'b2b_buyer'];
export const CONTACT_ROLE_LABELS = {
  customer: 'Customer',
  vendor: 'Vendor',
  b2b_buyer: 'B2B buyer',
};
export function contactRoles(contact) {
  return [...new Set(contact.roles ?? ['customer'])];
}
export function isInvoiceRecipient(contact) {
  return contact.active !== false && contactRoles(contact).some((role) => CONTACT_ROLES.includes(role));
}
export function normalizeContact(contact) {
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
