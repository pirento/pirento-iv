/** Integration tests: the per-login request limit for paid endpoints, counted in MongoDB. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageLimit } from '../../src/middleware/usage-limit.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 60_000,
};

test('a login shares one allowance across servers and gets it back after the window', options, async (t) => {
  const { backend } = await createFixture(t, { auth: false });
  // Two middlewares stand for two servers using the same database.
  const settings = { db: backend.db, scope: 'test', maximum: 2, windowMs: 1500 };
  const servers = [createUsageLimit(settings), createUsageLimit(settings)];
  const request = async (server, userId) => {
    const result = { status: 200, headers: {} };
    const res = {
      locals: { user: { id: userId } },
      set: (name, value) => (result.headers[name] = value),
      status: (code) => ((result.status = code), { json: () => {} }),
    };
    await servers.at(server)({ ip: '127.0.0.1' }, res, (error) => {
      if (error) throw error;
    });
    return result;
  };
  assert.equal((await request(0, 'a')).status, 200);
  assert.equal((await request(1, 'a')).status, 200);
  const refused = await request(0, 'a');
  assert.equal(refused.status, 429, 'the third request is refused on either server');
  assert.match(refused.headers['Retry-After'], /^[12]$/);
  assert.equal((await request(1, 'a')).status, 429);
  assert.equal((await request(1, 'b')).status, 200, 'another login has its own allowance');
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal((await request(0, 'a')).status, 200, 'allowed again when the window has passed');
});
