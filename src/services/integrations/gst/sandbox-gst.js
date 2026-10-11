import { lookupResultSchema, validGstin } from '../../validation/validation.js';
import { discardProviderResponse, readProviderJson } from '../provider-http.js';
const HOSTS = {
  test: 'https://test-api.sandbox.co.in',
  production: 'https://api.sandbox.co.in',
};
const MINUTE = 60_000;
const CACHE_LIFETIME = 5 * MINUTE;
const MAX_TOKEN_LIFETIME = 24 * 60 * MINUTE;
const MAX_CLIENTS = 1000;
const MAX_CACHE = 500;
export class SandboxGstError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'SandboxGstError';
  }
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider data');
  return value;
}
function credential(value) {
  const trimmed = value?.trim() ?? '';
  return trimmed && trimmed.length <= 2048 && !/[\x00-\x20\x7f]/.test(trimmed) ? trimmed : '';
}
function providerFailure(code, authentication = false) {
  if (code === 429)
    throw new SandboxGstError(429, 'Sandbox GST requests are temporarily limited. Please try again later.');
  if (code === 401 || code === 403)
    throw new SandboxGstError(
      503,
      'Sandbox GST authentication was rejected. Ask an administrator to check the API credentials and access.',
    );
  if (!authentication && (code === 400 || code === 422))
    throw new SandboxGstError(400, 'Sandbox did not accept this GSTIN. Check the number and try again.');
  if (!authentication && code === 404)
    throw new SandboxGstError(404, 'No taxpayer was found for this GSTIN.');
  throw new SandboxGstError(
    502,
    'Sandbox GST lookup is unavailable or returned an invalid response. Try again later or enter the details manually.',
  );
}
function normalizeResult(payload, requested) {
  const envelope = object(payload);
  if (envelope.code !== 200) providerFailure(envelope.code);
  const wrapped = object(envelope.data);
  if (wrapped.status_cd === '0') {
    const error = object(wrapped.error);
    if (error.error_cd === 'FO8000') throw new SandboxGstError(404, 'No taxpayer was found for this GSTIN.');
    providerFailure(undefined);
  }
  if (wrapped.status_cd !== '1') providerFailure(undefined);
  const taxpayer = object(wrapped.data);
  if (typeof taxpayer.gstin !== 'string' || taxpayer.gstin.trim().toUpperCase() !== requested)
    providerFailure(undefined);
  if (typeof taxpayer.lgnm !== 'string' || typeof taxpayer.sts !== 'string' || !taxpayer.sts.trim())
    providerFailure(undefined);
  let address = '';
  if (taxpayer.pradr !== undefined) {
    const primary = object(taxpayer.pradr);
    if (primary.addr !== undefined) {
      const fields = object(primary.addr);
      const components = ['bno', 'flno', 'bnm', 'st', 'landMark', 'locality', 'loc', 'dst', 'stcd', 'pncd'];
      address = components
        .map((key) => {
          const value = fields[key];
          if (value === undefined) return '';
          if (typeof value !== 'string') throw new Error('Invalid provider address');
          return value.trim();
        })
        .filter(Boolean)
        .join(', ');
    } else if (primary.adr !== undefined) {
      if (typeof primary.adr !== 'string') throw new Error('Invalid provider address');
      address = primary.adr;
    }
  }
  const normalized = lookupResultSchema.safeParse({
    gstin: requested,
    name: taxpayer.lgnm,
    address,
    stateCode: requested.slice(0, 2),
    status: taxpayer.sts,
  });
  if (!normalized.success) providerFailure(undefined);
  return normalized.data;
}
export function createSandboxGst(options = {}) {
  const environment = options.environment ?? process.env;
  const selected = environment.SANDBOX_ENVIRONMENT?.trim().toLowerCase() || 'test';
  const mode = selected === 'production' ? 'production' : 'test';
  const validMode = selected === 'test' || selected === 'production';
  const apiKey = credential(environment.SANDBOX_API_KEY);
  const apiSecret = credential(environment.SANDBOX_API_SECRET);
  const configured = Boolean(validMode && apiKey && apiSecret);
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const requests = new Map();
  let globalWindow = {
    since: now(),
    count: 0,
  };
  const cache = new Map();
  const pending = new Map();
  let token;
  let authenticating;
  function rateLimit(client) {
    const time = now();
    for (const [id, window] of requests) if (window.since + MINUTE <= time) requests.delete(id);
    if (globalWindow.since + MINUTE <= time)
      globalWindow = {
        since: time,
        count: 0,
      };
    const window = requests.get(client) ?? {
      since: time,
      count: 0,
    };
    if (
      (!requests.has(client) && requests.size >= MAX_CLIENTS) ||
      window.count >= 10 ||
      globalWindow.count >= 60
    )
      throw new SandboxGstError(429, 'Too many GST lookup requests. Please wait one minute and try again.');
    window.count++;
    globalWindow.count++;
    requests.set(client, window);
  }
  async function authenticate() {
    if (token && token.expiresAt > now()) return token;
    if (authenticating) return authenticating;
    const operation = (async () => {
      const response = await fetcher(`${HOSTS[mode]}/authenticate`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-api-secret': apiSecret,
          'x-api-version': '1.0.0',
        },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        discardProviderResponse(response);
        providerFailure(response.status, true);
      }
      const payload = object(await readProviderJson(response, 16 * 1024));
      if (payload.code !== 200) providerFailure(payload.code, true);
      const value = object(payload.data).access_token;
      if (
        typeof value !== 'string' ||
        value.length > 8192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
      )
        providerFailure(undefined, true);
      const claims = object(JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')));
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) providerFailure(undefined, true);
      const expiresAt = Math.min(claims.exp * 1000, now() + MAX_TOKEN_LIFETIME) - MINUTE;
      if (expiresAt <= now()) providerFailure(undefined, true);
      const authenticated = {
        value,
        expiresAt,
      };
      token = authenticated;
      return authenticated;
    })();
    authenticating = operation;
    try {
      return await operation;
    } finally {
      if (authenticating === operation) authenticating = undefined;
    }
  }
  async function search(gstin) {
    const authenticated = await authenticate();
    const response = await fetcher(`${HOSTS[mode]}/gst/compliance/public/gstin/search`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        authorization: authenticated.value,
        'x-api-key': apiKey,
        'x-api-version': '1.0.0',
        'x-accept-cache': 'false',
      },
      body: JSON.stringify({
        gstin,
      }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && token === authenticated) token = undefined;
      discardProviderResponse(response);
      providerFailure(response.status);
    }
    const payload = await readProviderJson(response, 128 * 1024);
    if (payload && typeof payload === 'object') {
      const code = payload.code;
      if ((code === 401 || code === 403) && token === authenticated) token = undefined;
    }
    return normalizeResult(payload, gstin);
  }
  return {
    status() {
      return {
        provider: 'sandbox',
        mode,
        configured,
        keyConfigured: Boolean(apiKey),
        secretConfigured: Boolean(apiSecret),
      };
    },
    async lookup(number, clientId) {
      if (!configured)
        throw new SandboxGstError(
          503,
          'Sandbox GST is not configured. Ask an administrator to set the API key, API secret and environment.',
        );
      const gstin = typeof number === 'string' ? number.trim().toUpperCase() : '';
      if (!validGstin(gstin))
        throw new SandboxGstError(400, 'Enter a valid GSTIN, including its check digit.');
      if (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 256)
        throw new SandboxGstError(400, 'A valid workspace session is required for GST lookup.');
      rateLimit(clientId);
      for (const [id, entry] of cache) if (entry.expiresAt <= now()) cache.delete(id);
      const cached = cache.get(gstin);
      if (cached)
        return {
          ...cached.result,
        };
      const existing = pending.get(gstin);
      if (existing)
        return {
          ...(await existing),
        };
      const operation = search(gstin).catch((error) => {
        if (error instanceof SandboxGstError) throw error;
        return providerFailure(undefined);
      });
      pending.set(gstin, operation);
      try {
        const result = await operation;
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
        cache.set(gstin, {
          result,
          expiresAt: now() + CACHE_LIFETIME,
        });
        return {
          ...result,
        };
      } catch (error) {
        if (error instanceof SandboxGstError) throw error;
        return providerFailure(undefined);
      } finally {
        if (pending.get(gstin) === operation) pending.delete(gstin);
      }
    },
  };
}
