import test from 'node:test';
import assert from 'node:assert/strict';
import {
  integrationEnvironmentPrefix,
  organizationEnvironment,
} from '../../server/config/business-config.ts';
import type { Organization } from '../../shared/types.ts';

function organization(id: string, businessType?: Organization['businessType']): Organization {
  return {
    id,
    businessType,
    name: 'Test business',
    legalName: 'Test legal name',
    gstin: '',
    email: '',
    phone: '',
    address: '',
    stateCode: '',
    accentColor: '#123456',
    logoUrl: '',
    invoicePrefix: 'TST',
    quotationPrefix: 'TSQ',
    bankName: '',
    accountName: '',
    accountNumber: '',
    ifsc: '',
    terms: '',
    signature: '',
    template: 'modern',
  };
}
const globalSettings = () => ({
  RAZORPAY_KEY_ID: 'main-key-id',
  RAZORPAY_KEY_SECRET: 'main-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'main-webhook-secret',
  CASHFREE_CLIENT_ID: 'main-cashfree-id',
  CASHFREE_CLIENT_SECRET: 'main-cashfree-secret',
  CASHFREE_ENVIRONMENT: 'production',
  EMAIL_FROM: 'Main <invoice@main.example>',
  RESEND_API_KEY: 'main-resend-secret',
  EMAIL_AUTOMATION: 'true',
  PUBLIC_APP_URL: 'https://workspace.example',
});
const credentialNames = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'CASHFREE_CLIENT_ID',
  'CASHFREE_CLIENT_SECRET',
  'EMAIL_FROM',
  'RESEND_API_KEY',
];

test('Venturecore divisions retain shared configuration unless their own credential group is set', () => {
  const env = Object.freeze(globalSettings());
  const original = { ...env };
  const scoped = organizationEnvironment(organization('pipeline2-legal'), env);
  for (const name of credentialNames) assert.equal(scoped[name], env[name as keyof typeof env]);
  assert.equal(scoped.EMAIL_AUTOMATION, 'true');
  assert.equal(scoped.CASHFREE_ENVIRONMENT, 'production');
  assert.deepEqual(env, original, 'resolving a business must not delete or rewrite process-wide settings');
  assert.notEqual(scoped, env);
});

test('Shri Sarraf and every independent business never inherit global merchant or email settings', () => {
  const env = globalSettings();
  for (const org of [
    organization('shri-sarraf'),
    organization('shri-sarraf', 'division'),
    organization('other-business', 'independent'),
  ]) {
    const scoped = organizationEnvironment(org, env);
    for (const name of credentialNames)
      assert.equal(scoped[name], undefined, `${org.id} must not inherit ${name}`);
    assert.equal(scoped.EMAIL_AUTOMATION, undefined);
    assert.equal(
      scoped.CASHFREE_ENVIRONMENT,
      undefined,
      'missing independent environment must leave the adapter on its sandbox default',
    );
    assert.equal(scoped.PUBLIC_APP_URL, env.PUBLIC_APP_URL, 'non-provider runtime settings are preserved');
  }
});

test('independent Cashfree and sender credentials use only that organization prefix', () => {
  const env = {
    ...globalSettings(),
    SHRI_SARRAF_CASHFREE_CLIENT_ID: 'shri-id',
    SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'shri-secret',
    SHRI_SARRAF_CASHFREE_ENVIRONMENT: 'sandbox',
    SHRI_SARRAF_EMAIL_FROM: 'Shri <invoice@shri.example>',
    SHRI_SARRAF_RESEND_API_KEY: 'shri-resend',
    SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
    PIRENTO_LEGAL_EMAIL_FROM: 'Legal <invoice@legal.example>',
    PIRENTO_LEGAL_RESEND_API_KEY: 'legal-resend',
  };
  const shri = organizationEnvironment(organization('shri-sarraf'), env);
  assert.equal(shri.CASHFREE_CLIENT_ID, 'shri-id');
  assert.equal(shri.CASHFREE_CLIENT_SECRET, 'shri-secret');
  assert.equal(shri.CASHFREE_ENVIRONMENT, 'sandbox');
  assert.equal(shri.EMAIL_FROM, env.SHRI_SARRAF_EMAIL_FROM);
  assert.equal(shri.RESEND_API_KEY, 'shri-resend');
  assert.equal(shri.EMAIL_AUTOMATION, 'false');
  assert.equal(shri.RAZORPAY_KEY_ID, undefined);
  assert.equal(shri.RAZORPAY_KEY_SECRET, undefined);
  assert.equal(shri.RAZORPAY_WEBHOOK_SECRET, undefined);
  const legal = organizationEnvironment(organization('pipeline2-legal'), env);
  assert.equal(legal.EMAIL_FROM, env.PIRENTO_LEGAL_EMAIL_FROM);
  assert.equal(legal.RESEND_API_KEY, 'legal-resend');
  assert.equal(legal.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_ID);
  assert.equal(legal.EMAIL_AUTOMATION, 'true');
  assert.equal(
    organizationEnvironment(organization('unrelated', 'independent'), env).RESEND_API_KEY,
    undefined,
  );
});

