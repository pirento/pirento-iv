/**
 * A per-login request limit for endpoints that cost money or send email (AI helpers, test email),
 * so a stolen or careless login cannot run up the bill or flood a mailbox.
 * shortcut: counts are kept in this server process's memory; move them to MongoDB (as
 * account-rate-limit.js does) if the app runs on several servers.
 */
export function createUsageLimit({ maximum, windowMs, now = Date.now }) {
  const recent = new Map();
  return (req, res, next) => {
    const key = res.locals.user?.id ?? req.ip;
    const since = now() - windowMs;
    const times = (recent.get(key) ?? []).filter((time) => time > since);
    if (times.length >= maximum) {
      res.set('Retry-After', String(Math.ceil((times[0] + windowMs - now()) / 1000)));
      res.status(429).json({ error: 'Too many requests in a short time. Try again in a few minutes.' });
      return;
    }
    times.push(now());
    if (recent.size > 5000) recent.clear();
    recent.set(key, times);
    next();
  };
}
