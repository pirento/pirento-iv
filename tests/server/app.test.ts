import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import {
  COMPANY_NAME,
  blankShipping,
  calculateLineAmount,
  calculateTotals,
  defaultDocumentBranding,
  defaultFormatFor,
  installmentBalances,
  type Organization,
  type Customer,
  type DocumentInput,
  type BusinessDocument,
  type CatalogInput,
  type CatalogItem,
  type InvoiceFormat,
  type PaymentInput,
  type PaymentDetails,
  type BusinessProduct,
  type InstallmentPlan,
  type WorkspaceSettings,
} from '../../shared/types.ts';
import { validGstin } from '../../server/validation/validation.ts';

const ORG = 'pipeline2-ecosystem';
const OTHER_ORG = 'at-facilities';
const GSTIN = '27AAPFU0939F1ZV';

async function fixture(
  t: TestContext,
  extra: Partial<Parameters<typeof createApp>[0]> = {},
  filename = ':memory:',
) {
  const db = initDb(filename);
  // Application tests never inherit real provider credentials from the hosting environment.
  const app = createApp({
    auth: false,
    db,
    environment: {},
    now: () => new Date('2026-10-08T12:00:00.000Z'),
    ...extra,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  async function request<T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
    expectedStatus = 200,
  ): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function customer(organizationId = ORG, overrides: Partial<Customer> = {}) {
    return request<Customer>(
      '/api/customers',
      'POST',
      {
        organizationId,
        name: 'Test Customer',
        email: '',
        phone: '',
        gstin: '',
        address: 'Test address',
        stateCode: '27',
        contactPerson: '',
        ...overrides,
      },
      201,
    );
  }
  async function input(overrides: Partial<DocumentInput> = {}): Promise<DocumentInput> {
    const savedCustomer = await customer(overrides.organizationId);
    return {
      organizationId: ORG,
      customerId: savedCustomer.id,
      kind: 'quotation',
      status: 'draft',
      businessProductId: (overrides.organizationId ?? ORG) === ORG ? 'ecosystem-product-1' : undefined,
      issueDate: '2026-10-08',
      dueDate: '2026-10-20',
      title: 'Service quotation',
      items: [{ description: 'Workspace services', hsn: '998599', quantity: 2, rate: 1500, gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '27',
      notes: '',
      terms: '',
      ...overrides,
    };
  }
  async function enableTax() {
    const organizations = await request<Organization[]>('/api/organizations');
    const organization = organizations.find((item) => item.id === ORG)!;
    return request<Organization>(`/api/organizations/${ORG}`, 'PUT', {
      ...organization,
      gstin: GSTIN,
      stateCode: '27',
    });
  }
  return { request, customer, input, enableTax, db, base };
}

test('rounding, discounts and intrastate/interstate GST have consistent totals', () => {
  const items = [{ description: 'Service', hsn: '', quantity: 3, rate: 199.99, gstRate: 18 }];
  assert.deepEqual(calculateTotals(items, 10, false), {
    subtotal: 599.97,
    discount: 60,
    taxable: 539.97,
    cgst: 48.6,
    sgst: 48.6,
    igst: 0,
    total: 637.17,
  });
  assert.deepEqual(calculateTotals(items, 10, true), {
    subtotal: 599.97,
    discount: 60,
    taxable: 539.97,
    cgst: 0,
    sgst: 0,
    igst: 97.2,
    total: 637.17,
  });
  const penny = calculateTotals([{ ...items[0], quantity: 1, rate: 0.05 }], 0, false);
  assert.equal(penny.cgst + penny.sgst, 0.01);
  assert.equal(penny.total, 0.06);
});

test('GSTIN checks known check digits, format and valid state codes', () => {
  assert.equal(validGstin(GSTIN), true);
  assert.equal(validGstin('29AABCU9603R1ZJ'), true);
  assert.equal(validGstin('27AAPFU0939F1ZA'), false);
  assert.equal(validGstin('99AAPFU0939F1ZV'), false);
  assert.equal(validGstin('not-a-gstin'), false);
});

test('database seeds six branded organizations and preserves saved data across reopen', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'venture-db-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'workspace.sqlite');
  const { request, customer } = await fixture(t, {}, filename);
  const organizations = await request<Organization[]>('/api/organizations');
  assert.equal(organizations.length, 6);
  assert.deepEqual(
    organizations.map((org) => org.name),
    ['Pirento legal', 'Pirento ecosystem', 'AT Facility', 'A T Elevator', 'INZARIO SPACE', 'Shri Sarraf'],
  );
  assert.ok(
    organizations.every(
      (org) =>
        org.legalName === (org.id === 'shri-sarraf' ? 'Shri Sarraf' : COMPANY_NAME) && org.gstin === '',
    ),
  );
  assert.equal(organizations.find((org) => org.id === 'shri-sarraf')?.businessType, 'independent');
  assert.deepEqual(await request(`/api/customers?organizationId=${ORG}`), []);
  assert.deepEqual(await request(`/api/documents?organizationId=${ORG}`), []);
  const saved = await customer();
  const second = initDb(filename);
  try {
    const row = second.prepare('SELECT data FROM customers WHERE id = ?').get(saved.id) as { data: string };
    assert.equal(JSON.parse(row.data).name, 'Test Customer');
  } finally {
    second.close();
  }
});

test('customers and documents stay in their organization; used customers cannot be deleted', async (t) => {
  const { request, input, customer } = await fixture(t);
  const otherCustomer = await customer(OTHER_ORG);
  const docInput = await input();
  await request('/api/documents', 'POST', { ...docInput, customerId: otherCustomer.id }, 400);
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(saved.number, 'P2EQ/2627/0001');
  assert.equal((await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}`)).length, 1);
  assert.deepEqual(await request(`/api/documents?organizationId=${OTHER_ORG}`), []);
  await request(
    `/api/documents/${saved.id}`,
    'PUT',
    { ...docInput, organizationId: OTHER_ORG, customerId: otherCustomer.id },
    400,
  );
  await request(`/api/customers/${otherCustomer.id}`, 'PUT', { ...otherCustomer, organizationId: ORG }, 400);
  await request(`/api/customers/${docInput.customerId}`, 'DELETE', undefined, 409);
  await request('/api/documents', 'GET', undefined, 400);
});

test('numbers are unique under concurrent saves and scoped by kind and Indian financial year', async (t) => {
  const { request, input } = await fixture(t);
  const docInput = await input();
  const documents = await Promise.all(
    Array.from({ length: 8 }, () => request<BusinessDocument>('/api/documents', 'POST', docInput, 201)),
  );
  assert.equal(new Set(documents.map((document) => document.number)).size, 8);
  assert.ok(documents.every((document) => document.number.length <= 16));
  const invoice = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, kind: 'invoice' },
    201,
  );
  assert.equal(invoice.number, 'P2EI/2627/0001');
  const march = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, issueDate: '2027-03-31', dueDate: '' },
    201,
  );
  assert.equal(march.number, 'P2EQ/2627/0009');
  const april = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, issueDate: '2027-04-01', dueDate: '' },
    201,
  );
  assert.equal(april.number, 'P2EQ/2728/0001');
  await request(
    `/api/documents/${march.id}`,
    'PUT',
    { ...docInput, issueDate: '2027-04-01', dueDate: '' },
    400,
  );
  await request(`/api/documents/${documents[0].id}`, 'DELETE');
  const next = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(next.number, 'P2EQ/2627/0010');
});

test('quotation conversion is idempotent, keeps snapshots, marks accepted and protects links', async (t) => {
  const { request, input } = await fixture(t);
  const docInput = await input();
  const quotation = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  await request(`/api/customers/${docInput.customerId}`, 'PUT', {
    ...quotation.customerSnapshot,
    name: 'Changed after quotation',
  });
  const invoice = await request<BusinessDocument>(`/api/documents/${quotation.id}/convert`, 'POST', {}, 201);
  const again = await request<BusinessDocument>(`/api/documents/${quotation.id}/convert`, 'POST', {});
  assert.equal(invoice.id, again.id);
  assert.equal(invoice.number, 'P2EI/2627/0001');
  assert.equal(invoice.customerSnapshot.name, 'Test Customer');
  assert.equal(invoice.sourceQuotationId, quotation.id);
  const documents = await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}`);
  const original = documents.find((document) => document.id === quotation.id)!;
  assert.equal(original.status, 'accepted');
  assert.equal(original.convertedInvoiceId, invoice.id);
  await request(`/api/documents/${quotation.id}`, 'PUT', { ...docInput, notes: 'change' }, 409);
  await request(`/api/documents/${invoice.id}`, 'DELETE', undefined, 409);
  await request(`/api/documents/${invoice.id}/convert`, 'POST', {}, 400);
});

test('metadata updates preserve financial snapshots; draft financial changes use current master data', async (t) => {
  const { request, input, enableTax } = await fixture(t);
  await enableTax();
  const docInput = await input({
    kind: 'invoice',
    items: [{ description: 'Taxed service', hsn: '', quantity: 1, rate: 1000, gstRate: 18 }],
  });
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  await request(`/api/organizations/${ORG}`, 'PUT', { ...saved.organizationSnapshot, name: 'Updated brand' });
  await request(`/api/customers/${saved.customerId}`, 'PUT', {
    ...saved.customerSnapshot,
    name: 'Updated customer',
  });
  const metadata = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', {
    ...docInput,
    notes: 'Metadata only',
  });
  assert.equal(metadata.organizationSnapshot.name, saved.organizationSnapshot.name);
  assert.equal(metadata.customerSnapshot.name, saved.customerSnapshot.name);
  assert.deepEqual(metadata.totals, saved.totals);
  const changedInput = { ...docInput, items: [{ ...docInput.items[0], rate: 2000 }] };
  const changed = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', changedInput);
  assert.equal(changed.organizationSnapshot.name, 'Updated brand');
  assert.equal(changed.customerSnapshot.name, 'Updated customer');
  assert.equal(changed.totals.total, 2360);
  await request(`/api/documents/${saved.id}`, 'PUT', { ...changedInput, status: 'sent' });
  await request(`/api/documents/${saved.id}`, 'PUT', { ...changedInput, status: 'draft' }, 409);
  await request(
    `/api/documents/${saved.id}`,
    'PUT',
    { ...changedInput, status: 'sent', items: docInput.items },
    409,
  );
  await request(
    `/api/documents/${saved.id}`,
    'PUT',
    { ...changedInput, status: 'paid', notes: 'Payment received' },
    409,
  );
  const { document: paid } = await request<PaymentDetails>(
    `/api/documents/${saved.id}/payments`,
    'POST',
    {
      amount: 2360,
      paidOn: '2026-10-08',
      method: 'bank_transfer',
      reference: 'Settlement',
      notes: '',
      requestId: 'snapshot-test-payment',
    },
    201,
  );
  assert.equal(paid.status, 'paid');
  assert.equal(paid.totals.total, 2360);
  await request(`/api/documents/${saved.id}`, 'DELETE', undefined, 409);
});

