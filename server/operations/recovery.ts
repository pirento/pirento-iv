import type { DatabaseSync } from 'node:sqlite';

function hasTable(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

/** Restored files stay offline until the operator has reconciled the missing period. */
export function assertDatabaseRecoveryReviewed(db: DatabaseSync) {
  if (!hasTable(db, 'ops_recovery_state')) return;
  const state = db.prepare('SELECT status FROM ops_recovery_state WHERE id=1').get() as
    { status: string } | undefined;
  if (!state || state.status !== 'reviewed')
    throw new Error(
      'Restored database is held for recovery review. Reconcile accounts, payments and email before using db:resume.',
    );
}

export function prepareRestoredDatabase(db: DatabaseSync, checksum: string, now = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('A verified backup checksum is required.');
  for (const table of ['organizations', 'documents', 'sequences'])
    if (!hasTable(db, table)) throw new Error('The backup is not a workspace database.');
  const timestamp = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['auth_sessions', 'auth_password_resets'])
      if (hasTable(db, table)) db.exec(`DELETE FROM ${table}`);
    if (hasTable(db, 'email_outbox')) {
      db.prepare(
        "UPDATE email_outbox SET status='held', lease_until=NULL, next_attempt_at=NULL, updated_at=?, last_error='Database restored. Review provider delivery history before retrying.' WHERE status IN ('queued','sending')",
      ).run(timestamp);
      db.prepare(
        "UPDATE email_outbox SET status='failed', payload='{}', lease_until=NULL, next_attempt_at=NULL, updated_at=?, last_error='Reset link invalidated by database recovery. Request a new link.' WHERE kind='password_reset' AND status!='sent'",
      ).run(timestamp);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS ops_recovery_state (
      id INTEGER PRIMARY KEY CHECK(id=1), status TEXT NOT NULL CHECK(status IN ('pending','reviewed')),
      restored_at TEXT NOT NULL, backup_sha256 TEXT NOT NULL, reviewed_at TEXT
    )`);
    db.prepare(
      "INSERT INTO ops_recovery_state(id,status,restored_at,backup_sha256,reviewed_at) VALUES(1,'pending',?,?,NULL) ON CONFLICT(id) DO UPDATE SET status='pending', restored_at=excluded.restored_at, backup_sha256=excluded.backup_sha256, reviewed_at=NULL",
    ).run(timestamp, checksum);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function acknowledgeDatabaseRecovery(db: DatabaseSync, acknowledged: boolean, now = new Date()) {
  if (!acknowledged) throw new Error('Recovery requires an explicit reconciliation acknowledgement.');
  if (!hasTable(db, 'ops_recovery_state'))
    throw new Error('This database has no recovery review to release.');
  const result = db
    .prepare("UPDATE ops_recovery_state SET status='reviewed', reviewed_at=? WHERE id=1 AND status='pending'")
    .run(now.toISOString());
  if (!result.changes) throw new Error('This recovery review has already been released or is unavailable.');
}
