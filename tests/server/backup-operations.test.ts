import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
const { runDatabaseCommand } = await import(new URL('../../scripts/database.mjs', import.meta.url).href);
import { assertDatabaseRecoveryReviewed } from '../../server/operations/recovery.ts';
import { createBackupManager } from '../../server/operations/backup-scheduler.ts';

const owner = { email: 'backup-owner@example.test', password: 'Synthetic backup owner password' };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'venture-backup-api-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const backupsPath = join(directory, 'backups');
  const db = initDb(databasePath);
  const app = createApp({
    db,
    environment: {
      DATABASE_BACKUP_DIR: backupsPath,
      INITIAL_ADMIN_EMAIL: owner.email,
      INITIAL_ADMIN_PASSWORD: owner.password,
    },
  });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.locals.services.backups.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function login(account = owner) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  const cookie = await login();
  const call = (path: string, method = 'GET', session: string | undefined = cookie, body = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(session ? { Cookie: session } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
  return { directory, databasePath, backupsPath, db, app, base, cookie, call, login };
}

test('all-workspace snapshots are admin-only, verified, downloadable with a manifest and never public assets', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/backups')).status, 401);
  assert.equal((await fetch(f.base + '/api/backups/status')).status, 401);
  assert.deepEqual(await (await fetch(f.base + '/api/health')).json(), { ok: true });
  const status = await (await f.call('/api/backups/status')).json();
  assert.equal(status.enabled, false);
  assert.equal(status.remoteConfigured, false);
  assert.equal(JSON.stringify(status).includes(f.directory), false);
  const created = await f.call('/api/backups', 'POST');
  assert.equal(created.status, 201);
  const metadata = await created.json();
  assert.equal(metadata.verified, true);
  assert.equal(metadata.sha256.length, 64);
  assert.equal(JSON.stringify(metadata).includes(owner.password), false);
  assert.deepEqual(
    (await (await f.call('/api/backups')).json()).map((row: { id: string }) => row.id),
    [metadata.id],
  );
  assert.equal((await f.call('/api/backups', 'POST')).status, 429);
  const download = await f.call(`/api/backups/${metadata.id}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.match(download.headers.get('content-disposition')!, /attachment/);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(bytes.byteLength, metadata.byteLength);
  const manifestResponse = await f.call(`/api/backups/${metadata.id}/manifest`);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.database.sha256, metadata.sha256);
  assert.equal(manifest.database.file, 'database.sqlite');
  const outsider = await fetch(f.base + `/api/backups/${metadata.id}/download`);
  assert.equal(outsider.status, 401);
  const staff = { email: 'backup-staff@example.test', password: 'Synthetic backup staff password' };
  await fetch(f.base + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...staff, name: 'Synthetic staff' }),
  });
  f.db.prepare("UPDATE auth_users SET status='active',organization_ids='[]' WHERE email=?").run(staff.email);
  const staffCookie = await f.login(staff);
  for (const path of [
    '/api/backups',
    '/api/backups/status',
    `/api/backups/${metadata.id}/download`,
    `/api/backups/${metadata.id}/manifest`,
  ])
    assert.equal((await f.call(path, 'GET', staffCookie)).status, 403);
  assert.equal((await f.call('/api/backups', 'POST', staffCookie)).status, 403);
  writeFileSync(join(f.backupsPath, metadata.id, 'database.sqlite'), 'SYNTHETIC_TAMPERED_DATABASE');
  const corrupted = await f.call(`/api/backups/${metadata.id}/download`);
  assert.equal(corrupted.status, 503);
  assert.equal((await corrupted.text()).includes('SYNTHETIC_TAMPERED_DATABASE'), false);
});

test('restore creates a new reviewed-offline file, preserves financial identity, revokes tokens and holds notifications', async (t) => {
  const f = await fixture(t);
  const organizationId = (f.db.prepare('SELECT id FROM organizations LIMIT 1').get() as { id: string }).id;
  f.db
    .prepare('INSERT INTO customers(id,organization_id,data) VALUES(?,?,?)')
    .run('synthetic-customer', organizationId, '{"name":"Synthetic buyer"}');
  const snapshot = '{"status":"paid","finalizedAt":"2026-10-09T01:00:00.000Z","total":15000}';
  f.db
    .prepare('INSERT INTO documents(id,organization_id,customer_id,kind,number,data) VALUES(?,?,?,?,?,?)')
    .run(
      'synthetic-invoice',
      organizationId,
      'synthetic-customer',
      'invoice',
      'SYNTHETIC/2627/0001',
      snapshot,
    );
  f.db
    .prepare('INSERT INTO sequences(organization_id,kind,fiscal_year,value) VALUES(?,?,?,?)')
    .run(organizationId, 'invoice', '2627', 1);
  const userId = (f.db.prepare('SELECT id FROM auth_users LIMIT 1').get() as { id: string }).id;
  f.db
    .prepare('INSERT INTO auth_password_resets(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run('synthetic-reset-hash', userId, Date.now() + 3600, Date.now());
  const insert = f.db.prepare(
    'INSERT INTO email_outbox(id,event_key,kind,recipient,subject,status,attempts,created_at,updated_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  for (const [id, status, kind] of [
    ['queued', 'queued', 'invoice'],
    ['sending', 'sending', 'payment'],
    ['sent', 'sent', 'invoice'],
    ['reset', 'queued', 'password_reset'],
  ])
    insert.run(
      id,
      id,
      kind,
      'synthetic@example.test',
      'Synthetic message',
      status,
      2,
      '2026-10-09T01:00:00Z',
      '2026-10-09T01:00:00Z',
      '{"sample":"private synthetic token"}',
    );
  const backupResult = await runDatabaseCommand(
    'backup',
    ['--database', f.databasePath, '--directory', f.backupsPath],
    { environment: {} },
  );
  const id = backupResult.backup.id;
  const target = join(f.directory, 'recovered', 'workspace.sqlite');
  const sourceBefore = readFileSync(f.databasePath);
  const result = await runDatabaseCommand(
    'restore',
    ['--backup', id, '--directory', f.backupsPath, '--target', target],
    { environment: {} },
  );
  assert.equal(result.recoveryRequired, true);
  assert.deepEqual(readFileSync(f.databasePath), sourceBefore, 'source database file is never overwritten');
  const recovered = new DatabaseSync(target);
  assert.equal((recovered.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number }).n, 0);
  assert.equal(
    (recovered.prepare('SELECT COUNT(*) AS n FROM auth_password_resets').get() as { n: number }).n,
    0,
  );
  assert.equal(
    (recovered.prepare('SELECT data FROM documents WHERE id=?').get('synthetic-invoice') as { data: string })
      .data,
    snapshot,
  );
  assert.equal((recovered.prepare('SELECT value FROM sequences').get() as { value: number }).value, 1);
  assert.equal(
    (recovered.prepare('SELECT status FROM email_outbox WHERE id=?').get('queued') as { status: string })
      .status,
    'held',
  );
  assert.equal(
    (recovered.prepare('SELECT status FROM email_outbox WHERE id=?').get('sending') as { status: string })
      .status,
    'held',
  );
  assert.equal(
    (recovered.prepare('SELECT status FROM email_outbox WHERE id=?').get('sent') as { status: string })
      .status,
    'sent',
  );
  assert.equal(
    (recovered.prepare('SELECT payload FROM email_outbox WHERE id=?').get('reset') as { payload: string })
      .payload,
    '{}',
  );
  assert.throws(() => assertDatabaseRecoveryReviewed(recovered), /recovery review/);
  assert.throws(() => createApp({ db: recovered, environment: {} }), /recovery review/);
  recovered.close();
  await assert.rejects(
    runDatabaseCommand('restore', ['--backup', id, '--directory', f.backupsPath, '--target', target], {
      environment: {},
    }),
    /new target/,
  );
  await assert.rejects(
    runDatabaseCommand('resume', ['--database', target], { environment: {} }),
    /acknowledging recovery/,
  );
  assert.equal(
    (
      await runDatabaseCommand('resume', ['--database', target, '--acknowledge-reconciliation'], {
        environment: {},
      })
    ).recoveryReviewed,
    true,
  );
  const released = new DatabaseSync(target);
  assert.doesNotThrow(() => assertDatabaseRecoveryReviewed(released));
  assert.equal(
    (released.prepare('SELECT status FROM email_outbox WHERE id=?').get('queued') as { status: string })
      .status,
    'held',
  );
  released.close();
});

test('backup storage cannot be configured inside frontend static assets', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'venture-backup-static-'));
  mkdirSync(join(root, 'dist'));
  const db = initDb(':memory:');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['backups', '..leak'])
    assert.throws(
      () =>
        createApp({
          db,
          distPath: join(root, 'dist'),
          environment: { DATABASE_BACKUP_DIR: join(root, 'dist', name) },
        }),
      /private directory/,
    );
});

test('automatic backup scheduler waits for due snapshots, avoids overlap, reports failure and drains on shutdown', async () => {
  let time = new Date('2026-10-09T00:00:00Z');
  let count = 0;
  let reject = false;
  let release: (() => void) | undefined;
  const service = {
    async listBackups() {
      return [{ createdAt: time.toISOString() }] as any[];
    },
    async createBackup() {
      count++;
      if (reject) throw new Error('synthetic failure');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { createdAt: time.toISOString() } as any;
    },
    async waitForIdle() {},
  };
  const manager = createBackupManager({
    service,
    enabled: true,
    intervalMinutes: 1440,
    retention: 7,
    now: () => time,
  });
  await manager.initialize();
  await manager.tick();
  assert.equal(count, 0);
  time = new Date(time.getTime() + 24 * 60 * 60_000);
  const first = manager.tick();
  await Promise.resolve();
  await manager.tick();
  assert.equal(count, 1);
  assert.equal(manager.status().running, true);
  release!();
  await first;
  assert.equal(manager.status().running, false);
  reject = true;
  time = new Date(time.getTime() + 24 * 60 * 60_000);
  await assert.rejects(manager.tick());
  assert.equal(manager.status().lastFailure, true);
  reject = false;
  const pending = manager.create();
  const shutdown = manager.stop();
  release!();
  await pending;
  await shutdown;
  await assert.rejects(manager.create(), /stopping/);
});
