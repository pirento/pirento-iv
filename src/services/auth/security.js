/**
 * Account security features: "My sessions" (list / sign out sessions), administrator session
 * revocation for a staff account, and the paginated security activity log with filters.
 */

import { randomUUID } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { HttpError } from '../../middleware/errors.js';

// Activity types shown in the Security activity filter, with their display labels.
export const SECURITY_ACTIONS = Object.freeze([
  { value: 'login', label: 'Signed in' },
  { value: 'login-unsuccessful', label: 'Unsuccessful sign-in observed' },
  { value: 'account-throttled', label: 'Account request limit reached' },
  { value: 'session-revoked', label: 'Session signed out' },
  { value: 'other-sessions-revoked', label: 'Other sessions signed out' },
  { value: 'user-sessions-revoked', label: 'Account sessions revoked by administrator' },
  { value: 'signup-requested', label: 'Account approval requested' },
  { value: 'access-updated', label: 'Account access updated' },
  { value: 'password-reset-requested', label: 'Password reset requested' },
  { value: 'password-reset-delivery-failed', label: 'Password reset delivery failed' },
  { value: 'password-reset-completed', label: 'Password reset completed' },
  { value: 'owner-provisioned', label: 'Initial administrator provisioned' },
  { value: 'other', label: 'Other account activity' },
]);
const ACTION_NAMES = new Set(SECURITY_ACTIONS.map(({ value }) => value).filter((value) => value !== 'other'));
const PAGE_SIZE = 50;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SOURCE_SCOPES = new Set(['login', 'signup', 'forgot', 'reset']);

function scalar(query, key, fallback = '') {
  const value = query[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > 120)
    throw new HttpError(400, `Provide one valid ${key} filter.`);
  return value;
}

/** Validates a ?page= value (1 when missing); throws 400 for anything else. */
export function securityPageNumber(value) {
  if (value === undefined || value === '') return 1;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,5}$/.test(value))
    throw new HttpError(400, 'Choose a valid page number.');
  return Number(value);
}

function day(value) {
  if (!value) return '';
  if (!/^2[01][0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(value))
    throw new HttpError(400, 'Use a date between 2000 and 2199 in YYYY-MM-DD format.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
    throw new HttpError(400, 'Choose a valid calendar date.');
  return value;
}

/** Validates the activity filters from the query string: action, from/to dates, userId and page. */
export function readSecurityAuditFilters(query = {}) {
  if (!query || typeof query !== 'object' || Array.isArray(query))
    throw new HttpError(400, 'Provide valid activity filters.');
  if (Object.keys(query).some((key) => !['action', 'from', 'to', 'userId', 'page'].includes(key)))
    throw new HttpError(400, 'Use the supported account activity filters.');
  const action = scalar(query, 'action', 'all');
  if (!['all', 'other', ...ACTION_NAMES].includes(action))
    throw new HttpError(400, 'Choose a supported account action.');
  const from = day(scalar(query, 'from'));
  const to = day(scalar(query, 'to'));
  if (from && to && from > to) throw new HttpError(400, 'The end date must be on or after the start date.');
  const userId = scalar(query, 'userId');
  if (userId && !ACCOUNT_ID.test(userId)) throw new HttpError(400, 'Choose a valid account filter.');
  return { action, from, to, userId, page: securityPageNumber(query.page) };
}

const timestamp = (value) => {
  const parsed = value === null || value === undefined ? undefined : new Date(value);
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
};

function safeAccess(value) {
  if (!value || typeof value !== 'object') return undefined;
  const output = {};
  if (['admin', 'staff'].includes(value.role)) output.role = value.role;
  if (['pending', 'active', 'disabled'].includes(value.status)) output.status = value.status;
  if (Array.isArray(value.organizationIds))
    output.organizationIds = value.organizationIds
      .filter((id) => typeof id === 'string' && ACCOUNT_ID.test(id))
      .slice(0, 1000);
  return Object.keys(output).length ? output : undefined;
}

/** Existing/legacy audit details are data, never an open-ended object sent to the browser. */
export function safeSecurityDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  const before = safeAccess(value.before);
  const after = safeAccess(value.after);
  if (before) output.before = before;
  if (after) output.after = after;
  if (Number.isSafeInteger(value.revokedSessions) && value.revokedSessions >= 0)
    output.revokedSessions = value.revokedSessions;
  if (SOURCE_SCOPES.has(value.scope)) output.scope = value.scope;
  return output;
}

function sessionId(value) {
  if (typeof value === 'string' && UUID.test(value)) return value;
  if (value instanceof ObjectId) return `legacy-${value.toHexString()}`;
  return null;
}

function sessionDatabaseId(value) {
  if (typeof value === 'string' && UUID.test(value)) return value;
  if (typeof value === 'string' && /^legacy-[a-f0-9]{24}$/.test(value)) return new ObjectId(value.slice(7));
  throw new HttpError(400, 'Choose a valid session.');
}

function accountId(value) {
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value))
    throw new HttpError(400, 'Choose a valid account.');
  return value;
}

