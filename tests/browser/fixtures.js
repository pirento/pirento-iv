import { randomUUID } from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import { createFixture } from '../integration/fixture.js';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { indiaBusinessDate } from '../../shared/business-date.js';

export const test = base.extend({
  // Playwright requires an object pattern for fixtures that use no other fixtures.
  // eslint-disable-next-line no-empty-pattern
  app: async ({}, use) => {
    if (!process.env.MONGODB_TEST_URI?.trim()) {
      throw new Error(
        'Browser verification requires MONGODB_TEST_URI pointing to a dedicated test replica set.',
      );
    }
    const cleanup = [];
    const resetMessages = [];
    const credentials = { email: 'browser-owner@example.test', password: 'BrowserTestOnlyPassword2026!' };
    const rejectProvider = async () => {
      throw new Error('External provider transport is disabled in browser tests.');
    };
    try {
      const fixture = await createFixture(
        { after: (callback) => cleanup.push(callback) },
        {
          environment: {
            INITIAL_ADMIN_EMAIL: credentials.email,
            INITIAL_ADMIN_PASSWORD: credentials.password,
            INITIAL_ADMIN_NAME: 'Browser test owner',
            EMAIL_AUTOMATION: 'false',
          },
          auth: { sendPasswordReset: async (payload) => resetMessages.push(payload) },
          fetch: rejectProvider,
          emailFetch: rejectProvider,
          paymentFetch: rejectProvider,
        },
      );
      attachPageRoutes(fixture.backend);
      const organization = await fixture.backend.db.models.organizations.findById('at-elevators');
      await fixture.backend.db.models.organizations.save({
        ...organization,
        stateCode: '09',
        address: 'Synthetic test office, Lucknow',
      });
      await use({ ...fixture, credentials, organizationId: organization.id, resetMessages });
    } finally {
      for (const callback of cleanup.reverse()) await callback();
    }
  },
  pageErrors: [
    async ({ context }, use) => {
      const errors = [];
      const observe = (page) => page.on('pageerror', (error) => errors.push(error.message));
      context.pages().forEach(observe);
      context.on('page', observe);
      await use(errors);
      context.off('page', observe);
      expect(errors, 'No uncaught browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function signIn(page, app) {
  const response = await page.request.post(`${app.base}/api/auth/login`, { data: app.credentials });
  expect(response.status()).toBe(200);
}

export async function api(page, app, path, method = 'GET', data) {
  const response = await page.request.fetch(`${app.base}/api${path}`, { method, data });
  const body = await response.json();
  expect(response.ok(), `${method} ${path}: ${JSON.stringify(body)}`).toBeTruthy();
  return body;
}

export function customerInput(organizationId, name = 'Browser Customer') {
  return {
    organizationId,
    name,
    email: 'customer@example.test',
    phone: '',
    gstin: '',
    address: 'Synthetic customer address, Lucknow',
    stateCode: '09',
    contactPerson: '',
    roles: ['customer'],
    active: true,
    pan: '',
    shippingAddress: '',
    shippingStateCode: '',
    paymentTermsDays: 0,
    creditLimit: 0,
    notes: '',
  };
}

export function catalogInput(organizationId, name = 'Browser Product') {
  return {
    organizationId,
    name,
    sku: '',
    description: 'Synthetic catalog item',
    type: 'product',
    unit: 'Nos',
    hsn: '',
    rate: 20.15,
    gstRate: 0,
    active: true,
  };
}

export function invoiceInput(organizationId, customerId, extra = {}) {
  const today = indiaBusinessDate(new Date());
  return {
    organizationId,
    customerId,
    requestId: randomUUID(),
    kind: 'invoice',
    status: 'draft',
    issueDate: today,
    dueDate: today,
    title: 'Browser Invoice',
    items: [{ description: 'Test service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    ...extra,
  };
}

export async function seedDirectory(app, count = 121) {
  const now = new Date().toISOString();
  const customers = Array.from({ length: count }, (_, index) => ({
    ...customerInput(app.organizationId, `Directory Customer ${String(index + 1).padStart(3, '0')}`),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }));
  const catalog = Array.from({ length: count }, (_, index) => ({
    ...catalogInput(app.organizationId, `Directory Product ${String(index + 1).padStart(3, '0')}`),
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  }));
  await app.backend.db.collection('customers').insertMany(customers);
  await app.backend.db.collection('catalog').insertMany(catalog);
  return { customers, catalog };
}