test('conversion uses the current India date and fiscal year, carries payment interval and preserves quoted finances', async (t) => {
  // UTC is still March 31; India has entered April 1 and a new financial year.
  const { request, input, enableTax } = await fixture(t, { now: () => new Date('2026-03-31T20:00:00.000Z') });
  const organization = await enableTax();
  const quoteInput = await input({
    issueDate: '2025-03-01',
    dueDate: '2025-03-15',
    title: 'Quotation',
    items: [{ description: 'Agreed service', hsn: '', quantity: 3, rate: 123.45, gstRate: 18 }],
    discountPercent: 5,
  });
  const quotation = await request<BusinessDocument>('/api/documents', 'POST', quoteInput, 201);
  assert.equal(quotation.number, 'P2EQ/2425/0001');
  await request(`/api/organizations/${ORG}`, 'PUT', {
    ...organization,
    invoicePrefix: 'NEWI',
    name: 'Renamed current division',
  });
  const invoice = await request<BusinessDocument>(`/api/documents/${quotation.id}/convert`, 'POST', {}, 201);
  assert.equal(invoice.issueDate, '2026-04-01');
  assert.equal(invoice.dueDate, '2026-04-15');
  assert.equal(invoice.number, 'NEWI/2627/0001');
  assert.equal(invoice.title, 'Invoice');
  assert.deepEqual(invoice.totals, quotation.totals);
  assert.deepEqual(invoice.organizationSnapshot, quotation.organizationSnapshot);
  assert.deepEqual(invoice.customerSnapshot, quotation.customerSnapshot);
  const noDueDate = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...quoteInput, title: 'Annual lift servicing', dueDate: '' },
    201,
  );
  const second = await request<BusinessDocument>(`/api/documents/${noDueDate.id}/convert`, 'POST', {}, 201);
  assert.equal(second.title, 'Annual lift servicing');
  assert.equal(second.dueDate, '');
});

test('cross-site browser calls and simple form submissions cannot mutate local documents', async (t) => {
  const { request, input, base } = await fixture(t);
  const quotation = await request<BusinessDocument>('/api/documents', 'POST', await input(), 201);
  const path = `${base}/api/documents/${quotation.id}/convert`;
  const crossSite = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  const form = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'convert=yes',
  });
  assert.equal(form.status, 415);
  const saved = await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}`);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].convertedInvoiceId, null);
});

test('invalid tax configuration, dates, amounts, statuses and prefixes are rejected', async (t) => {
  const { request, input, enableTax } = await fixture(t);
  const docInput = await input();
  await request('/api/documents', 'POST', { ...docInput, issueDate: '2026-02-30' }, 400);
  await request('/api/documents', 'POST', { ...docInput, dueDate: '2026-01-01' }, 400);
  await request('/api/documents', 'POST', { ...docInput, status: 'paid' }, 400);
  await request(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], quantity: 0 }] },
    400,
  );
  await request('/api/documents', 'POST', { ...docInput, items: [{ ...docInput.items[0], rate: -10 }] }, 400);
  await request(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], description: '  ' }] },
    400,
  );
  const taxed = { ...docInput, items: [{ ...docInput.items[0], gstRate: 18 }] };
  await request('/api/documents', 'POST', taxed, 400);
  const org = await enableTax();
  await request('/api/documents', 'POST', { ...taxed, placeOfSupply: '' }, 400);
  const interstate = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...taxed, placeOfSupply: '29' },
    201,
  );
  assert.equal(interstate.totals.igst, 540);
  assert.equal(interstate.totals.cgst, 0);
  await request(
    '/api/organizations',
    'POST',
    { ...org, name: 'Another brand', invoicePrefix: org.invoicePrefix, quotationPrefix: 'NEWQ' },
    409,
  );
  await request(`/api/organizations/${ORG}`, 'PUT', { ...org, stateCode: '29' }, 400);
  await request(`/api/organizations/${ORG}`, 'PUT', { ...org, gstin: '27AAPFU0939F1ZA' }, 400);
});

test('GST lookup has honest missing-provider errors and normalized provider responses', async (t) => {
  const empty = await fixture(t, { gstLookupUrl: '' });
  const health = await empty.request('/api/health');
  assert.equal(health.gstConfigured, false);
  assert.equal(health.gstMode, 'portal');
  await empty.request(`/api/gst/${GSTIN}`, 'GET', undefined, 503);
  await empty.request('/api/gst/27AAPFU0939F1ZA', 'GET', undefined, 400);
  let forwardedAuthorization = '';
  const provider = await fixture(t, {
    gstLookupUrl: 'https://example.test/gst/{gstin}',
    gstApiKey: 'server-only-test-key',
    fetch: (async (url, init) => {
      assert.equal(String(url), `https://example.test/gst/${GSTIN}`);
      forwardedAuthorization = new Headers(init?.headers).get('Authorization') ?? '';
      return Response.json({
        data: {
          gstin: GSTIN,
          name: 'Registered customer',
          address: 'Registered address',
          stateCode: '27',
          status: 'Active',
        },
      });
    }) as typeof fetch,
  });
  const result = await provider.request(`/api/gst/${GSTIN}`);
  assert.equal(result.name, 'Registered customer');
  assert.equal(forwardedAuthorization, 'Bearer server-only-test-key');
  assert.ok(!JSON.stringify(result).includes('server-only-test-key'));
});

