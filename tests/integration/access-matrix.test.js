/** Integration tests: who may reach the newer endpoints (settings, AI, HSN lookup, test email, letterhead). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 180_000,
};
const owner = { email: 'matrix-admin@example.test', password: 'MatrixAdminPassword2026!' };

test('each login reaches only what its access level and businesses allow', options, async (t) => {
  const { base, backend } = await createFixture(t, {
    environment: { INITIAL_ADMIN_EMAIL: owner.email, INITIAL_ADMIN_PASSWORD: owner.password },
  });
  attachPageRoutes(backend);
  const request = async (path, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
  };
  const admin = (await request('/api/auth/login', { method: 'POST', body: owner })).cookie;
  const mine = 'at-elevators';
  const other = 'pipeline2-legal';
  const logins = {};
  for (const permission of ['full', 'view', 'accounts', 'owner']) {
    const account = { email: `${permission}@example.test`, password: 'MatrixStaffPassword2026!' };
    const created = await request('/api/auth/users', {
      method: 'POST',
      cookie: admin,
      body: { ...account, name: `Staff ${permission}`, role: 'staff', organizationIds: [mine], permission },
    });
    assert.equal(created.status, 201);
    logins[permission] = (await request('/api/auth/login', { method: 'POST', body: account })).cookie;
  }
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const letterhead = { image: pixel, top: 40, bottom: 30, left: 15, right: 15, defaultOn: false };
  // [path, method, body, expected status per login: none (signed out), full, view, accounts, owner]
  const cases = [
    [`/api/hsn-gst?organizationId=${mine}&hsn=8428`, 'GET', undefined, [401, 200, 200, 200, 200]],
    [`/api/hsn-gst?organizationId=${other}&hsn=8428`, 'GET', undefined, [401, 403, 403, 403, 403]],
    [`/api/integrations/${mine}/settings`, 'GET', undefined, [401, 403, 403, 403, 200]],
    [`/api/integrations/${other}/settings`, 'GET', undefined, [401, 403, 403, 403, 403]],
    [`/api/integrations/${mine}/settings`, 'PUT', { EMAIL_FROM: '' }, [401, 403, 403, 403, 200]],
    [`/api/integrations/${other}/settings`, 'PUT', { EMAIL_FROM: '' }, [401, 403, 403, 403, 403]],
    [`/api/integrations/${other}/test-email`, 'POST', { to: 'a@example.test' }, [401, 403, 403, 403, 403]],
    [`/api/integrations/${mine}/test-email`, 'POST', { to: 'a@example.test' }, [401, 403, 403, 403, 409]],
    ['/api/ai-settings', 'GET', undefined, [401, 403, 403, 403, 403]],
    ['/api/ai-settings', 'PUT', { apiKey: 'sk-x', model: 'gpt-4o-mini' }, [401, 403, 403, 403, 403]],
    ['/api/finance/ai/statement', 'POST', { text: 'Date | Credit' }, [401, 403, 403, 409, 403]],
    [`/api/letterheads/${mine}`, 'PUT', letterhead, [401, 403, 403, 403, 200]],
    [`/api/letterheads/${other}`, 'PUT', letterhead, [401, 403, 403, 403, 403]],
    ['/api/organizations', 'POST', {}, [401, 403, 403, 403, 403]],
    ['/api/auth/users', 'POST', {}, [401, 403, 403, 403, 403]],
    [`/workspace/${mine}/finance`, 'GET', undefined, [302, 403, 403, 200, 403]],
    [`/workspace/${other}/finance`, 'GET', undefined, [302, 403, 403, 403, 403]],
    [`/workspace/${mine}/integrations`, 'GET', undefined, [302, 403, 403, 403, 200]],
    [`/workspace/${mine}/team`, 'GET', undefined, [302, 403, 403, 403, 403]],
    [`/workspace/${other}/overview`, 'GET', undefined, [302, 403, 403, 302, 403]],
  ];
  for (const [path, method, body, expected] of cases)
    for (const [index, who] of ['none', 'full', 'view', 'accounts', 'owner'].entries()) {
      const { status } = await request(path, { method, body, cookie: logins[who] ?? '' });
      assert.equal(status, expected.at(index), `${who}: ${method} ${path}`);
    }
});
