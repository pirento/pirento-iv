import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';

const organizationIdSchema = z.string().trim().min(1).max(100);

export function createController({ recurringInvoices, auth }) {
  function authorize(res, rawOrganizationId, manage = false) {
    const organizationId = organizationIdSchema.parse(rawOrganizationId);
    const user = res.locals.user;
    if (auth) {
      if (!user || user.status !== 'active') throw new HttpError(401, 'Sign in to continue.');
      if (user.role !== 'admin' && (manage || !user.organizationIds.includes(organizationId)))
        throw new HttpError(
          403,
          manage
            ? 'Administrator access is required to manage recurring invoices.'
            : 'This business is outside your access.',
        );
    }
    return { organizationId, actorId: user?.id || 'test-administrator' };
  }
  function mutation(req, res) {
    const { organizationId, actorId } = authorize(res, req.body?.organizationId, true);
    const { organizationId: ignored, ...input } = req.body;
    return { organizationId, actorId, input };
  }
  return {
    getRecurringInvoices: async (req, res) => {
      const { organizationId } = authorize(res, req.query.organizationId);
      res.json(await recurringInvoices.list(organizationId, req.query));
    },
    getRecurringSources: async (req, res) => {
      const { organizationId } = authorize(res, req.query.organizationId);
      res.json(await recurringInvoices.sourceCandidates(organizationId, req.query.q || ''));
    },
    getRecurringInvoicesId: async (req, res) => {
      const { organizationId } = authorize(res, req.query.organizationId);
      res.json(await recurringInvoices.get(organizationId, req.params.id, req.query));
    },
    postRecurringInvoices: async (req, res) => {
      const { actorId } = authorize(res, req.body?.organizationId, true);
      const result = await recurringInvoices.create(req.body, actorId);
      res.status(result.created ? 201 : 200).json(result);
    },
    putRecurringInvoicesId: async (req, res) => {
      const { organizationId, actorId, input } = mutation(req, res);
      res.json(await recurringInvoices.update(organizationId, req.params.id, input, actorId));
    },
    postRecurringInvoicesIdStatus: async (req, res) => {
      const { organizationId, actorId, input } = mutation(req, res);
      res.json(await recurringInvoices.setStatus(organizationId, req.params.id, input, actorId));
    },
    postRecurringInvoicesIdGenerate: async (req, res) => {
      const { organizationId, actorId, input } = mutation(req, res);
      const result = await recurringInvoices.generate(organizationId, req.params.id, input, actorId);
      res
        .status(result.failed ? 422 : result.created ? 201 : 200)
        .json(
          result.failed ? { ...result, error: result.message, code: 'RECURRING_GENERATION_FAILED' } : result,
        );
    },
  };
}