test('human CAPTCHA sessions keep cookies server-side, normalize results and cannot be reused', async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const { request } = await fixture(t, {
    gstLookupUrl: '',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/captcha?'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: {
            'Content-Type': 'image/png',
            'Set-Cookie': 'CaptchaCookie=private-session; Path=/; Secure; HttpOnly',
          },
        });
      assert.equal(new Headers(init?.headers).get('Cookie'), 'CaptchaCookie=private-session');
      assert.deepEqual(JSON.parse(String(init?.body)), { gstin: GSTIN, captcha: '123456' });
      return Response.json({
        gstin: GSTIN,
        lgnm: 'Portal taxpayer',
        sts: 'Active',
        pradr: { adr: 'GST registered address' },
      });
    }) as typeof fetch,
  });
  const challenge = await request<{ challengeId: string; image: string }>('/api/gst/captcha');
  assert.ok(challenge.image.startsWith('data:image/png;base64,'));
  assert.ok(!JSON.stringify(challenge).includes('private-session'));
  const body = { gstin: GSTIN, challengeId: challenge.challengeId, captcha: '123456' };
  const result = await request('/api/gst/lookup', 'POST', body);
  assert.equal(result.name, 'Portal taxpayer');
  assert.equal(result.stateCode, '27');
  await request('/api/gst/lookup', 'POST', body, 400);
  assert.equal(calls.length, 2);
});

test('portal network failures return a manual-entry fallback and hide upstream errors', async (t) => {
  const { request } = await fixture(t, {
    fetch: (async () => {
      throw new Error('Proxy refused with secret: do-not-expose');
    }) as typeof fetch,
  });
  const error = await request<{ error: string }>('/api/gst/captcha', 'GET', undefined, 502);
  assert.match(error.error, /manually/);
  assert.ok(!error.error.includes('do-not-expose'));
});

test('uploaded logos must match an allowed image signature', async (t) => {
  const { request } = await fixture(t);
  const [organization] = await request<Organization[]>('/api/organizations');
  await request(
    `/api/organizations/${organization.id}`,
    'PUT',
    { ...organization, logoUrl: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` },
    400,
  );
  await request(
    `/api/organizations/${organization.id}`,
    'PUT',
    { ...organization, logoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    400,
  );
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=';
  const result = await request<Organization>(`/api/organizations/${organization.id}`, 'PUT', {
    ...organization,
    logoUrl: png,
  });
  assert.equal(result.logoUrl, png);
});

test('company migration preserves records, prefixes and historical branding and runs only once', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'venturecore-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'legacy.sqlite');
  const { request, input, db } = await fixture(t, {}, filename);
  const saved = await request<BusinessDocument>('/api/documents', 'POST', await input(), 201);
  const oldLegalName = 'Venture Force Solutions Private Limited';
  const oldOrganization = {
    ...saved.organizationSnapshot,
    name: 'Pipeline2 Ecosystem',
    legalName: oldLegalName,
    invoicePrefix: 'MYIN',
    quotationPrefix: 'MYQT',
    template: 'classic',
    accentColor: '#654321',
    bankName: 'Existing bank',
    terms: 'Existing terms',
  };
  db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(JSON.stringify(oldOrganization), ORG);
  const historical = {
    ...saved,
    organizationSnapshot: {
      ...saved.organizationSnapshot,
      name: 'Pipeline2 Ecosystem',
      legalName: oldLegalName,
      accentColor: '#123456',
    },
  };
  delete historical.formatId;
  delete historical.formatSnapshot;
  db.prepare('UPDATE documents SET data = ? WHERE id = ?').run(JSON.stringify(historical), saved.id);
  const [baseOrganization] = await request<Organization[]>('/api/organizations');
  const custom = await request<Organization>(
    '/api/organizations',
    'POST',
    { ...baseOrganization, name: 'Custom division', invoicePrefix: 'CUSI', quotationPrefix: 'CUSQ' },
    201,
  );
  // Reconstruct the pre-upgrade tables while retaining real related records.
  db.exec('DROP TABLE formats; DROP TABLE catalog;');
  db.prepare('DELETE FROM organizations WHERE id = ?').run('shri-sarraf');
  const other = (await request<Organization[]>('/api/organizations')).find((org) => org.id === OTHER_ORG)!;
  db.prepare('UPDATE organizations SET data = ? WHERE id = ?').run(
    JSON.stringify({ ...other, invoicePrefix: 'SSRI', quotationPrefix: 'SSRQ' }),
    OTHER_ORG,
  );
  db.exec('PRAGMA user_version = 0');

  const migrated = initDb(filename);
  const read = <T>(table: string, id: string) =>
    JSON.parse(
      (migrated.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }).data,
    ) as T;
  try {
    const organization = read<Organization>('organizations', ORG);
    assert.equal(organization.name, 'Pirento ecosystem');
    assert.equal(organization.legalName, COMPANY_NAME);
    assert.equal(organization.invoicePrefix, 'MYIN');
    assert.equal(organization.quotationPrefix, 'MYQT');
    assert.equal(organization.bankName, 'Existing bank');
    assert.equal(organization.terms, 'Existing terms');
    const document = read<BusinessDocument>('documents', saved.id);
    assert.deepEqual(document.organizationSnapshot, historical.organizationSnapshot);
    assert.deepEqual(document.customerSnapshot, saved.customerSnapshot);
    assert.deepEqual(document.totals, saved.totals);
    assert.equal(document.number, saved.number);
    assert.equal(document.formatSnapshot?.accentColor, '#123456');
    assert.equal(document.formatSnapshot?.layout, 'modern');
    assert.equal(read<InvoiceFormat>('formats', `${ORG}-standard`).accentColor, '#654321');
    assert.equal(read<InvoiceFormat>('formats', `${ORG}-standard`).layout, 'classic');
    assert.equal(read<Customer>('customers', saved.customerId).name, saved.customerSnapshot.name);
    assert.equal(read<Organization>('organizations', custom.id).name, 'Custom division');
    assert.equal(read<Organization>('organizations', custom.id).legalName, COMPANY_NAME);
    const sarraf = read<Organization>('organizations', 'shri-sarraf');
    assert.equal(sarraf.name, 'Shri Sarraf');
    assert.notEqual(sarraf.invoicePrefix, 'SSRI');
    assert.notEqual(sarraf.quotationPrefix, 'SSRQ');
    assert.notEqual(sarraf.invoicePrefix, sarraf.quotationPrefix);
    assert.ok(sarraf.invoicePrefix.length <= 4 && sarraf.quotationPrefix.length <= 4);
    migrated
      .prepare('UPDATE organizations SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...organization, name: 'User edited after migration' }), ORG);
  } finally {
    migrated.close();
  }
  const repeated = initDb(filename);
  try {
    const rows = repeated.prepare('SELECT data FROM organizations').all() as { data: string }[];
    assert.equal(rows.length, 7);
    assert.equal(
      rows.map((row) => JSON.parse(row.data) as Organization).find((org) => org.id === ORG)?.name,
      'User edited after migration',
    );
    assert.equal(
      (repeated.prepare('SELECT COUNT(*) AS count FROM formats').get() as { count: number }).count,
      105,
    );
    const document = JSON.parse(
      (repeated.prepare('SELECT data FROM documents WHERE id = ?').get(saved.id) as { data: string }).data,
    ) as BusinessDocument;
    assert.deepEqual(document.organizationSnapshot, historical.organizationSnapshot);
    assert.deepEqual(document.totals, saved.totals);
  } finally {
    repeated.close();
  }
});

const catalogInput = (overrides: Partial<CatalogInput> = {}): CatalogInput => ({
  organizationId: ORG,
  type: 'service',
  name: 'Annual maintenance',
  description: 'Scheduled maintenance visit',
  sku: 'SERVICE-01',
  hsn: '998599',
  unit: 'Visit',
  rate: 1200,
  gstRate: 0,
  active: true,
  ...overrides,
});

test('catalog validates products and services, scopes SKU uniqueness and supports archival', async (t) => {
  const { request } = await fixture(t);
  const input = catalogInput();
  const saved = await request<CatalogItem>('/api/catalog', 'POST', input, 201);
  await request('/api/catalog', 'POST', { ...input, sku: 'service-01' }, 409);
  const other = await request<CatalogItem>(
    '/api/catalog',
    'POST',
    { ...input, organizationId: OTHER_ORG, type: 'product' },
    201,
  );
  assert.equal(other.type, 'product');
  assert.equal((await request<CatalogItem[]>(`/api/catalog?organizationId=${ORG}`)).length, 1);
  await request(`/api/catalog/${saved.id}`, 'PUT', { ...saved, organizationId: OTHER_ORG }, 400);
  const archived = await request<CatalogItem>(`/api/catalog/${saved.id}`, 'PUT', { ...saved, active: false });
  assert.equal(archived.active, false);
  assert.equal((await request<CatalogItem[]>(`/api/catalog?organizationId=${ORG}`))[0].active, false);
  await request('/api/catalog', 'POST', input, 409);
  await request(`/api/catalog/${saved.id}`, 'DELETE', undefined, 404);
  const blankSku = { ...input, sku: '' };
  await request('/api/catalog', 'POST', blankSku, 201);
  await request('/api/catalog', 'POST', blankSku, 201);
  for (const override of [
    { name: '' },
    { rate: -1 },
    { gstRate: 41 },
    { unit: 'x'.repeat(21) },
    { hsn: 'ABC' },
    { type: 'other' },
  ]) {
    await request('/api/catalog', 'POST', { ...input, ...override }, 400);
  }
  await request('/api/catalog', 'GET', undefined, 400);
});

test('catalog-backed lines retain negotiated values and support old archived references only within their organization', async (t) => {
  const { request, input } = await fixture(t);
  const item = await request<CatalogItem>('/api/catalog', 'POST', catalogInput(), 201);
  const docInput = await input({
    items: [
      {
        description: 'Negotiated maintenance',
        hsn: '998599',
        quantity: 2,
        rate: 900,
        gstRate: 0,
        unit: 'Visit',
        itemType: 'service',
        catalogItemId: item.id,
      },
    ],
  });
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(saved.items[0].unit, 'Visit');
  assert.equal(saved.items[0].catalogItemId, item.id);
  assert.equal(saved.totals.total, 1800);
  await request(`/api/catalog/${item.id}`, 'PUT', {
    ...item,
    active: false,
    rate: 9999,
    description: 'New catalog wording',
  });
  await request('/api/documents', 'POST', docInput, 400);
  const edited = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', {
    ...docInput,
    notes: 'Existing archived line remains valid',
  });
  assert.deepEqual(edited.items, saved.items);
  assert.deepEqual(edited.totals, saved.totals);
  const otherItem = await request<CatalogItem>(
    '/api/catalog',
    'POST',
    catalogInput({ organizationId: OTHER_ORG }),
    201,
  );
  await request(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], catalogItemId: otherItem.id }] },
    400,
  );
  await request(
    `/api/documents/${saved.id}`,
    'PUT',
    { ...docInput, items: [{ ...docInput.items[0], catalogItemId: otherItem.id }] },
    400,
  );
  const invoice = await request<BusinessDocument>(`/api/documents/${saved.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(invoice.items, saved.items);
  assert.deepEqual(invoice.totals, saved.totals);
});

test('document lines retain a full catalog name and description within a bounded length', async (t) => {
  const { request, input } = await fixture(t);
  const item = await request<CatalogItem>(
    '/api/catalog',
    'POST',
    catalogInput({ name: 'N'.repeat(200), description: 'D'.repeat(2000) }),
    201,
  );
  const description = `${item.name}\n${item.description}`;
  const docInput = await input({
    items: [
      {
        description,
        hsn: item.hsn,
        quantity: 1,
        rate: item.rate,
        gstRate: item.gstRate,
        unit: item.unit,
        itemType: item.type,
        catalogItemId: item.id,
      },
    ],
  });
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(saved.items[0].description, description);
  await request(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], description: 'D'.repeat(2501) }] },
    400,
  );
});

