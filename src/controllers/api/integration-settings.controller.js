/**
 * Payments & email settings of one business (/api/integrations/:organizationId/settings):
 * the payment gateway and its keys, how emails are sent (SMTP server or Resend API) and the
 * addresses that receive replies. Administrators, and Business owner logins for their own business.
 * Secrets are write-only: responses say only whether each is saved and its last 4 characters.
 */

import { z } from 'zod';
import { transaction } from '../../config/database.js';
import { HttpError } from '../../middleware/errors.js';
import { organizationGateway } from '../../../shared/business-identity.js';
import { INTEGRATION_SETTINGS } from '../../services/integrations/integration-settings.js';

const secret = z
  .string()
  .trim()
  .max(500)
  .regex(/^\S*$/, 'Keys and passwords cannot contain spaces.')
  .optional();
const plain = (max) => z.string().trim().max(max).optional();
const emailOrBlank = z.union([z.literal(''), z.email('Enter a valid email address.')]).optional();
const settingsSchema = z.object({
  paymentGateway: z.enum(['razorpay', 'cashfree', 'none']).optional(),
  RAZORPAY_KEY_ID: plain(100).refine(
    (value) => !value || /^rzp_(test|live)_\w+$/.test(value),
    'A Razorpay key ID starts with rzp_test_ or rzp_live_.',
  ),
  RAZORPAY_KEY_SECRET: secret,
  RAZORPAY_WEBHOOK_SECRET: secret,
  CASHFREE_CLIENT_ID: plain(200),
  CASHFREE_CLIENT_SECRET: secret,
  CASHFREE_ENVIRONMENT: z.enum(['', 'sandbox', 'production']).optional(),
  EMAIL_FROM: emailOrBlank,
  RESEND_API_KEY: secret,
  SMTP_HOST: plain(253).refine(
    (value) => !value || /^[A-Za-z0-9.-]+$/.test(value),
    'Enter the SMTP server name, e.g. smtp.hostinger.com.',
  ),
  // Mail ports only, so the setting cannot point the server at other services.
  SMTP_PORT: z.enum(['', '25', '465', '587', '2525']).optional(),
  SMTP_SECURE: z.enum(['', 'true', 'false']).optional(),
  SMTP_USER: plain(254),
  SMTP_PASSWORD: secret,
  EMAIL_AUTOMATION: z.enum(['', 'true', 'false']).optional(),
  supportEmail: emailOrBlank,
  financeEmail: emailOrBlank,
  clear: z
    .array(z.enum(Object.keys(INTEGRATION_SETTINGS).filter((key) => INTEGRATION_SETTINGS[key])))
    .optional(),
});

export function createController({ db, online, mailer, integrationSettings, getOrganization }) {
  // Administrators, or a Business owner login assigned to this business (the access guard checks the id).
  const allowed = (res) => {
    const user = res.locals.user;
    if (user && user.role !== 'admin' && user.permission !== 'owner')
      throw new HttpError(403, 'Only an administrator or the business owner can change these settings.');
  };
  const current = async (organizationId) => ({
    settings: await integrationSettings.view(organizationId),
    email: await mailer.status(organizationId),
    payment: await online.getStatus(organizationId),
  });
  return {
    // GET /api/integrations/:organizationId/settings
    show: async (req, res) => {
      allowed(res);
      const organization = await getOrganization(req.params.organizationId);
      res.json(await current(organization.id));
    },
    // POST /api/integrations/:organizationId/test-email { to }: sends one test email now.
    testEmail: async (req, res) => {
      allowed(res);
      const organization = await getOrganization(req.params.organizationId);
      res.json(
        await mailer.sendTest(
          organization.id,
          z
            .string()
            .trim()
            .max(254)
            .parse(req.body?.to ?? ''),
        ),
      );
    },
    // PUT /api/integrations/:organizationId/settings
    save: async (req, res) => {
      allowed(res);
      const { paymentGateway, supportEmail, financeEmail, clear, ...settings } = settingsSchema.parse(
        req.body,
      );
      const organization = await getOrganization(req.params.organizationId);
      const changes = {
        ...(paymentGateway ? { paymentGateway } : {}),
        ...(supportEmail !== undefined ? { supportEmail: supportEmail || undefined } : {}),
        ...(financeEmail !== undefined ? { financeEmail: financeEmail || undefined } : {}),
      };
      if (Object.keys(changes).length)
        await transaction(
          db,
          async () => {
            const latest = await getOrganization(organization.id);
            const result = { ...latest, ...changes };
            // As in Business settings: a gateway change waits until no online payment is in progress.
            if (organizationGateway(result) !== organizationGateway(latest))
              for (const row of await db.models.documents.list(latest.id))
                await online.assertManualChangesAllowed(row.id);
            await db.models.organizations.save(result);
          },
          { organizationId: organization.id },
        );
      await integrationSettings.save(organization.id, settings, clear);
      res.json(await current(organization.id));
    },
  };
}
