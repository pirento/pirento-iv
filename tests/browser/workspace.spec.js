/** Browser tests (`npm run test:browser`): real sign-in, navigation, contacts/catalog, invoices, drafts and payments in Chromium. */

import { readFile } from 'node:fs/promises';
import { test, expect, signIn, api, customerInput, invoiceInput, seedDirectory } from './fixtures.js';

const workspace = (app, suffix) => `${app.base}/workspace/${app.organizationId}/${suffix}`;

async function fillInvoice(page, app, customer) {
  await page.goto(workspace(app, 'invoices/new'));
  await page.locator('#doc-customer').selectOption(customer.id);
  await page.locator('[name="placeOfSupply"]').selectOption('09');
  await page.locator('[data-line="description"]').first().fill('Decimal boundary service');
  await page.locator('[data-line="quantity"]').first().fill('0.5');
  await page.locator('[data-line="rate"]').first().fill('20.15');
}

test('real login and mobile navigation open, trap focus and close with Escape', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.base}/login`);
  await page.locator('[name="email"]').fill(app.credentials.email);
  await page.locator('[name="password"]').fill(app.credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/.+\/overview$/);
  const toggle = page.locator('[data-toggle-sidebar]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const close = page.locator('[data-close-sidebar]');
  await expect(close).toBeVisible();
  await expect(close).toBeFocused();
  await close.press('Shift+Tab');
  await expect(page.locator('#workspace-navigation [data-logout]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('contact and catalog saves, then logout, succeed when optional browser storage throws', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('Unavailable test storage', 'QuotaExceededError');
    };
    Storage.prototype.removeItem = function () {
      throw new DOMException('Unavailable test storage', 'SecurityError');
    };
  });
  await page.goto(workspace(app, 'customers/new'));
  await page.locator('#contact-form [name="name"]').fill('Storage-safe contact');
  await page.locator('#contact-form [name="email"]').fill('storage@example.test');
  await page.locator('#contact-form [name="stateCode"]').selectOption('09');
  await page.locator('#contact-form button[type="submit"]').click();
  await expect(page).toHaveURL(workspace(app, 'customers'));
  expect(await app.backend.db.collection('customers').countDocuments({ name: 'Storage-safe contact' })).toBe(
    1,
  );

  await page.goto(workspace(app, 'catalog/new'));
  await page.locator('#catalog-form [name="name"]').fill('Storage-safe catalog item');
  await page.locator('#catalog-form [name="rate"]').fill('20');
  await page.locator('#catalog-form [name="gstRate"]').fill('0');
  await page.locator('#catalog-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/catalog(?:\?.*)?$/);
  expect(
    await app.backend.db.collection('catalog').countDocuments({ name: 'Storage-safe catalog item' }),
  ).toBe(1);
  await page.locator('[data-logout]').click();
  await expect(page).toHaveURL(`${app.base}/login`);
  expect((await page.request.get(`${app.base}/api/organizations`)).status()).toBe(401);
});

test('password reset redirects and accepts the new password despite blocked toast storage', async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = function () {
      throw new DOMException('Unavailable test storage', 'QuotaExceededError');
    };
  });
  await page.goto(`${app.base}/forgot-password`);
  await page.locator('[name="email"]').fill(app.credentials.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect.poll(() => app.resetMessages.length).toBe(1);
  await page.goto(`${app.base}/reset-password?token=${app.resetMessages[0].token}`);
  const password = 'ReplacementBrowserTestPassword2026!';
  await page.locator('[name="password"]').fill(password);
  await page.locator('[name="confirmPassword"]').fill(password);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page).toHaveURL(`${app.base}/login`);
  await page.locator('[name="email"]').fill(app.credentials.email);
  await page.locator('[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/.+\/overview$/);
});

test('new decimal invoice agrees across editor, MongoDB, preview and receipts, with a downloadable PDF', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  const customer = await api(page, app, '/customers', 'POST', customerInput(app.organizationId));
  await fillInvoice(page, app, customer);
  await page.locator('[name="status"]').selectOption('sent');
  await expect(page.locator('[data-total="total"]')).toHaveText('₹10.08');
  await page.locator('#doc-save-button').click();
  await expect(page).toHaveURL(/\/invoices\/preview\//);
  const id = page.url().split('/').at(-1);
  const saved = await app.backend.db.models.documents.findById(id);
  expect(saved.totals.total).toBe(10.08);
  expect(saved.totals.roundingPolicy).toBe('decimal-half-up-v1');
  await expect(page.locator('.doc-paper')).toContainText('10.08');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const contents = await readFile(await download.path());
  expect(contents.subarray(0, 4).toString()).toBe('%PDF');
  expect(contents.length).toBeGreaterThan(1000);

  await page.goto(workspace(app, `invoices/payments/${id}`));
  await expect(page.locator('#payment-record-fields')).toBeEnabled();
  await page.locator('#payment-amount').fill('5.00');
  await page.locator('#payment-record-form [name="method"]').selectOption('bank_transfer');
  await page.locator('#payment-record-button').click();
  await expect(page.locator('[data-payment-total="received"]')).toHaveText('₹5.00');
  await expect(page.locator('[data-payment-total="remaining"]')).toHaveText('₹5.08');
  expect((await app.backend.db.models.documents.findById(id)).balanceDue).toBe(5.08);
});

test('stale tabs keep unsaved input and cannot overwrite a newer draft', async ({ page, context, app }) => {
  await signIn(page, app);
  const customer = await api(page, app, '/customers', 'POST', customerInput(app.organizationId));
  const invoice = await api(page, app, '/documents', 'POST', invoiceInput(app.organizationId, customer.id));
  const stale = await context.newPage();
  try {
    await page.goto(workspace(app, `invoices/edit/${invoice.id}`));
    await stale.goto(workspace(app, `invoices/edit/${invoice.id}`));
    await page.locator('[name="notes"]').fill('Saved from the first tab');
    await page.locator('#doc-save-button').click();
    await expect(page).toHaveURL(/\/preview\//);
    await stale.locator('[name="title"]').fill('Unsaved second-tab title');
    await stale.locator('#doc-save-button').click();
    await expect(stale.locator('#doc-save-conflict')).toBeVisible();
    await expect(stale.locator('[name="title"]')).toHaveValue('Unsaved second-tab title');
    const saved = await app.backend.db.models.documents.findById(invoice.id);
    expect(saved.notes).toBe('Saved from the first tab');
    expect(saved.title).toBe('Browser Invoice');
  } finally {
    await stale.close();
  }
});

test('legacy invoice amounts survive browser edits until a draft is financially changed', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  const customer = await api(page, app, '/customers', 'POST', customerInput(app.organizationId));
  const invoice = await api(
    page,
    app,
    '/documents',
    'POST',
    invoiceInput(app.organizationId, customer.id, {
      items: [{ description: 'Legacy fractional service', quantity: 0.5, rate: 20.15, hsn: '', gstRate: 0 }],
    }),
  );
  const legacyTotals = {
    subtotal: 10.07,
    discount: 0,
    taxable: 10.07,
    cgst: 0,
    sgst: 0,
    igst: 0,
    total: 10.07,
  };
  await app.backend.db.collection('documents').updateOne(
    { id: invoice.id },
    {
      $set: { totals: legacyTotals, balanceDue: 10.07 },
    },
  );
  await page.goto(workspace(app, `invoices/edit/${invoice.id}`));
  await page.locator('[name="notes"]').fill('Keep the existing agreed amount');
  await expect(page.locator('[data-line-amount]').first()).toHaveText('₹10.07');
  await expect(page.locator('[data-total="total"]')).toHaveText('₹10.07');
  await page.locator('#doc-save-button').click();
  await expect(page).toHaveURL(/\/invoices\/preview\//);
  const savedLegacy = await app.backend.db.models.documents.findById(invoice.id);
  expect(savedLegacy.notes).toBe('Keep the existing agreed amount');
  expect(savedLegacy.totals).toEqual(legacyTotals);

  await page.goto(workspace(app, `invoices/edit/${invoice.id}`));
  await page.locator('[data-line="quantity"]').first().fill('1.25');
  await page.locator('[data-line="rate"]').first().fill('8.06');
  await expect(page.locator('[data-line-amount]').first()).toHaveText('₹10.08');
  await expect(page.locator('[data-total="total"]')).toHaveText('₹10.08');
  await page.locator('#doc-save-button').click();
  await expect(page).toHaveURL(/\/invoices\/preview\//);
  const repriced = await app.backend.db.models.documents.findById(invoice.id);
  expect(repriced.totals.total).toBe(10.08);
  expect(repriced.totals.roundingPolicy).toBe('decimal-half-up-v1');
});

test('a lost successful save response retries the same invoice without duplicating records', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  const customer = await api(page, app, '/customers', 'POST', customerInput(app.organizationId));
  await fillInvoice(page, app, customer);
  let dropped = false;
  await page.route('**/api/documents', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.locator('#doc-save-button').click();
  await expect(page.locator('#doc-save-button')).toHaveText('Retry save');
  expect(
    await app.backend.db.collection('documents').countDocuments({ organizationId: app.organizationId }),
  ).toBe(1);
  await page.locator('#doc-save-button').click();
  await expect(page).toHaveURL(/\/invoices\/preview\//);
  expect(
    await app.backend.db.collection('documents').countDocuments({ organizationId: app.organizationId }),
  ).toBe(1);
  expect(
    await app.backend.db
      .collection('document_requests')
      .countDocuments({ organizationId: app.organizationId }),
  ).toBe(1);
});

test('directory pages, editor search and CSV export keep results complete and page payloads bounded', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  const { customers } = await seedDirectory(app);
  await page.goto(workspace(app, 'customers'));
  await expect(page.locator('[data-contact-row]')).toHaveCount(50);
  let data = await page.locator('#page-data').textContent();
  expect(JSON.parse(data).customers.length).toBe(50);
  await page.getByRole('navigation', { name: 'Contact pages' }).locator('[rel="next"]').click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('[data-contact-row]')).toHaveCount(50);
  const search = page.locator('[data-directory-filters] [name="q"]');
  await search.fill('Customer 121');
  await search.press('Enter');
  await expect(page.locator('[data-contact-row]')).toHaveCount(1);
  await expect(page.locator('[data-contact-row]')).toContainText('Directory Customer 121');

  const exported = await page.request.get(
    `${app.base}/api/customers/export?organizationId=${app.organizationId}`,
  );
  expect(exported.status()).toBe(200);
  const csv = await exported.text();
  expect(csv).toContain('Directory Customer 001');
  expect(csv).toContain('Directory Customer 121');
  expect(csv.trim().split(/\r?\n/)).toHaveLength(122);

  await page.goto(workspace(app, 'catalog'));
  data = await page.locator('#page-data').textContent();
  expect(JSON.parse(data).catalog.length).toBe(50);
  await page.getByRole('navigation', { name: 'Catalog pages' }).locator('[rel="next"]').click();
  await expect(page).toHaveURL(/page=2/);
  await page.goto(workspace(app, 'invoices/new'));
  data = JSON.parse(await page.locator('#page-data').textContent());
  expect(data.customers.length).toBeLessThanOrEqual(20);
  expect(data.catalog.length).toBeLessThanOrEqual(20);
  await page.getByRole('searchbox', { name: 'Search saved contacts' }).fill('Customer 121');
  await expect(page.locator('#doc-customer option')).toContainText([
    'Select a saved contact',
    'Directory Customer 121',
  ]);
  await page.locator('#doc-customer').selectOption(customers.at(-1).id);
  await page.locator('#doc-catalog-search').fill('Product 121');
  await expect(page.locator('#doc-catalog-results [data-catalog-id]')).toHaveCount(1);
  await expect(page.locator('#doc-catalog-results')).toContainText('Directory Product 121');
});

test('adding a contact returns to the exact draft and selects a new contact outside the first lookup page', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  await seedDirectory(app, 60);
  await page.goto(workspace(app, 'invoices/new'));
  await page.locator('[name="title"]').fill('Return to this specific draft');
  await page.locator('a[data-manager-link][href*="/customers/new"]').click();
  await expect(page).toHaveURL(/\/customers\/new\?/);
  await page.locator('#contact-form [name="name"]').fill('ZZZ Newly Added Contact');
  await page.locator('#contact-form [name="stateCode"]').selectOption('09');
  await page.locator('#contact-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/invoices\/new/);
  await expect(page.locator('[name="title"]')).toHaveValue('Return to this specific draft');
  const customer = await app.backend.db.collection('customers').findOne({ name: 'ZZZ Newly Added Contact' });
  await expect(page.locator('#doc-customer')).toHaveValue(customer.id);
  await expect(page.locator('#doc-customer-card')).toContainText('ZZZ Newly Added Contact');
});

test('an expense fills from a vendor contact, previews its GST, saves, edits and deletes', async ({
  page,
  app,
}) => {
  await signIn(page, app);
  const vendor = await api(page, app, '/customers', 'POST', {
    ...customerInput(app.organizationId, 'Browser Vendor'),
    roles: ['vendor'],
    gstin: '27AAACR5055K1Z7',
    stateCode: '27',
  });
  await page.goto(workspace(app, 'expenses?month=2026-09'));
  const form = page.locator('[data-expense-form]');
  await form.locator('[name="vendorId"]').selectOption(vendor.id);
  await expect(form.locator('[name="vendorName"]')).toHaveValue('Browser Vendor');
  await expect(form.locator('[name="interstate"]')).toHaveValue('true');
  await form.locator('[name="billDate"]').fill('2026-09-05');
  await form.locator('[name="taxable"]').fill('0.1');
  await form.locator('[name="gstRate"]').selectOption('18');
  await expect(form.locator('[data-expense-preview]')).toContainText('IGST');
  await form.locator('[name="interstate"]').selectOption('false');
  const preview = await form.locator('[data-expense-preview]').textContent();
  await form.getByRole('button', { name: 'Add expense' }).click();
  await expect(page).toHaveURL(/\/expenses\?month=2026-09$/);
  const saved = await app.backend.db.collection('expenses').findOne({ vendorId: vendor.id });
  expect([saved.cgst, saved.sgst, saved.total]).toEqual([0.01, 0.01, 0.12]);
  expect(preview).toContain('Total ₹0.12');

  await page.getByRole('link', { name: 'Edit' }).click();
  await form.locator('[name="taxable"]').fill('100');
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(/\/expenses\?month=2026-09$/);
  await expect(page.locator('.finance-table')).toContainText('₹118.00');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No expenses this month')).toBeVisible();
});
