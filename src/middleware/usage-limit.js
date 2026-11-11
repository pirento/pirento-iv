/**
 * A per-login request limit for endpoints that cost money or send email (AI helpers, HSN lookup,
 * test email), so a stolen or careless login cannot run up the bill or flood a mailbox.
 * Counters live in MongoDB (the auth_rate_limits collection, cleaned up by its TTL index), so the
 * limit holds across restarts and across several servers. MongoDB's clock defines the window.
 */

import { createHash } from 'node:crypto';

export function createUsageLimit({ db, scope, maximum, windowMs }) {
  const counters = db.collection('auth_rate_limits');
  const expired = { $lte: [{ $ifNull: ['$expiresOn', new Date(0)] }, '$$NOW'] };
  const update = [
    {
      $set: {
        scope: `usage:${scope}`,
        count: { $cond: [expired, 1, { $min: [maximum + 1, { $add: [{ $ifNull: ['$count', 0] }, 1] }] }] },
        expiresOn: { $cond: [expired, { $add: ['$$NOW', windowMs] }, '$expiresOn'] },
        observedAt: '$$NOW',
      },
    },
  ];
  const take = (key, upsert) =>
    counters.findOneAndUpdate({ _id: key }, update, {
      upsert,
      returnDocument: 'after',
      includeResultMetadata: false,
    });
  return async (req, res, next) => {
    const key = createHash('sha256')
      .update(`usage:${scope}:${res.locals.user?.id ?? req.ip}`)
      .digest('hex');
    let row;
    try {
      row = await take(key, true).catch((error) => {
        // The first request of a login can race the same upsert on another server.
        if (error.code !== 11000) throw error;
        return take(key, false);
      });
    } catch (error) {
      return next(error);
    }
    if (row.count > maximum) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((row.expiresOn - row.observedAt) / 1000))));
      res.status(429).json({ error: 'Too many requests in a short time. Try again in a few minutes.' });
      return;
    }
    next();
  };
}
