/** Unit tests: two-step login codes (src/services/auth/two-step.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base32Encode,
  createTwoStepVault,
  newTwoStepSecret,
  qrSvg,
  twoStepCode,
  twoStepSetupUrl,
  verifyTwoStepCode,
} from '../src/services/auth/two-step.js';

// RFC 6238 appendix B: the ASCII key "12345678901234567890" (SHA-1) gives 94287082 at T=59 s,
// 07081804 at T=1111111109 s and 14050471 at T=1111111111 s; apps show the last 6 digits.
const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

test('codes match the RFC 6238 test vectors', () => {
  assert.equal(rfcSecret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(twoStepCode(rfcSecret, Math.floor(59 / 30)), '287082');
  assert.equal(twoStepCode(rfcSecret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(twoStepCode(rfcSecret, Math.floor(1111111111 / 30)), '050471');
});

test('a code is accepted once, within one step of clock drift', () => {
  const now = 1111111111_000;
  const step = Math.floor(now / 30_000);
  const code = twoStepCode(rfcSecret, step);
  assert.equal(verifyTwoStepCode(rfcSecret, code, now), step);
  assert.equal(verifyTwoStepCode(rfcSecret, code, now + 30_000), step, 'one step late still works');
  assert.equal(verifyTwoStepCode(rfcSecret, code, now + 90_000), null, 'old codes expire');
  assert.equal(verifyTwoStepCode(rfcSecret, code, now, step), null, 'a used code cannot be replayed');
  assert.equal(verifyTwoStepCode(rfcSecret, '12345', now), null);
  assert.equal(verifyTwoStepCode(rfcSecret, undefined, now), null);
});

test('new keys, setup links and QR codes have the expected shape', () => {
  const secret = newTwoStepSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const url = twoStepSetupUrl(secret, 'owner@example.test', 'Venturecore');
  assert.equal(
    url,
    `otpauth://totp/Venturecore%3Aowner%40example.test?secret=${secret}&issuer=Venturecore&digits=6&period=30`,
  );
  const svg = qrSvg(url);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.ok(svg.length > 1000, 'the QR code has modules');
});

test('saved keys are encrypted and only open with the same TWO_STEP_KEY', () => {
  const vault = createTwoStepVault({ TWO_STEP_KEY: 'ab'.repeat(32) }, true);
  const secret = newTwoStepSecret();
  const sealed = vault.seal(secret);
  assert.match(sealed, /^v1:/);
  assert.equal(sealed.includes(secret), false);
  assert.notEqual(vault.seal(secret), sealed, 'a fresh IV each time');
  assert.equal(vault.open(sealed), secret);
  assert.equal(createTwoStepVault({ TWO_STEP_KEY: 'cd'.repeat(32) }, true).open(sealed), null);
  assert.equal(vault.open('not-sealed'), null);
  assert.equal(vault.open(null), null);
  assert.throws(() => createTwoStepVault({}, true), /TWO_STEP_KEY/);
  assert.throws(() => createTwoStepVault({ TWO_STEP_KEY: 'short' }, false), /TWO_STEP_KEY/);
  assert.equal(createTwoStepVault({}, false).open(createTwoStepVault({}, false).seal('KEY')), 'KEY');
});
