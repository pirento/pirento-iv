/**
 * Business identity rules shared by server and browser: independent businesses (Shri Sarraf),
 * support email, payment gateway choice, settings prefixes and the seller details for a
 * chosen GST registration.
 */

// Independent businesses never use the shared Venturecore payment/email credentials.
export const isIndependentBusiness = (organization) =>
  organization.id === 'shri-sarraf' || organization.businessType === 'independent';
// Support email shown on documents and emails (business setting, else a default).
export const organizationSupportEmail = (organization) =>
  organization.supportEmail ??
  (organization.id === 'shri-sarraf' ? 'support@shrisarraf.com' : 'support@pirento.com');
// Finance email (reply-to on invoices, receipts and reminders): business setting, else the
// company finance desk; independent businesses fall back to their own support email.
export const organizationFinanceEmail = (organization) =>
  organization.financeEmail ||
  (isIndependentBusiness(organization) ? organizationSupportEmail(organization) : 'finance@pirento.com');
// Online payment provider for the business: its setting, else Cashfree for Shri Sarraf and Razorpay for others.
export const organizationGateway = (organization) =>
  organization.paymentGateway ?? (organization.id === 'shri-sarraf' ? 'cashfree' : 'razorpay');
/** Prefix of a business's own settings, e.g. at-elevators -> A_T_ELEVATOR (A_T_ELEVATOR_RAZORPAY_KEY_ID ...). */
export function integrationEnvironmentPrefix(organization) {
  const known = {
    'pipeline2-legal': 'PIRENTO_LEGAL',
    'pipeline2-ecosystem': 'PIRENTO_ECOSYSTEM',
    'at-facilities': 'AT_FACILITY',
    'at-elevators': 'A_T_ELEVATOR',
    'ingenio-space': 'INZARIO_SPACE',
    'shri-sarraf': 'SHRI_SARRAF',
  };
  return known[organization.id] ?? `ORG_${organization.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}
/** The business with GSTIN, state and address replaced by those of the chosen GST registration. */
export function organizationForRegistration(organization, registrationId) {
  if (!registrationId) return organization;
  const registration = organization.gstRegistrations?.find((item) => item.id === registrationId);
  if (!registration) throw new Error('Choose a GST registration saved in this organization.');
  return {
    ...organization,
    gstin: registration.gstin,
    stateCode: registration.stateCode,
    address: registration.address,
  };
}
