/** Integration tests: Business owner logins and each business's payment and email settings (SMTP). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 180_000,
};
const owner = { email: 'owner-admin@example.test', password: 'OwnerAdminPassword2026!' };

test(
  'a Business owner runs only its own business and sets its gateway and SMTP email',
  options,
  async (t) => {
    const sent = [];
    const { base, backend } = await createFixture(t, {
      environment: {
        INITIAL_ADMIN_EMAIL: owner.email,
        INITIAL_ADMIN_PASSWORD: owner.password,
        EMAIL_AUTOMATION: 'false',
      },
      smtpSend: async (smtp, message) => {
        sent.push({ smtp, message });
        return { messageId: `<${sent.length}@smtp.test>` };
      },
    });
    attachPageRoutes(backend);
    const call = async (path, { method = 'GET', body, cookie = '', status = 200 } = {}) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
    };
    const page = (path, cookie) =>
      fetch(`${base}/workspace/${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    const admin = (await call('/auth/login', { method: 'POST', body: owner })).cookie;
    const organizationId = 'at-elevators';
    const business = await backend.db.models.organizations.findById(organizationId);
    await backend.db.models.organizations.save({ ...business, gstin: '09AAJCV6240P1ZL', stateCode: '09' });

    const login = { email: 'elevator-owner@example.test', password: 'ElevatorOwner2026!' };
    await call('/auth/users', {
      method: 'POST',
      cookie: admin,
      status: 201,
      body: {
        ...login,
        name: 'Elevator Owner',
        role: 'staff',
        organizationIds: [organizationId],
        permission: 'owner',
      },
    });
    const ownerCookie = (await call('/auth/login', { method: 'POST', body: login })).cookie;

    // Only its own business: lists, pages and changes.
    const listed = await call('/organizations', { cookie: ownerCookie });
    assert.deepEqual(
      listed.data.map((row) => row.id),
      [organizationId],
    );
    const latest = await backend.db.models.organizations.findById(organizationId);
    const { id: _id, ...editable } = latest;
    await call(`/organizations/${organizationId}`, {
      method: 'PUT',
      cookie: ownerCookie,
      body: { ...editable, gstRegistrations: latest.gstRegistrations ?? [], phone: '9876543210' },
    });
    assert.equal((await backend.db.models.organizations.findById(organizationId)).phone, '9876543210');
    const other = await backend.db.models.organizations.findById('pipeline2-legal');
    await call('/organizations/pipeline2-legal', {
      method: 'PUT',
      cookie: ownerCookie,
      status: 403,
      body: { ...editable, name: other.name },
    });
    await call('/organizations', { method: 'POST', cookie: ownerCookie, status: 403, body: editable });
    for (const view of ['business_settings', 'letterhead', 'integrations', 'overview'])
      assert.equal((await page(`${organizationId}/${view}`, ownerCookie)).status, 200, view);
    assert.equal((await page(`${organizationId}/team`, ownerCookie)).status, 403);
    assert.equal((await page('pipeline2-legal/overview', ownerCookie)).status, 403);
    await call('/integrations/pipeline2-legal/settings', { cookie: ownerCookie, status: 403 });

    // Gateway keys and SMTP email, saved by the owner.
    const saved = await call(`/integrations/${organizationId}/settings`, {
      method: 'PUT',
      cookie: ownerCookie,
      body: {
        paymentGateway: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_owner123',
        RAZORPAY_KEY_SECRET: 'razor-secret-5678',
        RAZORPAY_WEBHOOK_SECRET: 'hook-secret-9999',
        EMAIL_FROM: 'billing@elevator.example',
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'billing@elevator.example',
        SMTP_PASSWORD: 'smtp-pass-4321',
        financeEmail: 'accounts@elevator.example',
      },
    });
    assert.deepEqual(saved.data.settings.SMTP_PASSWORD, { set: true, end: '4321' });
    assert.equal(saved.data.settings.SMTP_HOST, 'smtp.example.test');
    assert.deepEqual([saved.data.email.configured, saved.data.email.provider], [true, 'smtp']);
    assert.deepEqual([saved.data.payment.configured, saved.data.payment.mode], [true, 'test']);
    const stored = JSON.stringify(
      await backend.db.collection('workspace_metadata').findOne({ _id: `integrations:${organizationId}` }),
    );
    for (const secret of ['razor-secret', 'hook-secret', 'smtp-pass'])
      assert.ok(!stored.includes(secret), `${secret} is encrypted at rest`);
    const html = await (await page(`${organizationId}/integrations`, ownerCookie)).text();
    assert.match(html, /Saved, ending 4321/);
    assert.ok(!html.includes('smtp-pass-4321'), 'the page never shows a saved secret');
    assert.doesNotMatch(html, /id="ai-settings"/, 'AI settings stay admin-only');
    // Other logins of the business cannot change its settings.
    await call('/auth/users', {
      method: 'POST',
      cookie: admin,
      status: 201,
      body: {
        email: 'elevator-staff@example.test',
        password: 'ElevatorStaff2026!',
        name: 'Elevator Staff',
        role: 'staff',
        organizationIds: [organizationId],
        permission: 'full',
      },
    });
    const staff = (
      await call('/auth/login', {
        method: 'POST',
        body: { email: 'elevator-staff@example.test', password: 'ElevatorStaff2026!' },
      })
    ).cookie;
    await call(`/integrations/${organizationId}/settings`, {
      method: 'PUT',
      cookie: staff,
      status: 403,
      body: { EMAIL_FROM: 'x@example.test' },
    });
    assert.equal((await page(`${organizationId}/integrations`, staff)).status, 403);

    // An invoice email goes out through the business's SMTP server.
    const buyer = (
      await call('/customers', {
        method: 'POST',
        cookie: ownerCookie,
        status: 201,
        body: {
          organizationId,
          name: 'SPARK DEVELOPERS',
          email: 'buyer@example.test',
          phone: '',
          gstin: '',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: '',
        },
      })
    ).data;
    const invoice = (
      await call('/documents', {
        method: 'POST',
        cookie: ownerCookie,
        status: 201,
        body: {
          organizationId,
          customerId: buyer.id,
          kind: 'invoice',
          status: 'sent',
          issueDate: '2026-10-15',
          dueDate: '2026-10-15',
          title: 'Lift repair',
          items: [{ description: 'Lift repair', hsn: '998718', quantity: 1, rate: 1000, gstRate: 18 }],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
      })
    ).data;
    await call(`/documents/${invoice.id}/email`, {
      method: 'POST',
      cookie: ownerCookie,
      status: 202,
      body: { requestId: '1f0d6f5e-1111-4222-8333-944445555666', includePaymentLink: false },
    });
    const result = await backend.mailer.processQueue();
    assert.equal(result.sent, 1, JSON.stringify(result));
    const [{ smtp, message }] = sent;
    assert.deepEqual(smtp, {
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      user: 'billing@elevator.example',
      pass: 'smtp-pass-4321',
    });
    assert.equal(message.from, '"A T Elevator" <billing@elevator.example>');
    assert.equal(message.replyTo, 'accounts@elevator.example');
    assert.equal(message.to, 'buyer@example.test');
    assert.equal(message.attachments[0].content.subarray(0, 4).toString(), '%PDF');
    // The email carries the business's look and details, in HTML and text.
    assert.match(message.html, /background:#1e88e5/, 'the A T Elevator stripe');
    assert.match(message.html, /color:#172b4d/, 'the A T Elevator colour');
    assert.doesNotMatch(message.html, /Description/, 'items stay in the attached PDF');
    assert.match(message.html, /Balance due.*₹1,180\.00/s);
    assert.match(message.html, /mailto:accounts@elevator\.example/);
    assert.match(message.text, /Balance due: ₹1,180\.00\nInvoice: ATEI\/2627\/0001/);
    assert.match(message.text, /The invoice is attached as a PDF\./);
    assert.match(message.text, /Questions\? Reply to this email or write to accounts@elevator\.example\./);

    // Its logo is served for email apps, which do not show images embedded in the message.
    const pixel =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await backend.db.models.organizations.save({
      ...(await backend.db.models.organizations.findById(organizationId)),
      logoUrl: pixel,
    });
    const logo = await fetch(`${base}/brand/${organizationId}/logo`);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.equal(logo.headers.get('cross-origin-resource-policy'), 'cross-origin', 'email apps may load it');
    assert.equal(
      (await fetch(`${base}/brand/pipeline2-legal/logo`)).headers.get('content-type'),
      'image/png',
    );
    assert.equal((await fetch(`${base}/brand/no-such-business/logo`)).status, 404);

    // Removing a secret: SMTP without its password still sends (servers that need no login).
    const cleared = await call(`/integrations/${organizationId}/settings`, {
      method: 'PUT',
      cookie: admin,
      body: { clear: ['SMTP_PASSWORD'] },
    });
    assert.deepEqual(cleared.data.settings.SMTP_PASSWORD, { set: false, end: '' });
    assert.equal(cleared.data.settings.SMTP_USER, 'billing@elevator.example');
  },
);
