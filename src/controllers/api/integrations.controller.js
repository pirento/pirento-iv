import { integrationEnvironmentPrefix } from '../../../shared/business-identity.js';
import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  const { db, auth, mailer, online, gstStatus, getOrganization, getDocument } = context;
  return {
    status: async (req, res) => {
      const user = res.locals.user;
      const documentId =
        req.query.documentId === undefined ? undefined : z.string().min(1).parse(req.query.documentId);
      const document = documentId ? await getDocument(documentId) : undefined;
      const requestedId =
        req.query.organizationId === undefined
          ? undefined
          : z.string().min(1).parse(req.query.organizationId);
      const firstId =
        auth && user?.role !== 'admin'
          ? user?.organizationIds[0]
          : (await db.models.organizations.first())?.id;
      const organizationId = requestedId ?? document?.organizationId ?? firstId;
      if (!organizationId) throw new HttpError(403, 'No organization is assigned to this account.');
      if (auth && user?.role !== 'admin' && !user?.organizationIds.includes(organizationId))
        throw new HttpError(403, 'This organization is outside your access.');
      if (document && document.organizationId !== organizationId)
        throw new HttpError(400, 'The document belongs to a different organization.');
      const organization = await getOrganization(organizationId);
      const payment = await online.getStatus(organizationId, documentId);
      res.json({
        email: await mailer.status(organizationId),
        payment,
        razorpay: payment,
        gst: gstStatus(),
        environmentPrefix: integrationEnvironmentPrefix(organization),
        webhookPath: payment.provider === 'none' ? '' : `/api/webhooks/${payment.provider}/${organizationId}`,
      });
    },
  };
}
