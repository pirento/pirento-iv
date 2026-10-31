/**
 * Accounts and sign-in: the /api/auth routes plus the session middleware used by every API call.
 *
 * - Passwords are stored as scrypt hashes; sessions are random tokens in an HttpOnly cookie
 *   (only a SHA-256 hash of the token is stored in the database). Sessions last 12 hours.
 * - New signups wait for administrator approval; the first administrator comes from
 *   INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (initializeOwner).
 * - Login/signup/reset requests are rate limited (account-rate-limit.js) and every account
 *   change is written to the security activity log (security.js).
 */

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { createAccountRateLimiter } from './account-rate-limit.js';
import { SESSION_IDLE_MS, createAuthSecurity, deviceLabel } from './security.js';
import {
  createTwoStepVault,
  newTwoStepSecret,
  qrSvg,
  twoStepSetupUrl,
  verifyTwoStepCode,
} from './two-step.js';
// Session cookie name, session length (12 h, ending sooner after 60 min idle) and password-reset link lifetime (30 min).
const COOKIE = 'venturecore_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const RESET_MS = 30 * 60 * 1000;
// The same message is shown whether or not the email exists, so accounts cannot be discovered.
const GENERIC_SIGNUP =
  'Your request has been received. New accounts require administrator approval before signing in.';
const GENERIC_RESET =
  'If an active account exists for this email and email delivery is configured, a password reset link will be sent.';
// Request body schemas for /api/auth endpoints.
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
    code: z.string().max(10).optional(),
  })
  .strict();
// Error code the login page uses to show the authenticator-code field.
const TWO_STEP_REQUIRED = 'TWO_STEP_REQUIRED';
const TWO_STEP_ISSUER = 'Venturecore Workspace';
const twoStepInput = z
  .object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.') })
  .strict();
// Staff permission levels (administrators always have full access); a missing value means 'full'.
// 'accounts' is view-only too, and also opens Group finance for the businesses assigned.
// 'owner' (Business owner) has full access to its assigned business and also manages its settings,
// letterhead and Payments & email; it never sees other businesses or the admin pages.
export const STAFF_PERMISSIONS = ['full', 'no-delete', 'view', 'accounts', 'owner'];
const access = z
  .object({
    role: z.enum(['admin', 'staff']),
    status: z.enum(['pending', 'active', 'disabled']),
    organizationIds: z.array(z.string().min(1).max(120)).max(1000),
    permission: z.enum(STAFF_PERMISSIONS).optional(),
  })
  .strict();
// A login an administrator creates directly (active at once; the administrator shares the password).
const newAccount = z
  .object({
    name: z.string().trim().min(2).max(120),
    email,
    password,
    role: z.enum(['admin', 'staff']),
    organizationIds: z.array(z.string().min(1).max(120)).max(1000),
    permission: z.enum(STAFF_PERMISSIONS).default('full'),
  })
  .strict();
const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
// scrypt key derivation (memory-hard, so stolen hashes are slow to crack).
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
// The account fields that may be sent to the browser (never the password hash).
function safeUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    role: row.role,
    status: row.status,
    organizationIds: row.organization_ids,
    permission: row.permission ?? 'full',
    twoStepEnabled: Boolean(row.totp_secret),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}
/**
 * Creates the auth service. Returns { router (mounted at /api/auth), requireSession,
 * requireAdmin, requireTwoStepSetup, twoStepSetupRequired, getSessionUser, initializeOwner, mutationGuard,
 * listUsers, sessionPage, listAudit }.
 */
