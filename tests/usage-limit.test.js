/** Unit tests: the per-login request limit for paid endpoints. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageLimit } from '../src/middleware/usage-limit.js';

test('a login is refused after its allowance and allowed again when the window has passed', () => {
  let time = 1_000_000;
  const limit = createUsageLimit({ maximum: 2, windowMs: 60_000, now: () => time });
  const request = (userId) => {
    const result = { status: 200, headers: {} };
    const res = {
      locals: { user: { id: userId } },
      set: (name, value) => (result.headers[name] = value),
      status: (code) => ((result.status = code), { json: () => {} }),
    };
    limit({ ip: '127.0.0.1' }, res, () => {});
    return result;
  };
  assert.equal(request('a').status, 200);
  assert.equal(request('a').status, 200);
  const refused = request('a');
  assert.deepEqual([refused.status, refused.headers['Retry-After']], [429, '60']);
  assert.equal(request('b').status, 200, 'another login has its own allowance');
  time += 60_001;
  assert.equal(request('a').status, 200);
});
