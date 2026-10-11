import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';
import { createBackend } from '../../src/services/backend.js';
import { createLogger } from '../../src/services/operations/logger.js';

export const integrationEnabled = Boolean(process.env.MONGODB_TEST_URI);

/**
 * Every integration test receives its own database and backup directory.
 * The configured URI supplies the server only; its default database is never used.
 * Cleanup is restricted to the random database allocated by this fixture.
 */
export async function createFixture(t, options = {}) {
  const testUri = process.env.MONGODB_TEST_URI;
  assert.ok(testUri, 'Set MONGODB_TEST_URI to a test replica set.');
  const databaseName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
  const backupDirectory = await mkdtemp(join(tmpdir(), 'venturecore-test-'));
  const instances = [];
  const environment = {
    NODE_ENV: 'test',
    BACKUP_ENABLED: 'false',
    ...options.environment,
    MONGODB_URI: testUri,
    MONGODB_DATABASE: databaseName,
    DATABASE_BACKUP_DIR: backupDirectory,
  };

  let cleaning;
  t.after(() => {
    cleaning ??= (async () => {
      const errors = [];
      const attempt = async (action) => {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      };
      for (const { server } of instances)
        await attempt(async () => {
          if (!server.listening) return;
          const closed = new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          // The test is over: browser preconnects that never sent a request are not
          // "idle" to Node and would otherwise hold close() open until headersTimeout.
          server.closeAllConnections();
          await closed;
        });
      // Stop workers and their connections before removing the allocated namespace.
      for (const { backend } of instances) await attempt(() => backend.close());
      await attempt(async () => {
        // Setup can reject after seeding, before any backend enters instances.
        // Use the captured test URI and exact generated name, never mutable app settings
        // or the URI's default database, even when no successful backend is available.
        assert.match(databaseName, /^venturecore_test_[a-f0-9]{32}$/);
        const client = new MongoClient(testUri, {
          serverSelectionTimeoutMS: 5_000,
          connectTimeoutMS: 5_000,
          socketTimeoutMS: 5_000,
        });
        try {
          await client.connect();
          await client.db(databaseName).dropDatabase();
        } finally {
          await attempt(() => client.close());
        }
      });
      await attempt(() => rm(backupDirectory, { recursive: true, force: true }));
      if (errors.length) throw new AggregateError(errors, 'Test fixture cleanup failed.');
    })();
    return cleaning;
  });

  async function startInstance() {
    const backend = await createBackend({
      ...options,
      logger: options.logger ?? createLogger({ write: () => {} }),
      environment,
    });
    const server = backend.app.listen(0, '127.0.0.1');
    instances.push({ backend, server });
    await Promise.all([
      backend.initialize(),
      new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      }),
    ]);
    return { backend, server, base: `http://127.0.0.1:${server.address().port}` };
  }

  return { ...(await startInstance()), environment, startInstance };
}
