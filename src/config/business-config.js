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
  ['EMAIL_FROM', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD'],
];
/**
 * Returns the environment variables that apply to one business: the shared values with that
 * business's prefixed overrides applied (and shared values removed for independent businesses),
 * then the settings saved for it on the Payments & email page (`saved`), which win group by group.
 */
export function organizationEnvironment(organization, environment = process.env, saved = {}) {
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
  // A saved credential replaces its whole group; a sender address, port or security setting
  // saved alone only changes that value (e.g. a new From address on the shared Resend account).
  const options = ['EMAIL_FROM', 'SMTP_PORT', 'SMTP_SECURE'];
  for (const group of groups) {
    if (group.some((key) => saved[key] && !options.includes(key)))
      for (const key of group) delete result[key];
    for (const key of group) if (saved[key]) result[key] = saved[key];
  }
  for (const key of ['EMAIL_AUTOMATION', 'CASHFREE_ENVIRONMENT']) if (saved[key]) result[key] = saved[key];
  return result;
}
