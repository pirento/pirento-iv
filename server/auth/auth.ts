import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import express, { type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthUser, AuthSessionResponse } from '../../shared/auth-types.ts';

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
const login = z.object({ email, password: z.string().min(1).max(256) }).strict();
const access = z
  .object({
    role: z.enum(['admin', 'staff']),
    status: z.enum(['pending', 'active', 'disabled']),
    organizationIds: z.array(z.string().min(1).max(120)).max(1000),
  })
  .strict();
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

function derive(password: string, salt: Buffer): Promise<Buffer> {
  // 32 MiB per hash with three passes; async crypto keeps requests off the event loop.
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt-v1:${salt.toString('hex')}:${(await derive(password, salt)).toString('hex')}`;
}

async function verifyPassword(password: string, stored: string) {
  const [version, salt, digest] = stored.split(':');
  if (version !== 'scrypt-v1' || !/^[0-9a-f]{32}$/.test(salt ?? '') || !/^[0-9a-f]{128}$/.test(digest ?? ''))
    return false;
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'hex')), Buffer.from(digest, 'hex'));
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  company: string;
  role: AuthUser['role'];
  status: AuthUser['status'];
  organization_ids: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  password_hash: string;
}

function safeUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    role: row.role,
    status: row.status,
    organizationIds: JSON.parse(row.organization_ids) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

export interface AuthOptions {
  publicOrigin?: string;
  production?: boolean;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  sendPasswordReset?: (message: { to: string; name: string; token: string }) => Promise<void>;
}

/** Account authentication lives in the same persistent database as business data. */
export function createAuth(db: DatabaseSync, options: AuthOptions = {}) {
  const environment = options.environment ?? process.env;
  const production = options.production ?? environment.NODE_ENV === 'production';
  const now = options.now ?? Date.now;
  const originInput = options.publicOrigin ?? environment.PUBLIC_APP_URL;
  const publicOrigin = originInput ? new URL(originInput).origin : undefined;
  if (production && (!publicOrigin || !publicOrigin.startsWith('https://')))
    throw new Error('Production account access requires an HTTPS PUBLIC_APP_URL.');
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      company TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','staff')),
      status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),
      organization_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_password_resets (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_password_resets_user ON auth_password_resets(user_id);
    CREATE TABLE IF NOT EXISTS auth_audit (
      id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
      user_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);

  const router = express.Router();
  const cookieOptions = {
    httpOnly: true,
    secure: production,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MS,
  };
  const audit = (action: string, userId: string | null, actorId: string | null, details: unknown = {}) =>
    db
      .prepare('INSERT INTO auth_audit VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), actorId, action, userId, JSON.stringify(details), new Date(now()).toISOString());
  const userById = (id: string) =>
    db.prepare('SELECT * FROM auth_users WHERE id = ?').get(id) as unknown as UserRow | undefined;
  const userByEmail = (address: string) =>
    db.prepare('SELECT * FROM auth_users WHERE email = ? COLLATE NOCASE').get(address) as unknown as
      UserRow | undefined;
  function sessionToken(req: Request) {
    const values = (req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`));
    if (values.length !== 1) return undefined;
    const token = values[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  }
  function getSessionUser(req: Request): AuthUser | null {
    const token = sessionToken(req);
    if (!token) return null;
    const row = db
      .prepare(
        'SELECT u.* FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = ?',
      )
      .get(tokenHash(token), now(), 'active') as unknown as UserRow | undefined;
    return row ? safeUser(row) : null;
  }
  const requireSession: RequestHandler = (req, res, next) => {
    const user = getSessionUser(req);
    res.set('Cache-Control', 'no-store');
    if (!user) {
      res.status(401).json({ error: 'Please sign in to continue.' });
      return;
    }
    res.locals.user = user;
    next();
  };
  const requireAdmin: RequestHandler = (_req, res, next) => {
    if ((res.locals.user as AuthUser | undefined)?.role !== 'admin') {
      res.status(403).json({ error: 'Administrator access is required.' });
      return;
    }
    next();
  };

  // The socket address is intentionally used: callers cannot bypass limits with a forged proxy header.
  const attempts = new Map<string, { count: number; until: number }>();
  const rateLimit =
    (scope: string, maximum: number, windowMs: number): RequestHandler =>
    (req, res, next) => {
      const time = now();
      for (const [key, attempt] of attempts) if (attempt.until <= time) attempts.delete(key);
      const key = `${scope}:${req.socket.remoteAddress ?? 'unknown'}`;
      const attempt = attempts.get(key);
      if (attempt && attempt.count >= maximum) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.until - time) / 1000))));
        res.status(429).json({ error: 'Too many account requests. Please wait and try again.' });
        return;
      }
      if (!attempt && attempts.size >= 4096) {
        res.status(429).json({ error: 'Account service is busy. Please try again shortly.' });
        return;
      }
      attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: attempt?.until ?? time + windowMs });
      next();
    };
  const mutationGuard: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    // req.is() returns null for bodyless DELETE/logout requests even when their
    // JSON header is present. The header itself is what forces CORS preflight.
    if (req.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      res.status(415).json({ error: 'Use application/json for account changes.' });
      return;
    }
    const origin = req.get('Origin');
    const expected = publicOrigin ?? `${req.protocol}://${req.get('host')}`;
    if ((origin && origin !== expected) || req.get('Sec-Fetch-Site') === 'cross-site') {
      res.status(403).json({ error: 'Account changes must come from this website.' });
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
    const existing = userByEmail(address);
    if (existing) {
      if (existing.role !== 'admin' || existing.status !== 'active')
        throw new Error(
          'INITIAL_ADMIN_EMAIL belongs to an existing non-administrator account; choose an unused owner email.',
        );
      return safeUser(existing);
    }
    // Hash outside the transaction; provisioning may run only during server startup.
    const hash = await hashPassword(configuredPassword);
    const timestamp = new Date(now()).toISOString();
    const id = randomUUID();
    const inserted = db
      .prepare(
        'INSERT OR IGNORE INTO auth_users (id,name,email,company,password_hash,role,status,organization_ids,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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
    // Another server can finish initialization while scrypt is running. Never
    // promote a competing pending signup or replace an existing password.
    const initialized = userByEmail(address)!;
    if (initialized.role !== 'admin' || initialized.status !== 'active')
      throw new Error(
        'INITIAL_ADMIN_EMAIL belongs to an existing non-administrator account; choose an unused owner email.',
      );
    if (inserted.changes) audit('owner-provisioned', initialized.id, null);
    return safeUser(initialized);
  }

  router.get('/me', (req, res) =>
    res.json({
      user: getSessionUser(req),
      signupEnabled: true,
      passwordResetEnabled: Boolean(options.sendPasswordReset),
    } satisfies AuthSessionResponse),
  );
  router.post('/signup', rateLimit('signup', 10, 60 * 60 * 1000), async (req, res) => {
    const input = signup.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: input.error.issues[0].message });
      return;
    }
    // Perform the expensive work for duplicate emails too, avoiding a useful timing distinction.
    const hash = await hashPassword(input.data.password);
    if (!userByEmail(input.data.email)) {
      const timestamp = new Date(now()).toISOString();
      const id = randomUUID();
      db.prepare(
        'INSERT OR IGNORE INTO auth_users (id,name,email,company,password_hash,role,status,organization_ids,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        input.data.name,
        input.data.email,
        input.data.company,
        hash,
        'staff',
        'pending',
        '[]',
        timestamp,
        timestamp,
      );
      audit('signup-requested', id, null);
    }
    res.status(202).json({ message: GENERIC_SIGNUP });
  });
  router.post('/login', rateLimit('login', 20, 15 * 60 * 1000), async (req, res) => {
    const input = login.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Enter a valid email and password.' });
      return;
    }
    const row = userByEmail(input.data.email);
    // Fixed dummy salt performs the same scrypt cost when no account exists.
    const matches = row
      ? await verifyPassword(input.data.password, row.password_hash)
      : (await derive(input.data.password, Buffer.alloc(16)), false);
    // Re-read after awaiting the hash so a concurrent access/password change wins.
    const latest = row && userById(row.id);
    if (!matches || !latest || latest.status !== 'active' || latest.password_hash !== row?.password_hash) {
      res.status(401).json({
        error:
          'Sign-in unsuccessful. Check your credentials and ask an administrator if your account is awaiting approval.',
      });
      return;
    }
    const oldToken = sessionToken(req);
    if (oldToken) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(oldToken));
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now());
    db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?)').run(
      tokenHash(token),
      row!.id,
      now() + SESSION_MS,
      now(),
    );
    db.prepare('UPDATE auth_users SET last_login_at = ? WHERE id = ?').run(
      new Date(now()).toISOString(),
      row!.id,
    );
    audit('login', row!.id, row!.id);
    res.cookie(COOKIE, token, cookieOptions);
    res.json({ user: safeUser(userById(row!.id)!) });
  });
  router.post('/logout', (req, res) => {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ message: 'Signed out.' });
  });
  router.post('/forgot-password', rateLimit('forgot', 8, 60 * 60 * 1000), async (req, res) => {
    const input = z.object({ email }).strict().safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Enter a valid email.' });
      return;
    }
    const user = userByEmail(input.data.email);
    if (user?.status === 'active' && options.sendPasswordReset) {
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM auth_password_resets WHERE expires_at <= ?').run(now());
      db.prepare('INSERT INTO auth_password_resets VALUES (?, ?, ?, ?)').run(
        tokenHash(token),
        user.id,
        now() + RESET_MS,
        now(),
      );
      try {
        await options.sendPasswordReset({ to: user.email, name: user.name, token });
        audit('password-reset-requested', user.id, null);
      } catch {
        // Never expose delivery/provider errors, credentials, or reset tokens in an HTTP response.
        db.prepare('DELETE FROM auth_password_resets WHERE token_hash = ?').run(tokenHash(token));
        audit('password-reset-delivery-failed', user.id, null);
      }
    }
    res.status(202).json({ message: GENERIC_RESET });
  });
  router.post('/reset-password', rateLimit('reset', 15, 60 * 60 * 1000), async (req, res) => {
    const input = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Use a valid reset link and a password with at least 12 characters.' });
      return;
    }
    const digest = tokenHash(input.data.token);
    const current = db
      .prepare('SELECT user_id FROM auth_password_resets WHERE token_hash = ? AND expires_at > ?')
      .get(digest, now()) as { user_id: string } | undefined;
    if (!current || userById(current.user_id)?.status !== 'active') {
      res.status(400).json({ error: 'This reset link has expired or has already been used.' });
      return;
    }
    const hash = await hashPassword(input.data.password);
    db.exec('BEGIN IMMEDIATE');
    try {
      const consumed = db
        .prepare(
          'DELETE FROM auth_password_resets WHERE token_hash = ? AND expires_at > ? AND user_id IN (SELECT id FROM auth_users WHERE status = ?)',
        )
        .run(digest, now(), 'active');
      if (!consumed.changes) {
        db.exec('ROLLBACK');
        res.status(400).json({ error: 'This reset link has expired or has already been used.' });
        return;
      }
      db.prepare('UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        hash,
        new Date(now()).toISOString(),
        current.user_id,
      );
      db.prepare('DELETE FROM auth_password_resets WHERE user_id = ?').run(current.user_id);
      db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(current.user_id);
      audit('password-reset-completed', current.user_id, current.user_id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
    res.json({ message: 'Password updated. Please sign in with your new password.' });
  });
  router.get('/users', requireSession, requireAdmin, (_req, res) => {
    const rows = db
      .prepare('SELECT * FROM auth_users ORDER BY created_at DESC, id')
      .all() as unknown as UserRow[];
    res.json(rows.map(safeUser));
  });
  router.patch('/users/:id', requireSession, requireAdmin, (req, res) => {
    const input = access.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Choose a valid role, status and organization list.' });
      return;
    }
    const target = userById(String(req.params.id));
    if (!target) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }
    const actor = res.locals.user as AuthUser;
    if (target.id === actor.id && (input.data.role !== 'admin' || input.data.status !== 'active')) {
      res.status(409).json({ error: 'You cannot disable or demote your own administrator account.' });
      return;
    }
    const organizationIds = [...new Set(input.data.organizationIds)];
    if (input.data.status === 'active' && input.data.role === 'staff' && organizationIds.length === 0) {
      res.status(400).json({ error: 'Assign at least one organization to an active staff account.' });
      return;
    }
    for (const id of organizationIds) {
      if (!db.prepare('SELECT id FROM organizations WHERE id = ?').get(id)) {
        res.status(400).json({ error: 'One or more organizations no longer exist.' });
        return;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-check under the write lock: another server may have changed either
      // account since the middleware read its session or the target was loaded.
      const currentActor = userById(actor.id);
      const currentTarget = userById(target.id)!;
      if (currentActor?.status !== 'active' || currentActor.role !== 'admin') {
        db.exec('ROLLBACK');
        res.status(403).json({ error: 'Administrator access is required.' });
        return;
      }
      const admins = db
        .prepare('SELECT COUNT(*) AS count FROM auth_users WHERE role = ? AND status = ?')
        .get('admin', 'active') as { count: number };
      if (
        currentTarget.role === 'admin' &&
        currentTarget.status === 'active' &&
        (input.data.role !== 'admin' || input.data.status !== 'active') &&
        admins.count <= 1
      ) {
        db.exec('ROLLBACK');
        res.status(409).json({ error: 'Keep at least one active administrator.' });
        return;
      }
      db.prepare(
        'UPDATE auth_users SET role = ?, status = ?, organization_ids = ?, updated_at = ? WHERE id = ?',
      ).run(
        input.data.role,
        input.data.status,
        JSON.stringify(organizationIds),
        new Date(now()).toISOString(),
        target.id,
      );
      if (
        currentTarget.status !== input.data.status ||
        currentTarget.role !== input.data.role ||
        currentTarget.organization_ids !== JSON.stringify(organizationIds)
      ) {
        // Approval requires a fresh login; narrowing access immediately revokes outstanding sessions too.
        db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(target.id);
        db.prepare('DELETE FROM auth_password_resets WHERE user_id = ?').run(target.id);
      }
      audit('access-updated', target.id, actor.id, {
        before: {
          role: currentTarget.role,
          status: currentTarget.status,
          organizationIds: JSON.parse(currentTarget.organization_ids),
        },
        after: { ...input.data, organizationIds },
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json(safeUser(userById(target.id)!));
  });

  return { router, requireSession, requireAdmin, getSessionUser, initializeOwner, mutationGuard };
}
