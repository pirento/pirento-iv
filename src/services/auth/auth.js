import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { createAccountRateLimiter } from './account-rate-limit.js';
import { createAuthSecurity } from './security.js';
const COOKIE = 'venturecore_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RESET_MS = 30 * 60 * 1000;
const GENERIC_SIGNUP =
  'Your request has been received. New accounts require administrator approval before signing in.';
const GENERIC_RESET =
  'If an active account exists for this email and email delivery is configured, a password reset link will be sent.';
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, 'Use at least 12 characters for your password.').max(256);
const signup = z
  .object({
    name: z.string().trim().min(2).max(120),
    email,
    password,
    company: z.string().trim().max(180).default(''),
  })
  .strict();
const login = z
  .object({
    email,
    password: z.string().min(1).max(256),
  })
  .strict();
const access = z
  .object({
    role: z.enum(['admin', 'staff']),
    status: z.enum(['pending', 'active', 'disabled']),
    organizationIds: z.array(z.string().min(1).max(120)).max(1000),
  })
  .strict();
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
function derive(password, salt) {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      {
        N: 32768,
        r: 8,
        p: 3,
        maxmem: 64 * 1024 * 1024,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt-v1:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [version, salt, digest] = stored.split(':');
  if (version !== 'scrypt-v1' || !/^[0-9a-f]{32}$/.test(salt ?? '') || !/^[0-9a-f]{128}$/.test(digest ?? ''))
    return false;
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'hex')), Buffer.from(digest, 'hex'));
}
function safeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    role: row.role,
    status: row.status,
    organizationIds: row.organization_ids,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}
