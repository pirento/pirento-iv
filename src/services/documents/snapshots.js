/**
 * What a saved document keeps of its customer and issuing business. The customer copy holds the
 * fields that are printed, emailed or used to match records; internal notes, credit limit, payment
 * terms and shipping defaults stay on the contact. The business copy drops its list of GST
 * registrations, because the registration used is already applied (GSTIN, state, address).
 */

const CUSTOMER_FIELDS = [
  'id',
  'organizationId',
  'name',
  'email',
  'phone',
  'gstin',
  'pan',
  'address',
  'stateCode',
  'contactPerson',
  'roles',
  'active',
];

export const customerSnapshot = (customer) =>
  Object.fromEntries(
    CUSTOMER_FIELDS.filter((key) => customer[key] !== undefined).map((key) => [key, customer[key]]),
  );

export const businessSnapshot = ({ gstRegistrations, ...organization }) => organization;
