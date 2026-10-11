export const isIndependentBusiness = (organization) =>
  organization.id === 'shri-sarraf' || organization.businessType === 'independent';
export const organizationSupportEmail = (organization) =>
  organization.supportEmail ??
  (organization.id === 'shri-sarraf' ? 'support@shrisarraf.com' : 'support@pirento.com');
export const organizationGateway = (organization) =>
  organization.paymentGateway ?? (organization.id === 'shri-sarraf' ? 'cashfree' : 'razorpay');
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
