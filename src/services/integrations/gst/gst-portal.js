/**
 * GST taxpayer lookup through the public government portal (services.gst.gov.in).
 * The user types the CAPTCHA shown by the portal; the server keeps the portal session for
 * 3 minutes and never tries to bypass the CAPTCHA.
 */

import { randomUUID } from 'node:crypto';
const CAPTCHA_URL = 'https://services.gst.gov.in/services/captcha';
const LOOKUP_URL = 'https://services.gst.gov.in/services/api/search/taxpayerDetails';
const SESSION_LIFETIME_MS = 3 * 60 * 1000;
/** Lookup failure with an HTTP status and a message safe to show the user. */
export class PortalError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
/** Reads a response body up to maxBytes (larger responses are rejected). */
export async function readLimited(response, maxBytes) {
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error('Provider response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
function normalizePortalResult(data, gstin) {
  if (!data || typeof data !== 'object') throw new Error('Invalid portal result');
  const value = data;
  if (value.errorCode === 'SWEB_9000')
    throw new PortalError(400, 'The CAPTCHA was incorrect or expired. Load a new image and try again.');
  if (value.errorCode === 'SWEB_9035') throw new PortalError(404, 'No taxpayer was found for this GSTIN.');
  if (value.errorCode || typeof value.lgnm !== 'string' || !value.lgnm.trim())
    throw new Error('Portal did not return a taxpayer');
  if (value.gstin && value.gstin !== gstin) throw new Error('Portal returned another GSTIN');
  const primaryAddress = value.pradr && typeof value.pradr === 'object' ? value.pradr : {};
  let address = typeof primaryAddress.adr === 'string' ? primaryAddress.adr : '';
  const components = primaryAddress.addr;
  if (!address && components && typeof components === 'object') {
    const fields = components;
    address = ['bno', 'flno', 'bnm', 'st', 'loc', 'dst', 'stcd', 'pncd']
      .map((key) => fields[key])
      .filter((field) => typeof field === 'string' && field.trim())
      .join(', ');
  }
  return {
    gstin,
    name: value.lgnm.trim(),
    address,
    stateCode: gstin.slice(0, 2),
    ...(typeof value.sts === 'string'
      ? {
          status: value.sts,
        }
      : {}),
  };
}
/** Returns { captcha, lookup } for the CAPTCHA-based portal lookup, with a per-client rate limit. */
export function createGstPortal(fetcher = globalThis.fetch) {
  const sessions = new Map();
  const requests = new Map();
  function rateLimit(client) {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [id, window] of requests) if (window.since + 60000 <= now) requests.delete(id);
    const window = requests.get(client) ?? {
      since: now,
      count: 0,
    };
    window.count++;
    requests.set(client, window);
    if (window.count > 20 || requests.size > 1000)
      throw new PortalError(429, 'Too many GST lookup requests. Please wait one minute and try again.');
  }
  function unavailable(error) {
    if (error instanceof PortalError) throw error;
    throw new PortalError(
      502,
      'The GST public portal is unavailable from this workspace or did not respond in time. Enter customer details manually, or configure a GST API provider.',
    );
  }
  return {
    async captcha(client) {
      rateLimit(client);
      if (sessions.size >= 100)
        throw new PortalError(429, 'Too many active GST challenges. Please try again in a few minutes.');
      try {
        const response = await fetcher(`${CAPTCHA_URL}?rnd=${randomUUID()}`, {
          headers: {
            Accept: 'image/png,image/jpeg,image/gif,image/webp',
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Portal captcha unavailable');
        const mime = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
        if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
          throw new Error('Unexpected captcha response');
        const cookies = response.headers.getSetCookie();
        const cookie = cookies
          .map((value) => value.split(';')[0])
          .find((value) => /^CaptchaCookie=[^\r\n;]+$/.test(value));
        if (!cookie || cookie.length > 2048) throw new Error('No captcha session');
        const bytes = await readLimited(response, 256000);
        if (!bytes.length) throw new Error('Empty captcha');
        const challengeId = randomUUID();
        sessions.set(challengeId, {
          cookie,
          client,
          expiresAt: Date.now() + SESSION_LIFETIME_MS,
        });
        return {
          challengeId,
          image: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
        };
      } catch (error) {
        return unavailable(error);
      }
    },
    async lookup(client, gstin, challengeId, captcha) {
      rateLimit(client);
      const session = sessions.get(challengeId);
      if (!session || session.client !== client || session.expiresAt <= Date.now())
        throw new PortalError(400, 'The CAPTCHA challenge expired. Load a new image and try again.');
      sessions.delete(challengeId);
      try {
        const response = await fetcher(LOOKUP_URL, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Cookie: session.cookie,
          },
          body: JSON.stringify({
            gstin,
            captcha,
          }),
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Portal lookup unavailable');
        const bytes = await readLimited(response, 128000);
        return normalizePortalResult(JSON.parse(new TextDecoder().decode(bytes)), gstin);
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
