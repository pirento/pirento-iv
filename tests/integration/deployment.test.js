/** Integration tests: hosted preflight never seeds or creates collections in an unintended empty database. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture, integrationEnabled } from './fixture.js';
import { inspectHostedDatabase, validateHostedProduction } from '../../scripts/hostinger-entry.js';

test(
  'hosted preflight reads an existing workspace and never seeds an empty database',
  { skip: !integrationEnabled },
  async (t) => {
    const fixture = await createFixture(t, {
      environment: {
        INITIAL_ADMIN_EMAIL: 'deployment-owner@example.test',
        INITIAL_ADMIN_NAME: 'Test owner',
        INITIAL_ADMIN_PASSWORD: 'TemporaryDeploymentTest123!',
      },
    });
    const environment = {
      ...fixture.environment,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://billing.example.test',
      TWO_STEP_KEY: 'a'.repeat(64),
    };
    assert.deepEqual(await inspectHostedDatabase(environment), {
      existing: true,
      activeAdmins: 1,
      recoveryPending: false,
    });
    assert.equal((await validateHostedProduction(environment)).existing, true);
    const emptyName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
    const client = new MongoClient(process.env.MONGODB_TEST_URI);
    await client.connect();
    try {
      const emptyEnvironment = { ...environment, MONGODB_DATABASE: emptyName };
      await assert.rejects(
        validateHostedProduction(emptyEnvironment),
        /Expected workspace database is empty/,
      );
      assert.equal((await client.db(emptyName).listCollections({}, { nameOnly: true }).toArray()).length, 0);
      assert.equal(
        (await validateHostedProduction({ ...emptyEnvironment, IV_ALLOW_NEW_DATABASE: 'true' })).existing,
        false,
      );
      assert.equal((await client.db(emptyName).listCollections({}, { nameOnly: true }).toArray()).length, 0);
    } finally {
      await client.close();
    }
  },
);

test(
  'normal production entry refuses an unintended empty database before creating any collections',
  { skip: !integrationEnabled },
  async () => {
    const databaseName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
    const directory = mkdtempSync(join(tmpdir(), 'venturecore-production-preflight-'));
    const client = new MongoClient(process.env.MONGODB_TEST_URI);
    await client.connect();
    try {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('../../server.js', import.meta.url))],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: {
            NODE_ENV: 'production',
            MONGODB_URI: process.env.MONGODB_TEST_URI,
            MONGODB_DATABASE: databaseName,
            PUBLIC_APP_URL: 'https://preflight.example.test',
            TWO_STEP_KEY: 'a'.repeat(64),
            INITIAL_ADMIN_EMAIL: '',
            INITIAL_ADMIN_PASSWORD: '',
            IV_ALLOW_NEW_DATABASE: 'false',
            DATABASE_BACKUP_DIR: directory,
            BACKUP_ENABLED: 'false',
            HOST: '127.0.0.1',
            PORT: '3001',
          },
          encoding: 'utf8',
          timeout: 20_000,
          killSignal: 'SIGKILL',
          maxBuffer: 128 * 1024,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(events.some((row) => row.event === 'server_start_failed' && row.stage === 'environment'));
      assert.equal(
        events.some((row) => row.event === 'server_listening'),
        false,
      );
      const collections = await client.db(databaseName).listCollections({}, { nameOnly: true }).toArray();
      assert.deepEqual(collections, []);
    } finally {
      // Only this test's newly allocated random namespace is eligible for cleanup.
      assert.match(databaseName, /^venturecore_test_[a-f0-9]{32}$/);
      await client.db(databaseName).dropDatabase();
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
