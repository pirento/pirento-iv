/** Integration tests: the disposable preview works end to end while isolating data and blocking providers. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createFixture, integrationEnabled } from './fixture.js';
import {
  createSyntheticPreviewApplication,
  PREVIEW_MODE,
  PREVIEW_CSP,
  PREVIEW_DISABLED,
} from '../../src/services/preview/synthetic-preview.js';

test(
  'disposable preview preserves authenticated local workflows while isolating data and blocking providers',
  {
    skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
    timeout: 120_000,
  },
  async (t) => {
    const control = await createFixture(t, { auth: false });
    const environment = {
      IV_PREVIEW_MODE: 'disposable-synthetic',
      IV_PREVIEW_MONGODB_URI: process.env.MONGODB_TEST_URI,
      IV_PREVIEW_ADMIN_EMAIL: 'preview@example.invalid',
      IV_PREVIEW_ADMIN_PASSWORD: 'PreviewPasswordForTests$123',
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://preview.example.invalid',
      MONGODB_URI: 'mongodb://127.0.0.1:1/must_not_open',
      MONGODB_DATABASE: control.environment.MONGODB_DATABASE,
      INITIAL_ADMIN_EMAIL: 'must-not-use@example.invalid',
      RAZORPAY_KEY_ID: 'must-not-use',
      RESEND_API_KEY: 'must-not-use',
    };
    const preview = await createSyntheticPreviewApplication({ environment });
    const server = preview.app.listen(0, '127.0.0.1');
    t.after(async () => {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await preview.close();
    });
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    async function call(path, method = 'GET', body, status = 200) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: environment.PUBLIC_APP_URL, Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.headers.get('set-cookie')) {
        const value = response.headers.get('set-cookie');
        assert.match(value, /HttpOnly/);
        assert.match(value, /Secure/);
        cookie = value.split(';')[0];
      }
      const value = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`);
      assert.equal(response.headers.get('x-iv-deployment-mode'), PREVIEW_MODE);
      assert.equal(response.headers.get('content-security-policy'), PREVIEW_CSP);
      return value;
    }

    assert.match(preview.db.database.databaseName, /^venturecore_preview_[a-f0-9]{32}$/);
    assert.notEqual(preview.db.database.databaseName, control.environment.MONGODB_DATABASE);
    assert.deepEqual(await call('/api/deployment-mode'), {
      mode: PREVIEW_MODE,
      disposable: true,
      integrationsDisabled: true,
    });
    assert.deepEqual(await call('/api/health'), { ok: true, preview: true, integrationsDisabled: true });
    await call('/api/organizations', 'GET', undefined, 401);
    for (const path of [
      '/api/webhooks/razorpay',
      '/api/webhooks/cashfree/shri-sarraf',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
    ]) {
      assert.equal((await call(path, 'POST', {}, 503)).error, PREVIEW_DISABLED);
    }
    await call('/api/gst/captcha', 'GET', undefined, 401);
    const loginPage = await fetch(base + '/login');
    const loginHtml = await loginPage.text();
    assert.equal(loginPage.status, 200);
    assert.match(loginHtml, /name="iv-deployment-mode" content="disposable-synthetic-preview"/);
    assert.match(loginHtml, /class="preview-notice"/);
    t.diagnostic(
      'Original preview deployment/health contracts, strict headers and public/protected denial retained',
    );

    const login = await call('/api/auth/login', 'POST', {
      email: environment.IV_PREVIEW_ADMIN_EMAIL,
      password: environment.IV_PREVIEW_ADMIN_PASSWORD,
    });
    assert.equal(login.user.email, environment.IV_PREVIEW_ADMIN_EMAIL);
    for (const path of [
      '/api/gst/captcha',
      '/api/integrations/status',
      '/api/documents/example/payment-link',
      '/api/documents/example/payment-link/sync',
      '/api/documents/example/email',
      '/api/messages/example/retry',
    ]) {
      assert.equal((await call(path, 'POST', {}, 503)).error, PREVIEW_DISABLED);
    }
    const organizations = await call('/api/organizations');
    assert.equal(organizations.length, 6);
    assert.ok(organizations.every((organization) => organization.name.startsWith('TEST ONLY —')));
    assert.ok(organizations.every((organization) => organization.legalName.includes('NOT A REAL BUSINESS')));
    const data = await preview.app.locals.workspaceData(login.user);
    assert.equal(data.workspaceSettings.companyName, 'TEMPORARY SYNTHETIC PREVIEW');
    assert.equal(data.preview, true);
    assert.equal(data.integrationsDisabled, true);
    assert.equal(data.integrationStatus.email.configured, false);
    assert.equal(data.integrationStatus.payment.configured, false);
    assert.equal(data.backupStatus.enabled, false);
    assert.equal(preview.app.locals.syntheticPreview, true);
    const page = await fetch(base + `/workspace/${organizations[0].id}/overview`, {
      headers: { Cookie: cookie },
    });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('x-robots-tag'), /noindex/);
    const pageHtml = await page.text();
    assert.match(pageHtml, /TEMPORARY SYNTHETIC PREVIEW/);
    assert.match(pageHtml, /name="iv-deployment-mode" content="disposable-synthetic-preview"/);
    assert.match(pageHtml, /class="preview-notice"/);
    assert.match(pageHtml, /TEST PREVIEW — NOT A VALID INVOICE/);
    assert.match(pageHtml, /Do not enter real invoices, customer data or integration credentials/);
    assert.match(pageHtml, /data-preview-link-status hidden/);
    t.diagnostic(
      'Preview-only administrator, synthetic seller identities and actual EJS workspace remain usable',
    );

    const organization = organizations[0];
    const customer = await call(
      '/api/customers',
      'POST',
      {
        organizationId: organization.id,
        name: 'Invented Preview Customer',
        email: 'customer@example.invalid',
        phone: '',
        gstin: '',
        address: 'Synthetic address',
        stateCode: '09',
        contactPerson: '',
      },
      201,
    );
    const invoice = await call(
      '/api/documents',
      'POST',
      {
        organizationId: organization.id,
        customerId: customer.id,
        kind: 'invoice',
        status: 'sent',
        issueDate: '2026-10-10',
        dueDate: '',
        title: 'Synthetic Invoice',
        items: [{ description: 'Invented test item', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: organization.terms,
      },
      201,
    );
    assert.match(invoice.number, /^T1I\//);
    assert.match(invoice.organizationSnapshot.legalName, /NOT A REAL BUSINESS/);
    assert.match(invoice.terms, /NOT A VALID INVOICE/);
    assert.equal(invoice.totals.total, 100);
    assert.equal(await control.backend.db.collection('customers').countDocuments({}), 0);
    assert.ok(
      (await control.backend.db.models.organizations.list()).every(
        (item) => !item.name.startsWith('TEST ONLY'),
      ),
    );
    t.diagnostic(
      'Document workflow writes only to the generated preview namespace; persistent control records stay unchanged',
    );

    const previewDatabaseName = preview.db.database.databaseName;
    const previewDirectory = preview.environment.DATABASE_BACKUP_DIR;
    await new Promise((resolve) => server.close(resolve));
    await preview.close();
    assert.equal(
      await control.backend.db.client
        .db(previewDatabaseName)
        .listCollections({}, { nameOnly: true })
        .hasNext(),
      false,
    );
    await assert.rejects(access(previewDirectory));
    assert.equal(await control.backend.db.collection('organizations').countDocuments({}), 6);
    const second = await createSyntheticPreviewApplication({ environment });
    try {
      assert.notEqual(second.db.database.databaseName, previewDatabaseName);
      assert.equal(await second.db.collection('customers').countDocuments({}), 0);
    } finally {
      await second.close();
    }
    t.diagnostic('Owned preview namespace/temp storage are removed on close and every new run starts fresh');
  },
);
