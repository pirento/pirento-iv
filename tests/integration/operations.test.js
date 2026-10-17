/** Integration tests: HTTP readiness, recovery hold, request diagnostics and graceful shutdown with MongoDB. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createApplication } from '../../src/app.js';
import { createLogger } from '../../src/services/operations/logger.js';
import { createReadiness } from '../../src/services/operations/readiness.js';
import { createHttpRuntime } from '../../src/services/operations/http-runtime.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test(
  'HTTP readiness, recovery and request diagnostics use live MongoDB without leaking input',
  options,
  async (t) => {
    const records = [];
    const logger = createLogger({ write: (line) => records.push(JSON.parse(line)) });
    const fixture = await createFixture(t, {
      logger,
      environment: {
        INITIAL_ADMIN_EMAIL: 'diagnostics@example.test',
        INITIAL_ADMIN_PASSWORD: 'DiagnosticsOwnerPassword$2026',
        INITIAL_ADMIN_NAME: 'Diagnostics Administrator',
      },
    });
    const { base, backend } = fixture;
    const health = await fetch(`${base}/api/health`);
    assert.deepEqual(await health.json(), { ok: true }, 'Existing anonymous liveness contract is unchanged');
    assert.match(health.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    let response = await fetch(`${base}/api/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      ready: true,
      state: 'ready',
      checks: { database: 'up', recovery: 'clear' },
    });

    await backend.db
      .collection('ops_recovery_state')
      .updateOne(
        { id: 1 },
        { $set: { status: 'pending', backup_sha256: 'DO_NOT_EXPOSE_RECOVERY_METADATA' } },
        { upsert: true },
      );
    response = await fetch(`${base}/api/ready`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.deepEqual(await response.json(), {
      ok: false,
      ready: false,
      state: 'recovery_required',
      checks: { database: 'up', recovery: 'pending' },
    });
    await backend.db.collection('ops_recovery_state').updateOne({ id: 1 }, { $set: { status: 'reviewed' } });
    assert.equal((await fetch(`${base}/api/ready`)).status, 200);

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'diagnostics@example.test', password: 'DiagnosticsOwnerPassword$2026' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const secret = 'DO_NOT_EXPOSE_DIAGNOSTIC_SECRET';
    const original = backend.db.models.organizations.list;
    backend.db.models.organizations.list = async () => {
      const error = new Error(`mongodb+srv://owner:${secret}@private.example/db`);
      error.body = { password: secret };
      error.code = secret;
      throw error;
    };
    try {
      response = await fetch(`${base}/api/organizations?token=${secret}`, {
        headers: { Cookie: cookie, 'X-Request-ID': secret, Authorization: secret },
      });
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.deepEqual(result, {
        error: 'Unable to complete the request. Please try again.',
        requestId: response.headers.get('x-request-id'),
      });
      assert.notEqual(result.requestId, secret);
      const failed = records.find(
        (record) => record.event === 'request_failed' && record.requestId === result.requestId,
      );
      assert.equal(failed.route, '/api/organizations');
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.errorType, 'Error');
      assert.equal(
        records.some(
          (record) => record.event === 'request_completed' && record.requestId === result.requestId,
        ),
        true,
      );
    } finally {
      backend.db.models.organizations.list = original;
    }
    response = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: secret, password: secret }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes(secret), false);
    assert.equal(JSON.stringify(records).includes(secret), false);
    assert.equal(JSON.stringify(records).includes('DiagnosticsOwnerPassword'), false);
    assert.equal(JSON.stringify(records).includes('DO_NOT_EXPOSE_RECOVERY_METADATA'), false);

    // Exercise the native driver after its real connection closes; stale successful
    // probes must never be reused as a current connectivity result.
    const client = new MongoClient(process.env.MONGODB_TEST_URI);
    await client.connect();
    const database = client.db(backend.db.database.databaseName);
    const disconnected = createReadiness({
      logger,
      db: { database, collection: (name) => database.collection(name) },
    });
    disconnected.markReady();
    assert.equal((await disconnected.check()).ready, true);
    await client.close();
    const started = performance.now();
    assert.equal((await disconnected.check()).state, 'unavailable');
    assert.ok(performance.now() - started < 2_500);

    backend.beginShutdown();
    response = await fetch(`${base}/api/ready`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).state, 'draining');
    response = await fetch(`${base}/api/organizations`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'SERVICE_DRAINING');
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  },
);

test(
  'Graceful HTTP shutdown drains an accepted request and current email before closing MongoDB',
  options,
  async (t) => {
    const databaseName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
    const backupDirectory = await mkdtemp(join(tmpdir(), 'venturecore-shutdown-test-'));
    const records = [];
    const logger = createLogger({ write: (line) => records.push(JSON.parse(line)) });
    let application;
    let setup;
    let runtime;
    let releaseEmail;
    let notifyEmail;
    const emailStarted = new Promise((resolve) => {
      notifyEmail = resolve;
    });
    let emailCalls = 0;
    t.after(async () => {
      releaseEmail?.(Response.json({ id: 'synthetic-cleanup' }));
      if (setup?.server.listening) await new Promise((resolve) => setup.server.close(resolve));
      await runtime?.stop();
      await application?.close();
      const cleanup = new MongoClient(process.env.MONGODB_TEST_URI);
      try {
        await cleanup.connect();
        assert.match(databaseName, /^venturecore_test_[a-f0-9]{32}$/);
        await cleanup.db(databaseName).dropDatabase();
      } finally {
        await cleanup.close();
        await rm(backupDirectory, { recursive: true, force: true });
      }
    });
    application = await createApplication({
      auth: false,
      logger,
      environment: {
        NODE_ENV: 'test',
        MONGODB_URI: process.env.MONGODB_TEST_URI,
        MONGODB_DATABASE: databaseName,
        DATABASE_BACKUP_DIR: backupDirectory,
        BACKUP_ENABLED: 'false',
        EMAIL_AUTOMATION: 'true',
        RESEND_API_KEY: 'synthetic_shutdown_test_key',
        EMAIL_FROM: 'Billing <billing@example.test>',
      },
      emailFetch: async (url) => {
        assert.equal(url, 'https://api.resend.com/emails');
        emailCalls++;
        notifyEmail();
        return new Promise((resolve) => {
          releaseEmail = resolve;
        });
      },
    });
    setup = await listen(application.app);
    async function post(path, body) {
      const response = await fetch(`${setup.base}/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      assert.equal(response.status, 201, JSON.stringify(data));
      return data;
    }
    const buyer = await post('/customers', {
      organizationId: 'pipeline2-legal',
      name: 'Shutdown Recipient',
      email: 'recipient@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    });
    for (let index = 0; index < 2; index++)
      await post('/documents', {
        organizationId: buyer.organizationId,
        customerId: buyer.id,
        kind: 'invoice',
        status: 'sent',
        issueDate: '2026-10-10',
        dueDate: '',
        title: `Shutdown test invoice ${index + 1}`,
        items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
        requestId: randomUUID(),
      });
    await new Promise((resolve) => setup.server.close(resolve));
    let closed = false;
    const close = application.close;
    application.close = async () => {
      closed = true;
      await close();
    };
    runtime = createHttpRuntime(application, { host: '127.0.0.1', port: 0, shutdownGraceMs: 8_000 });
    await runtime.ready;
    await emailStarted;
    const base = `http://127.0.0.1:${runtime.server.address().port}`;
    let notifyRequest;
    let releaseRequest;
    const requestStarted = new Promise((resolve) => {
      notifyRequest = resolve;
    });
    const pendingRequest = new Promise((resolve) => {
      releaseRequest = resolve;
    });
    const list = application.db.models.organizations.list;
    application.db.models.organizations.list = async () => {
      notifyRequest();
      await pendingRequest;
      return list();
    };
    const response = fetch(`${base}/api/organizations`);
    await requestStarted;
    const stopped = runtime.stop('SIGTERM');
    assert.equal((await application.readiness.check()).state, 'draining');
    assert.equal(closed, false);
    releaseRequest();
    assert.equal((await response).status, 200, 'An already accepted request completes during shutdown');
    assert.equal(closed, false, 'Database remains open until the provider delivery completes');
    releaseEmail(Response.json({ id: 'synthetic_shutdown_delivery' }));
    assert.deepEqual(await stopped, { forced: false, failed: false });
    assert.equal(closed, true);
    assert.equal(emailCalls, 1, 'Shutdown prevents the second queued message from being claimed');
    assert.equal((await application.readiness.check()).state, 'stopped');
    const inspect = new MongoClient(process.env.MONGODB_TEST_URI);
    try {
      await inspect.connect();
      const messages = await inspect.db(databaseName).collection('email_outbox').find({}).toArray();
      assert.deepEqual(messages.map((message) => message.status).sort(), ['queued', 'sent']);
    } finally {
      await inspect.close();
    }
    assert.equal(
      records.some((record) => record.event === 'shutdown_completed' && record.forced === false),
      true,
    );
    assert.equal(
      records.some((record) => record.event === 'shutdown_timeout'),
      false,
    );
  },
);

test(
  'The production server entry point handles SIGTERM with structured lifecycle events',
  options,
  async (t) => {
    const databaseName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
    const backupDirectory = await mkdtemp(join(tmpdir(), 'venturecore-signal-test-'));
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const records = [];
    let stderr = '';
    let buffer = '';
    let notifyListening;
    let rejectListening;
    const listening = new Promise((resolve, reject) => {
      notifyListening = resolve;
      rejectListening = reject;
    });
    const child = spawn(process.execPath, ['server.js'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        HOST: '127.0.0.1',
        MONGODB_URI: process.env.MONGODB_TEST_URI,
        MONGODB_DATABASE: databaseName,
        DATABASE_BACKUP_DIR: backupDirectory,
        BACKUP_ENABLED: 'false',
        INITIAL_ADMIN_EMAIL: 'signal-owner@example.test',
        INITIAL_ADMIN_PASSWORD: 'SignalOwnerPassword$2026',
        INITIAL_ADMIN_NAME: 'Signal Test Owner',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line);
          records.push(record);
          if (record.event === 'server_listening') notifyListening();
        } catch {
          rejectListening(new Error('The server emitted an unstructured log record.'));
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectListening);
    const exited = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        rejectListening(new Error('The server exited before listening.'));
        resolve({ code, signal });
      }),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      const cleanup = new MongoClient(process.env.MONGODB_TEST_URI);
      try {
        await cleanup.connect();
        assert.match(databaseName, /^venturecore_test_[a-f0-9]{32}$/);
        await cleanup.db(databaseName).dropDatabase();
      } finally {
        await cleanup.close();
        await rm(backupDirectory, { recursive: true, force: true });
      }
    });
    await listening;
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/ready`)).status, 200);
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(stderr, '');
    assert.equal(records.filter((record) => record.event === 'shutdown_started').length, 1);
    assert.equal(records.filter((record) => record.event === 'shutdown_completed').length, 1);
    assert.equal(
      records.some((record) => record.event === 'shutdown_timeout'),
      false,
    );
    assert.equal(JSON.stringify(records).includes('SignalOwnerPassword'), false);
    assert.equal(JSON.stringify(records).includes(process.env.MONGODB_TEST_URI), false);
  },
);
