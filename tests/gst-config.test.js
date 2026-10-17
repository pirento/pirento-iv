/** Unit tests: GST lookup provider selection (portal, custom URL, Sandbox). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGstIntegration } from '../src/services/integrations/gst/gst-config.js';

const build = (environment, overrides = {}) =>
  createGstIntegration({ environment, fetcher: async () => {}, now: () => new Date(), ...overrides });

test('GST lookup defaults to the captcha portal without a custom URL', () => {
  const gst = build({});
  assert.equal(gst.gstProvider, 'portal');
  assert.deepEqual(gst.gstStatus(), {
    provider: 'portal',
    mode: 'captcha',
    configured: false,
    keyConfigured: false,
    secretConfigured: false,
  });
});

test('a valid HTTPS lookup template selects the generic provider', () => {
  const gst = build({ GST_LOOKUP_URL: 'https://lookup.example/gst/{gstin}', GST_API_KEY: 'key' });
  assert.equal(gst.gstProvider, 'generic');
  assert.equal(gst.lookupUrl, 'https://lookup.example/gst/{gstin}');
  assert.equal(gst.gstStatus().configured, true);
  assert.equal(gst.gstStatus().keyConfigured, true);
});

test('lookup templates without HTTPS, the placeholder or with credentials are ignored', () => {
  for (const url of [
    'http://lookup.example/{gstin}',
    'https://lookup.example/gst',
    'https://user:pass@lookup.example/{gstin}',
  ])
    assert.equal(build({ GST_LOOKUP_URL: url }).gstProvider, 'portal', url);
});

test('explicit overrides take precedence and unknown providers are rejected', () => {
  assert.equal(build({}, { lookupUrl: 'https://override.example/{gstin}' }).gstProvider, 'generic');
  assert.throws(() => build({ GST_PROVIDER: 'other' }), /GST_PROVIDER must be portal, generic or sandbox/);
});
