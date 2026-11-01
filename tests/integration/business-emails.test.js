/** Integration tests: every business's customer email — its sender, reply-to, look, buttons and PDF — and the test email. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { BRANDS } from '../../src/models/workspace-seed.js';
import { createFixture, integrationEnabled } from './fixture.js';
import { startSmtpServer } from './smtp-server.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 240_000,
};

test('each business sends its own branded invoice email and test email', options, async (t) => {
  const sent = [];
  let smtpDown = false;
  const { base, backend } = await createFixture(t, {
    auth: false,
    environment: { EMAIL_AUTOMATION: 'false', PUBLIC_APP_URL: 'https://billing.example.test' },
    smtpSend: async (smtp, message) => {
      if (smtpDown) throw Object.assign(new Error('535 Authentication failed'), { responseCode: 535 });
      sent.push({ smtp, message });
      return { messageId: `<${sent.length}@smtp.test>` };
    },
  });
  const call = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const businesses = await backend.db.models.organizations.list();
  assert.equal(businesses.length, 6);
  for (const [index, business] of businesses.entries()) {
    await backend.db.models.organizations.save({ ...business, gstin: '', stateCode: '09' });
    const from = `billing${index}@example.test`;
    await call(`/integrations/${business.id}/settings`, 'PUT', {
      EMAIL_FROM: from,
      SMTP_HOST: `smtp${index}.example.test`,
      SMTP_USER: from,
      SMTP_PASSWORD: `secret-${index}`,
    });
    const buyer = await call(
      '/customers',
      'POST',
      {
        organizationId: business.id,
        name: `Buyer of ${business.name}`,
        email: `buyer${index}@example.test`,
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    // Businesses that sell named products need one on each document.
    const product = business.enableProductSelection
      ? await call(
          '/business-products',
          'POST',
          {
            organizationId: business.id,
            name: 'Main product',
            code: '',
            description: '',
            logoUrl: '',
            active: true,
          },
          201,
        )
      : null;
    const invoice = await call(
      '/documents',
      'POST',
      {
        organizationId: business.id,
        customerId: buyer.id,
        ...(product ? { businessProductId: product.id } : {}),
        kind: 'invoice',
        status: 'sent',
        issueDate: '2026-10-15',
        dueDate: '2026-11-14',
        title: 'Services',
        items: [{ description: 'Services', hsn: '998718', quantity: 1, rate: 1000, gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
      },
      201,
    );
    await call(
      `/documents/${invoice.id}/email`,
      'POST',
      {
        requestId: `1f0d6f5e-1111-4222-8333-94444555560${index}`,
        includePaymentLink: false,
      },
      202,
    );
    assert.equal((await backend.mailer.processQueue()).sent, 1, business.id);
    const { smtp, message } = sent.at(-1);
    const name = business.tradeName || business.name;
    const independent = business.id === 'shri-sarraf';
    const replyTo = independent ? 'support@shrisarraf.com' : 'finance@pirento.com';
    assert.equal(smtp.host, `smtp${index}.example.test`, `${business.id} uses its own SMTP server`);
    assert.equal(message.from, `"${name}" <${from}>`);
    assert.equal(message.to, `buyer${index}@example.test`);
    assert.equal(message.replyTo, replyTo);
    assert.equal(message.subject, `Invoice ${invoice.number} from ${name}`);
    assert.equal(message.attachments[0].content.subarray(0, 4).toString(), '%PDF', 'the invoice is attached');
    const colour = BRANDS[business.id]?.accentColor ?? business.accentColor;
    assert.ok(
      message.html.includes(`background:${colour};color:#ffffff`),
      `${business.id} buttons in its colour`,
    );
    assert.ok(
      message.html.includes(`href="mailto:${replyTo}?subject=`),
      'Reply to us opens a reply to the business',
    );
    assert.equal(
      message.html.includes(`https://billing.example.test/brand/${business.id}/logo`),
      Boolean(BRANDS[business.id]),
      `${business.id} logo only when it has one`,
    );
    assert.doesNotMatch(message.html, /₹/, 'amounts stay in the PDF');
    assert.equal(message.html.includes('Venturecore Solutions Private Limited'), !independent);

    const tested = await call(`/integrations/${business.id}/test-email`, 'POST', {
      to: 'owner@example.test',
    });
    assert.deepEqual(tested, { sent: true, from: `"${name}" <${from}>`, replyTo, provider: 'smtp' });
    assert.equal(sent.at(-1).message.subject, `Test email from ${name}`);
  }
  // A failing SMTP login is reported to the administrator instead of being hidden.
  smtpDown = true;
  const failed = await call(
    `/integrations/${businesses[0].id}/test-email`,
    'POST',
    { to: 'owner@example.test' },
    502,
  );
  assert.match(failed.error, /535 Authentication failed/);
  await call(`/integrations/${businesses[0].id}/test-email`, 'POST', { to: 'not-an-email' }, 400);
});

test('emails go out through a real SMTP conversation, with login, PDF and errors', options, async (t) => {
  const smtp = await startSmtpServer();
  t.after(() => smtp.close());
  const { base, backend } = await createFixture(t, {
    auth: false,
    environment: {
      EMAIL_AUTOMATION: 'false',
      EMAIL_FROM: 'billing@pirento.example',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_USER: 'billing@pirento.example',
      SMTP_PASSWORD: 'secret',
    },
  });
  const call = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const organizationId = 'at-elevators';
  const buyer = await call(
    '/customers',
    'POST',
    {
      organizationId,
      name: 'Spark Developers',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    },
    201,
  );
  const business = await backend.db.models.organizations.findById(organizationId);
  await backend.db.models.organizations.save({ ...business, stateCode: '09' });
  const invoice = await call(
    '/documents',
    'POST',
    {
      organizationId,
      customerId: buyer.id,
      kind: 'invoice',
      status: 'sent',
      issueDate: '2026-10-15',
      dueDate: '2026-11-14',
      title: 'Lift',
      items: [{ description: 'Lift service', hsn: '998718', quantity: 1, rate: 1000, gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    },
    201,
  );
  await call(
    `/documents/${invoice.id}/email`,
    'POST',
    { requestId: '2f0d6f5e-1111-4222-8333-944445555601', includePaymentLink: false },
    202,
  );
  assert.equal((await backend.mailer.processQueue()).sent, 1);
  const [raw] = smtp.messages;
  assert.match(raw, /^From: A T Elevator <billing@pirento\.example>$/m);
  assert.match(raw, /^To: buyer@example\.test$/m);
  assert.match(raw, /^Subject: Invoice ATEI\/2627\/0001 from A T Elevator$/m);
  assert.match(raw, /^Reply-To: finance@pirento\.com$/m);
  assert.match(raw, /Content-Type: application\/pdf; name=/, 'the invoice PDF is attached');
  assert.match(raw, /^JVBERi0/m, 'the attachment is a PDF (%PDF- in base64)');

  assert.deepEqual(
    await call(`/integrations/${organizationId}/test-email`, 'POST', { to: 'owner@example.test' }),
    {
      sent: true,
      from: '"A T Elevator" <billing@pirento.example>',
      replyTo: 'finance@pirento.com',
      provider: 'smtp',
    },
  );
  assert.match(smtp.messages.at(-1), /^Subject: Test email from A T Elevator$/m);
  smtp.rejectLogins = true;
  const failed = await call(
    `/integrations/${organizationId}/test-email`,
    'POST',
    { to: 'owner@example.test' },
    502,
  );
  assert.match(failed.error, /535 5\.7\.8 Authentication credentials invalid/);
});