test('formats keep exactly one default per organization and reject invalid or cross-organization changes', async (t) => {
  const { request } = await fixture(t);
  const [standard] = await request<InvoiceFormat[]>(`/api/formats?organizationId=${ORG}`);
  assert.equal(standard.name, 'Standard');
  assert.equal(standard.isDefault, true);
  await request(`/api/formats/${standard.id}`, 'DELETE', undefined, 409);
  await request(`/api/formats/${standard.id}`, 'PUT', { ...standard, isDefault: false }, 409);
  const custom = await request<InvoiceFormat>(
    '/api/formats',
    'POST',
    {
      ...standard,
      name: 'Compact service',
      layout: 'minimal',
      density: 'compact',
      showUnit: true,
      isDefault: false,
    },
    201,
  );
  await request(`/api/formats/${standard.id}`, 'DELETE', undefined, 409);
  await request(
    `/api/formats/${custom.id}`,
    'PUT',
    { ...custom, organizationId: OTHER_ORG, isDefault: true },
    400,
  );
  await request(`/api/formats/${custom.id}`, 'PUT', { ...custom, accentColor: 'red', isDefault: true }, 400);
  let formats = await request<InvoiceFormat[]>(`/api/formats?organizationId=${ORG}`);
  assert.equal(formats.filter((format) => format.isDefault).length, 1);
  assert.equal(formats.find((format) => format.isDefault)?.id, standard.id);
  const switched = await request<InvoiceFormat>(`/api/formats/${custom.id}`, 'PUT', {
    ...custom,
    isDefault: true,
  });
  assert.equal(switched.isDefault, true);
  formats = await request<InvoiceFormat[]>(`/api/formats?organizationId=${ORG}`);
  assert.equal(formats.filter((format) => format.isDefault).length, 1);
  assert.equal(formats[0].id, custom.id);
  await request(`/api/formats/${standard.id}`, 'DELETE');
  await request(`/api/formats/${custom.id}`, 'DELETE', undefined, 409);
  const organizations = await request<Organization[]>('/api/organizations');
  const newOrg = await request<Organization>(
    '/api/organizations',
    'POST',
    { ...organizations[0], name: 'New division', invoicePrefix: 'NWI', quotationPrefix: 'NWQ' },
    201,
  );
  const newFormats = await request<InvoiceFormat[]>(`/api/formats?organizationId=${newOrg.id}`);
  assert.equal(newFormats.length, 15);
  assert.equal(newFormats[0].isDefault, true);
  assert.equal(newFormats[0].presetKey, 'standard');
  await request('/api/formats', 'GET', undefined, 400);
});

