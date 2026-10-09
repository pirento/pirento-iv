import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import type { AuthUser } from '../../shared/auth-types.ts';
import type {
  BusinessDocument,
  Customer,
  InvoiceFormat,
  Organization,
  PaymentDetails,
} from '../../shared/types.ts';

const ORG = 'pipeline2-legal';
const OTHER = 'at-facilities';
const OWNER = { email: 'owner@example.test', password: 'Owner secure integration password' };
const MEMBER = { email: 'member@example.test', password: 'Member secure integration password' };

async function fixture(t: TestContext) {
  const db = initDb(':memory:');
  const app = createApp({
    db,
    environment: { INITIAL_ADMIN_EMAIL: OWNER.email, INITIAL_ADMIN_PASSWORD: OWNER.password },
    distPath: '/tmp/venturecore-no-access-test-dist',
  });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function call(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }
  const login = await call('/api/auth/login', 'POST', OWNER);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const owner = login.cookie!;
  const signUp = await call('/api/auth/signup', 'POST', { ...MEMBER, name: 'Organization member' });
  assert.equal(signUp.status, 202);
  const users = (await call('/api/auth/users', 'GET', undefined, owner)).body as AuthUser[];
  const member = users.find((user) => user.email === MEMBER.email)!;
  const approved = await call(
    `/api/auth/users/${member.id}`,
    'PATCH',
    { role: 'staff', status: 'active', organizationIds: [ORG] },
    owner,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const memberLogin = await call('/api/auth/login', 'POST', MEMBER);
  assert.equal(memberLogin.status, 200);
  const staff = memberLogin.cookie!;
  async function customer(organizationId: string) {
    const saved = await call(
      '/api/customers',
      'POST',
      {
        organizationId,
        name: 'Company buyer',
        email: 'buyer@example.test',
        phone: '',
        gstin: '',
        address: 'Business address',
        stateCode: '09',
        contactPerson: '',
      },
      owner,
    );
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    return saved.body as Customer;
  }
  async function document(organizationId: string) {
    const savedCustomer = await customer(organizationId);
    const input = {
      organizationId,
      customerId: savedCustomer.id,
      kind: 'invoice',
      status: 'sent',
      issueDate: '2026-10-08',
      dueDate: '2026-10-30',
      title: 'Consulting invoice',
      items: [{ description: 'Consulting', hsn: '', quantity: 1, rate: 100, gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    };
    const response = await call('/api/documents', 'POST', input, owner);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { document: response.body as BusinessDocument, input };
  }
  return { db, app, call, owner, staff, member, customer, document };
}

test('application exposes only account endpoints and basic health before login; staff sees only assigned organizations', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/health')).body, { ok: true });
  assert.equal((await f.call('/api/auth/me')).body.user, null);
  for (const path of [
    '/api/organizations',
    '/api/workspace-settings',
    `/api/customers?organizationId=${ORG}`,
    '/api/integrations/status',
    '/api/gst/captcha',
  ]) {
    assert.equal((await f.call(path)).status, 401, path);
  }
  const organizations = (await f.call('/api/organizations', 'GET', undefined, f.staff))
    .body as Organization[];
  assert.deepEqual(
    organizations.map((item) => item.id),
    [ORG],
  );
  assert.equal(
    ((await f.call('/api/organizations', 'GET', undefined, f.owner)).body as Organization[]).length,
    6,
  );
  assert.equal(
    (await f.call(`/api/customers?organizationId=${OTHER}`, 'GET', undefined, f.staff)).status,
    403,
  );
  assert.equal(
    (await f.call(`/api/customers?organizationId=${ORG}&organizationId=${OTHER}`, 'GET', undefined, f.staff))
      .status,
    400,
  );
  for (const resource of ['constructor', '__proto__'])
    assert.equal((await f.call(`/api/${resource}/unknown`, 'GET', undefined, f.staff)).status, 404);
});

test('resource IDs and nested invoice routes cannot bypass organization permissions using uppercase paths or escaped IDs', async (t) => {
  const f = await fixture(t);
  const { document: other } = await f.document(OTHER);
  const { document: own } = await f.document(ORG);
  const escaped = `%${other.id.charCodeAt(0).toString(16)}${other.id.slice(1)}`;
  for (const path of [
    `/api/documents/${other.id}/payments`,
    `/api/Documents/${other.id}/payments`,
    `/api/documents/${escaped}/payments`,
    `/api/documents/${other.id}/messages`,
    `/api/Documents/${other.id}/online-payments`,
    `/api/documents/${escaped}/online-payments`,
  ]) {
    const result = await f.call(path, 'GET', undefined, f.staff);
    assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.body)}`);
  }
  assert.equal((await f.call(`/api/documents/${own.id}/payments`, 'GET', undefined, f.staff)).status, 200);
  assert.equal(
    (await f.call(`/api/documents/${own.id}/online-payments`, 'GET', undefined, f.staff)).status,
    200,
  );
  const payment = await f.call(
    `/api/documents/${other.id}/payments`,
    'POST',
    {
      amount: 10,
      paidOn: '2026-10-08',
      method: 'cash',
      reference: '',
      notes: '',
      requestId: 'access-other-payment',
    },
    f.owner,
  );
  assert.equal(payment.status, 201, JSON.stringify(payment.body));
  const paymentId = (payment.body as PaymentDetails).payments[0].id;
  assert.equal(
    (
      await f.call(
        `/api/Payments/${paymentId}/void`,
        'POST',
        { reason: 'Attempted cross-organization void' },
        f.staff,
      )
    ).status,
    403,
  );
  assert.equal((await f.call(`/api/documents/${other.id}/payment-link`, 'POST', {}, f.staff)).status, 403);
  assert.equal((await f.call(`/api/documents/${other.id}/email`, 'POST', {}, f.staff)).status, 403);
  assert.equal(
    (await f.call(`/api/documents/${other.id}/installments`, 'PUT', { plan: null }, f.staff)).status,
    403,
  );
});

test('staff cannot write workspace settings, create organizations or mutate another organization’s customer or format', async (t) => {
  const f = await fixture(t);
  for (const path of ['/api/workspace-settings', '/api/WORKSPACE-SETTINGS', '/api/Organizations']) {
    assert.equal(
      (await f.call(path, path.toLowerCase().endsWith('organizations') ? 'POST' : 'PUT', {}, f.staff)).status,
      403,
      path,
    );
  }
  const other = await f.customer(OTHER);
  assert.equal((await f.call(`/api/Customers/${other.id}`, 'DELETE', undefined, f.staff)).status, 403);
  assert.equal(
    (await f.call(`/api/customers/${other.id}`, 'PUT', { ...other, organizationId: ORG }, f.staff)).status,
    403,
  );
  assert.equal((await f.call('/api/customers', 'POST', { ...other, id: undefined }, f.staff)).status, 403);
  const formats = (await f.call(`/api/formats?organizationId=${OTHER}`, 'GET', undefined, f.owner))
    .body as InvoiceFormat[];
  assert.equal((await f.call(`/api/Formats/${formats[0].id}`, 'DELETE', undefined, f.staff)).status, 403);
  assert.equal(
    (await f.call(`/api/customers?organizationId=${OTHER}`, 'GET', undefined, f.owner)).body.length,
    1,
  );
});

test('allowed organization IDs cannot authorize cross-organization document references, and changed roles revoke app access immediately', async (t) => {
  const f = await fixture(t);
  const { input: other } = await f.document(OTHER);
  const attempt = await f.call('/api/documents', 'POST', { ...other, organizationId: ORG }, f.staff);
  assert.equal(attempt.status, 400, JSON.stringify(attempt.body));
  const changed = await f.call(
    `/api/auth/users/${f.member.id}`,
    'PATCH',
    { role: 'staff', status: 'active', organizationIds: [OTHER] },
    f.owner,
  );
  assert.equal(changed.status, 200);
  assert.equal((await f.call('/api/organizations', 'GET', undefined, f.staff)).status, 401);
  const newLogin = await f.call('/api/auth/login', 'POST', MEMBER);
  const assigned = (await f.call('/api/organizations', 'GET', undefined, newLogin.cookie))
    .body as Organization[];
  assert.deepEqual(
    assigned.map((item) => item.id),
    [OTHER],
  );
  assert.equal(
    (await f.call(`/api/documents?organizationId=${ORG}`, 'GET', undefined, newLogin.cookie)).status,
    403,
  );
});

test('authenticated API mutations require same-origin JSON and opaque reset emails remain admin-only', async (t) => {
  const f = await fixture(t);
  const own = await f.customer(ORG);
  const crossSite = await f.call(`/api/customers/${own.id}`, 'PUT', own, f.staff, {
    Origin: 'https://unrelated.example',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(
    (await f.call(`/api/customers/${own.id}`, 'DELETE', undefined, f.staff, { 'Content-Type': 'text/plain' }))
      .status,
    415,
  );
  const { document: other } = await f.document(OTHER);
  const message = f.app.locals.services.mailer.enqueueInvoice(other, { eventKey: 'access-other-email' });
  assert.ok(message?.id);
  assert.equal((await f.call(`/api/messages/${message.id}/retry`, 'POST', {}, f.staff)).status, 403);
  const reset = f.app.locals.services.mailer.enqueuePasswordReset({
    to: OWNER.email,
    name: 'Owner',
    resetUrl: 'https://invoices.example.test/#reset-password?token=fixture',
    eventKey: 'access-reset-email',
  });
  assert.equal((await f.call(`/api/messages/${reset.id}/retry`, 'POST', {}, f.staff)).status, 403);
});
