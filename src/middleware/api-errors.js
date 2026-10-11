import { z } from 'zod';
import { HttpError } from './errors.js';
import { PortalError } from '../services/integrations/gst/gst-portal.js';
import { SandboxGstError } from '../services/integrations/gst/sandbox-gst.js';
import { EmailQueueError } from '../services/integrations/email/mailer.js';
import { OnlinePaymentError } from '../services/integrations/payments/online-payments.js';
import { DatabaseBackupError } from '../services/operations/database-backup.js';

/** Maps validation, service and infrastructure errors to the JSON API's HTTP responses. */
export function createApiErrorHandler(reportError) {
  return (error, req, res, _next) => {
    const sendError = (status, payload) => {
      reportError(error, req, status);
      if (res.headersSent) return res.destroy();
      res.status(status).json({ ...payload, ...(status >= 500 ? { requestId: req.requestId } : {}) });
    };
    if (error instanceof z.ZodError) {
      sendError(400, {
        error: error.issues
          .map(
            (issue) =>
              `${issue.path.join('.') || 'Input'}: ${issue.code === 'invalid_enum_value' ? 'Choose one of the supported values.' : issue.message}`,
          )
          .join(' '),
      });
    } else if (
      error instanceof HttpError ||
      error instanceof PortalError ||
      error instanceof SandboxGstError ||
      error instanceof EmailQueueError ||
      error instanceof OnlinePaymentError
    ) {
      sendError(error.status, {
        error: error.status === 500 ? 'Unable to complete the request. Please try again.' : error.message,
        ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
        ...(error instanceof HttpError && error.document ? { document: error.document } : {}),
      });
    } else if (error instanceof DatabaseBackupError) {
      sendError(error.code === 'not_found' ? 404 : 503, {
        error: error.message,
      });
    } else if (error?.code === 11000) {
      sendError(409, {
        error: 'A record with these unique details already exists. Refresh the workspace before retrying.',
      });
    } else if (error instanceof URIError) {
      sendError(400, {
        error: 'The request URL contains an invalid identifier.',
      });
    } else if (error instanceof SyntaxError && 'body' in error) {
      sendError(400, {
        error: 'Request body must contain valid JSON.',
      });
    } else if (error && error.type === 'entity.too.large') {
      sendError(413, {
        error: 'Request is too large.',
      });
    } else {
      sendError(500, {
        error: 'Unable to complete the request. Please try again.',
      });
    }
  };
}