test('document format snapshots survive master edits, deletions, financial edits and quotation conversion', async (t) => {
  const { request, input } = await fixture(t);
  const [standard] = await request<InvoiceFormat[]>(`/api/formats?organizationId=${ORG}`);
  const [otherFormat] = await request<InvoiceFormat[]>(`/api/formats?organizationId=${OTHER_ORG}`);
  const docInput = await input();
  await request('/api/documents', 'POST', { ...docInput, formatId: otherFormat.id }, 400);
  const custom = await request<InvoiceFormat>(
    '/api/formats',
    'POST',
    {
      ...standard,
      name: 'Agreed format',
      layout: 'classic',
      accentColor: '#225566',
      footerText: 'Agreed footer',
      isDefault: true,
    },
    201,
  );
  const quote = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(quote.formatId, custom.id);
  assert.deepEqual(quote.formatSnapshot, custom);
  await request(`/api/formats/${custom.id}`, 'PUT', {
    ...custom,
    layout: 'minimal',
    footerText: 'Changed master footer',
  });
  await request(`/api/formats/${standard.id}`, 'PUT', { ...standard, isDefault: true });
  await request(`/api/formats/${custom.id}`, 'DELETE');
  const metadata = await request<BusinessDocument>(`/api/documents/${quote.id}`, 'PUT', {
    ...docInput,
    formatId: custom.id,
    notes: 'Metadata edit',
  });
  assert.deepEqual(metadata.formatSnapshot, custom);
  const financialInput = { ...docInput, items: [{ ...docInput.items[0], rate: 1750 }] };
  const changed = await request<BusinessDocument>(`/api/documents/${quote.id}`, 'PUT', financialInput);
  assert.deepEqual(changed.formatSnapshot, custom);
  assert.equal(changed.totals.total, 3500);
  const invoice = await request<BusinessDocument>(`/api/documents/${quote.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(invoice.formatSnapshot, custom);
  assert.equal(invoice.formatId, custom.id);
  assert.deepEqual(invoice.organizationSnapshot, changed.organizationSnapshot);
  await request(`/api/documents/${invoice.id}`, 'PUT', { ...invoice, status: 'sent' });
  await request(`/api/organizations/${ORG}`, 'PUT', {
    ...invoice.organizationSnapshot,
    name: 'Updated live company division',
  });
  await request(
    `/api/documents/${invoice.id}`,
    'PUT',
    { ...invoice, status: 'sent', formatId: otherFormat.id },
    400,
  );
  const switched = await request<BusinessDocument>(`/api/documents/${invoice.id}`, 'PUT', {
    ...invoice,
    status: 'sent',
    formatId: standard.id,
  });
  assert.equal(switched.formatSnapshot?.id, standard.id);
  assert.deepEqual(switched.organizationSnapshot, invoice.organizationSnapshot);
  assert.deepEqual(switched.totals, invoice.totals);
  const fresh = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(fresh.formatId, standard.id);
  assert.equal(fresh.organizationSnapshot.name, 'Updated live company division');
  assert.deepEqual(defaultFormatFor(fresh.organizationSnapshot).layout, standard.layout);
});

const paymentInput = (overrides: Partial<PaymentInput> = {}): PaymentInput => ({
  amount: 0.1,
  paidOn: '2026-10-08',
  method: 'upi',
  reference: 'UTR-001',
  notes: '',
  requestId: 'payment-1',
  ...overrides,
});

test('invoice payment ledger uses integer paise, derives status and finalizes the same invoice number', async (t) => {
  const { request, input, db } = await fixture(t);
  const docInput = await input({
    kind: 'invoice',
    items: [{ description: 'Small amounts', hsn: '', quantity: 3, rate: 0.1, gstRate: 0 }],
  });
  await request('/api/documents', 'POST', { ...docInput, status: 'paid' }, 400);
  await request('/api/documents', 'POST', { ...docInput, status: 'partially_paid' }, 400);
  const invoice = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(invoice.balanceDue, 0.3);
  assert.equal(invoice.amountPaid, 0);
  for (const amount of [0, -1, 0.001])
    await request(`/api/documents/${invoice.id}/payments`, 'POST', paymentInput({ amount }), 400);
  await request(`/api/documents/${invoice.id}/finalize`, 'POST', {}, 409);
  const partial = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    paymentInput(),
    201,
  );
  assert.equal(partial.document.status, 'partially_paid');
  assert.equal(partial.document.amountPaid, 0.1);
  assert.equal(partial.document.balanceDue, 0.2);
  assert.equal(partial.document.finalizedAt, null);
  await request(
    `/api/documents/${invoice.id}`,
    'PUT',
    { ...docInput, status: 'partially_paid', items: [{ ...docInput.items[0], rate: 0.2 }] },
    409,
  );
  await request(`/api/documents/${invoice.id}`, 'PUT', { ...docInput, status: 'cancelled' }, 409);
  await request(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    paymentInput({ requestId: 'overpay', amount: 0.21 }),
    409,
  );
  const finalInput = paymentInput({ amount: 0.2, requestId: 'payment-2' });
  const final = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    finalInput,
    201,
  );
  assert.equal(final.document.status, 'paid');
  assert.equal(final.document.amountPaid, 0.3);
  assert.equal(final.document.balanceDue, 0);
  assert.equal(final.document.number, invoice.number);
  assert.equal(final.document.id, invoice.id);
  assert.ok(final.document.finalizedAt);
  assert.equal(final.payments.length, 2);
  assert.equal(final.events.filter((event) => event.type === 'invoice_finalized').length, 1);
  const stored = db
    .prepare('SELECT SUM(amount_paise) AS amount FROM payments WHERE document_id = ?')
    .get(invoice.id) as { amount: number };
  assert.equal(stored.amount, 30);
  const retry = await request<PaymentDetails>(`/api/documents/${invoice.id}/payments`, 'POST', finalInput);
  assert.deepEqual(retry, final);
  await request(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    { ...finalInput, reference: 'Different UTR' },
    409,
  );
  await request(
    `/api/documents/${invoice.id}`,
    'PUT',
    { ...docInput, status: 'paid', notes: 'Locked note' },
    409,
  );
  await request(`/api/documents/${invoice.id}`, 'DELETE', undefined, 409);
});

test('reasoned payment reversal reopens the balance and retains immutable finalization audit', async (t) => {
  const { request, input } = await fixture(t);
  const invoice = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'invoice' }),
    201,
  );
  const payment = paymentInput({ amount: invoice.totals.total });
  const settled = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    payment,
    201,
  );
  const record = settled.payments[0];
  await request(`/api/payments/${record.id}/void`, 'POST', { reason: ' ' }, 400);
  const reason = 'Bank transfer returned; receipt was entered in error.';
  const reopened = await request<PaymentDetails>(`/api/payments/${record.id}/void`, 'POST', { reason });
  assert.equal(reopened.document.number, invoice.number);
  assert.equal(reopened.document.status, 'sent');
  assert.equal(reopened.document.amountPaid, 0);
  assert.equal(reopened.document.balanceDue, invoice.totals.total);
  assert.equal(reopened.document.finalizedAt, null);
  assert.equal(reopened.payments[0].voidReason, reason);
  assert.ok(reopened.payments[0].voidedAt);
  assert.ok(reopened.events.some((event) => event.type === 'invoice_finalized'));
  assert.ok(reopened.events.some((event) => event.type === 'invoice_reopened'));
  const repeatVoid = await request<PaymentDetails>(`/api/payments/${record.id}/void`, 'POST', { reason });
  assert.deepEqual(repeatVoid, reopened);
  await request(`/api/payments/${record.id}/void`, 'POST', { reason: 'Rewritten historical reason' }, 409);
  const oldRetry = await request<PaymentDetails>(`/api/documents/${invoice.id}/payments`, 'POST', payment);
  assert.equal(oldRetry.document.amountPaid, 0);
  assert.equal(oldRetry.payments.length, 1);
  const corrected = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    { ...payment, requestId: 'corrected-payment' },
    201,
  );
  assert.equal(corrected.document.balanceDue, 0);
  assert.ok(corrected.document.finalizedAt);
  assert.equal(corrected.events.filter((event) => event.type === 'invoice_finalized').length, 2);
  assert.equal(corrected.payments.length, 2);
});

test('manual finalization is idempotent, requires settlement and handles zero-total invoices', async (t) => {
  const { request, input } = await fixture(t);
  const docInput = await input({ kind: 'invoice' });
  const invoice = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  const paid = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    paymentInput({ amount: invoice.totals.total, finalizeWhenPaid: false }),
    201,
  );
  assert.equal(paid.document.status, 'paid');
  assert.equal(paid.document.finalizedAt, null);
  await request(`/api/documents/${invoice.id}`, 'PUT', {
    ...docInput,
    status: 'paid',
    notes: 'Settlement reviewed',
  });
  const final = await request<PaymentDetails>(`/api/documents/${invoice.id}/finalize`, 'POST', {});
  assert.ok(final.document.finalizedAt);
  const repeated = await request<PaymentDetails>(`/api/documents/${invoice.id}/finalize`, 'POST', {});
  assert.deepEqual(repeated, final);
  const zero = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], rate: 0 }] },
    201,
  );
  const zeroFinal = await request<PaymentDetails>(`/api/documents/${zero.id}/finalize`, 'POST', {});
  assert.equal(zeroFinal.document.status, 'paid');
  assert.equal(zeroFinal.document.amountPaid, 0);
  assert.ok(zeroFinal.document.finalizedAt);
  assert.deepEqual(zeroFinal.payments, []);
});

test('concurrent payment retries cannot overpay or duplicate a receipt', async (t) => {
  const { request, input, base } = await fixture(t);
  const invoice = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'invoice' }),
    201,
  );
  const send = (body: PaymentInput) =>
    fetch(`${base}/api/documents/${invoice.id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const partial = paymentInput({ amount: 2000 });
  const first = await Promise.all([send(partial), send(partial)]);
  assert.deepEqual(first.map((response) => response.status).sort(), [200, 201]);
  const over = await Promise.all([
    send(paymentInput({ amount: 1000, requestId: 'balance-a' })),
    send(paymentInput({ amount: 1000, requestId: 'balance-b' })),
  ]);
  assert.deepEqual(over.map((response) => response.status).sort(), [201, 409]);
  const result = await request<PaymentDetails>(`/api/documents/${invoice.id}/payments`);
  assert.equal(result.payments.length, 2);
  assert.equal(result.document.amountPaid, invoice.totals.total);
  assert.equal(result.document.balanceDue, 0);
});

test('payment endpoints reject non-invoices and cancelled invoices', async (t) => {
  const { request, input } = await fixture(t);
  for (const kind of ['quotation', 'proforma', 'delivery_note'] as const) {
    const docInput = await input({
      kind,
      ...(kind === 'delivery_note'
        ? { items: [{ description: 'Quantity only', hsn: '', quantity: 2, rate: 0, gstRate: 0 }] }
        : {}),
    });
    const document = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
    await request(`/api/documents/${document.id}/payments`, 'POST', paymentInput(), 400);
    await request(`/api/documents/${document.id}/payments`, 'GET', undefined, 400);
    await request(`/api/documents/${document.id}/finalize`, 'POST', {}, 400);
  }
  const cancelled = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'invoice', status: 'cancelled' }),
    201,
  );
  await request(`/api/documents/${cancelled.id}/payments`, 'POST', paymentInput(), 409);
  await request(`/api/documents/${cancelled.id}/finalize`, 'POST', {}, 409);
});

