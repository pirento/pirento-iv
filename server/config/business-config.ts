import type { Organization } from '../../shared/types.ts';
import { integrationEnvironmentPrefix, isIndependentBusiness } from '../../shared/business-identity.ts';
export { integrationEnvironmentPrefix } from '../../shared/business-identity.ts';

const groups = [
  ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'],
  ['EMAIL_FROM', 'RESEND_API_KEY'],
];

/** Independent businesses never inherit another company's gateway or sender. */
export function organizationEnvironment(
  organization: Organization,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const prefix = integrationEnvironmentPrefix(organization);
  const isolated = isIndependentBusiness(organization);
  const result = { ...environment };
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
