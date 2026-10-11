import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';
import { readLimited } from '../../services/integrations/gst/gst-portal.js';
import { lookupResultSchema, validGstin } from '../../services/validation/validation.js';
export function createController(context) {
  const { portal, gstProvider, sandboxGst, lookupUrl, apiKey, fetcher } = context;
  return {
    captcha: async (req, res) => {
      res.json(await portal.captcha(req.ip ?? 'local'));
    },
    lookup: async (req, res) => {
      const input = z
        .object({
          gstin: z
            .string()
            .trim()
            .transform((value) => value.toUpperCase())
            .refine(validGstin, 'Enter a valid GSTIN.'),
          challengeId: z.string().uuid(),
          captcha: z
            .string()
            .trim()
            .regex(/^\d{6}$/, 'Enter the six digits shown in the CAPTCHA.'),
        })
        .parse(req.body);
      const result = await portal.lookup(req.ip ?? 'local', input.gstin, input.challengeId, input.captcha);
      const normalized = lookupResultSchema.safeParse(result);
      if (!normalized.success)
        throw new HttpError(
          502,
          'The GST public portal returned incomplete or invalid taxpayer details. Enter customer details manually.',
        );
      res.json(normalized.data);
    },
    lookupByGstin: async (req, res) => {
      const number = req.params.gstin.trim().toUpperCase();
      if (!validGstin(number))
        throw new HttpError(400, 'Enter a valid 15-character GSTIN, including its check digit.');
      if (gstProvider === 'sandbox') {
        const user = res.locals.user;
        res.json(await sandboxGst.lookup(number, user?.id ?? req.ip ?? 'local'));
        return;
      }
      if (gstProvider !== 'generic' || !lookupUrl)
        throw new HttpError(
          503,
          'GST lookup is not configured yet. Add your GST provider endpoint in server settings, or enter the customer details manually.',
        );
      try {
        const response = await fetcher(lookupUrl.replaceAll('{gstin}', encodeURIComponent(number)), {
          headers: {
            Accept: 'application/json',
            ...(apiKey
              ? {
                  Authorization: `Bearer ${apiKey}`,
                }
              : {}),
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (response.status === 404) throw new HttpError(404, 'No taxpayer was found for this GSTIN.');
        if (!response.ok)
          throw new HttpError(
            502,
            'The GST provider could not complete this lookup. Check the provider configuration or try again.',
          );
        const body = await readLimited(response, 128000);
        const parsed = JSON.parse(new TextDecoder().decode(body));
        const wrapped = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
        const result = lookupResultSchema.parse(wrapped);
        if (result.gstin !== number) throw new Error('Provider returned another GSTIN');
        res.json(result);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          502,
          'The GST provider returned an invalid response or did not respond in time. You can enter customer details manually.',
        );
      }
    },
  };
}