test('proforma converts once with historical issuer, customer, format, shipping and financial snapshots', async (t) => {
  const { request, input } = await fixture(t);
  const shipping = {
    ...blankShipping(),
    recipientName: 'Receiving team',
    address: 'Warehouse',
    trackingNumber: 'TRACK-42',
    dispatchDate: '2026-10-10',
    deliveryDate: '2026-10-12',
  };
  const proforma = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'proforma', title: 'Proforma invoice', shipping }),
    201,
  );
  assert.equal(proforma.number, 'P2EI/2627/P0001');
  await request(`/api/organizations/${ORG}`, 'PUT', {
    ...proforma.organizationSnapshot,
    name: 'Changed current brand',
  });
  await request(`/api/customers/${proforma.customerId}`, 'PUT', {
    ...proforma.customerSnapshot,
    name: 'Changed current customer',
  });
  const invoice = await request<BusinessDocument>(`/api/documents/${proforma.id}/convert`, 'POST', {}, 201);
  assert.equal(invoice.title, 'Invoice');
  assert.equal(invoice.sourceDocumentId, proforma.id);
  assert.equal(invoice.sourceQuotationId, null);
  assert.deepEqual(invoice.organizationSnapshot, proforma.organizationSnapshot);
  assert.deepEqual(invoice.customerSnapshot, proforma.customerSnapshot);
  assert.deepEqual(invoice.formatSnapshot, proforma.formatSnapshot);
  assert.deepEqual(invoice.shipping, shipping);
  assert.deepEqual(invoice.totals, proforma.totals);
  assert.equal(invoice.balanceDue, proforma.totals.total);
  const retry = await request<BusinessDocument>(`/api/documents/${proforma.id}/convert`, 'POST', {});
  assert.equal(retry.id, invoice.id);
  const listing = await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}&kind=proforma`);
  assert.equal(listing[0].status, 'accepted');
  await request(`/api/documents/${proforma.id}`, 'PUT', proforma, 409);
});

test('delivery challan generation is idempotent, quantity-only and independently tracks shipping', async (t) => {
  const { request, input } = await fixture(t);
  const invoice = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'invoice' }),
    201,
  );
  const challan = await request<BusinessDocument>(
    `/api/documents/${invoice.id}/delivery-note`,
    'POST',
    {},
    201,
  );
  assert.equal(challan.kind, 'delivery_note');
  assert.equal(challan.number, 'P2EI/2627/D0001');
  assert.equal(challan.sourceDocumentId, invoice.id);
  assert.equal(challan.totals.total, 0);
  assert.equal(challan.balanceDue, 0);
  assert.equal(challan.discountPercent, 0);
  assert.equal(challan.items[0].quantity, invoice.items[0].quantity);
  assert.ok(challan.items.every((item) => item.rate === 0 && item.gstRate === 0));
  assert.equal(challan.shipping?.reference, invoice.number);
  assert.deepEqual(challan.organizationSnapshot, invoice.organizationSnapshot);
  const retry = await request<BusinessDocument>(`/api/documents/${invoice.id}/delivery-note`, 'POST', {});
  assert.equal(retry.id, challan.id);
  const shipping = {
    ...challan.shipping!,
    carrier: 'Local transport',
    vehicleNumber: 'MH01AB1234',
    dispatchDate: '2026-10-08',
    deliveryDate: '2026-10-09',
  };
  const sent = await request<BusinessDocument>(`/api/documents/${challan.id}`, 'PUT', {
    ...challan,
    status: 'dispatched',
    shipping,
  });
  const delivered = await request<BusinessDocument>(`/api/documents/${challan.id}`, 'PUT', {
    ...sent,
    status: 'delivered',
  });
  assert.equal(delivered.shipping?.vehicleNumber, shipping.vehicleNumber);
  await request(
    `/api/documents/${challan.id}`,
    'PUT',
    { ...delivered, shipping: { ...shipping, deliveryDate: '2026-10-07' } },
    400,
  );
  await request('/api/documents', 'POST', { ...challan, items: [{ ...challan.items[0], rate: 1 }] }, 400);
  await request('/api/documents', 'POST', { ...challan, discountPercent: 1 }, 400);
  await request(`/api/documents/${invoice.id}`, 'DELETE', undefined, 409);
  const invoiceAfter = (
    await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}&kind=invoice`)
  )[0];
  assert.equal(invoiceAfter.deliveryNoteId, challan.id);
  assert.deepEqual(invoiceAfter.totals, invoice.totals);
});

test('new document numbering stays unique and at most 16 characters at sequence limits', async (t) => {
  const { request, input, db } = await fixture(t);
  for (const kind of ['invoice', 'quotation', 'proforma', 'delivery_note'] as const) {
    const limit = ['proforma', 'delivery_note'].includes(kind) ? 99999 : 999999;
    db.prepare('INSERT INTO sequences (organization_id, kind, fiscal_year, value) VALUES (?, ?, ?, ?)').run(
      ORG,
      kind,
      '2627',
      limit - 1,
    );
    const docInput = await input({
      kind,
      ...(kind === 'delivery_note'
        ? { items: [{ description: 'Last dispatch', hsn: '', quantity: 1, rate: 0, gstRate: 0 }] }
        : {}),
    });
    const document = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
    assert.equal(document.number.length, 16);
    await request('/api/documents', 'POST', docInput, 409);
  }
  const documents = await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}`);
  assert.equal(new Set(documents.map((document) => document.number)).size, 4);
});

test('seller images, identifiers and expanded format controls validate and persist', async (t) => {
  const { request } = await fixture(t);
  const [organization] = await request<Organization[]>('/api/organizations');
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=';
  const seller = {
    ...organization,
    signatureImageUrl: png,
    paymentQrUrl: png,
    pan: 'ABCDE1234F',
    cin: 'U12345MH2026PTC123456',
    bankBranch: 'Main branch',
    accountType: 'Current',
  };
  const saved = await request<Organization>(`/api/organizations/${organization.id}`, 'PUT', seller);
  assert.equal(saved.signatureImageUrl, png);
  assert.equal(saved.paymentQrUrl, png);
  assert.equal(saved.pan, seller.pan);
  assert.equal(saved.cin, seller.cin);
  assert.equal(saved.bankBranch, seller.bankBranch);
  await request(
    `/api/organizations/${organization.id}`,
    'PUT',
    { ...seller, paymentQrUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    400,
  );
  await request(
    `/api/organizations/${organization.id}`,
    'PUT',
    { ...seller, signatureImageUrl: `data:image/png;base64,${Buffer.from('not png').toString('base64')}` },
    400,
  );
  const formats = await request<InvoiceFormat[]>(`/api/formats?organizationId=${organization.id}`);
  assert.equal(formats.length, 15);
  assert.equal(new Set(formats.map((format) => format.presetKey)).size, 15);
  assert.equal(new Set(formats.map((format) => format.layout)).size, 5);
  const custom = {
    ...formats[0],
    name: 'Letter landscape',
    layout: 'sidebar',
    isDefault: false,
    logoUrl: png,
    pageSize: 'LETTER',
    orientation: 'landscape',
    fontSize: 12,
    logoWidth: 100,
    pageMargin: 12,
    tableStyle: 'striped',
    showPaymentQr: true,
    paymentQrWidth: 150,
    signatureWidth: 180,
  };
  const format = await request<InvoiceFormat>('/api/formats', 'POST', custom, 201);
  assert.equal(format.logoUrl, png);
  assert.equal(format.pageSize, 'LETTER');
  assert.equal(format.signatureWidth, 180);
  for (const value of [
    { paymentQrWidth: 161 },
    { signatureWidth: 221 },
    { pageMargin: 25 },
    { fontSize: 7 },
    { logoWidth: 141 },
  ])
    await request('/api/formats', 'POST', { ...custom, ...value }, 400);
});

test('workspace logo and name remain separate from organization and document identities', async (t) => {
  const { request, input } = await fixture(t);
  const initial = await request<WorkspaceSettings>('/api/workspace-settings');
  assert.equal(initial.dashboardLogoUrl, '');
  const workspace = { companyName: COMPANY_NAME, dashboardLogoUrl: 'https://example.test/dashboard.png' };
  await request('/api/workspace-settings', 'PUT', workspace);
  const organizations = await request<Organization[]>('/api/organizations');
  assert.ok(organizations.every((org) => org.logoUrl === ''));
  const organization = organizations.find((org) => org.id === ORG)!;
  await request(`/api/organizations/${ORG}`, 'PUT', {
    ...organization,
    logoUrl: 'https://example.test/division.png',
    secondarySignatureLabel: 'Director',
    secondarySignatureImageUrl: 'https://example.test/second.png',
    stampLabel: 'Official stamp',
    stampImageUrl: 'https://example.test/stamp.png',
  });
  const document = await request<BusinessDocument>('/api/documents', 'POST', await input(), 201);
  assert.equal(document.organizationSnapshot.logoUrl, 'https://example.test/division.png');
  assert.equal(document.organizationSnapshot.secondarySignatureLabel, 'Director');
  assert.equal(document.organizationSnapshot.stampImageUrl, 'https://example.test/stamp.png');
  assert.ok(!JSON.stringify(document).includes('dashboard.png'));
  await request('/api/workspace-settings', 'PUT', {
    ...workspace,
    dashboardLogoUrl: 'https://example.test/revised-dashboard.png',
  });
  assert.equal(
    (await request<BusinessDocument[]>(`/api/documents?organizationId=${ORG}`))[0].organizationSnapshot
      .logoUrl,
    'https://example.test/division.png',
  );
  await request(
    '/api/workspace-settings',
    'PUT',
    { ...workspace, dashboardLogoUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    400,
  );
});

test('business products are organization-scoped, archived safely and preserve historical document snapshots', async (t) => {
  const { request, input } = await fixture(t);
  const products = await request<BusinessProduct[]>(`/api/business-products?organizationId=${ORG}`);
  assert.equal(products.length, 10);
  const product = products[0];
  const configured = await request<BusinessProduct>(`/api/business-products/${product.id}`, 'PUT', {
    ...product,
    code: 'LEGAL',
    description: 'Legal platform',
    logoUrl: 'https://example.test/product.png',
  });
  await request(
    '/api/business-products',
    'POST',
    { ...configured, name: 'Duplicate code', code: 'legal' },
    409,
  );
  const other = await request<BusinessProduct>(
    '/api/business-products',
    'POST',
    { ...configured, organizationId: OTHER_ORG },
    201,
  );
  await request(
    `/api/business-products/${product.id}`,
    'PUT',
    { ...configured, organizationId: OTHER_ORG },
    400,
  );
  const docInput = await input({ businessProductId: product.id });
  await request('/api/documents', 'POST', { ...docInput, businessProductId: '' }, 400);
  await request('/api/documents', 'POST', { ...docInput, businessProductId: other.id }, 400);
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.deepEqual(saved.businessProductSnapshot, configured);
  await request(`/api/business-products/${product.id}`, 'PUT', {
    ...configured,
    name: 'New master name',
    active: false,
  });
  await request('/api/documents', 'POST', docInput, 400);
  const edited = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', {
    ...docInput,
    notes: 'Preserve old product identity',
  });
  assert.deepEqual(edited.businessProductSnapshot, configured);
  const invoice = await request<BusinessDocument>(`/api/documents/${saved.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(invoice.businessProductSnapshot, configured);
  assert.equal(invoice.businessProductId, product.id);
  await request(`/api/business-products/${product.id}`, 'DELETE', undefined, 404);
  await request('/api/business-products', 'GET', undefined, 400);
});

