/**
 * Per-business integration settings. Each business can override the shared Razorpay,
 * Cashfree and Resend credentials with prefixed variables (e.g. PIRENTO_LEGAL_RAZORPAY_KEY_ID).
 * Independent businesses (Shri Sarraf) never inherit the shared Venturecore credentials.
 */

import { integrationEnvironmentPrefix, isIndependentBusiness } from '../../shared/business-identity.js';
export { integrationEnvironmentPrefix } from '../../shared/business-identity.js';
// Credentials that must be overridden together: setting any key in a group replaces the whole group.
const groups = [
  ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'],
  ['EMAIL_FROM', 'RESEND_API_KEY'],
];
/**
 * Returns the environment variables that apply to one business: the shared values with that
 * business's prefixed overrides applied (and shared values removed for independent businesses).
 */
export function organizationEnvironment(organization, environment = process.env) {
  const prefix = integrationEnvironmentPrefix(organization);
  const isolated = isIndependentBusiness(organization);
  const result = {
    ...environment,
  };
  for (const group of groups) {
    const hasOverride = group.some((key) => environment[`${prefix}_${key}`] !== undefined);
    for (const key of group) {
      if (isolated || hasOverride) delete result[key];
      if (environment[`${prefix}_${key}`] !== undefined) result[key] = environment[`${prefix}_${key}`];
    }
  }
  for (const key of ['EMAIL_AUTOMATION', 'CASHFREE_ENVIRONMENT']) {
    if (isolated) delete result[key];
    if (environment[`${prefix}_${key}`] !== undefined) result[key] = environment[`${prefix}_${key}`];
  }
  return result;
}
