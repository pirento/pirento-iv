/**
 * Error type and request diagnostics shared by the whole server.
 *
 * - HttpError: throw it anywhere to send a specific HTTP status and message to the client.
 * - createRequestDiagnostics: request ID + structured request log line for every request.
 * - createErrorReporter: logs an error safely (no request data or secrets in the log).
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { requestRoute } from '../services/operations/logger.js';

const diagnosticsStarted = Symbol('request-diagnostics');
const errorReported = Symbol('request-error-reported');

/**
 * An error with an HTTP status. Example: `throw new HttpError(404, 'Customer not found.')`.
 * Optional `code` is returned to the browser for special cases (e.g. version conflicts).
 */
export class HttpError extends Error {
  status;
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

/** Server-generated IDs cannot be used to inject client data into logs. */
export function createRequestDiagnostics(logger, readiness) {
  return (req, res, next) => {
    if (req[diagnosticsStarted]) return next();
    req[diagnosticsStarted] = true;
    req.requestId = randomUUID();
    res.locals.requestId = req.requestId;
    res.setHeader('X-Request-ID', req.requestId);
    const started = performance.now();
    let completed = false;
    function finish(aborted = false) {
      if (completed) return;
      completed = true;
      logger[aborted ? 'warn' : 'info'](aborted ? 'request_aborted' : 'request_completed', {
        requestId: req.requestId,
        method: req.method,
        route: requestRoute(req),
        statusCode: aborted ? 499 : res.statusCode,
        durationMs: performance.now() - started,
      });
    }
    res.once('finish', () => finish());
    res.once('close', () => finish(!res.writableFinished));
    const healthRequest =
      ['GET', 'HEAD'].includes(req.method) && ['/api/health', '/api/ready'].includes(req.path.toLowerCase());
    if (readiness.isDraining() && !healthRequest) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({
        error: 'The workspace is restarting. Retry shortly.',
        code: 'SERVICE_DRAINING',
        requestId: req.requestId,
      });
    }
    next();
  };
}

/** Public handlers can report an error without passing its text or payload to the log sink. */
export function createErrorReporter(logger) {
  return (error, req, statusCode = 500) => {
    if (req[errorReported]) return;
    req[errorReported] = true;
    logger[statusCode >= 500 ? 'error' : 'warn']('request_failed', {
      error,
      requestId: req.requestId,
      method: req.method,
      route: requestRoute(req),
      statusCode,
    });
  };
}