test('an incomplete prefixed credential group cannot borrow any remaining shared credentials', () => {
  const groups = [
    ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
    ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'],
    ['EMAIL_FROM', 'RESEND_API_KEY'],
  ];
  for (const group of groups) {
    for (const providedName of group) {
      for (const value of ['specific-business-value', '']) {
        const scoped = organizationEnvironment(organization('pipeline2-legal'), {
          ...globalSettings(),
          [`PIRENTO_LEGAL_${providedName}`]: value,
        });
        for (const name of group)
          assert.equal(
            scoped[name],
            name === providedName ? value : undefined,
            `${providedName}=${JSON.stringify(value)} must isolate ${name}`,
          );
        const unaffected = credentialNames.find((name) => !group.includes(name))!;
        assert.equal(
          scoped[unaffected],
          globalSettings()[unaffected as keyof ReturnType<typeof globalSettings>],
          'one override must not disable unrelated credential groups',
        );
      }
    }
  }
});

test('complete prefixed credentials and per-business automation override only their intended group', () => {
  const scoped = organizationEnvironment(organization('at-facilities'), {
    ...globalSettings(),
    AT_FACILITY_RAZORPAY_KEY_ID: 'facility-id',
    AT_FACILITY_RAZORPAY_KEY_SECRET: 'facility-secret',
    AT_FACILITY_RAZORPAY_WEBHOOK_SECRET: 'facility-webhook',
    AT_FACILITY_EMAIL_AUTOMATION: 'false',
  });
  assert.equal(scoped.RAZORPAY_KEY_ID, 'facility-id');
  assert.equal(scoped.RAZORPAY_KEY_SECRET, 'facility-secret');
  assert.equal(scoped.RAZORPAY_WEBHOOK_SECRET, 'facility-webhook');
  assert.equal(scoped.EMAIL_FROM, globalSettings().EMAIL_FROM);
  assert.equal(scoped.RESEND_API_KEY, globalSettings().RESEND_API_KEY);
  assert.equal(scoped.EMAIL_AUTOMATION, 'false');
});

test('documented prefixes match stored organization IDs and newly created businesses have stable names', () => {
  for (const [id, expected] of Object.entries({
    'pipeline2-legal': 'PIRENTO_LEGAL',
    'pipeline2-ecosystem': 'PIRENTO_ECOSYSTEM',
    'at-facilities': 'AT_FACILITY',
    'at-elevators': 'A_T_ELEVATOR',
    'ingenio-space': 'INZARIO_SPACE',
    'shri-sarraf': 'SHRI_SARRAF',
    'some-new.business': 'ORG_SOME_NEW_BUSINESS',
  }))
    assert.equal(integrationEnvironmentPrefix({ id }), expected);
  const org = organization('some-new.business', 'independent');
  const scoped = organizationEnvironment(org, {
    ...globalSettings(),
    ORG_SOME_NEW_BUSINESS_EMAIL_FROM: 'new@business.example',
    ORG_SOME_NEW_BUSINESS_RESEND_API_KEY: 'new-key',
  });
  assert.equal(scoped.EMAIL_FROM, 'new@business.example');
  assert.equal(scoped.RESEND_API_KEY, 'new-key');
});
