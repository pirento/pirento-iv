import type { Organization } from './types';

export const isIndependentBusiness = (organization: Organization) =>
  organization.id === 'shri-sarraf' || organization.businessType === 'independent';
export const organizationSupportEmail = (organization: Organization) =>
  organization.supportEmail ??
  (organization.id === 'shri-sarraf' ? 'support@shrisarraf.com' : 'support@pirento.com');
export const organizationGateway = (organization: Organization) =>
  organization.paymentGateway ?? (organization.id === 'shri-sarraf' ? 'cashfree' : 'razorpay');

export function integrationEnvironmentPrefix(organization: Pick<Organization, 'id'>): string {
  const known: Record<string, string> = {
    'pipeline2-legal': 'PIRENTO_LEGAL',
    'pipeline2-ecosystem': 'PIRENTO_ECOSYSTEM',
    'at-facilities': 'AT_FACILITY',
    'at-elevators': 'A_T_ELEVATOR',
    'ingenio-space': 'INZARIO_SPACE',
    'shri-sarraf': 'SHRI_SARRAF',
  };
  return known[organization.id] ?? `ORG_${organization.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Only a registration saved on this organization may be selected for a document. */
export function organizationForRegistration(
  organization: Organization,
  registrationId?: string,
): Organization {
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
