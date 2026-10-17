/** Chooses the GST taxpayer lookup provider from the environment (GST_PROVIDER, GST_LOOKUP_URL, GST_API_KEY). */

import { createGstPortal } from './gst-portal.js';
import { createSandboxGst } from './sandbox-gst.js';

/** A custom lookup URL must be HTTPS, credential-free and contain the {gstin} placeholder. */
function configuredLookupUrl(template) {
  if (!template || !template.includes('{gstin}')) return undefined;
  try {
    const url = new URL(template.replaceAll('{gstin}', '27AAACR5055K1Z7'));
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return template;
  } catch {
    return undefined;
  }
}

/** Selects the GST taxpayer lookup provider (government portal, custom URL or Sandbox). */
export function createGstIntegration({
  environment,
  fetcher,
  now,
  lookupUrl: lookupOverride,
  apiKey: keyOverride,
}) {
  const lookupUrl = configuredLookupUrl(lookupOverride ?? environment.GST_LOOKUP_URL);
  const apiKey = keyOverride ?? environment.GST_API_KEY;
  const requestedProvider = environment.GST_PROVIDER?.trim().toLowerCase();
  if (requestedProvider && !['portal', 'generic', 'sandbox'].includes(requestedProvider))
    throw new Error('GST_PROVIDER must be portal, generic or sandbox.');
  const gstProvider = requestedProvider || (lookupUrl ? 'generic' : 'portal');
  const sandboxGst = createSandboxGst({
    environment,
    fetch: fetcher,
    now: () => now().getTime(),
  });
  const gstStatus = () =>
    gstProvider === 'sandbox'
      ? sandboxGst.status()
      : {
          provider: gstProvider,
          mode: gstProvider === 'generic' ? 'custom' : 'captcha',
          configured: gstProvider === 'generic' && Boolean(lookupUrl),
          keyConfigured: gstProvider === 'generic' && Boolean(apiKey),
          secretConfigured: false,
        };
  return { portal: createGstPortal(fetcher), sandboxGst, gstProvider, gstStatus, lookupUrl, apiKey };
}
