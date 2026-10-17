/**
 * Data access layer (the "M" in MVC): every read and write to MongoDB goes through these models.
 *
 * db.models.<group>.<operation>(...). Groups: organizations, documents, payments, events,
 * catalog, businessProducts, formats, sequences (document numbers), settings, ownership,
 * auth (users, sessions, password resets, audit), email (outbox queue), razorpay, cashfree.
 * Each call automatically joins the current transaction, if one is running.
 */

import { HttpError } from '../middleware/errors.js';
import { receiptPaise, validReceiptPaise } from './money-expressions.js';
import { createImageStore } from './image-store.js';
import { RETENTION_DAYS, expiresAfter } from '../config/retention.js';

/**
 * Native MongoDB models. Business records are complete BSON documents (including
 * their issuer/customer/format snapshots), not JSON strings. Unbounded payment,
 * audit, session, provider-event and email histories live in referenced collections.
 * Every operation inherits the current transaction session from the database context.
 */
export function createModels(context) {
  // ---------------------------------------------------------------------------
  // Low-level helpers shared by all models (find one / list / insert / update / replace ...).
  // ---------------------------------------------------------------------------
  const options = () => ({ ...context.options(), ignoreUndefined: true });
  const collection = (name) => context.collection(name);
  const present = (value) => {
    if (!value) return undefined;
    const { _id, ...record } = value;
    return record;
  };
  const one = async (name, filter) => present(await collection(name).findOne(filter, options()));
  // Existing databases need no bulk rewrite: absent versions are read as revision zero.
  const documentRecord = (record) => (record ? { ...record, version: record.version ?? 0 } : undefined);
  // Documents and email payloads keep image references; reads put the images back (see image-store.js).
  const images = createImageStore(context);
  const oneDocument = async (filter) => documentRecord(await images.unpack(await one('documents', filter)));
  const allDocuments = async (filter = {}) =>
    (await images.unpackAll(await all('documents', filter, { _id: -1 }))).map(documentRecord);
  const all = async (name, filter = {}, sort = { _id: 1 }) =>
    (await collection(name).find(filter, options()).sort(sort).toArray()).map(present);
  const insert = async (name, record) => {
    const result = await collection(name).insertOne(structuredClone(record), options());
    return { changes: result.acknowledged ? 1 : 0 };
  };
  const update = async (name, filter, fields, extra = {}) => {
    const result = await collection(name).updateOne(filter, { $set: fields }, { ...options(), ...extra });
    return { changes: result.matchedCount + result.upsertedCount };
  };
  const replace = async (name, record) => {
    const result = await collection(name).replaceOne({ id: record.id }, structuredClone(record), {
      ...options(),
      upsert: true,
      ignoreUndefined: true,
    });
    return { changes: result.matchedCount + result.upsertedCount };
  };
  const remove = async (name, filter) => {
    const result = await collection(name).deleteMany(filter, options());
    return { changes: result.deletedCount };
  };
  const upsert = async (name, filter, record) => {
    const result = await collection(name).updateOne(
      filter,
      { $setOnInsert: structuredClone(record) },
      { ...options(), upsert: true },
    );
    return { changes: result.upsertedCount };
  };
  const total = async (name, filter, alias = 'amount') => {
    const rows = await collection(name)
      .aggregate(
        [{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount_paise' } } }],
        options(),
      )
      .toArray();
    return { [alias]: rows[0]?.amount ?? 0 };
  };
  // Standard model for a business-owned collection: findById, list(organizationId), insert, save, remove.
  const business = (name, newestFirst = true) => ({
    findById: (id) => one(name, { id }),
    list: (organizationId) => all(name, { organizationId }, { _id: newestFirst ? -1 : 1 }),
    insert: (record) => insert(name, record),
    save: (record) => replace(name, record),
    remove: (id) => remove(name, { id }),
  });
  // ---------------------------------------------------------------------------
  // Business records: businesses, documents, receipts, catalog, formats, numbering, settings.
  // ---------------------------------------------------------------------------
  const models = {
    organizations: {
      ...business('organizations', false),
      list: () => all('organizations'),
      first: async () =>
        present(await collection('organizations').findOne({}, { ...options(), sort: { _id: 1 } })),
    },
    customers: business('customers'),
    // Expenses of one business between two dates (from inclusive, to exclusive), newest first.
    expenses: {
      ...business('expenses'),
      listBetween: (organizationId, { from, to }) =>
        all('expenses', { organizationId, billDate: { $gte: from, $lt: to } }, { billDate: -1, id: -1 }),
    },
    documents: {
      ...business('documents'),
      findById: (id) => oneDocument({ id }),
      list: (organizationId, kind) => allDocuments({ organizationId, ...(kind ? { kind } : {}) }),
      listAll: async () => (await images.unpackAll(await all('documents'))).map(documentRecord),
      insert: async (record) => insert('documents', await images.pack(record)),
      findByNumber: (number) => oneDocument({ number }),
      findByCustomer: (customerId) => oneDocument({ customerId }),
      save: async (record, expectedVersion) => {
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
          throw new TypeError('Document updates require an expected nonnegative integer version.');
        const versionFilter =
          expectedVersion === 0
            ? { $or: [{ version: 0 }, { version: { $exists: false } }] }
            : { version: expectedVersion };
        const result = await collection('documents').replaceOne(
          { id: record.id, organizationId: record.organizationId, ...versionFilter },
          structuredClone(await images.pack(record)),
          options(),
        );
        return { changes: result.matchedCount };
      },
    },
    documentRequests: {
      find: (organizationId, requestId) => one('document_requests', { organizationId, requestId }),
      insert: (record) => insert('document_requests', record),
    },
    payments: {
      ...business('payments'),
      list: (documentId) => all('payments', { documentId }, { _id: -1 }),
      first: (documentId) => one('payments', { documentId }),
      findByRequest: (documentId, requestId) => one('payments', { documentId, requestId }),
      insert: (record) => insert('payments', record),
      activeTotal: async (documentId) => {
        const rows = await collection('payments')
          .aggregate(
            [
              { $match: { documentId, voidedAt: null } },
              { $set: { paymentPaise: receiptPaise } },
              {
                $group: {
                  _id: null,
                  paid: { $sum: '$paymentPaise' },
                  invalidAmounts: { $sum: { $cond: [validReceiptPaise('$paymentPaise'), 0, 1] } },
                },
              },
            ],
            options(),
          )
          .toArray();
        const { paid = 0, invalidAmounts = 0 } = rows[0] ?? {};
        if (invalidAmounts || !Number.isSafeInteger(paid) || paid < 0)
          throw new HttpError(
            409,
            'Saved active receipt amounts are invalid or exceed the safe integer-paise range. Review or void the incorrect receipt before recording another payment.',
            'PAYMENT_DATA_INVALID',
          );
        return { paid };
      },
    },
    events: {
      insert: (record) => insert('document_events', record),
      list: (documentId) => all('document_events', { documentId }, { _id: -1 }),
      removeForDocument: (documentId) => remove('document_events', { documentId }),
    },
    catalog: {
      ...business('catalog'),
      findSkuConflict: (organizationId, sku, excludedId) =>
        collection('catalog')
          .findOne(
            { organizationId, sku, id: { $ne: excludedId } },
            { ...options(), collation: { locale: 'en', strength: 2 } },
          )
          .then(present),
    },
    businessProducts: {
      ...business('business_products', false),
      firstActive: (organizationId) => one('business_products', { organizationId, active: true }),
      findCodeConflict: (organizationId, code, excludedId) =>
        collection('business_products')
          .findOne(
            { organizationId, code, id: { $ne: excludedId } },
            { ...options(), collation: { locale: 'en', strength: 2 } },
          )
          .then(present),
    },
    formats: {
      ...business('formats', false),
      findDefault: (organizationId) => one('formats', { organizationId, isDefault: true }),
      findOtherDefault: (organizationId, id) =>
        one('formats', { organizationId, isDefault: true, id: { $ne: id } }),
      list: (organizationId) => all('formats', { organizationId }, { isDefault: -1, _id: 1 }),
      count: async (organizationId) => ({
        count: await collection('formats').countDocuments({ organizationId }, options()),
      }),
    },
    sequences: {
      next: async (organizationId, kind, fiscalYear) => {
        const row = await collection('sequences').findOneAndUpdate(
          { organizationId, kind, fiscalYear },
          { $inc: { value: 1 } },
          { ...options(), upsert: true, returnDocument: 'after' },
        );
        return { value: row.value };
      },
    },
    settings: {
      get: async () => {
        const record = await one('workspace_settings', { id: 1 });
        if (!record) return undefined;
        const { id, ...settings } = record;
        return settings;
      },
      save: (settings) => update('workspace_settings', { id: 1 }, settings, { upsert: true }),
    },
    // Answers "which business owns this record?" for the access guard (src/middleware/access.js).
    ownership: {
      resource: async (name, id) => {
        const allowed = new Set([
          'customers',
          'documents',
          'catalog',
          'formats',
          'business_products',
          'payments',
          'expenses',
        ]);
        if (!allowed.has(name)) throw new Error('Unsupported resource model.');
        const record = await one(name, { id });
        return record ? { organization_id: record.organizationId } : undefined;
      },
      document: async (id) => {
        const record = await one('documents', { id });
        return record ? { organization_id: record.organizationId } : undefined;
      },
    },
  };
  // ---------------------------------------------------------------------------
  // Accounts: users, sessions, password resets, audit trail.
  // ---------------------------------------------------------------------------
  // Sessions created before activity tracking count their sign-in time as the last activity.
  const activeSince = (cutoff) => ({
    $or: [
      { last_seen_at: { $gt: cutoff } },
      { last_seen_at: { $exists: false }, created_at: { $gt: cutoff } },
    ],
  });
  models.auth = {
    userById: (id) => one('auth_users', { id }),
    userByEmail: (email) => one('auth_users', { email: email.toLowerCase() }),
    listUsers: () => all('auth_users', {}, { created_at: -1, id: 1 }),
    // A session is valid until expires_at and while it was active after idleCutoff (ms).
    sessionUser: async (token_hash, time, status, idleCutoff = 0) => {
      const session = await one('auth_sessions', {
        token_hash,
        expires_at: { $gt: time },
        ...activeSince(idleCutoff),
      });
      if (!session) return undefined;
      // Activity is written at most every 5 minutes per session.
      if (!(session.last_seen_at > time - 300_000))
        await update('auth_sessions', { token_hash }, { last_seen_at: time });
      return one('auth_users', { id: session.user_id, status });
    },
    insertUser: (
      id,
      name,
      email,
      company,
      password_hash,
      role,
      status,
      organization_ids,
      created_at,
      updated_at,
    ) =>
      upsert(
        'auth_users',
        { email },
        {
          id,
          name,
          email,
          company,
          password_hash,
          role,
          status,
          organization_ids:
            typeof organization_ids === 'string' ? JSON.parse(organization_ids) : organization_ids,
          created_at,
          updated_at,
          last_login_at: null,
        },
      ),
    audit: (id, actor_id, action, user_id, details, created_at) =>
      insert('auth_audit', {
        id,
        actor_id,
        action,
        user_id,
        details,
        created_at,
        expiresOn: expiresAfter(created_at, RETENTION_DAYS.securityLog),
      }),
    deleteSession: (token_hash) => remove('auth_sessions', { token_hash }),
    deleteExpiredSessions: (time) => remove('auth_sessions', { expires_at: { $lte: time } }),
    insertSession: (token_hash, user_id, expires_at, created_at) =>
      insert('auth_sessions', {
        token_hash,
        user_id,
        expires_at,
        created_at,
        expiresOn: new Date(expires_at),
      }),
    setLastLogin: (last_login_at, id) => update('auth_users', { id }, { last_login_at }),
    deleteExpiredResets: (time) => remove('auth_password_resets', { expires_at: { $lte: time } }),
    insertReset: (token_hash, user_id, expires_at, created_at) =>
      insert('auth_password_resets', {
        token_hash,
        user_id,
        expires_at,
        created_at,
        expiresOn: new Date(expires_at),
      }),
    deleteReset: (token_hash) => remove('auth_password_resets', { token_hash }),
    findValidReset: (token_hash, time) =>
      one('auth_password_resets', { token_hash, expires_at: { $gt: time } }),
    consumeReset: async (token_hash, time, status) => {
      const reset = await one('auth_password_resets', { token_hash, expires_at: { $gt: time } });
      if (!reset || !(await one('auth_users', { id: reset.user_id, status }))) return { changes: 0 };
      return remove('auth_password_resets', { token_hash, expires_at: { $gt: time } });
    },
    updatePassword: (password_hash, updated_at, id) =>
      update('auth_users', { id }, { password_hash, updated_at }),
    deleteUserResets: (user_id) => remove('auth_password_resets', { user_id }),
    deleteUserSessions: (user_id) => remove('auth_sessions', { user_id }),
    deleteOtherSessions: (user_id, token_hash) =>
      remove('auth_sessions', { user_id, token_hash: { $ne: token_hash } }),
    // Two-step login: a pending key during setup, the active key, and the last accepted code step.
    setTwoStepPending: (totp_pending, updated_at, id) =>
      update('auth_users', { id }, { totp_pending, updated_at }),
    enableTwoStep: (totp_secret, totp_last_step, updated_at, id) =>
      update('auth_users', { id }, { totp_secret, totp_last_step, totp_pending: null, updated_at }),
    disableTwoStep: (updated_at, id) =>
      update(
        'auth_users',
        { id },
        { totp_secret: null, totp_pending: null, totp_last_step: null, updated_at },
      ),
    // Accepts a code's step only once, even when two sign-ins race with the same code.
    useTwoStepCode: async (step, id) => {
      const result = await collection('auth_users').updateOne(
        { id, $or: [{ totp_last_step: null }, { totp_last_step: { $lt: step } }] },
        { $set: { totp_last_step: step } },
        options(),
      );
      return { changes: result.modifiedCount };
    },
    countUsers: async (role, status) => ({
      count: await collection('auth_users').countDocuments({ role, status }, options()),
    }),
    updateAccess: (role, status, organization_ids, permission, updated_at, id) =>
      update('auth_users', { id }, { role, status, organization_ids, permission, updated_at }),
  };
  // A claim token fences every worker write. In particular, an undefined token
  // must never be omitted from a MongoDB filter by ignoreUndefined.
  // ---------------------------------------------------------------------------
  // Email outbox: queued emails are "claimed" by one worker at a time with an expiring lease,
  // so two servers never send the same email.
  // ---------------------------------------------------------------------------
  const emailClaimFilter = (id, claim_token, at) => {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof claim_token !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(claim_token) ||
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at))
    )
      throw new TypeError('Email worker writes require a message ID, claim token and timestamp.');
    return { id, claim_token, status: 'sending', lease_until: { $gt: at } };
  };
  const emailOptions = (timeoutMS = 10_000) => {
    const inherited = options();
    return inherited.session ? inherited : { ...inherited, timeoutMS, writeConcern: { w: 'majority' } };
  };
  const emailMutation = async (filter, mutation, timeoutMS) => {
    const result = await collection('email_outbox').updateOne(filter, mutation, emailOptions(timeoutMS));
    return { changes: result.matchedCount };
  };
  // A sent email is never re-sent, so only the fields its history and reminder checks read are kept;
  // the invoice copy, HTML and PDF are dropped. Password reset links are removed entirely.
  const sentEmailPayload = {
    $cond: [
      { $eq: ['$kind', 'password_reset'] },
      {},
      {
        organizationId: { $ifNull: ['$payload.organizationId', '$payload.document.organizationId'] },
        reminder: '$payload.reminder',
      },
    ],
  };
  const unattemptedEmailFilter = (id, claim_token, at) => {
    if (typeof id !== 'string' || !id) throw new TypeError('An email message ID is required.');
    return {
      ...(claim_token === undefined
        ? { id, status: { $in: ['held', 'queued', 'failed'] }, claim_token: null }
        : emailClaimFilter(id, claim_token, at)),
      first_attempt_at: null,
    };
  };
  const unpackEmail = async (row) => row && { ...row, payload: await images.unpack(row.payload) };
  models.email = {
    findById: async (id) => unpackEmail(await one('email_outbox', { id })),
    findByEvent: async (event_key) => unpackEmail(await one('email_outbox', { event_key })),
    list: (document_id) => all('email_outbox', { document_id }, { created_at: -1, _id: -1 }),
    countReminders: (organizationId) =>
      collection('email_outbox').countDocuments(
        { kind: 'payment_reminder', 'payload.organizationId': organizationId },
        options(),
      ),
    listReminders: async (organizationId, skip, limit) =>
      (
        await collection('email_outbox')
          .find({ kind: 'payment_reminder', 'payload.organizationId': organizationId }, options())
          .sort({ created_at: -1, _id: -1 })
          .skip(skip)
          .limit(limit)
          .toArray()
      ).map(present),
    enqueue: async (
      id,
      event_key,
      document_id,
      kind,
      recipient,
      subject,
      status,
      created_at,
      updated_at,
      next_attempt_at,
      last_error,
      has_payment_link,
      payload,
    ) =>
      upsert(
        'email_outbox',
        { event_key },
        {
          id,
          event_key,
          document_id,
          kind,
          recipient,
          subject,
          status,
          created_at,
          updated_at,
          next_attempt_at,
          last_error,
          has_payment_link,
          payload: await images.pack(payload),
          attempts: 0,
          sent_at: null,
          lease_until: null,
          claim_token: null,
          first_attempt_at: null,
          provider_id: '',
        },
      ),
    retry: (next_attempt_at, updated_at, id) =>
      update(
        'email_outbox',
        { id, status: { $in: ['held', 'failed'] } },
        {
          status: 'queued',
          attempts: 0,
          next_attempt_at,
          updated_at,
          last_error: '',
          lease_until: null,
          claim_token: null,
        },
      ),
    holdUnattemptedForDocument: (document_id, organizationId, last_error, updated_at) =>
      collection('email_outbox').updateMany(
        {
          document_id,
          kind: {
            $in: ['invoice', 'payment_failed', 'payment_received', 'payment_paid', 'payment_reminder'],
          },
          first_attempt_at: null,
          status: { $in: ['held', 'queued', 'failed', 'sending'] },
          $or: [
            { 'payload.organizationId': organizationId },
            {
              'payload.organizationId': { $exists: false },
              'payload.document.organizationId': organizationId,
            },
          ],
        },
        {
          $set: {
            status: 'held',
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            last_error,
            updated_at,
          },
        },
        options(),
      ),
    holdUnattemptedRemindersForPolicy: (organizationId, last_error, updated_at) =>
      collection('email_outbox').updateMany(
        {
          kind: 'payment_reminder',
          'payload.organizationId': organizationId,
          'payload.reminder.automatic': true,
          first_attempt_at: null,
          status: { $in: ['held', 'queued', 'failed', 'sending'] },
        },
        {
          $set: {
            status: 'held',
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            last_error,
            updated_at,
          },
        },
        options(),
      ),
    expireResets: (updated_at, time) =>
      collection('email_outbox').updateMany(
        {
          kind: 'password_reset',
          status: { $in: ['held', 'queued', 'failed'] },
          'payload.expiresAt': { $lte: time },
        },
        {
          $set: {
            status: 'failed',
            payload: {},
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            updated_at,
            last_error: 'This password reset link has expired. Request a new password reset.',
          },
        },
        options(),
      ),
    /** One-off clean-up for emails sent before payloads were trimmed on send (safe to repeat). */
    compactSent: () =>
      collection('email_outbox').updateMany(
        {
          status: 'sent',
          $or: [
            { 'payload.document': { $exists: true } },
            { 'payload.html': { $exists: true } },
            { 'payload.attachment': { $exists: true } },
          ],
        },
        [{ $set: { payload: sentEmailPayload } }],
        options(),
      ),
    claim: async (updated_at, lease_until, due, expired, claim_token) => {
      emailClaimFilter('claim', claim_token, updated_at);
      return unpackEmail(
        present(
          await collection('email_outbox').findOneAndUpdate(
            {
              $or: [
                { status: 'queued', next_attempt_at: { $lte: due } },
                {
                  status: 'sending',
                  $or: [{ lease_until: { $lte: expired } }, { lease_until: null }],
                },
              ],
            },
            { $set: { status: 'sending', updated_at, lease_until, claim_token }, $inc: { attempts: 1 } },
            { ...emailOptions(), sort: { created_at: 1, _id: 1 }, returnDocument: 'after' },
          ),
        ),
      );
    },
    renew: (updated_at, lease_until, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), {
        $set: { updated_at },
        $max: { lease_until },
      }),
    failUnsafeRetry: (last_error, updated_at, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), [
        {
          $set: {
            status: 'failed',
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            last_error: { $literal: last_error },
            updated_at,
            payload: { $cond: [{ $eq: ['$kind', 'password_reset'] }, {}, '$payload'] },
          },
        },
      ]),
    hold: (last_error, updated_at, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), [
        {
          $set: {
            status: 'held',
            attempts: { $max: [{ $subtract: ['$attempts', 1] }, 0] },
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            last_error: { $literal: last_error },
            updated_at,
          },
        },
      ]),
    expireReset: (last_error, updated_at, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), {
        $set: {
          status: 'failed',
          lease_until: null,
          claim_token: null,
          next_attempt_at: null,
          payload: {},
          last_error,
          updated_at,
        },
      }),
    setPaymentLink: (has_payment_link, id, claim_token, at) =>
      emailMutation(unattemptedEmailFilter(id, claim_token, at), { $set: { has_payment_link } }),
    // The claim filter is built first so invalid worker arguments still throw immediately.
    setPayload: (payload, id, claim_token, at) => {
      const filter = unattemptedEmailFilter(id, claim_token, at);
      return images.pack(payload).then((packed) => emailMutation(filter, { $set: { payload: packed } }));
    },
    setReminderPayload: (payload, recipient, subject, id, claim_token, at) => {
      const filter = {
        ...emailClaimFilter(id, claim_token, at),
        kind: 'payment_reminder',
        first_attempt_at: null,
      };
      return images
        .pack(payload)
        .then((packed) =>
          emailMutation(filter, { $set: { payload: packed, recipient, subject, has_payment_link: 0 } }),
        );
    },
    deferReminderPreparation: (last_error, updated_at, next_attempt_at, id, claim_token) =>
      emailMutation(
        {
          ...emailClaimFilter(id, claim_token, updated_at),
          kind: 'payment_reminder',
          first_attempt_at: null,
        },
        [
          {
            $set: {
              status: 'queued',
              lease_until: null,
              claim_token: null,
              next_attempt_at,
              last_error,
              updated_at,
              attempts: { $max: [{ $subtract: ['$attempts', 1] }, 0] },
            },
          },
        ],
      ),
    markFirstAttempt: (first_attempt_at, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, first_attempt_at), [
        { $set: { first_attempt_at: { $ifNull: ['$first_attempt_at', first_attempt_at] } } },
      ]),
    markSent: (sent_at, updated_at, provider_id, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), [
        {
          $set: {
            status: 'sent',
            sent_at,
            updated_at,
            lease_until: null,
            claim_token: null,
            next_attempt_at: null,
            provider_id: { $literal: provider_id },
            last_error: '',
            payload: sentEmailPayload,
          },
        },
      ]),
    markFailed: (status, updated_at, next_attempt_at, last_error, id, claim_token) =>
      emailMutation(emailClaimFilter(id, claim_token, updated_at), {
        $set: { status, updated_at, lease_until: null, claim_token: null, next_attempt_at, last_error },
      }),
    releaseClaim: (updated_at, retry_at, id, claim_token) =>
      emailMutation(
        emailClaimFilter(id, claim_token, updated_at),
        [
          {
            $set: {
              status: 'queued',
              lease_until: null,
              claim_token: null,
              next_attempt_at: { $cond: [{ $ifNull: ['$first_attempt_at', false] }, retry_at, updated_at] },
              updated_at,
              attempts: {
                $cond: [
                  { $ifNull: ['$first_attempt_at', false] },
                  '$attempts',
                  { $max: [{ $subtract: ['$attempts', 1] }, 0] },
                ],
              },
              last_error: {
                $cond: [
                  { $ifNull: ['$first_attempt_at', false] },
                  'Worker stopped during an unconfirmed delivery. Retry uses the same delivery key.',
                  'Worker stopped before delivery started. This message remains queued.',
                ],
              },
            },
          },
        ],
        3_000,
      ),
  };
  // ---------------------------------------------------------------------------
  // Online payment providers: payment links, verified payments and webhook events.
  // ---------------------------------------------------------------------------
  function providerModels(prefix, scoped) {
    const links = `${prefix}_payment_links`,
      payments = `${prefix}_verified_payments`;
    const scope = (organization_id, rest) => (scoped ? { organization_id, ...rest } : rest);
    return {
      listLinks: (document_id, organization_id) =>
        all(links, scope(organization_id, { document_id }), { created_at: -1, _id: -1 }),
      received: (link_id) => total(payments, { link_id }),
      setState: (state, review_reason, updated_at, id) =>
        update(links, { id }, { state, review_reason, updated_at }),
      setProviderUrl: (provider_id, url, id) => update(links, { id }, { provider_id, url }),
      setProvider: (provider_id, id) => update(links, { id }, { provider_id }),
      setUrl: (url, id) => update(links, { id }, { url }),
    };
  }
  // Razorpay payment links and payments.
  models.razorpay = {
    ...providerModels('online', false),
    paymentById: (provider_payment_id) => one('online_verified_payments', { provider_payment_id }),
    insertPayment: (provider_payment_id, link_id, amount_paise, ledger_payment_id, created_at) =>
      insert('online_verified_payments', {
        provider_payment_id,
        link_id,
        amount_paise,
        ledger_payment_id,
        created_at,
      }),
    failedById: (provider_payment_id) => one('online_failed_attempts', { provider_payment_id }),
    insertFailure: (provider_payment_id, link_id, created_at) =>
      upsert('online_failed_attempts', { provider_payment_id }, { provider_payment_id, link_id, created_at }),
    insertLink: (
      id,
      document_id,
      reference_id,
      amount_paise,
      initial_paid_paise,
      state,
      created_at,
      updated_at,
    ) =>
      insert('online_payment_links', {
        id,
        document_id,
        reference_id,
        amount_paise,
        initial_paid_paise,
        state,
        created_at,
        updated_at,
        provider_id: null,
        url: '',
        review_reason: '',
      }),
    eventByKey: (event_key) => one('online_webhook_events', { event_key }),
    linkByProvider: (provider_id) => one('online_payment_links', { provider_id }),
    linkByReference: (reference_id) => one('online_payment_links', { reference_id }),
    insertEvent: (event_key, payload_hash, event_type, created_at, updated_at) =>
      upsert(
        'online_webhook_events',
        { event_key },
        {
          event_key,
          payload_hash,
          event_type,
          status: 'pending',
          created_at,
          updated_at,
          expiresOn: expiresAfter(created_at, RETENTION_DAYS.webhookEvents),
        },
      ),
    completeEvent: (updated_at, event_key) =>
      update('online_webhook_events', { event_key }, { status: 'complete', updated_at }),
    linkByPayment: async (provider_payment_id) => {
      const payment = await one('online_verified_payments', { provider_payment_id });
      return payment ? one('online_payment_links', { id: payment.link_id }) : undefined;
    },
    linkByProviderReference: (provider_id, reference_id) =>
      one('online_payment_links', { provider_id, reference_id }),
  };
  // Cashfree payment links, orders and payments (always scoped to one business).
  models.cashfree = {
    ...providerModels('cashfree', true),
    orderById: (organization_id, provider_order_id) =>
      one('cashfree_link_orders', { organization_id, provider_order_id }),
    insertOrder: (organization_id, provider_order_id, link_id) =>
      upsert(
        'cashfree_link_orders',
        { organization_id, provider_order_id },
        { organization_id, provider_order_id, link_id },
      ),
    paymentById: (organization_id, provider_payment_id) =>
      one('cashfree_verified_payments', { organization_id, provider_payment_id }),
    insertPayment: (
      organization_id,
      provider_payment_id,
      link_id,
      amount_paise,
      ledger_payment_id,
      created_at,
    ) =>
      insert('cashfree_verified_payments', {
        organization_id,
        provider_payment_id,
        link_id,
        amount_paise,
        ledger_payment_id,
        created_at,
      }),
    failedById: (organization_id, provider_payment_id) =>
      one('cashfree_failed_attempts', { organization_id, provider_payment_id }),
    insertFailure: (organization_id, provider_payment_id, link_id, created_at) =>
      insert('cashfree_failed_attempts', { organization_id, provider_payment_id, link_id, created_at }),
    insertLink: (
      id,
      organization_id,
      document_id,
      reference_id,
      amount_paise,
      initial_paid_paise,
      state,
      created_at,
      updated_at,
    ) =>
      insert('cashfree_payment_links', {
        id,
        organization_id,
        document_id,
        reference_id,
        amount_paise,
        initial_paid_paise,
        state,
        created_at,
        updated_at,
        provider_id: null,
        url: '',
        review_reason: '',
      }),
    eventByKey: (organization_id, event_key) =>
      one('cashfree_webhook_events', { organization_id, event_key }),
    linkByReference: (organization_id, reference_id) =>
      one('cashfree_payment_links', { organization_id, reference_id }),
    linkByOrder: async (organization_id, provider_order_id) => {
      const order = await one('cashfree_link_orders', { organization_id, provider_order_id });
      return order ? one('cashfree_payment_links', { id: order.link_id }) : undefined;
    },
    activeLinks: (organization_id) =>
      all('cashfree_payment_links', { organization_id, state: { $nin: ['paid', 'cancelled', 'expired'] } }),
    insertEvent: (organization_id, event_key, payload_hash, event_type, created_at, updated_at) =>
      upsert(
        'cashfree_webhook_events',
        { organization_id, event_key },
        {
          organization_id,
          event_key,
          payload_hash,
          event_type,
          status: 'pending',
          created_at,
          updated_at,
          expiresOn: expiresAfter(created_at, RETENTION_DAYS.webhookEvents),
        },
      ),
    completeEvent: (updated_at, organization_id, event_key) =>
      update('cashfree_webhook_events', { organization_id, event_key }, { status: 'complete', updated_at }),
  };
  return models;
}
