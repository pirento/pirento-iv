import type { RequestHandler } from 'express';

/** Browser safeguards for the served application; development keeps Vite HMR working. */
export function securityHeaders(production: boolean): RequestHandler {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Invoice colors, dimensions and print styles are set by React.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:", // Browser PDF downloads can resolve a saved HTTPS logo.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (production)
      res.set({ 'Content-Security-Policy': policy, 'Strict-Transport-Security': 'max-age=15552000' });
    next();
  };
}

/** Repeated query keys are arrays in Express and must never silently bypass scoping. */
export const validateResourceQueries: RequestHandler = (req, res, next) => {
  for (const key of ['organizationId', 'documentId']) {
    const value = req.query[key];
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 100)) {
      res.status(400).json({ error: `Provide one valid ${key}.` });
      return;
    }
  }
  next();
};