function pagination(page, total) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { page: Math.min(page, pageCount), pageSize: PAGE_SIZE, total, pageCount };
}

/** Returns the session and activity operations used by src/services/auth/auth.js. */
export function createAuthSecurity({ db, now = Date.now, audit, logger }) {
  const sessions = db.collection('auth_sessions');
  const records = db.collection('auth_audit');
  const users = db.collection('auth_users');
  const options = () => db.options();

  async function requireCurrentUser(user, administrator = false) {
    const current = user?.id && (await db.models.auth.userById(user.id));
    if (!current || current.status !== 'active') throw new HttpError(401, 'Please sign in to continue.');
    if (administrator && current.role !== 'admin')
      throw new HttpError(403, 'Administrator access is required.');
    return current;
  }

  async function requireActor(user, currentTokenHash, administrator = false) {
    const current = await requireCurrentUser(user, administrator);
    const session =
      typeof currentTokenHash === 'string' &&
      (await sessions.findOne(
        { user_id: current.id, token_hash: currentTokenHash, expires_at: { $gt: now() } },
        { ...options(), projection: { _id: 1 } },
      ));
    if (!session) throw new HttpError(401, 'Please sign in to continue.');
    return current;
  }

  async function insertSession(tokenHash, userId, expiresAt, createdAt) {
    return sessions.insertOne(
      {
        _id: randomUUID(),
        token_hash: tokenHash,
        user_id: userId,
        expires_at: expiresAt,
        created_at: createdAt,
        expiresOn: new Date(expiresAt),
      },
      options(),
    );
  }

  async function listSessions(user, currentTokenHash, query = {}) {
    if (Object.keys(query).some((key) => key !== 'page'))
      throw new HttpError(400, 'Use the supported session filters.');
    const requested = securityPageNumber(query.page);
    const current = await requireCurrentUser(user);
    const at = now();
    const filter = { user_id: current.id, expires_at: { $gt: at } };
    const total = await sessions.countDocuments(filter, options());
    const page = pagination(requested, total);
    const rows = await sessions
      .find(filter, {
        ...options(),
        projection: { _id: 1, token_hash: 1, created_at: 1, expires_at: 1 },
      })
      .sort({ created_at: -1, _id: -1 })
      .skip((page.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .toArray();
    return {
      sessions: rows.map((row) => ({
        id: sessionId(row._id),
        createdAt: timestamp(row.created_at),
        expiresAt: timestamp(row.expires_at),
        current: row.token_hash === currentTokenHash,
      })),
      total,
      asOf: timestamp(at),
      pagination: page,
    };
  }

  async function revokeOne(user, currentTokenHash, id) {
    const databaseId = sessionDatabaseId(id);
    return db.transaction(async () => {
      const actor = await requireActor(user, currentTokenHash);
      const target = await sessions.findOne(
        { _id: databaseId, user_id: actor.id, expires_at: { $gt: now() } },
        { ...options(), projection: { _id: 1, token_hash: 1 } },
      );
      if (!target)
        return {
          message: 'This session is already signed out or is unavailable.',
          revokedSessions: 0,
          signedOut: false,
        };
      await sessions.deleteOne({ _id: target._id, user_id: actor.id }, options());
      await audit('session-revoked', actor.id, actor.id, { revokedSessions: 1 });
      return {
        message: 'Session signed out.',
        revokedSessions: 1,
        signedOut: target.token_hash === currentTokenHash,
      };
    });
  }

  async function revokeOthers(user, currentTokenHash) {
    return db.transaction(async () => {
      const actor = await requireActor(user, currentTokenHash);
      const result = await sessions.deleteMany(
        {
          user_id: actor.id,
          token_hash: { $ne: currentTokenHash },
          expires_at: { $gt: now() },
        },
        options(),
      );
      if (result.deletedCount)
        await audit('other-sessions-revoked', actor.id, actor.id, { revokedSessions: result.deletedCount });
      return {
        message: 'Other sessions signed out. This session remains active.',
        revokedSessions: result.deletedCount,
        signedOut: false,
      };
    });
  }

  async function revokeUserSessions(user, currentTokenHash, targetId) {
    accountId(targetId);
    return db.transaction(async () => {
      const actor = await requireActor(user, currentTokenHash, true);
      const target = await db.models.auth.userById(targetId);
      if (!target) throw new HttpError(404, 'Account not found.');
      const result = await sessions.deleteMany({ user_id: target.id, expires_at: { $gt: now() } }, options());
      if (result.deletedCount)
        await audit('user-sessions-revoked', target.id, actor.id, { revokedSessions: result.deletedCount });
      return {
        message: 'Account sessions revoked. The person can sign in again using their credentials.',
        revokedSessions: result.deletedCount,
        signedOut: actor.id === target.id,
      };
    });
  }

  async function listAudit(user, query = {}) {
    await requireCurrentUser(user, true);
    const { page: requested, ...filters } = readSecurityAuditFilters(query);
    const filter = {};
    if (filters.action === 'other') filter.action = { $nin: [...ACTION_NAMES] };
    else if (filters.action !== 'all') filter.action = filters.action;
    if (filters.userId) filter.$or = [{ actor_id: filters.userId }, { user_id: filters.userId }];
    if (filters.from || filters.to) {
      filter.created_at = {};
      if (filters.from) filter.created_at.$gte = new Date(`${filters.from}T00:00:00.000+05:30`).toISOString();
      if (filters.to)
        filter.created_at.$lt = new Date(
          Date.parse(`${filters.to}T00:00:00.000+05:30`) + 86_400_000,
        ).toISOString();
    }
    const total = await records.countDocuments(filter, options());
    const page = pagination(requested, total);
    const rows = await records
      .find(filter, {
        ...options(),
        projection: { _id: 0, id: 1, action: 1, actor_id: 1, user_id: 1, created_at: 1, details: 1 },
      })
      .sort({ created_at: -1, id: -1 })
      .skip((page.page - 1) * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .toArray();
    const ids = [
      ...new Set(
        rows
          .flatMap((row) => [row.actor_id, row.user_id])
          .filter((id) => typeof id === 'string' && ACCOUNT_ID.test(id)),
      ),
    ];
    const identities = await users
      .find(
        { id: { $in: ids } },
        {
          ...options(),
          projection: { _id: 0, id: 1, name: 1, email: 1 },
        },
      )
      .toArray();
    const byId = new Map(
      identities.map((row) => [
        row.id,
        {
          id: row.id,
          name: typeof row.name === 'string' ? row.name.slice(0, 120) : 'Account',
          email: typeof row.email === 'string' ? row.email.slice(0, 254) : '',
        },
      ]),
    );
    const identity = (id) =>
      byId.get(id) ??
      (typeof id === 'string' && ACCOUNT_ID.test(id) ? { id, name: 'Account unavailable', email: '' } : null);
    return {
      events: rows.map((row) => ({
        id: typeof row.id === 'string' && ACCOUNT_ID.test(row.id) ? row.id : '',
        action: ACTION_NAMES.has(row.action) ? row.action : 'other',
        createdAt: timestamp(row.created_at),
        actor: identity(row.actor_id),
        user: identity(row.user_id),
        details: safeSecurityDetails(row.details),
      })),
      filters,
      pagination: page,
      actions: SECURITY_ACTIONS,
    };
  }

  async function observe(action, userId, details) {
    if (!['login-unsuccessful', 'account-throttled'].includes(action)) return;
    let timer;
    try {
      await Promise.race([
        records.insertOne(
          {
            id: randomUUID(),
            actor_id: null,
            user_id: userId ?? null,
            action,
            details: safeSecurityDetails(details),
            created_at: new Date(now()).toISOString(),
          },
          { timeoutMS: 1000, writeConcern: { w: 'majority' } },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Account activity record timed out.')), 1000);
        }),
      ]);
    } catch (error) {
      try {
        logger?.warn('application_event', { error });
      } catch {
        // A failing log sink must not change a credential or throttling response.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { insertSession, listSessions, revokeOne, revokeOthers, revokeUserSessions, listAudit, observe };
}