test('catalog business product links enforce matching selections and preserve old linked lines', async (t) => {
  const { request, input } = await fixture(t);
  const [first, second] = await request<BusinessProduct[]>(`/api/business-products?organizationId=${ORG}`);
  const item = await request<CatalogItem>(
    '/api/catalog',
    'POST',
    catalogInput({ businessProductId: first.id }),
    201,
  );
  const docInput = await input({
    businessProductId: second.id,
    items: [
      {
        description: item.name,
        hsn: item.hsn,
        quantity: 1,
        rate: item.rate,
        gstRate: item.gstRate,
        catalogItemId: item.id,
      },
    ],
  });
  await request('/api/documents', 'POST', docInput, 400);
  const saved = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, businessProductId: first.id },
    201,
  );
  await request(`/api/documents/${saved.id}`, 'PUT', docInput, 400);
  await request(`/api/catalog/${item.id}`, 'PUT', { ...item, businessProductId: second.id });
  const retained = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', {
    ...saved,
    notes: 'Old line remains assigned to the accepted product',
  });
  assert.equal(retained.businessProductId, first.id);
  const other = await request<BusinessProduct>(
    '/api/business-products',
    'POST',
    {
      organizationId: OTHER_ORG,
      name: 'Other product',
      code: '',
      description: '',
      logoUrl: '',
      active: true,
    },
    201,
  );
  await request('/api/catalog', 'POST', catalogInput({ businessProductId: other.id }), 400);
});

test('legacy documents without a business product remain editable for metadata after product selection becomes required', async (t) => {
  const { request, input, db } = await fixture(t);
  const saved = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ status: 'sent' }),
    201,
  );
  const legacy = { ...saved };
  delete legacy.businessProductId;
  delete legacy.businessProductSnapshot;
  db.prepare('UPDATE documents SET data = ? WHERE id = ?').run(JSON.stringify(legacy), legacy.id);
  const edited = await request<BusinessDocument>(`/api/documents/${legacy.id}`, 'PUT', {
    ...legacy,
    notes: 'Historical invoice note',
  });
  assert.equal(edited.businessProductId, undefined);
  assert.deepEqual(edited.organizationSnapshot, saved.organizationSnapshot);
  assert.deepEqual(edited.totals, saved.totals);
  await request(
    `/api/documents/${legacy.id}`,
    'PUT',
    { ...legacy, businessProductId: 'ecosystem-product-1' },
    409,
  );
});

