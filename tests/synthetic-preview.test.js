import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareSyntheticPreviewEnvironment,
  blockedPreviewFetch,
  PREVIEW_DISABLED,
} from '../src/services/preview/synthetic-preview.js';

const settings = () => ({
  IV_PREVIEW_MODE: 'disposable-synthetic',
  IV_PREVIEW_MONGODB_URI: 'mongodb://127.0.0.1:27017/?replicaSet=preview',
  IV_PREVIEW_ADMIN_EMAIL: 'preview@example.invalid',
  IV_PREVIEW_ADMIN_PASSWORD: 'PreviewPasswordForTests$123',
  NODE_ENV: 'production',
  PUBLIC_APP_URL: 'https://preview.example.invalid',
});

test('synthetic startup requires explicit mode, its own database connection and HTTPS origin', () => {
  for (const [key, value] of [
    ['IV_PREVIEW_MODE', undefined],
    ['IV_PREVIEW_MONGODB_URI', undefined],
    ['IV_PREVIEW_ADMIN_PASSWORD', 'short'],
    ['PUBLIC_APP_URL', 'http://preview.example.invalid'],
    ['PUBLIC_APP_URL', 'https://preview.example.invalid/path'],
    ['NODE_ENV', 'development'],
  ])
    assert.throws(() => prepareSyntheticPreviewEnvironment({ ...settings(), [key]: value }));
});

test('synthetic settings exclude persistent databases, owners and provider credentials', () => {
  const environment = prepareSyntheticPreviewEnvironment({
    ...settings(),
    MONGODB_URI: 'mongodb://persistent.invalid/workspace',
    MONGODB_DATABASE: 'existing_workspace',
    INITIAL_ADMIN_EMAIL: 'existing-owner@example.invalid',
    INITIAL_ADMIN_PASSWORD: 'ExistingPassword$123',
    RAZORPAY_KEY_ID: 'ignored',
    RESEND_API_KEY: 'ignored',
    SHRI_SARRAF_CASHFREE_CLIENT_SECRET: 'ignored',
    EMAIL_AUTOMATION: 'true',
    BACKUP_ENABLED: 'true',
  });
  assert.equal(environment.MONGODB_URI, settings().IV_PREVIEW_MONGODB_URI);
  assert.equal(environment.MONGODB_DATABASE, undefined);
  assert.equal(environment.INITIAL_ADMIN_EMAIL, settings().IV_PREVIEW_ADMIN_EMAIL);
  for (const key of ['RAZORPAY_KEY_ID', 'RESEND_API_KEY', 'SHRI_SARRAF_CASHFREE_CLIENT_SECRET'])
    assert.equal(environment[key], undefined);
  assert.equal(environment.EMAIL_AUTOMATION, 'false');
  assert.equal(environment.SHRI_SARRAF_EMAIL_AUTOMATION, 'false');
  assert.equal(environment.BACKUP_ENABLED, 'false');
});

test('synthetic provider transport always rejects without making a network request', async () => {
  await assert.rejects(blockedPreviewFetch('https://provider.example.invalid'), {
    message: PREVIEW_DISABLED,
  });
});
