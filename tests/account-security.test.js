/** Unit tests (`npm test`): trusted-proxy parsing, account rate limiting and security-activity filters. */

import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { configureTrustedProxy, normalizeIpAddress, parseTrustedProxy } from '../src/config/trusted-proxy.js';
import { createAccountRateLimiter } from '../src/services/auth/account-rate-limit.js';
import {
  createAuthSecurity,
  readSecurityAuditFilters,
  safeSecurityDetails,
} from '../src/services/auth/security.js';

test('Trusted proxy configuration is empty by default and rejects permissive shortcuts and invalid ranges', () => {
  for (const value of [undefined, null, '', '   ']) assert.deepEqual(parseTrustedProxy(value), []);
  for (const value of [
    true,
    false,
    1,
    'true',
    'false',
    '1',
    'loopback',
    '*',
    '0.0.0.0',
    '::',
    '0.0.0.0/0',
    '192.0.2.1/0',
    '::/0',
    '2001:db8::/0',
    '127.0.0.1:8080',
    'host.example.test',
    '127.0.0.1,',
    ',127.0.0.1',
    '192.0.2.1/33',
    '192.0.2.1/-1',
    '2001:db8::/129',
    '2001:db8::/1/2',
    'fe80::1%eth0',
    '::ffff:192.0.2.1/96',
  ]) {
    assert.throws(() => parseTrustedProxy(value), /TRUST_PROXY/, String(value));
  }
  assert.deepEqual(parseTrustedProxy('127.0.0.1, 192.0.2.0/24,2001:db8::/64'), [
    { address: '127.0.0.1', prefix: 32, family: 'ipv4' },
    { address: '192.0.2.0', prefix: 24, family: 'ipv4' },
    { address: '2001:db8::', prefix: 64, family: 'ipv6' },
  ]);
});

test('Equivalent IP spellings normalize together and trust is restricted to configured peers', () => {
  assert.equal(normalizeIpAddress('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeIpAddress('::ffff:c000:201'), '192.0.2.1');
  assert.equal(normalizeIpAddress('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(normalizeIpAddress('::1'), '::1');
  for (const value of [' 127.0.0.1', '192.000.2.1', 'localhost', 'unknown', 'fe80::1%eth0', null])
    assert.equal(normalizeIpAddress(value), undefined);
  const app = express();
  configureTrustedProxy(app, {});
  assert.equal(app.get('trust proxy'), false);
  configureTrustedProxy(app, { TRUST_PROXY: '192.0.2.0/24,2001:db8:1::/64' });
  const trusted = app.get('trust proxy fn');
  assert.equal(trusted('192.0.2.7'), true);
  assert.equal(trusted('::ffff:192.0.2.7'), true);
  assert.equal(trusted('192.0.3.7'), false);
  assert.equal(trusted('2001:db8:1::3'), true);
  assert.equal(trusted('2001:db8:2::3'), false);
  assert.equal(trusted('invalid'), false);
});

test('Shared account protection fails closed within its deadline without leaking database errors', async () => {
  for (const findOneAndUpdate of [
    async () => {
      throw new Error('mongodb://private-password@example.test/secret');
    },
    () => new Promise(() => {}),
  ]) {
    const limiter = createAccountRateLimiter({
      db: { collection: () => ({ findOneAndUpdate }) },
      timeoutMs: 40,
    });
    const started = performance.now();
    await assert.rejects(limiter.take('login', { ip: '192.0.2.1' }), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
      assert.doesNotMatch(error.message, /password|mongodb|secret/);
      return true;
    });
    assert.ok(performance.now() - started < 500);
  }
});

test('Broken audit storage and a throwing log sink cannot replace the intended throttling response', async () => {
  const now = Date.now();
  const security = createAuthSecurity({
    db: {
      collection: () => ({
        insertOne: async () => {
          throw new Error('Private audit write failure');
        },
      }),
    },
    logger: {
      warn: () => {
        throw new Error('Broken log sink');
      },
    },
  });
  const limiter = createAccountRateLimiter({
    db: {
      collection: () => ({
        findOneAndUpdate: async () => ({
          count: 21,
          startedAt: new Date(now),
          observedAt: new Date(now),
          expiresOn: new Date(now + 900_000),
        }),
      }),
    },
    observe: security.observe,
  });
  let status;
  let body;
  const response = {
    set: () => {},
    status: (value) => {
      status = value;
      return response;
    },
    json: (value) => {
      body = value;
    },
  };
  await limiter.middleware('login')({ ip: '192.0.2.1' }, response, () =>
    assert.fail('A blocked request must not continue.'),
  );
  assert.equal(status, 429);
  assert.deepEqual(body, { error: 'Too many account requests. Please wait and try again.' });
  const malformed = createAccountRateLimiter({
    db: {
      collection: () => ({
        findOneAndUpdate: async () => ({
          count: 0,
          startedAt: new Date(now),
          observedAt: new Date(now),
          expiresOn: new Date(now + 900_000),
        }),
      }),
    },
  });
  await assert.rejects(malformed.take('login', { ip: '192.0.2.1' }), (error) => error.status === 503);
});

test('Activity filters reject duplicate/object inputs and invalid dates while accepting real Indian calendar dates', () => {
  assert.deepEqual(
    readSecurityAuditFilters({ from: '2024-02-29', to: '2024-03-01', userId: 'legacy-admin', page: '2' }),
    {
      action: 'all',
      from: '2024-02-29',
      to: '2024-03-01',
      userId: 'legacy-admin',
      page: 2,
    },
  );
  for (const query of [
    { from: '2026-02-29' },
    { from: '2026-13-01' },
    { from: '2026-10-12', to: '2026-10-11' },
    { from: ['2026-10-11'] },
    { action: { $ne: '' } },
    { action: 'arbitrary-action' },
    { page: '0' },
    { page: '1.5' },
    { page: ['1', '2'] },
    { userId: '<script>' },
    { password: 'secret' },
  ])
    assert.throws(
      () => readSecurityAuditFilters(query),
      (error) => error.status === 400,
    );
});

test('Activity detail projection removes secret fields and unrecognized values from old and new records', () => {
  const details = safeSecurityDetails({
    before: { role: 'admin', status: 'active', organizationIds: ['org-1'], password: 'secret' },
    after: { role: 'staff', status: 'disabled', organizationIds: ['org-2', { secret: true }] },
    revokedSessions: 4,
    scope: 'login',
    token: 'secret',
    password_hash: 'secret',
    reason: 'private user input',
  });
  assert.deepEqual(details, {
    before: { role: 'admin', status: 'active', organizationIds: ['org-1'] },
    after: { role: 'staff', status: 'disabled', organizationIds: ['org-2'] },
    revokedSessions: 4,
    scope: 'login',
  });
  assert.deepEqual(
    safeSecurityDetails({ before: { role: 'secret' }, revokedSessions: -1, scope: 'secret' }),
    {},
  );
  assert.deepEqual(safeSecurityDetails('old string details'), {});
  assert.doesNotMatch(JSON.stringify(details), /secret|private user input|password|token/);
});
