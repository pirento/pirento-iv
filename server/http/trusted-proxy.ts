import { isIP } from 'node:net';

const namedRanges = new Set(['loopback', 'linklocal', 'uniquelocal']);
const invalidConfiguration = () =>
  new Error(
    'TRUSTED_PROXY must list trusted proxy IP addresses, CIDR ranges or loopback/linklocal/uniquelocal; blanket trust and hop counts are not allowed.',
  );

/** Trust forwarded client addresses only from explicitly configured proxy networks. */
export function parseTrustedProxy(value?: string): false | string[] {
  if (value === undefined || value.trim() === '' || value.trim() === 'false') return false;
  if (value.length > 4096) throw invalidConfiguration();
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.length > 128) throw invalidConfiguration();
  for (const entry of entries) {
    if (namedRanges.has(entry)) continue;
    const parts = entry.split('/');
    const address = parts[0];
    const version = isIP(address);
    if (!version || address.includes('%') || parts.length > 2) throw invalidConfiguration();
    if (parts.length === 2) {
      const prefix = parts[1];
      if (!/^(?:[1-9]\d*)$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128))
        throw invalidConfiguration();
    }
  }
  return [...new Set(entries)];
}