test('jewellery and recurring pricing use full charge bases for GST and preserve pricing snapshots', async (t) => {
  const { request, input, enableTax } = await fixture(t);
  await enableTax();
  const jewellery = {
    mode: 'jewellery' as const,
    jewellery: {
      grossWeight: 10,
      stoneWeight: 1,
      purity: '22K',
      makingChargeType: 'per_gram' as const,
      makingCharge: 500,
      stoneAmount: 1000,
      otherCharges: 100,
      wastagePercent: 2,
    },
  };
  const item = await request<CatalogItem>(
    '/api/catalog',
    'POST',
    catalogInput({
      type: 'product',
      name: 'Gold jewellery',
      unit: 'Piece',
      rate: 6000,
      gstRate: 3,
      pricing: jewellery,
    }),
    201,
  );
  const docInput = await input({
    items: [
      {
        description: 'Two gold pieces',
        hsn: '7113',
        quantity: 2,
        rate: item.rate,
        gstRate: 3,
        unit: 'Piece',
        pricing: jewellery,
        catalogItemId: item.id,
      },
    ],
  });
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  assert.equal(saved.totals.subtotal, 121360);
  assert.equal(saved.totals.cgst, 1820.4);
  assert.equal(saved.totals.sgst, 1820.4);
  assert.equal(saved.totals.total, 125000.8);
  assert.equal(
    calculateLineAmount({
      ...docInput.items[0],
      pricing: { ...jewellery, jewellery: { ...jewellery.jewellery, makingChargeType: 'fixed' } },
    }),
    113360,
  );
  assert.equal(
    calculateLineAmount({
      ...docInput.items[0],
      pricing: {
        ...jewellery,
        jewellery: { ...jewellery.jewellery, makingChargeType: 'percent', makingCharge: 5 },
      },
    }),
    117760,
  );
  await request(`/api/catalog/${item.id}`, 'PUT', {
    ...item,
    rate: 9000,
    pricing: { ...jewellery, jewellery: { ...jewellery.jewellery, makingCharge: 900 } },
  });
  const invoice = await request<BusinessDocument>(`/api/documents/${saved.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(invoice.items, saved.items);
  assert.deepEqual(invoice.totals, saved.totals);
  const delivery = await request<BusinessDocument>(
    `/api/documents/${invoice.id}/delivery-note`,
    'POST',
    {},
    201,
  );
  assert.equal(delivery.totals.total, 0);
  assert.equal(delivery.items[0].pricing, undefined);
  const recurring = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({
      items: [
        {
          description: 'Five staff for three months',
          hsn: '',
          quantity: 5,
          rate: 2000,
          gstRate: 18,
          pricing: { mode: 'recurring', periods: 3, periodUnit: 'Month' },
        },
      ],
    }),
    201,
  );
  assert.equal(recurring.totals.subtotal, 30000);
  assert.equal(recurring.totals.total, 35400);
  for (const pricing of [
    { mode: 'recurring', periods: 0, periodUnit: 'Month' },
    { mode: 'recurring', periods: 1201, periodUnit: 'Month' },
    { ...jewellery, jewellery: { ...jewellery.jewellery, stoneWeight: 10 } },
    { ...jewellery, jewellery: { ...jewellery.jewellery, makingChargeType: 'percent', makingCharge: 101 } },
    { ...jewellery, jewellery: { ...jewellery.jewellery, otherCharges: -1 } },
  ])
    await request('/api/documents', 'POST', { ...docInput, items: [{ ...docInput.items[0], pricing }] }, 400);
  await request(
    '/api/documents',
    'POST',
    { ...docInput, items: [{ ...docInput.items[0], quantity: 1.5 }] },
    400,
  );
  await request(
    '/api/catalog',
    'POST',
    catalogInput({
      sku: 'TOO-LARGE',
      rate: 100000000,
      pricing: { mode: 'recurring', periods: 1200, periodUnit: 'Month' },
    }),
    400,
  );
});

test('draft branding is isolated to its document and locks with product and pricing after issue', async (t) => {
  const { request, input } = await fixture(t);
  const draft = await request<BusinessDocument>('/api/documents', 'POST', await input(), 201);
  const branding = {
    ...defaultDocumentBranding(draft.organizationSnapshot),
    logoMode: 'custom' as const,
    logoUrl: 'https://example.test/custom-document.png',
    primarySignatureLabel: 'Prepared by',
    secondarySignatureLabel: 'Approved by',
    stampLabel: 'Original stamp',
    stampImageUrl: 'https://example.test/stamp.png',
  };
  const customized = await request<BusinessDocument>(`/api/documents/${draft.id}`, 'PUT', {
    ...draft,
    branding,
  });
  assert.deepEqual(customized.branding, branding);
  assert.equal(
    (await request<Organization[]>('/api/organizations')).find((org) => org.id === ORG)?.logoUrl,
    draft.organizationSnapshot.logoUrl,
  );
  const issued = await request<BusinessDocument>(`/api/documents/${draft.id}`, 'PUT', {
    ...customized,
    status: 'sent',
  });
  await request(
    `/api/documents/${draft.id}`,
    'PUT',
    { ...issued, branding: { ...branding, stampLabel: 'Changed after issue' } },
    409,
  );
  await request(
    `/api/documents/${draft.id}`,
    'PUT',
    { ...issued, businessProductId: 'ecosystem-product-2' },
    409,
  );
  await request(
    `/api/documents/${draft.id}`,
    'PUT',
    {
      ...issued,
      items: [{ ...issued.items[0], pricing: { mode: 'recurring', periods: 2, periodUnit: 'Month' } }],
    },
    409,
  );
  const invoice = await request<BusinessDocument>(`/api/documents/${draft.id}/convert`, 'POST', {}, 201);
  assert.deepEqual(invoice.branding, branding);
  await request('/api/documents', 'POST', { ...draft, branding: { ...branding, logoUrl: '' } }, 400);
});

const monthlyPlan = (): InstallmentPlan => ({
  name: 'Three monthly installments',
  installments: [
    { id: 'emi-1', label: 'First installment', dueDate: '2026-10-10', amount: 1000 },
    { id: 'emi-2', label: 'Second installment', dueDate: '2026-11-10', amount: 1000 },
    { id: 'emi-3', label: 'Third installment', dueDate: '2026-12-10', amount: 1000 },
  ],
});

test('installments allocate ledger payments oldest first, retain schedule audit and reopen on a reasoned void', async (t) => {
  const { request, input } = await fixture(t);
  const plan = monthlyPlan();
  const invoice = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    await input({ kind: 'invoice', installmentPlan: plan }),
    201,
  );
  const partial = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    paymentInput({ amount: 1500 }),
    201,
  );
  assert.deepEqual(
    installmentBalances(partial.document, '2026-10-08').map((entry) => [
      entry.amountPaid,
      entry.balanceDue,
      entry.status,
    ]),
    [
      [1000, 0, 'paid'],
      [500, 500, 'partially_paid'],
      [0, 1000, 'pending'],
    ],
  );
  const revised = {
    name: 'Two installments',
    installments: [
      { ...plan.installments[0], amount: 1500 },
      { ...plan.installments[1], amount: 1500 },
    ],
  };
  const scheduled = await request<PaymentDetails>(`/api/documents/${invoice.id}/installments`, 'PUT', {
    plan: revised,
  });
  assert.deepEqual(scheduled.payments, partial.payments);
  assert.equal(scheduled.document.amountPaid, 1500);
  assert.ok(
    scheduled.events.some(
      (event) =>
        event.type === 'installment_plan_changed' &&
        event.description.includes('Three monthly installments') &&
        event.description.includes('Two installments'),
    ),
  );
  assert.deepEqual(
    installmentBalances(scheduled.document).map((entry) => entry.amountPaid),
    [1500, 0],
  );
  const finalized = await request<PaymentDetails>(
    `/api/documents/${invoice.id}/payments`,
    'POST',
    paymentInput({ amount: 1500, requestId: 'payment-2' }),
    201,
  );
  assert.ok(finalized.document.finalizedAt);
  assert.ok(installmentBalances(finalized.document).every((entry) => entry.status === 'paid'));
  await request(`/api/documents/${invoice.id}/installments`, 'PUT', { plan: null }, 409);
  const voided = await request<PaymentDetails>(`/api/payments/${partial.payments[0].id}/void`, 'POST', {
    reason: 'Payment reversed by bank',
  });
  assert.deepEqual(voided.document.installmentPlan, revised);
  assert.deepEqual(
    installmentBalances(voided.document).map((entry) => entry.amountPaid),
    [1500, 0],
  );
  const removed = await request<PaymentDetails>(`/api/documents/${invoice.id}/installments`, 'PUT', {
    plan: null,
  });
  assert.equal(removed.document.installmentPlan, null);
  assert.deepEqual(removed.payments, voided.payments);
});

test('installment validation enforces paise totals, ordered unique entries and draft financial consistency', async (t) => {
  const { request, input } = await fixture(t);
  const plan = monthlyPlan();
  const docInput = await input({ kind: 'invoice', installmentPlan: plan });
  for (const invalid of [
    { ...plan, installments: plan.installments.slice(0, 2) },
    {
      ...plan,
      installments: [plan.installments[0], { ...plan.installments[1], id: 'emi-1' }, plan.installments[2]],
    },
    { ...plan, installments: [...plan.installments].reverse() },
    { ...plan, installments: [{ ...plan.installments[0], amount: 1000.001 }, ...plan.installments.slice(1)] },
    {
      ...plan,
      installments: [{ ...plan.installments[0], dueDate: '2026-02-30' }, ...plan.installments.slice(1)],
    },
  ])
    await request('/api/documents', 'POST', { ...docInput, installmentPlan: invalid }, 400);
  const saved = await request<BusinessDocument>('/api/documents', 'POST', docInput, 201);
  const changedInput = { ...docInput, items: [{ ...docInput.items[0], rate: 2000 }] };
  await request(`/api/documents/${saved.id}`, 'PUT', changedInput, 400);
  const changed = await request<BusinessDocument>(`/api/documents/${saved.id}`, 'PUT', {
    ...changedInput,
    installmentPlan: null,
  });
  assert.equal(changed.totals.total, 4000);
  assert.equal(changed.installmentPlan, null);
  await request(`/api/documents/${saved.id}/installments`, 'PUT', { plan }, 400);
  const quotation = await request<BusinessDocument>(
    '/api/documents',
    'POST',
    { ...docInput, kind: 'quotation' },
    201,
  );
  const converted = await request<BusinessDocument>(
    `/api/documents/${quotation.id}/convert`,
    'POST',
    {},
    201,
  );
  assert.deepEqual(converted.installmentPlan, plan);
  const delivery = await request<BusinessDocument>(
    `/api/documents/${converted.id}/delivery-note`,
    'POST',
    {},
    201,
  );
  assert.equal(delivery.installmentPlan, undefined);
  await request('/api/documents', 'POST', { ...delivery, installmentPlan: plan }, 400);
  await request(`/api/documents/${quotation.id}/installments`, 'PUT', { plan }, 400);
});
