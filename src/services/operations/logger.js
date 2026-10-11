const EVENTS = new Set([
  'application_event',
  'request_completed',
  'request_aborted',
  'request_failed',
  'readiness_changed',
  'server_starting',
  'server_listening',
  'server_start_failed',
  'email_worker_failed',
  'automation_failed',
  'backup_failed',
  'shutdown_started',
  'shutdown_completed',
  'shutdown_timeout',
  'shutdown_failed',
  'uncaught_exception',
  'unhandled_rejection',
]);
const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'AbortError',
  'TimeoutError',
  'HttpError',
  'ZodError',
  'PortalError',
  'SandboxGstError',
  'EmailQueueError',
  'OnlinePaymentError',
  'DatabaseBackupError',
  'MongoServerError',
  'MongoServerSelectionError',
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoOperationTimeoutError',
  'MongoNotConnectedError',
  'MongoClientClosedError',
  'MongoTopologyClosedError',
  'MongoPoolClosedError',
  'MongoWriteConcernError',
  'MongoParseError',
  'MongoInvalidArgumentError',
]);
const ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRINUSE',
  'EACCES',
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'ABORT_ERR',
  'DOCUMENT_VERSION_CONFLICT',
  'DOCUMENT_REQUEST_CONFLICT',
  'SERVICE_DRAINING',
  'not_found',
  'configuration',
  'unsafe_path',
  'verification',
  'backup_failed',
  18,
  50,
  91,
  112,
  189,
  262,
  10107,
  11000,
  11600,
  11602,
]);
const STATES = new Set(['starting', 'ready', 'unavailable', 'recovery_required', 'draining', 'stopped']);
const REASONS = new Set([
  'SIGINT',
  'SIGTERM',
  'manual',
  'startup_error',
  'server_error',
  'uncaught_exception',
  'unhandled_rejection',
]);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Never serialize an Error object, message, cause, stack, URL, request body or headers. */
export function safeErrorDetails(error) {
  if (!error || typeof error !== 'object') return { errorType: 'Error' };
  const constructorName = error.constructor?.name;
  const type =
    ERROR_TYPES.has(constructorName) && constructorName !== 'Error'
      ? constructorName
      : ERROR_TYPES.has(error.name)
        ? error.name
        : 'Error';
  return {
    errorType: type,
    ...(ERROR_CODES.has(error.code) ? { errorCode: error.code } : {}),
  };
}

/** The route comes from Express's registered template, never the requested URL. */
export function requestRoute(req) {
  const route = req.route?.path;
  return typeof route === 'string' && route.length <= 200 && /^\/[A-Za-z0-9_/:.*{}?()-]*$/.test(route)
    ? route
    : 'unmatched';
}

/** A small allowlist keeps future callers from accidentally logging credentials or customer data. */
export function createLogger({ write = (line) => console.log(line), now = () => new Date() } = {}) {
  function log(level, event, details = {}) {
    try {
      const record = {
        timestamp: now().toISOString(),
        level,
        event: EVENTS.has(event) ? event : 'application_event',
      };
      if (UUID.test(details.requestId || '')) record.requestId = details.requestId;
      if (METHODS.has(details.method)) record.method = details.method;
      if (
        typeof details.route === 'string' &&
        details.route.length <= 200 &&
        (details.route === 'unmatched' || /^\/[A-Za-z0-9_/:.*{}?()-]*$/.test(details.route))
      )
        record.route = details.route;
      if (Number.isInteger(details.statusCode) && details.statusCode >= 100 && details.statusCode <= 599)
        record.statusCode = details.statusCode;
      if (Number.isFinite(details.durationMs) && details.durationMs >= 0)
        record.durationMs = Math.round(details.durationMs * 100) / 100;
      if (Number.isInteger(details.port) && details.port >= 0 && details.port <= 65535)
        record.port = details.port;
      if (STATES.has(details.state)) record.state = details.state;
      if (REASONS.has(details.reason)) record.reason = details.reason;
      if (
        ['environment', 'application', 'http', 'workers', 'database', 'recurring', 'reminders'].includes(
          details.stage,
        )
      )
        record.stage = details.stage;
      if (typeof details.forced === 'boolean') record.forced = details.forced;
      if (details.error !== undefined) Object.assign(record, safeErrorDetails(details.error));
      write(JSON.stringify(record));
    } catch {
      // A failed log sink must not change a committed payment or an HTTP response.
    }
  }
  return {
    info: (event, details) => log('info', event, details),
    warn: (event, details) => log('warn', event, details),
    error: (event, details) => log('error', event, details),
  };
}
