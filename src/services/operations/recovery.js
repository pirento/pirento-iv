/** Recovery remains offline until an operator reconciles provider activity. */
export async function assertDatabaseRecoveryReviewed(db) {
  const state = await db.collection('ops_recovery_state').findOne({ id: 1 }, db.options());
  if (state && state.status !== 'reviewed') {
    throw new Error(
      'Restored database is held for recovery review. Reconcile accounts, payments and email before using db:resume.',
    );
  }
}

export async function prepareRestoredDatabase(db, checksum, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('A verified backup checksum is required.');
  const names = new Set(
    (await db.database.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name),
  );
  if (!['organizations', 'documents', 'sequences'].every((name) => names.has(name))) {
    throw new Error('The backup is not a workspace database.');
  }
  const timestamp = now.toISOString();
  await db.transaction(async () => {
    for (const name of ['auth_sessions', 'auth_password_resets']) {
      await db.collection(name).deleteMany({}, db.options());
    }
    await db.collection('email_outbox').updateMany(
      { status: { $in: ['queued', 'sending'] } },
      {
        $set: {
          status: 'held',
          lease_until: null,
          claim_token: null,
          next_attempt_at: null,
          updated_at: timestamp,
          last_error: 'Database restored. Review provider delivery history before retrying.',
        },
      },
      db.options(),
    );
    await db.collection('email_outbox').updateMany(
      { kind: 'password_reset', status: { $ne: 'sent' } },
      {
        $set: {
          status: 'failed',
          payload: {},
          lease_until: null,
          claim_token: null,
          next_attempt_at: null,
          updated_at: timestamp,
          last_error: 'Reset link invalidated by database recovery. Request a new link.',
        },
      },
      db.options(),
    );
    // A snapshot may predate an occurrence or a delivery already made by the old database.
    // Releasing the global recovery hold must not silently restart those automations.
    if (names.has('payment_reminder_policies'))
      await db.collection('payment_reminder_policies').updateMany(
        {},
        {
          $set: { enabled: false, updatedAt: timestamp, recoveryDisabledAt: timestamp },
          $inc: { version: 1 },
        },
        db.options(),
      );
    if (names.has('recurring_invoice_schedules'))
      await db.collection('recurring_invoice_schedules').updateMany(
        { status: { $ne: 'completed' } },
        {
          $set: { status: 'paused', updatedAt: timestamp, recoveryPausedAt: timestamp },
          $inc: { version: 1 },
        },
        db.options(),
      );
    await db
      .collection('ops_recovery_state')
      .updateOne(
        { id: 1 },
        { $set: { status: 'pending', restored_at: timestamp, backup_sha256: checksum, reviewed_at: null } },
        { ...db.options(), upsert: true },
      );
  });
}

export async function acknowledgeDatabaseRecovery(db, acknowledged, now = new Date()) {
  if (!acknowledged) throw new Error('Recovery requires an explicit reconciliation acknowledgement.');
  const result = await db
    .collection('ops_recovery_state')
    .updateOne(
      { id: 1, status: 'pending' },
      { $set: { status: 'reviewed', reviewed_at: now.toISOString() } },
      db.options(),
    );
  if (!result.modifiedCount)
    throw new Error('This recovery review has already been released or is unavailable.');
}
