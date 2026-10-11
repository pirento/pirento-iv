import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  const { auth, mailer, getDocument } = context;
  return {
    postMessagesIdRetry: async (req, res) => {
      const message = await mailer.get(req.params.id);
      if (!message) throw new HttpError(404, 'Email not found.');
      const user = res.locals.user;
      if (
        auth &&
        user?.role !== 'admin' &&
        (!message.documentId ||
          !user?.organizationIds.includes((await getDocument(message.documentId)).organizationId))
      )
        throw new HttpError(403, 'This email is outside your organization access.');
      res.json({
        message: await mailer.retry(message.id),
      });
    },
  };
}
