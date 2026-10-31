/** Unit tests: which payment and email settings apply to a business (server variables and saved settings). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { organizationEnvironment } from '../src/config/business-config.js';

const division = { id: 'at-elevators', businessType: 'division' };
const server = {
  RESEND_API_KEY: 're_shared',
  EMAIL_FROM: 'billing@pirento.com',
  RAZORPAY_KEY_ID: 'rzp_live_shared',
};

test('saved settings win over server variables, a credential replacing its whole group', () => {
  assert.deepEqual(
    organizationEnvironment(division, server, { EMAIL_FROM: 'lifts@pirento.com' }).RESEND_API_KEY,
    're_shared',
    'a From address alone keeps the shared Resend key',
  );
  const smtp = organizationEnvironment(division, server, { SMTP_HOST: 'smtp.test', EMAIL_FROM: 'a@b.test' });
  assert.equal(smtp.RESEND_API_KEY, undefined, 'an SMTP server replaces the shared Resend key');
  assert.deepEqual([smtp.SMTP_HOST, smtp.EMAIL_FROM], ['smtp.test', 'a@b.test']);
  assert.equal(organizationEnvironment(division, server, {}).RAZORPAY_KEY_ID, 'rzp_live_shared');
  assert.equal(
    organizationEnvironment({ id: 'shri-sarraf' }, server, {}).RESEND_API_KEY,
    undefined,
    'independent businesses never inherit shared credentials',
  );
});
