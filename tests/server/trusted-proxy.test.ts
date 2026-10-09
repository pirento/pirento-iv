import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustedProxy } from '../../server/http/trusted-proxy.ts';

test('forwarded headers are untrusted by default and explicitly false remains untrusted', () => {
  for (const value of [undefined, '', ' ', 'false', ' false ']) assert.equal(parseTrustedProxy(value), false);
});

test('explicit proxy IP addresses, CIDR ranges and named Express ranges are accepted and deduplicated', () => {
  assert.deepEqual(
    parseTrustedProxy('127.0.0.1, 10.20.0.0/16, ::1, 2001:db8::/48, loopback, linklocal, uniquelocal, ::1'),
    ['127.0.0.1', '10.20.0.0/16', '::1', '2001:db8::/48', 'loopback', 'linklocal', 'uniquelocal'],
  );
  assert.deepEqual(parseTrustedProxy('192.0.2.1/32, ::ffff:192.0.2.2/128'), [
    '192.0.2.1/32',
    '::ffff:192.0.2.2/128',
  ]);
});

test('invalid configurations fail closed instead of enabling blanket proxy trust', () => {
  for (const value of [
    'true',
    'TRUE',
    '1',
    '2',
    '*',
    '0.0.0.0/0',
    '::/0',
    '192.0.2.1/33',
    '2001:db8::/129',
    '192.0.2.1/-1',
    '192.0.2.1/01',
    '192.0.2.1/24/32',
    '192.0.2.1/',
    '256.0.0.1',
    'proxy.example.test',
    'http://127.0.0.1',
    '127.0.0.1,',
    ',127.0.0.1',
    'false,127.0.0.1',
    'fe80::1%eth0',
    '[::1]',
    '127.0.0.1:8080',
    'x'.repeat(4097),
    Array.from({ length: 129 }, () => '127.0.0.1').join(','),
  ])
    assert.throws(() => parseTrustedProxy(value), /TRUSTED_PROXY/, value);
});