export function createAuth(db, options = {}) {
  const environment = options.environment ?? process.env;
  const production = options.production ?? environment.NODE_ENV === 'production';
  const now = options.now ?? Date.now;
  const originInput = options.publicOrigin ?? environment.PUBLIC_APP_URL;
  const publicOrigin = originInput ? new URL(originInput).origin : undefined;
  if (production && (!publicOrigin || !publicOrigin.startsWith('https://')))
    throw new Error('Production account access requires an HTTPS PUBLIC_APP_URL.');
  const vault = createTwoStepVault(environment, production);
  // Administrators must use two-step login in production unless ADMIN_TWO_STEP=optional.
  const adminTwoStep = environment.ADMIN_TWO_STEP?.trim() || (production ? 'required' : 'optional');
  if (!['required', 'optional'].includes(adminTwoStep))
    throw new Error('ADMIN_TWO_STEP must be required or optional.');
  const twoStepSetupRequired = (user) =>
    adminTwoStep === 'required' && user?.role === 'admin' && !user.twoStepEnabled;
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
  // --- Sessions ---
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
    const time = now();
    const row = await db.models.auth.sessionUser(tokenHash(token), time, 'active', time - SESSION_IDLE_MS);
    return row ? safeUser(row) : null;
  }
  // Middleware: 401 unless a valid session cookie is present; puts the user in res.locals.user.
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
  // Middleware for /api business routes: an administrator who must use two-step login sets it up first.
  const requireTwoStepSetup = (_req, res, next) => {
    if (!twoStepSetupRequired(res.locals.user)) return next();
    res.status(403).json({
      error: 'Administrators must turn on two-step login on My sessions before using the workspace.',
      code: 'TWO_STEP_SETUP_REQUIRED',
    });
  };
  // Middleware: 403 unless the signed-in user is an administrator.
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
  // Cross-site request protection: changes must be JSON and come from this website's own origin.
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
  // Creates the first administrator from INITIAL_ADMIN_* settings. If that email already belongs to an
  // active administrator nothing changes (the password is never reset); any other existing account is an error.
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

  // --- Routes: /api/auth/... ---
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
    if (matches && row.status === 'active' && row.totp_secret && !input.data.code) {
      res.status(401).json({
        error: 'Enter the 6-digit code from your authenticator app.',
        code: TWO_STEP_REQUIRED,
      });
      return;
    }
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
          if (latest.totp_secret) {
            const secret = vault.open(latest.totp_secret);
            const step = secret
              ? verifyTwoStepCode(secret, input.data.code, now(), latest.totp_last_step ?? -1)
              : null;
            if (step === null || !(await db.models.auth.useTwoStepCode(step, latest.id)).changes)
              return { codeRejected: true };
          }
          const oldToken = sessionToken(req);
          if (oldToken) await db.models.auth.deleteSession(tokenHash(oldToken));
          await db.models.auth.deleteExpiredSessions(now());
          await security.insertSession(
            tokenHash(token),
            row.id,
            now() + SESSION_MS,
            now(),
            deviceLabel(req.get('user-agent')),
          );
          await db.models.auth.setLastLogin(new Date(now()).toISOString(), row.id);
          await audit('login', row.id, row.id);
          return safeUser(await userById(row.id));
        });
    if (authenticated?.codeRejected) {
      await accountRateLimit.recordLoginFailure(req.accountAttempt, row.id);
      res.status(401).json({
        error: 'That code is not valid. Enter the newest code from your authenticator app.',
        code: TWO_STEP_REQUIRED,
      });
      return;
    }
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
  // Password reset: emails a one-time link (only when email sending is configured).
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
  // --- Team access (administrators): list accounts, approve/disable, assign businesses ---
  router.get('/users', requireSession, requireAdmin, async (_req, res) => {
    const rows = await db.models.auth.listUsers();
    res.json(rows.map(safeUser));
  });
  router.post('/users', requireSession, requireAdmin, async (req, res) => {
    const input = newAccount.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: input.error.issues[0].message });
    const { name, role, password: initialPassword } = input.data;
    const address = input.data.email;
    const organizationIds = [...new Set(input.data.organizationIds)];
    if (role === 'staff' && organizationIds.length === 0)
      return res.status(400).json({ error: 'Assign at least one organization to a staff login.' });
    for (const id of organizationIds)
      if (!(await db.models.organizations.findById(id)))
        return res.status(400).json({ error: 'One or more organizations no longer exist.' });
    const hash = await hashPassword(initialPassword);
    const id = randomUUID();
    const permission = role === 'admin' ? 'full' : input.data.permission;
    const created = await db.transaction(async () => {
      if (await userByEmail(address)) return false;
      const timestamp = new Date(now()).toISOString();
      await db.models.auth.insertUser(
        id,
        name,
        address,
        '',
        hash,
        role,
        'active',
        organizationIds,
        timestamp,
        timestamp,
      );
      await db.models.auth.updateAccess(role, 'active', organizationIds, permission, timestamp, id);
      await audit('account-created', id, res.locals.user.id, { role, organizationIds, permission });
      return true;
    });
    if (!created) return res.status(409).json({ error: 'A login with this email already exists.' });
    res.status(201).json(safeUser(await userById(id)));
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
        const currentPermission = currentTarget.permission ?? 'full';
        const permission = input.data.permission ?? currentPermission;
        await db.models.auth.updateAccess(
          input.data.role,
          input.data.status,
          organizationIds,
          permission,
          new Date(now()).toISOString(),
          target.id,
        );
        if (
          currentTarget.status !== input.data.status ||
          currentTarget.role !== input.data.role ||
          currentPermission !== permission ||
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
            permission: currentPermission,
          },
          after: {
            ...input.data,
            organizationIds,
            permission,
          },
        });
        return true;
      }))
    )
      return;
    res.json(safeUser(await userById(target.id)));
  });

  // --- My sessions and security activity ---
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

  // --- Passwords: change your own (current password required) or, as an administrator, set another person's ---
  router.post('/password', requireSession, rateLimit('login'), async (req, res) => {
    const input = z
      .object({ currentPassword: z.string().min(1).max(256), newPassword: password })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      const issue = input.error.issues.find((item) => item.path[0] === 'newPassword');
      res.status(400).json({ error: issue?.message ?? 'Enter your current password and a new password.' });
      return;
    }
    const user = res.locals.user;
    const row = await userById(user.id);
    if (!row || !(await verifyPassword(input.data.currentPassword, row.password_hash))) {
      res.status(400).json({ error: 'Your current password is incorrect.' });
      return;
    }
    if (await verifyPassword(input.data.newPassword, row.password_hash)) {
      res.status(400).json({ error: 'Choose a new password that is different from your current one.' });
      return;
    }
    const hash = await hashPassword(input.data.newPassword);
    const changed = await db.transaction(async () => {
      const latest = await userById(user.id);
      if (latest?.status !== 'active' || latest.password_hash !== row.password_hash) return false;
      await db.models.auth.updatePassword(hash, new Date(now()).toISOString(), user.id);
      await db.models.auth.deleteUserResets(user.id);
      await db.models.auth.deleteOtherSessions(user.id, currentTokenHash(req));
      await audit('password-changed', user.id, user.id);
      return true;
    });
    if (!changed) {
      res.status(409).json({ error: 'Your password was changed elsewhere. Sign in again, then retry.' });
      return;
    }
    res.json({ message: 'Password changed. Your other sessions were signed out.' });
  });
  router.post('/users/:id/password', requireSession, requireAdmin, async (req, res) => {
    const input = z.object({ password }).strict().safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: input.error.issues[0].message });
      return;
    }
    const actor = res.locals.user;
    const target = await userById(String(req.params.id));
    if (!target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    if (target.id === actor.id) {
      res.status(409).json({ error: 'Change your own password from My sessions.' });
      return;
    }
    const hash = await hashPassword(input.data.password);
    const saved = await db.transaction(async () => {
      const currentActor = await userById(actor.id);
      if (currentActor?.status !== 'active' || currentActor.role !== 'admin') return false;
      await db.models.auth.updatePassword(hash, new Date(now()).toISOString(), target.id);
      await db.models.auth.deleteUserResets(target.id);
      await db.models.auth.deleteUserSessions(target.id);
      await audit('password-set-by-admin', target.id, actor.id);
      return true;
    });
    if (!saved) {
      res.status(403).json({ error: 'Administrator access is required.' });
      return;
    }
    res.json({
      message:
        'New password saved and all of their sessions were signed out. Share it privately and ask them to change it after signing in.',
    });
  });

  // --- Two-step login: authenticator-app codes, turned on and off by the account owner ---
  const codeMismatch = 'That code did not match. Check the time on your phone and use the newest code.';
  router.post('/two-step/setup', requireSession, async (_req, res) => {
    const user = res.locals.user;
    if (user.twoStepEnabled) {
      res.status(409).json({ error: 'Two-step login is already on for your account.' });
      return;
    }
    const secret = newTwoStepSecret();
    await db.models.auth.setTwoStepPending(vault.seal(secret), new Date(now()).toISOString(), user.id);
    const url = twoStepSetupUrl(secret, user.email, TWO_STEP_ISSUER);
    res.json({ secret, url, qrSvg: qrSvg(url) });
  });
  router.post('/two-step/enable', requireSession, rateLimit('login'), async (req, res) => {
    const input = twoStepInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: input.error.issues[0].message });
      return;
    }
    const user = res.locals.user;
    const enabled = await db.transaction(async () => {
      const row = await userById(user.id);
      const pending = vault.open(row?.totp_pending);
      const step = pending ? verifyTwoStepCode(pending, input.data.code, now()) : null;
      if (step === null) return false;
      await db.models.auth.enableTwoStep(row.totp_pending, step, new Date(now()).toISOString(), user.id);
      await audit('two-step-enabled', user.id, user.id);
      return true;
    });
    if (!enabled) {
      res.status(400).json({ error: codeMismatch });
      return;
    }
    res.json({ message: 'Two-step login is on. You will be asked for a code each time you sign in.' });
  });
  router.post('/two-step/disable', requireSession, rateLimit('login'), async (req, res) => {
    const input = twoStepInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: input.error.issues[0].message });
      return;
    }
    const user = res.locals.user;
    const disabled = await db.transaction(async () => {
      const row = await userById(user.id);
      const secret = vault.open(row?.totp_secret);
      const step = secret
        ? verifyTwoStepCode(secret, input.data.code, now(), row.totp_last_step ?? -1)
        : null;
      if (step === null) return false;
      await db.models.auth.disableTwoStep(new Date(now()).toISOString(), user.id);
      await audit('two-step-disabled', user.id, user.id);
      return true;
    });
    if (!disabled) {
      res.status(400).json({ error: codeMismatch });
      return;
    }
    res.json({ message: 'Two-step login is off.' });
  });
  // Administrator recovery for a person who lost their phone.
  router.post(
    '/users/:id/two-step/remove',
    requireSession,
    requireAdmin,
    noActionFields,
    async (req, res) => {
      const actor = res.locals.user;
      const target = await userById(String(req.params.id));
      if (!target) {
        res.status(404).json({ error: 'Account not found.' });
        return;
      }
      if (target.id === actor.id) {
        res.status(409).json({ error: 'Turn off your own two-step login from My sessions.' });
        return;
      }
      const removed = await db.transaction(async () => {
        const currentActor = await userById(actor.id);
        if (currentActor?.status !== 'active' || currentActor.role !== 'admin') return false;
        await db.models.auth.disableTwoStep(new Date(now()).toISOString(), target.id);
        await audit('two-step-removed-by-admin', target.id, actor.id);
        return true;
      });
      if (!removed) {
        res.status(403).json({ error: 'Administrator access is required.' });
        return;
      }
      res.json({
        message: 'Two-step login removed. They can sign in with their password and set it up again.',
      });
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
    requireTwoStepSetup,
    twoStepSetupRequired,
    listUsers: async () => (await db.models.auth.listUsers()).map(safeUser),
    sessionPage: async (req) =>
      security.listSessions(await getSessionUser(req), currentTokenHash(req), req.query),
    listAudit: (user, query) => security.listAudit(user, query),
  };
}
