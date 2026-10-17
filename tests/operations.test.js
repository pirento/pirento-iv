/** Unit tests: structured logging, readiness probe and graceful shutdown. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger, safeErrorDetails } from '../src/services/operations/logger.js';
import { createReadiness } from '../src/services/operations/readiness.js';
import { createHttpRuntime } from '../src/services/operations/http-runtime.js';
import { HttpError } from '../src/middleware/errors.js';

const silentLogger = () => createLogger({ write: () => {} });

test('Structured logs use an allowlist and never serialize errors, credentials or request payloads', () => {
  const lines = [];
  const logger = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date('2026-10-10T12:00:00.000Z'),
  });
  const secret = 'DO_NOT_LOG_PRIVATE_VALUE';
  const error = Object.assign(new Error(`mongodb+srv://owner:${secret}@private.example/tenant`), {
    code: secret,
    cause: { password: secret },
    body: { apiKey: secret },
  });
  logger.error('request_failed', {
    error,
    requestId: '16ac99f2-c3ba-409c-9cf3-d293c6a2ee63',
    method: 'POST',
    route: '/api/documents/:id',
    statusCode: 500,
    durationMs: 42.123,
    url: `https://private.example/reset-password?token=${secret}`,
    headers: { authorization: secret },
    body: { secret },
  });
  logger.warn(secret, { requestId: secret, route: `mongodb://${secret}`, reason: secret, error: secret });
  assert.equal(
    lines.some((line) => line.includes(secret)),
    false,
  );
  assert.equal(
    lines.some((line) => /mongodb|https|stack|cause|authorization|apiKey/.test(line)),
    false,
  );
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: '2026-10-10T12:00:00.000Z',
    level: 'error',
    event: 'request_failed',
    requestId: '16ac99f2-c3ba-409c-9cf3-d293c6a2ee63',
    method: 'POST',
    route: '/api/documents/:id',
    statusCode: 500,
    durationMs: 42.12,
    errorType: 'Error',
  });
  assert.deepEqual(safeErrorDetails(new HttpError(409, secret, 'DOCUMENT_VERSION_CONFLICT')), {
    errorType: 'HttpError',
    errorCode: 'DOCUMENT_VERSION_CONFLICT',
  });
  assert.doesNotThrow(() =>
    createLogger({
      write: () => {
        throw error;
      },
    }).error('request_failed', { error }),
  );
});

test('Startup failures emit structured diagnostics without a stack or configured connection string', () => {
  const secret = 'DO_NOT_LOG_STARTUP_CREDENTIAL';
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      PORT: 'invalid-port',
      MONGODB_URI: `mongodb://owner:${secret}@private.example/workspace`,
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(secret), false);
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.event),
    ['server_starting', 'server_start_failed'],
  );
  assert.equal(records[1].stage, 'environment');
  assert.equal(records[1].errorType, 'Error');
});

test('Readiness requires initialization, live database and completed recovery review', async () => {
  let recovery;
  let commands = 0;
  const readiness = createReadiness({
    logger: silentLogger(),
    db: {
      database: {
        command: async () => {
          commands++;
        },
      },
      collection: () => ({ findOne: async () => recovery }),
    },
  });
  assert.deepEqual(await readiness.check(), { ok: false, ready: false, state: 'starting' });
  assert.equal(commands, 0);
  readiness.markReady();
  assert.deepEqual(await readiness.check(), {
    ok: true,
    ready: true,
    state: 'ready',
    checks: { database: 'up', recovery: 'clear' },
  });
  recovery = { status: 'pending' };
  assert.deepEqual(await readiness.check(), {
    ok: false,
    ready: false,
    state: 'recovery_required',
    checks: { database: 'up', recovery: 'pending' },
  });
  recovery.status = 'reviewed';
  assert.equal((await readiness.check()).ready, true);
  readiness.beginDrain();
  assert.equal((await readiness.check()).state, 'draining');
  readiness.markStopped();
  readiness.markReady();
  assert.equal((await readiness.check()).state, 'stopped');
});

test('Concurrent readiness requests share one bounded, cancellable database probe', async () => {
  let commands = 0;
  let aborted = false;
  const readiness = createReadiness({
    logger: silentLogger(),
    timeoutMs: 40,
    db: {
      database: {
        command: async (_command, options) => {
          commands++;
          assert.ok(options.timeoutMS <= 40);
          options.signal.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise(() => {});
        },
      },
      collection: () => ({
        findOne: async () => {
          throw new Error('Must not reach recovery without ping');
        },
      }),
    },
  });
  readiness.markReady();
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: 20 }, () => readiness.check()));
  assert.equal(commands, 1);
  assert.equal(aborted, true);
  assert.ok(performance.now() - started < 500);
  for (const response of responses) {
    assert.equal(response.ready, false);
    assert.equal(response.state, 'unavailable');
  }
});

test('A readiness probe cannot turn green after draining begins', async () => {
  let release;
  const readiness = createReadiness({
    logger: silentLogger(),
    timeoutMs: 100,
    db: {
      database: {
        command: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      collection: () => ({ findOne: async () => null }),
    },
  });
  readiness.markReady();
  const pending = readiness.check();
  readiness.beginDrain();
  release();
  assert.equal((await pending).state, 'draining');
});

test('HTTP shutdown has a deadline even when a background job never settles', async () => {
  const records = [];
  const logger = createLogger({ write: (line) => records.push(JSON.parse(line)) });
  let draining = false;
  let stopped = false;
  let forced = false;
  let releaseBackup;
  const pendingBackup = new Promise((resolve) => {
    releaseBackup = resolve;
  });
  const application = {
    app: express(),
    logger,
    beginShutdown: () => {
      draining = true;
    },
    readiness: {
      markStopped: () => {
        stopped = true;
      },
    },
    mailer: { processQueue: async () => {}, stop: async () => {} },
    backups: { start: () => {}, stop: () => pendingBackup },
    close: async () => {},
  };
  const runtime = createHttpRuntime(application, {
    host: '127.0.0.1',
    port: 0,
    shutdownGraceMs: 40,
    onForcedShutdown: () => {
      forced = true;
    },
  });
  await runtime.ready;
  const first = runtime.stop('SIGTERM');
  assert.equal(runtime.stop('SIGINT'), first);
  assert.equal(draining, true);
  const result = await first;
  assert.deepEqual(result, { forced: true, failed: true });
  assert.equal(stopped, true);
  assert.equal(forced, true);
  assert.equal(records.filter((record) => record.event === 'shutdown_timeout').length, 1);
  releaseBackup();
});
