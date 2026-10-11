import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import { createBackend } from '../../src/services/backend.js';
import { createFixture, integrationEnabled } from './fixture.js';

test(
  'MongoDB lifecycle, financial invariants, access controls and backup contracts',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    const reset = [];
    const fixture = await createFixture(t, {
      environment: {
        INITIAL_ADMIN_EMAIL: 'owner@example.test',
        INITIAL_ADMIN_PASSWORD: 'CorrectHorseBatteryStaple$2026',
        INITIAL_ADMIN_NAME: 'Test Administrator',
      },
      auth: {
        sendPasswordReset: async (payload) => {
          reset.push(payload);
        },
      },
    });
    const { backend, base, environment: env } = fixture;
    let cookie = '';
    async function call(path, method = 'GET', body, expected = 200, session = cookie) {
      const res = await fetch(base + '/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: session },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      const data = await res.json();
      assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
      return data;
    }
    const customerInput = (organizationId) => ({
      organizationId,
      name: 'Acme Customer',
      email: 'customer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow, Uttar Pradesh',
      stateCode: '09',
      contactPerson: 'Accounts',
    });
    const invoiceInput = (org, customer, extra = {}) => ({
      organizationId: org,
      customerId: customer,
      kind: 'invoice',
      status: 'draft',
      issueDate: '2026-10-10',
      dueDate: '2026-10-31',
      title: 'Invoice',
      items: [{ description: 'Annual service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
      ...extra,
    });
    const receipt = (amount, requestId = randomUUID()) => ({
      amount,
      requestId,
      paidOn: '2026-10-10',
      method: 'bank_transfer',
      reference: 'TEST',
      notes: '',
      finalizeWhenPaid: true,
    });
    let passed = 0;
    const check = (name) => {
      passed++;
      t.diagnostic(name);
    };
    await call('/health');
    await call('/organizations', 'GET', undefined, 401);
    await call('/auth/login', 'POST', {
      email: env.INITIAL_ADMIN_EMAIL,
      password: env.INITIAL_ADMIN_PASSWORD,
    });
    const adminCookie = cookie;
    check('Session login and API protection');
    const orgs = await call('/organizations');
    assert.equal(orgs.length, 6);
    const org = orgs[0];
    const other = orgs[1];
    const formats = await call('/formats?organizationId=' + org.id);
    assert.equal(formats.length, 15);
    const products = await call('/business-products?organizationId=' + other.id);
    assert.equal(products.length, 10);
    check('Six organizations, formats and product seeding');
    const c = await call('/customers', 'POST', customerInput(org.id), 201);
    const c2 = await call('/customers', 'POST', customerInput(other.id), 201);
    const catalog = await call(
      '/catalog',
      'POST',
      {
        organizationId: org.id,
        name: 'Annual service',
        sku: 'SERV-1',
        description: 'Annual servicing',
        type: 'service',
        unit: 'Year',
        hsn: '',
        rate: 100,
        gstRate: 0,
        active: true,
      },
      201,
    );
    await call('/catalog', 'POST', { ...catalog, sku: 'serv-1' }, 409);
    check('Native catalog case-insensitive uniqueness');
    let inv = await call('/documents', 'POST', invoiceInput(org.id, c.id), 201);
    assert.match(inv.number, /0001$/);
    assert.equal(inv.customerSnapshot.name, c.name);
    await call('/customers/' + c.id, 'PUT', { ...c, name: 'Updated Customer' });
    const listed = await call('/documents?organizationId=' + org.id);
    assert.equal(listed[0].customerSnapshot.name, c.name);
    check('Draft issuance and immutable customer snapshot');
    await call('/documents', 'POST', invoiceInput(org.id, 'missing'), 404);
    const next = await call('/documents', 'POST', invoiceInput(org.id, c.id), 201);
    assert.match(next.number, /0002$/);
    check('Failed transactions do not consume document numbers');
    inv = await call('/documents/' + inv.id, 'PUT', { ...inv, status: 'sent' });
    const first = receipt(70);
    let details = await call('/documents/' + inv.id + '/payments', 'POST', first, 201);
    assert.equal(details.document.status, 'partially_paid');
    assert.equal(details.document.balanceDue, 30);
    await call('/documents/' + inv.id + '/payments', 'POST', first, 200);
    await call('/documents/' + inv.id + '/payments', 'POST', { ...first, amount: 60 }, 409);
    await call('/documents/' + inv.id + '/payments', 'POST', receipt(31), 409);
    details = await call('/documents/' + inv.id + '/payments', 'POST', receipt(20), 201);
    assert.equal(details.document.balanceDue, 10);
    details = await call('/documents/' + inv.id + '/payments', 'POST', receipt(10), 201);
    assert.equal(details.document.status, 'paid');
    assert.ok(details.document.finalizedAt);
    assert.equal(details.payments.length, 3);
    check('70/20/10 payments, exact balance, duplicate receipt and finalization');
    await call('/documents/' + inv.id, 'PUT', { ...inv, status: 'sent', notes: 'locked' }, 409);
    await call('/documents/' + inv.id, 'DELETE', undefined, 409);
    const last = details.payments[0];
    details = await call('/payments/' + last.id + '/void', 'POST', { reason: 'Incorrect bank reference' });
    assert.equal(details.document.balanceDue, 10);
    assert.equal(details.document.finalizedAt, null);
    await call('/payments/' + last.id + '/void', 'POST', { reason: 'Incorrect bank reference' });
    await call('/payments/' + last.id + '/void', 'POST', { reason: 'another reason' }, 409);
    check('Finalization locks and audited payment void/reopen');
    const challan = await call('/documents/' + inv.id + '/delivery-note', 'POST', {}, 201);
    assert.equal(challan.kind, 'delivery_note');
    assert.equal(challan.totals.total, 0);
    const existingChallan = await call('/documents/' + inv.id + '/delivery-note', 'POST', {});
    assert.equal(challan.id, existingChallan.id);
    check('Delivery note conversion is idempotent and quantity-only');
    const q = await call(
      '/documents',
      'POST',
      invoiceInput(org.id, c.id, { kind: 'quotation', title: 'Quotation', status: 'sent' }),
      201,
    );
    const converted = await call('/documents/' + q.id + '/convert', 'POST', {}, 201);
    assert.equal(converted.customerSnapshot.name, q.customerSnapshot.name);
    assert.deepEqual(converted.totals, q.totals);
    assert.equal((await call('/documents/' + q.id + '/convert', 'POST', {})).id, converted.id);
    check('Quotation conversion preserves accepted snapshots and tax amounts');
    const changed = await call('/formats/' + formats[1].id, 'PUT', { ...formats[1], isDefault: true });
    assert.equal(changed.isDefault, true);
    assert.equal((await call('/formats?organizationId=' + org.id)).filter((f) => f.isDefault).length, 1);
    check('Changing default format atomically');
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => call('/documents', 'POST', invoiceInput(org.id, c.id), 201)),
    );
    assert.equal(new Set(concurrent.map((d) => d.number)).size, 10);
    check('Concurrent document numbers remain unique');
    const balanceInvoice = await call(
      '/documents',
      'POST',
      invoiceInput(org.id, c.id, { status: 'sent' }),
      201,
    );
    const payments = await Promise.all(
      [receipt(70), receipt(70)].map(async (data) => {
        const response = await fetch(base + '/api/documents/' + balanceInvoice.id + '/payments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
          body: JSON.stringify(data),
        });
        return { status: response.status, data: await response.json() };
      }),
    );
    assert.deepEqual(payments.map((v) => v.status).sort(), [201, 409]);
    assert.equal((await call('/documents/' + balanceInvoice.id + '/payments')).document.amountPaid, 70);
    check('Concurrent payments cannot exceed the outstanding balance');
    await call(
      '/auth/signup',
      'POST',
      {
        name: 'Staff Member',
        email: 'staff@example.test',
        password: 'StaffPasswordSecure$123',
        company: 'Test',
      },
      202,
    );
    await call(
      '/auth/login',
      'POST',
      { email: 'staff@example.test', password: 'StaffPasswordSecure$123' },
      401,
      '',
    );
    cookie = adminCookie;
    let users = await call('/auth/users');
    const staff = users.find((u) => u.email === 'staff@example.test');
    await call('/auth/users/' + staff.id, 'PATCH', {
      role: 'staff',
      status: 'active',
      organizationIds: [org.id],
    });
    await call('/auth/login', 'POST', { email: staff.email, password: 'StaffPasswordSecure$123' }, 200, '');
    const staffCookie = cookie;
    assert.equal((await call('/organizations')).length, 1);
    await call('/documents?organizationId=' + other.id, 'GET', undefined, 403);
    await call('/customers/' + c2.id, 'PUT', c2, 403);
    await call('/workspace-settings', 'PUT', { companyName: 'Bad', dashboardLogoUrl: '' }, 403);
    await call('/auth/users', 'GET', undefined, 403);
    await call('/backups', 'GET', undefined, 403);
    check('Pending approval, staff scoping and admin-only actions');
    cookie = adminCookie;
    await call('/auth/users/' + staff.id, 'PATCH', {
      role: 'staff',
      status: 'disabled',
      organizationIds: [org.id],
    });
    await call('/organizations', 'GET', undefined, 401, staffCookie);
    check('Access changes immediately revoke existing sessions');
    await call('/auth/forgot-password', 'POST', { email: env.INITIAL_ADMIN_EMAIL }, 202);
    assert.equal(reset.length, 1);
    await call('/auth/reset-password', 'POST', {
      token: reset[0].token,
      password: 'NewOwnerPasswordSecure$123',
    });
    await call(
      '/auth/reset-password',
      'POST',
      { token: reset[0].token, password: 'AnotherPasswordSecure$123' },
      400,
    );
    await call('/organizations', 'GET', undefined, 401, adminCookie);
    await call('/auth/login', 'POST', {
      email: env.INITIAL_ADMIN_EMAIL,
      password: 'NewOwnerPasswordSecure$123',
    });
    check('Single-use password reset and session revocation');
    const backup = await call('/backups', 'POST', {}, 201);
    assert.equal(backup.verified, true);
    const manifest = await call('/backups/' + backup.id + '/manifest');
    assert.equal(manifest.kind, 'venturecore-mongodb-backup');
    check('Native Mongo backup with verified manifest');
    const raw = await backend.db.collection('documents').findOne({ id: inv.id });
    assert.equal(typeof raw, 'object');
    assert.equal(raw.data, undefined);
    assert.equal(raw.number, inv.number);
    assert.ok(Array.isArray(raw.items));
    check('Native document persistence without JSON-string rows');
    const closeClient = MongoClient.prototype.close;
    let ownedConnectionsClosed = 0;
    const closeMonitor = t.mock.method(MongoClient.prototype, 'close', function (...args) {
      if (this !== backend.db.client) ownedConnectionsClosed++;
      return closeClient.apply(this, args);
    });
    try {
      await backend.db.collection('ops_recovery_state').insertOne({ id: 1, status: 'pending' });
      await assert.rejects(createBackend({ environment: env, auth: false }), /held for recovery review/);
      assert.equal(ownedConnectionsClosed, 1);
      await assert.rejects(
        createBackend({ environment: env, db: backend.db, auth: false }),
        /held for recovery review/,
      );
      assert.equal(ownedConnectionsClosed, 1);
      assert.equal((await backend.db.database.command({ ping: 1 })).ok, 1);
      await backend.db.collection('ops_recovery_state').deleteOne({ id: 1 });
      await assert.rejects(
        createBackend({ environment: { ...env, GST_PROVIDER: 'invalid' }, auth: false }),
        /GST_PROVIDER/,
      );
      assert.equal(ownedConnectionsClosed, 2);
    } finally {
      closeMonitor.mock.restore();
      await backend.db.collection('ops_recovery_state').deleteOne({ id: 1 });
    }
    check('Rejected startup closes owned MongoDB clients and preserves supplied connections');
    assert.equal(passed, 18);
  },
);