export function createAuth(db, options = {}) {
  const environment = options.environment ?? process.env;
  const production = options.production ?? environment.NODE_ENV === 'production';
  const now = options.now ?? Date.now;
  const originInput = options.publicOrigin ?? environment.PUBLIC_APP_URL;
  const publicOrigin = originInput ? new URL(originInput).origin : undefined;
  if (production && (!publicOrigin || !publicOrigin.startsWith('https://')))
    throw new Error('Production account access requires an HTTPS PUBLIC_APP_URL.');
  const router = express.Router();
  const cookieOptions = {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS,
  };
  const audit = async (action, userId, actorId, details = {}) =>
    await db.models.auth.audit(randomUUID(), actorId, action, userId, details, new Date(now()).toISOString());
  const security = createAuthSecurity({ db, now, audit, logger: options.logger });
  const accountRateLimit = createAccountRateLimiter({ db, observe: security.observe });
  const userById = async (id) => await db.models.auth.userById(id);
  const userByEmail = async (address) => await db.models.auth.userByEmail(address);
  function sessionToken(req) {
    const values = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`));
    if (values.length !== 1) return undefined;
    const token = values[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }
  async function getSessionUser(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const row = await db.models.auth.sessionUser(tokenHash(token), now(), 'active');
    return row ? safeUser(row) : null;
  }
  const requireSession = async (req, res, next) => {
    const user = await getSessionUser(req);
    res.set('Cache-Control', 'no-store');
    if (!user) {
      res.status(401).json({
        error: 'Please sign in to continue.',
      });
      return;
    }
    res.locals.user = user;
    next();
  };
  const requireAdmin = (_req, res, next) => {
    if (res.locals.user?.role !== 'admin') {
      res.status(403).json({
        error: 'Administrator access is required.',
      });
      return;
    }
    next();
  };
  const rateLimit = (scope) => accountRateLimit.middleware(scope);
  const mutationGuard = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    if (req.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      res.status(415).json({
        error: 'Use application/json for account changes.',
      });
      return;
    }
    const origin = req.get('Origin');
    const expected = publicOrigin ?? `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== expected) || req.get('Sec-Fetch-Site') === 'cross-site') {
      res.status(403).json({
        error: 'Account changes must come from this website.',
      });
      return;
    }
    next();
  };
  router.use(mutationGuard);
  async function initializeOwner() {
    const configuredEmail = environment.INITIAL_ADMIN_EMAIL;
    const configuredPassword = environment.INITIAL_ADMIN_PASSWORD;
    if (!configuredEmail && !configuredPassword) return null;
    if (!configuredEmail || !configuredPassword)
      throw new Error(
        'Set both INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD to provision the first owner.',
      );
    const address = email.parse(configuredEmail);
    password.parse(configuredPassword);
    const existing = await userByEmail(address);
    if (existing) {
      if (existing.role !== 'admin' || existing.status !== 'active')
        throw new Error(
          'INITIAL_ADMIN_EMAIL belongs to an existing non-administrator account; choose an unused owner email.',
        );
      return safeUser(existing);
    }
    const hash = await hashPassword(configuredPassword);
    const timestamp = new Date(now()).toISOString();
    const id = randomUUID();
    return db.transaction(async () => {
      const inserted = await db.models.auth.insertUser(
        id,
        environment.INITIAL_ADMIN_NAME?.trim().slice(0, 120) || 'Workspace administrator',
        address,
        '',
        hash,
        'admin',
        'active',
        '[]',
        timestamp,
        timestamp,
      );
      const initialized = await userByEmail(address);
      if (initialized.role !== 'admin' || initialized.status !== 'active')
        throw new Error(
          'INITIAL_ADMIN_EMAIL belongs to an existing non-administrator account; choose an unused owner email.',
        );
      if (inserted.changes) await audit('owner-provisioned', initialized.id, null);
      return safeUser(initialized);
    });
  }

  router.get('/me', async (req, res) =>
    res.json({
      user: await getSessionUser(req),
      signupEnabled: true,
      passwordResetEnabled: Boolean(options.sendPasswordReset),
    }),
  );
  router.post('/signup', rateLimit('signup'), async (req, res) => {
    const input = signup.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: input.error.issues[0].message,
      });
      return;
    }
    const hash = await hashPassword(input.data.password);
    await db.transaction(async () => {
      if (await userByEmail(input.data.email)) return;
      const timestamp = new Date(now()).toISOString();
      const id = randomUUID();
      const inserted = await db.models.auth.insertUser(
        id,
        input.data.name,
        input.data.email,
        input.data.company,
        hash,
        'staff',
        'pending',
        [],
        timestamp,
        timestamp,
      );
      if (inserted.changes) await audit('signup-requested', id, null);
    });
    res.status(202).json({
      message: GENERIC_SIGNUP,
    });
  });
  router.post('/login', rateLimit('login'), async (req, res) => {
    const input = login.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: 'Enter a valid email and password.',
      });
      return;
    }
    const row = await userByEmail(input.data.email);
    const matches = row
      ? await verifyPassword(input.data.password, row.password_hash)
      : (await derive(input.data.password, Buffer.alloc(16)), false);
    const token = randomBytes(32).toString('hex');
    // A known password mismatch cannot create a session and must not acquire the
    // exclusive workspace transaction used for successful account changes.
    const authenticated = !matches
      ? null
      : await db.transaction(async () => {
          // Password hashing happens outside the transaction. Recheck current access
          // while holding the write snapshot before creating a session.
          const latest = row && (await userById(row.id));
          if (
            !matches ||
            !latest ||
            latest.status !== 'active' ||
            latest.password_hash !== row?.password_hash
          )
            return null;
          const oldToken = sessionToken(req);
          if (oldToken) await db.models.auth.deleteSession(tokenHash(oldToken));
          await db.models.auth.deleteExpiredSessions(now());
          await security.insertSession(tokenHash(token), row.id, now() + SESSION_MS, now());
          await db.models.auth.setLastLogin(new Date(now()).toISOString(), row.id);
          await audit('login', row.id, row.id);
          return safeUser(await userById(row.id));
        });
    if (!authenticated) {
      await accountRateLimit.recordLoginFailure(req.accountAttempt, row?.id ?? null);
      res.status(401).json({
        error:
          'Sign-in unsuccessful. Check your credentials and ask an administrator if your account is awaiting approval.',
      });
      return;
    }
    res.cookie(COOKIE, token, cookieOptions);
    res.json({ user: authenticated });
  });
  router.post('/logout', async (req, res) => {
    const token = sessionToken(req);
    if (token) await db.models.auth.deleteSession(tokenHash(token));
    res.clearCookie(COOKIE, {
      ...cookieOptions,
      maxAge: undefined,
    });
    res.json({
      message: 'Signed out.',
    });
  });
  router.post('/forgot-password', rateLimit('forgot'), async (req, res) => {
    const input = z
      .object({
        email,
      })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: 'Enter a valid email.',
      });
      return;
    }
    const user = await userByEmail(input.data.email);
    if (user?.status === 'active' && options.sendPasswordReset) {
      const token = randomBytes(32).toString('hex');
      const created = await db.transaction(async () => {
        if ((await userById(user.id))?.status !== 'active') return false;
        await db.models.auth.deleteExpiredResets(now());
        await db.models.auth.insertReset(tokenHash(token), user.id, now() + RESET_MS, now());
        return true;
      });
      if (!created) {
        res.status(202).json({ message: GENERIC_RESET });
        return;
      }
      try {
        await options.sendPasswordReset({
          to: user.email,
          name: user.name,
          token,
        });
        await audit('password-reset-requested', user.id, null);
      } catch {
        await db.models.auth.deleteReset(tokenHash(token));
        await audit('password-reset-delivery-failed', user.id, null);
      }
    }
    res.status(202).json({
      message: GENERIC_RESET,
    });
  });
  router.post('/reset-password', rateLimit('reset'), async (req, res) => {
    const input = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/),
        password,
      })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: 'Use a valid reset link and a password with at least 12 characters.',
      });
      return;
    }
    const digest = tokenHash(input.data.token);
    const current = await db.models.auth.findValidReset(digest, now());
    if (!current || (await userById(current.user_id))?.status !== 'active') {
      res.status(400).json({
        error: 'This reset link has expired or has already been used.',
      });
      return;
    }
    const hash = await hashPassword(input.data.password);
    if (
      !(await db.transaction(async () => {
        const consumed = await db.models.auth.consumeReset(digest, now(), 'active');
        if (!consumed.changes) {
          res.status(400).json({
            error: 'This reset link has expired or has already been used.',
          });
          return false;
        }
        await db.models.auth.updatePassword(hash, new Date(now()).toISOString(), current.user_id);
        await db.models.auth.deleteUserResets(current.user_id);
        await db.models.auth.deleteUserSessions(current.user_id);
        await audit('password-reset-completed', current.user_id, current.user_id);
        return true;
      }))
    )
      return;
    res.clearCookie(COOKIE, {
      ...cookieOptions,
      maxAge: undefined,
    });
    res.json({
      message: 'Password updated. Please sign in with your new password.',
    });
  });
  router.get('/users', requireSession, requireAdmin, async (_req, res) => {
    const rows = await db.models.auth.listUsers();
    res.json(rows.map(safeUser));
  });
  router.patch('/users/:id', requireSession, requireAdmin, async (req, res) => {
    const input = access.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({
        error: 'Choose a valid role, status and organization list.',
      });
      return;
    }
    const target = await userById(String(req.params.id));
    if (!target) {
      res.status(404).json({
        error: 'Account not found.',
      });
      return;
    }
    const actor = res.locals.user;
    if (target.id === actor.id && (input.data.role !== 'admin' || input.data.status !== 'active')) {
      res.status(409).json({
        error: 'You cannot disable or demote your own administrator account.',
      });
      return;
    }
    const organizationIds = [...new Set(input.data.organizationIds)];
    if (input.data.status === 'active' && input.data.role === 'staff' && organizationIds.length === 0) {
      res.status(400).json({
        error: 'Assign at least one organization to an active staff account.',
      });
      return;
    }
    for (const id of organizationIds) {
      if (!(await db.models.organizations.findById(id))) {
        res.status(400).json({
          error: 'One or more organizations no longer exist.',
        });
        return;
      }
    }
    if (
      !(await db.transaction(async () => {
        const currentActor = await userById(actor.id);
        const currentTarget = await userById(target.id);
        if (currentActor?.status !== 'active' || currentActor.role !== 'admin') {
          res.status(403).json({
            error: 'Administrator access is required.',
          });
          return false;
        }
        const admins = await db.models.auth.countUsers('admin', 'active');
        if (
          currentTarget.role === 'admin' &&
          currentTarget.status === 'active' &&
          (input.data.role !== 'admin' || input.data.status !== 'active') &&
          admins.count <= 1
        ) {
          res.status(409).json({
            error: 'Keep at least one active administrator.',
          });
          return false;
        }
        await db.models.auth.updateAccess(
          input.data.role,
          input.data.status,
          organizationIds,
          new Date(now()).toISOString(),
          target.id,
        );
        if (
          currentTarget.status !== input.data.status ||
          currentTarget.role !== input.data.role ||
          JSON.stringify(currentTarget.organization_ids) !== JSON.stringify(organizationIds)
        ) {
          await db.models.auth.deleteUserSessions(target.id);
          await db.models.auth.deleteUserResets(target.id);
        }
        await audit('access-updated', target.id, actor.id, {
          before: {
            role: currentTarget.role,
            status: currentTarget.status,
            organizationIds: currentTarget.organization_ids,
          },
          after: {
            ...input.data,
            organizationIds,
          },
        });
        return true;
      }))
    )
      return;
    res.json(safeUser(await userById(target.id)));
  });

  const currentTokenHash = (req) => {
    const token = sessionToken(req);
    return token ? tokenHash(token) : undefined;
  };
  const noActionFields = (req, res, next) => {
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      return res.status(400).json({ error: 'This action does not accept additional fields.' });
    next();
  };
  const sessionResult = (res, result) => {
    if (result.signedOut) res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json(result);
  };
  router.get('/sessions', requireSession, async (req, res) => {
    res.json(await security.listSessions(res.locals.user, currentTokenHash(req), req.query));
  });
  router.post('/sessions/revoke-others', requireSession, noActionFields, async (req, res) => {
    sessionResult(res, await security.revokeOthers(res.locals.user, currentTokenHash(req)));
  });
  router.post('/sessions/:id/revoke', requireSession, noActionFields, async (req, res) => {
    sessionResult(res, await security.revokeOne(res.locals.user, currentTokenHash(req), req.params.id));
  });
  router.post(
    '/users/:id/revoke-sessions',
    requireSession,
    requireAdmin,
    noActionFields,
    async (req, res) => {
      sessionResult(
        res,
        await security.revokeUserSessions(res.locals.user, currentTokenHash(req), req.params.id),
      );
    },
  );
  router.get('/audit', requireSession, requireAdmin, async (req, res) => {
    res.json(await security.listAudit(res.locals.user, req.query));
  });
  return {
    router,
    requireSession,
    requireAdmin,
    getSessionUser,
    initializeOwner,
    mutationGuard,
    listUsers: async () => (await db.models.auth.listUsers()).map(safeUser),
    sessionPage: async (req) =>
      security.listSessions(await getSessionUser(req), currentTokenHash(req), req.query),
    listAudit: (user, query) => security.listAudit(user, query),
  };
}
