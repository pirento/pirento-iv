/**
 * Payment gateway and email settings each business keeps in the app (Payments & email page),
 * instead of server variables. Secrets are encrypted with TWO_STEP_KEY and pages see only whether
 * each is set and its last 4 characters. Saved values win over the server variables, group by group
 * (organizationEnvironment in src/config/business-config.js).
 */

import { createTwoStepVault } from '../auth/two-step.js';

// Each setting and whether it is a secret.
export const INTEGRATION_SETTINGS = {
  RAZORPAY_KEY_ID: false,
  RAZORPAY_KEY_SECRET: true,
  RAZORPAY_WEBHOOK_SECRET: true,
  CASHFREE_CLIENT_ID: false,
  CASHFREE_CLIENT_SECRET: true,
  CASHFREE_ENVIRONMENT: false,
  EMAIL_FROM: false,
  RESEND_API_KEY: true,
  SMTP_HOST: false,
  SMTP_PORT: false,
  SMTP_SECURE: false,
  SMTP_USER: false,
  SMTP_PASSWORD: true,
  EMAIL_AUTOMATION: false,
};

export function createIntegrationSettings({ db, environment, production }) {
  const vault = createTwoStepVault(environment, production);
  const store = () => db.collection('workspace_metadata');
  const key = (organizationId) => ({ _id: `integrations:${organizationId}` });
  const saved = async (organizationId) =>
    (await store().findOne(key(organizationId), db.options()))?.values ?? {};

  /** The saved settings of one business as plain values (secrets decrypted), for the server only. */
  async function values(organizationId) {
    const result = {};
    for (const [name, value] of Object.entries(await saved(organizationId))) {
      const plain = INTEGRATION_SETTINGS[name] ? vault.open(value) : value;
      if (plain) result[name] = plain;
    }
    return result;
  }

  /** What the page may show: plain settings, and for secrets only { set, end }. */
  async function view(organizationId) {
    const plain = await values(organizationId);
    return Object.fromEntries(
      Object.entries(INTEGRATION_SETTINGS).map(([name, secret]) => [
        name,
        secret ? { set: Boolean(plain[name]), end: plain[name]?.slice(-4) ?? '' } : (plain[name] ?? ''),
      ]),
    );
  }

  /**
   * Saves settings: a plain setting given as '' is removed; a secret left blank keeps its saved
   * value and is removed only when named in `clear`.
   */
  async function save(organizationId, input, clear = []) {
    const set = {};
    const unset = {};
    for (const [name, secret] of Object.entries(INTEGRATION_SETTINGS)) {
      const value = input[name];
      if (clear.includes(name)) unset[`values.${name}`] = '';
      else if (typeof value !== 'string') continue;
      else if (value) set[`values.${name}`] = secret ? vault.seal(value) : value;
      else if (!secret) unset[`values.${name}`] = '';
    }
    await store().updateOne(
      key(organizationId),
      {
        $set: { ...set, organizationId, updatedAt: new Date() },
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { upsert: true, ...db.options() },
    );
    return view(organizationId);
  }

  return { values, view, save };
}
