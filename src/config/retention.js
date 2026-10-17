/**
 * How long log-type records are kept before MongoDB deletes them (TTL indexes on their expiresOn
 * date, created in config/database.js). Invoices, payments and their histories are never deleted
 * automatically (GST record keeping).
 */

export const RETENTION_DAYS = Object.freeze({ securityLog: 365, webhookEvents: 90 });

/** Expiry date `days` after an ISO timestamp (or now, if the timestamp is unreadable). */
export const expiresAfter = (createdAt, days) =>
  new Date((Date.parse(createdAt) || Date.now()) + days * 86_400_000);
