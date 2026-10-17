/**
 * Request limits for login, signup, forgot-password and reset-password, per client IP address.
 * Counters are stored in MongoDB, so the limits hold across restarts and multiple servers.
 */

import { createHash } from 'node:crypto';
import { normalizedClientAddress } from '../../config/trusted-proxy.js';
import { HttpError } from '../../middleware/errors.js';

// Allowed requests per window: login 20 / 15 min, signup 10 / hour, forgot 8 / hour, reset 15 / hour.
export const ACCOUNT_LIMITS = Object.freeze({
  login: { maximum: 20, windowMs: 15 * 60 * 1000 },
  signup: { maximum: 10, windowMs: 60 * 60 * 1000 },
  forgot: { maximum: 8, windowMs: 60 * 60 * 1000 },
  reset: { maximum: 15, windowMs: 60 * 60 * 1000 },
});
// When the counter cannot be read in time, the request fails with 503 instead of skipping the limit.
export const ACCOUNT_LIMIT_TIMEOUT_MS = 2000;

/** A late counter write is harmless: it consumes an attempt but can never authorize a request. */
async function boundedOperation(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Account protection timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Returns { middleware(scope), take, recordLoginFailure } used by src/services/auth/auth.js. */
export function createAccountRateLimiter({ db, observe, timeoutMs = ACCOUNT_LIMIT_TIMEOUT_MS }) {
  const counters = db.collection('auth_rate_limits');
  const writeOptions = () => ({ timeoutMS: timeoutMs, writeConcern: { w: 'majority' } });

  async function take(scope, req) {
    const { maximum, windowMs } = ACCOUNT_LIMITS[scope];
    const key = createHash('sha256')
      .update(`${scope}:${normalizedClientAddress(req)}`)
      .digest('hex');
    const expired = { $lte: [{ $ifNull: ['$expiresOn', new Date(0)] }, '$$NOW'] };
    // The server's clock defines the shared window, so skew between app instances
    // cannot reset or extend another instance's allowance. TTL is cleanup only.
    const update = [
      {
        $set: {
          scope,
          count: {
            $cond: [expired, 1, { $min: [maximum + 2, { $add: [{ $ifNull: ['$count', 0] }, 1] }] }],
          },
          startedAt: { $cond: [expired, '$$NOW', '$startedAt'] },
          expiresOn: { $cond: [expired, { $add: ['$$NOW', windowMs] }, '$expiresOn'] },
          observedAt: '$$NOW',
          failureRecorded: { $cond: [expired, false, { $ifNull: ['$failureRecorded', false] }] },
        },
      },
    ];
    try {
      const row = await boundedOperation(async () => {
        try {
          return await counters.findOneAndUpdate({ _id: key }, update, {
            ...writeOptions(),
            upsert: true,
            returnDocument: 'after',
            includeResultMetadata: false,
          });
        } catch (error) {
          // First use of one address can race an upsert on another instance.
          if (error.code !== 11000) throw error;
          return counters.findOneAndUpdate({ _id: key }, update, {
            ...writeOptions(),
            returnDocument: 'after',
            includeResultMetadata: false,
          });
        }
      }, timeoutMs);
      if (
        !row ||
        !Number.isInteger(row.count) ||
        row.count < 1 ||
        row.count > maximum + 2 ||
        ![row.startedAt, row.expiresOn, row.observedAt].every(
          (value) => value instanceof Date && Number.isFinite(value.getTime()),
        ) ||
        row.expiresOn <= row.observedAt
      )
        throw new Error('Invalid counter.');
      return {
        scope,
        key,
        startedAt: row.startedAt,
        allowed: row.count <= maximum,
        firstBlocked: row.count === maximum + 1,
        retryAfter: Math.max(1, Math.ceil((row.expiresOn - row.observedAt) / 1000)),
      };
    } catch {
      throw new HttpError(
        503,
        'Account service is temporarily unavailable. Please try again shortly.',
        'AUTH_RATE_LIMIT_UNAVAILABLE',
      );
    }
  }

  function middleware(scope) {
    if (!Object.hasOwn(ACCOUNT_LIMITS, scope)) throw new TypeError('Unknown account protection scope.');
    return async (req, res, next) => {
      let attempt;
      try {
        attempt = await take(scope, req);
      } catch (error) {
        res.set('Retry-After', '5');
        return next(error);
      }
      if (!attempt.allowed) {
        if (attempt.firstBlocked) await observe?.('account-throttled', null, { scope });
        res.set('Retry-After', String(attempt.retryAfter));
        return res.status(429).json({ error: 'Too many account requests. Please wait and try again.' });
      }
      req.accountAttempt = attempt;
      next();
    };
  }

  /** One unsuccessful-login observation per source/window avoids an audit row per repeated attempt. */
  async function recordLoginFailure(attempt, userId) {
    if (!attempt || attempt.scope !== 'login') return;
    try {
      const result = await boundedOperation(
        () =>
          counters.updateOne(
            { _id: attempt.key, startedAt: attempt.startedAt, failureRecorded: false },
            { $set: { failureRecorded: true } },
            writeOptions(),
          ),
        timeoutMs,
      );
      if (result.modifiedCount) await observe?.('login-unsuccessful', userId, { scope: 'login' });
    } catch {
      // Observability must not alter the generic credential response.
    }
  }

  return { middleware, take, recordLoginFailure };
}
