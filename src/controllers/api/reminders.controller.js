/**
 * Payment reminders API: unpaid invoices due for a reminder, reminder history, the per-business
 * automatic reminder policy (admin only), and preview/send for one invoice.
 * Logic lives in src/services/integrations/email/payment-reminders.js.
 */

import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';

const organizationId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

export function createController({ reminders, auth, scopedOrganization, getDocument }) {
  function authorize(res, id, administrator = false) {
    if (!auth) return;
    const user = res.locals.user;
    if (!user || user.status !== 'active') throw new HttpError(401, 'Please sign in to continue.');
    if (administrator && user.role !== 'admin')
      throw new HttpError(403, 'Administrator access is required to change automatic reminders.');
    if (user.role !== 'admin' && !user.organizationIds.includes(id))
      throw new HttpError(403, 'This organization is outside your access.');
  }

  async function scope(res, value, administrator = false) {
    const id = organizationId.parse(value);
    authorize(res, id, administrator);
    return await scopedOrganization(id);
  }

  async function documentScope(req, res) {
    const document = await getDocument(req.params.id);
    authorize(res, document.organizationId);
    return document;
  }

  return {
    // GET /api/reminders
    list: async (req, res) => {
      const organization = await scope(res, req.query.organizationId);
      res.json(await reminders.list(organization.id, req.query));
    },
    // GET /api/reminders/history
    history: async (req, res) => {
      const organization = await scope(res, req.query.organizationId);
      res.json(await reminders.history(organization.id, req.query));
    },
    // GET /api/reminders/policy
    getPolicy: async (req, res) => {
      const organization = await scope(res, req.query.organizationId);
      res.json({ policy: await reminders.getPolicy(organization.id) });
    },
    // PUT /api/reminders/policy
    updatePolicy: async (req, res) => {
      const organization = await scope(res, req.body?.organizationId, true);
      res.json({
        policy: await reminders.updatePolicy(organization.id, req.body, res.locals.user?.id),
      });
    },
    // GET /api/documents/:id/reminder-preview
    preview: async (req, res) => {
      const document = await documentScope(req, res);
      res.json(await reminders.preview(document.id, req.query));
    },
    // POST /api/documents/:id/reminders
    queue: async (req, res) => {
      const document = await documentScope(req, res);
      res.status(202).json(await reminders.enqueueManual(document.id, req.body));
    },
  };
}
