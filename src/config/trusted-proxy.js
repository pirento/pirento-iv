/**
 * Reverse-proxy trust (TRUST_PROXY setting). Only explicitly listed proxy IPs/ranges may set
 * the client's address through X-Forwarded-For; login rate limits depend on this address.
 */

import { BlockList, isIP } from 'node:net';

/** Canonical keys prevent IPv4-mapped IPv6 addresses from receiving a second allowance. */
export function normalizeIpAddress(value) {
  if (typeof value !== 'string' || value.includes('%') || value.trim() !== value) return undefined;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

/** Trust only explicit peer addresses/ranges, never a header alone or an arbitrary hop count. */
export function parseTrustedProxy(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('TRUST_PROXY must be a comma-separated list of proxy IP addresses or CIDRs.');
  if (!value.trim()) return [];
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > 32 || entries.some((entry) => !entry))
    throw new Error('TRUST_PROXY requires between 1 and 32 explicit proxy addresses or CIDRs.');
  return entries.map((entry) => {
    const parts = entry.split('/');
    const rawAddress = parts[0];
    const address = normalizeIpAddress(rawAddress);
    const originalFamily = isIP(rawAddress);
    const family = isIP(address ?? '');
    if (
      !address ||
      ['0.0.0.0', '::'].includes(address) ||
      parts.length > 2 ||
      (parts.length === 2 && !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1]))
    )
      throw new Error(
        'TRUST_PROXY accepts explicit IP addresses and CIDRs; booleans, names and hop counts are unsafe.',
      );
    let prefix = parts.length === 2 ? Number(parts[1]) : originalFamily === 4 ? 32 : 128;
    if (prefix < 1 || prefix > (originalFamily === 4 ? 32 : 128))
      throw new Error('TRUST_PROXY must not trust every address; use a valid, restricted proxy CIDR.');
    if (originalFamily === 6 && family === 4) {
      prefix -= 96;
      if (prefix < 1)
        throw new Error('An IPv4-mapped TRUST_PROXY CIDR must identify a restricted IPv4 range.');
    }
    return { address, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
  });
}

/** Applies TRUST_PROXY to the Express app (empty = trust no proxy). */
export function configureTrustedProxy(app, environment = process.env) {
  const entries = parseTrustedProxy(environment.TRUST_PROXY);
  if (!entries.length) {
    app.set('trust proxy', false);
    return;
  }
  const addresses = new BlockList();
  for (const entry of entries) addresses.addSubnet(entry.address, entry.prefix, entry.family);
  app.set('trust proxy', (peer) => {
    const address = normalizeIpAddress(peer);
    return Boolean(address && addresses.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6'));
  });
}

/** Express resolves req.ip from the right using the configured trusted-peer predicate. */
export function normalizedClientAddress(req) {
  return normalizeIpAddress(req.ip ?? req.socket?.remoteAddress) ?? 'unknown';
}
