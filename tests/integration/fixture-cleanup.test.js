/** Integration tests: the test fixture always removes its own database and files, even after errors. */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createFixture, integrationEnabled } from './fixture.js';

const testName = /^venturecore_test_[a-f0-9]{32}$/;

test(
  'rejected fixture initialization removes its seeded database and preserves another test namespace',
  { skip: !integrationEnabled },
  async (t) => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI);
    await client.connect();
    const controlName = `venturecore_test_${randomUUID().replaceAll('-', '')}`;
    let fixtureName;
    const callbacks = [];
    t.after(async () => {
      try {
        for (const callback of callbacks) await callback().catch(() => {});
        for (const name of [controlName, fixtureName].filter(Boolean)) {
          assert.match(name, testName);
          await client.db(name).dropDatabase();
        }
      } finally {
        await client.close();
      }
    });
    await client.db(controlName).collection('sentinel').insertOne({ id: 'preserve-me' });

    // Observe the real driver's database selection without replacing database behavior.
    // This identifies only this fixture, even if other test files run concurrently.
    const names = new Set();
    const originalDb = MongoClient.prototype.db;
    const observeDb = t.mock.method(MongoClient.prototype, 'db', function (...args) {
      const database = Reflect.apply(originalDb, this, args);
      if (testName.test(database.databaseName)) names.add(database.databaseName);
      return database;
    });
    try {
      await assert.rejects(
        createFixture(
          { after: (callback) => callbacks.push(callback) },
          { environment: { GST_PROVIDER: 'invalid-for-cleanup-test', MONGODB_DATABASE: controlName } },
        ),
        /GST_PROVIDER must be portal, generic or sandbox/,
      );
    } finally {
      observeDb.mock.restore();
      fixtureName = [...names][0];
    }
    assert.equal(names.size, 1);
    assert.match(fixtureName, testName);
    assert.notEqual(fixtureName, controlName);
    const collections = () => client.db(fixtureName).listCollections({}, { nameOnly: true }).toArray();
    assert.ok((await collections()).length > 0, 'The rejected initialization created real collections.');
    assert.equal(callbacks.length, 1);

    await callbacks[0]();
    assert.deepEqual(await collections(), [], 'Cleanup must remove a database created before rejection.');
    assert.equal(
      await client.db(controlName).collection('sentinel').countDocuments({ id: 'preserve-me' }),
      1,
    );
  },
);

test(
  'fixture cleanup attempts every resource after server and backend shutdown errors',
  { skip: !integrationEnabled },
  async (t) => {
    const callbacks = [];
    let fixture;
    let second;
    let closeFirst;
    let closeSecond;
    const client = new MongoClient(process.env.MONGODB_TEST_URI);
    await client.connect();
    t.after(async () => {
      try {
        for (const callback of callbacks) await callback().catch(() => {});
        await Promise.allSettled([closeFirst?.(), closeSecond?.()]);
        if (fixture) {
          assert.match(fixture.backend.db.database.databaseName, testName);
          await client.db(fixture.backend.db.database.databaseName).dropDatabase();
          await rm(fixture.environment.DATABASE_BACKUP_DIR, { recursive: true, force: true });
        }
      } finally {
        await client.close();
      }
    });
    fixture = await createFixture({ after: (callback) => callbacks.push(callback) }, { auth: false });
    second = await fixture.startInstance();
    const databaseName = fixture.backend.db.database.databaseName;
    const backupDirectory = fixture.environment.DATABASE_BACKUP_DIR;
    const closeServer = fixture.server.close.bind(fixture.server);
    closeFirst = fixture.backend.close.bind(fixture.backend);
    closeSecond = second.backend.close.bind(second.backend);
    let secondClosed = false;
    fixture.server.close = (callback) =>
      closeServer(() => callback(new Error('Controlled server shutdown failure.')));
    fixture.backend.close = async () => {
      await closeFirst();
      throw new Error('Controlled backend shutdown failure.');
    };
    second.backend.close = async () => {
      await closeSecond();
      secondClosed = true;
    };
    // Cleanup must not follow settings changed after fixture allocation.
    fixture.environment.MONGODB_DATABASE = 'do_not_use_mutable_database_name';
    fixture.environment.MONGODB_URI = 'do_not_use_mutable_database_uri';
    assert.ok(existsSync(backupDirectory));

    await assert.rejects(callbacks[0](), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.message),
        ['Controlled server shutdown failure.', 'Controlled backend shutdown failure.'],
      );
      return true;
    });
    assert.equal(fixture.server.listening, false);
    assert.equal(second.server.listening, false);
    assert.equal(secondClosed, true);
    assert.deepEqual(await client.db(databaseName).listCollections({}, { nameOnly: true }).toArray(), []);
    assert.equal(existsSync(backupDirectory), false);
  },
);
