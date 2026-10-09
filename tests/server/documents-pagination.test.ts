import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import { documentExportRows } from '../../server/documents/document-list.ts';
import type { AuthUser } from '../../shared/auth-types.ts';
import type { DocumentPage as Page, DocumentSummary as Summary } from '../../shared/document-list.ts';
import type { BusinessDocument, Customer } from '../../shared/types.ts';

const ORG = 'pipeline2-ecosystem';
const OTHER = 'at-facilities';
const TODAY = '2026-10-08';
const OWNER = { email: 'pagination-owner@example.test', password: 'Synthetic pagination owner password' };
const MEMBER = { email: 'pagination-staff@example.test', password: 'Synthetic pagination staff password' };

async function fixture(t: TestContext, authenticated = false) {
  const db = initDb(':memory:');
  const app = createApp({
    db,
    auth: authenticated ? undefined : false,
    environment: authenticated
      ? { INITIAL_ADMIN_EMAIL: OWNER.email, INITIAL_ADMIN_PASSWORD: OWNER.password }
      : {},
    now: () => new Date(`${TODAY}T12:00:00.000Z`),
    distPath: '/tmp/pagination-test-no-dist',
  });
  await app.locals.initialize();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  let cookie = '';
  async function send(path: string, method = 'GET', body?: unknown, session = cookie) {
    return fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function request<T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
    expected = 200,
    session = cookie,
  ): Promise<T> {
    const response = await send(path, method, body, session);
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function login(account: typeof OWNER) {
    const response = await send('/auth/login', 'POST', account, '');
    assert.equal(response.status, 200, await response.text());
    const result = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(result);
    return result;
  }
  if (authenticated) cookie = await login(OWNER);
  const templates = new Map<string, BusinessDocument>();
  async function template(organizationId = ORG) {
    if (templates.has(organizationId)) return templates.get(organizationId)!;
    const customer = await request<Customer>(
      '/customers',
      'POST',
      {
        organizationId,
        name: 'Synthetic pagination buyer',
        email: '',
        phone: '',
        gstin: '',
        address: 'Synthetic address',
        stateCode: '27',
        contactPerson: '',
      },
      201,
    );
    const result = await request<BusinessDocument>(
      '/documents',
      'POST',
      {
        organizationId,
        customerId: customer.id,
        kind: 'invoice',
        status: 'draft',
        businessProductId: organizationId === ORG ? 'ecosystem-product-1' : undefined,
        issueDate: TODAY,
        dueDate: '2026-11-08',
        title: 'Synthetic pagination fixture',
        items: [{ description: 'Synthetic service', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
        discountPercent: 0,
        placeOfSupply: '27',
        notes: '',
        terms: '',
      },
      201,
    );
    db.prepare('DELETE FROM documents WHERE id = ?').run(result.id);
    templates.set(organizationId, result);
    return result;
  }
  const original = await template();
  let sequence = 0;
  function insert(overrides: Partial<BusinessDocument> = {}, source = original) {
    const serial = ++sequence;
    const document: BusinessDocument = {
      ...structuredClone(source),
      id: `synthetic-pagination-${serial}`,
      number: `SYN-${String(serial).padStart(6, '0')}`,
      // Identical timestamps ensure pagination depends on the stable DB ordering.
      createdAt: `${TODAY}T12:00:00.000Z`,
      updatedAt: `${TODAY}T12:00:00.000Z`,
      ...overrides,
    };
    db.prepare(
      'INSERT INTO documents (id, organization_id, customer_id, kind, number, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      document.id,
      document.organizationId,
      document.customerId,
      document.kind,
      document.number,
      JSON.stringify(document),
    );
    return document;
  }
  return { db, app, send, request, template, insert, login, owner: cookie };
}

const pagePath = (query = '') => `/documents/page?organizationId=${ORG}${query ? `&${query}` : ''}`;
const summaryPath = `/documents/summary?organizationId=${ORG}`;

test('document pages are bounded, stable and nonoverlapping; stale page numbers clamp to the last page', async (t) => {
  const f = await fixture(t);
  const empty = await f.request<Page>(pagePath());
  assert.deepEqual(empty.items, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.page, 1);
  const inserted = Array.from({ length: 137 }, () => f.insert());
  const expected = [...inserted].reverse().map((document) => document.id);
  const first = await f.request<Page>(pagePath());
  assert.deepEqual([first.page, first.pageSize, first.total, first.totalPages], [1, 25, 137, 6]);
  assert.deepEqual(
    first.items.map((document) => document.id),
    expected.slice(0, 25),
  );
  const second = await f.request<Page>(pagePath('page=2'));
  assert.deepEqual(
    second.items.map((document) => document.id),
    expected.slice(25, 50),
  );
  assert.equal(new Set([...first.items, ...second.items].map((document) => document.id)).size, 50);
  const last = await f.request<Page>(pagePath('page=1000000'));
  assert.deepEqual([last.page, last.totalPages, last.items.length], [6, 6, 12]);
  assert.deepEqual(
    last.items.map((document) => document.id),
    expected.slice(125),
  );
  const large = await f.request<Page>(pagePath('pageSize=100'));
  assert.equal(large.items.length, 100);
  assert.equal(large.totalPages, 2);
  const legacy = await f.request<BusinessDocument[]>(`/documents?organizationId=${ORG}`);
  assert.equal(legacy.length, 100);
  assert.deepEqual(
    legacy.map((document) => document.id),
    expected.slice(0, 100),
  );
  const own = inserted[0];
  assert.equal((await f.request<BusinessDocument>(`/documents/${own.id}?organizationId=${ORG}`)).id, own.id);
  await f.request(`/documents/${own.id}?organizationId=${OTHER}`, 'GET', undefined, 404);
});

test('search and product/status filters run across all pages while status counts retain all matching statuses', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 60; index++) {
    f.insert({
      title: 'Shared needle',
      status: (['paid', 'sent', 'draft'] as const)[index % 3],
      businessProductId: index < 30 ? 'ecosystem-product-1' : 'ecosystem-product-2',
    });
  }
  f.insert({ kind: 'quotation', title: 'Shared needle', status: 'draft' });
  const result = await f.request<Page>(
    pagePath('kind=invoice&search=%20NEEDLE%20&businessProductId=ecosystem-product-1&status=paid&pageSize=5'),
  );
  assert.deepEqual([result.total, result.items.length, result.totalPages], [10, 5, 2]);
  assert.equal(result.statusCounts.paid, 10);
  assert.equal(result.statusCounts.sent, 10);
  assert.equal(result.statusCounts.draft, 10);
  assert.equal(result.statusCounts.all, 30);
  assert.ok(
    result.items.every(
      (document) =>
        document.kind === 'invoice' &&
        document.status === 'paid' &&
        document.businessProductId === 'ecosystem-product-1',
    ),
  );
  const number = f.insert({ number: 'UNIQUE-NUMBER' });
  const customer = f.insert({ customerSnapshot: { ...number.customerSnapshot, name: 'Unique buyer' } });
  const title = f.insert({ title: 'Unique title' });
  const product = f.insert({
    businessProductSnapshot: { ...number.businessProductSnapshot!, name: 'Unique product' },
  });
  for (const [search, document] of [
    ['unique-number', number],
    ['unique buyer', customer],
    ['unique title', title],
    ['unique product', product],
  ] as const) {
    const found = await f.request<Page>(pagePath(`search=${encodeURIComponent(search)}`));
    assert.deepEqual(
      found.items.map((item) => item.id),
      [document.id],
    );
  }
  const literal = f.insert({ title: 'Discount 10%_literal' });
  f.insert({ title: 'Discount 10XAliteral' });
  const percent = await f.request<Page>(pagePath('search=%25'));
  const underscore = await f.request<Page>(pagePath('search=_'));
  assert.deepEqual(
    percent.items.map((document) => document.id),
    [literal.id],
  );
  assert.deepEqual(
    underscore.items.map((document) => document.id),
    [literal.id],
  );
});

test('search retains Unicode case matching for document, contact and business product names', async (t) => {
  const f = await fixture(t);
  const title = f.insert({ title: 'ÉCOLE consultation' });
  const customer = f.insert({ customerSnapshot: { ...title.customerSnapshot, name: 'ÜBER buyer' } });
  const product = f.insert({
    businessProductSnapshot: { ...title.businessProductSnapshot!, name: 'ŚRI product' },
  });
  for (const [search, document] of [
    ['école', title],
    ['über', customer],
    ['śri', product],
  ] as const) {
    const result = await f.request<Page>(pagePath(`search=${encodeURIComponent(search)}`));
    assert.deepEqual(
      result.items.map((item) => item.id),
      [document.id],
    );
    const csv = await f.send(
      `/documents/export.csv?organizationId=${ORG}&search=${encodeURIComponent(search)}`,
    );
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.ok(text.includes(document.number));
    assert.equal(text.split('\r\n').filter(Boolean).length, 2);
  }
});

test('CSV row batches project financial fields without retaining large document images and snapshots', async (t) => {
  const f = await fixture(t);
  const first = f.insert();
  const image = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
  const stored = f.insert({
    organizationSnapshot: { ...first.organizationSnapshot, logoUrl: image },
    notes: 'private non-CSV note',
    items: [{ description: 'Non-CSV line details', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
  });
  const rows = [...documentExportRows(f.db, ORG, TODAY, { search: stored.number })];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].document.number, stored.number);
  assert.deepEqual(rows[0].document.totals, stored.totals);
  assert.equal(rows[0].document.customerSnapshot.name, stored.customerSnapshot.name);
  assert.ok(JSON.stringify(rows[0]).length < 1000);
  assert.equal(Object.hasOwn(rows[0].document, 'organizationSnapshot'), false);
  assert.equal(Object.hasOwn(rows[0].document, 'items'), false);
  assert.equal(Object.hasOwn(rows[0].document, 'notes'), false);
});

test('overdue filtering follows installment balances rather than paid installments or the invoice date alone', async (t) => {
  const f = await fixture(t);
  const lateInvoice = f.insert({ status: 'sent', dueDate: '2026-10-07' });
  const plan = {
    name: 'Synthetic schedule',
    installments: [
      { id: 'early', label: 'Earlier', dueDate: '2026-10-01', amount: 50 },
      { id: 'later', label: 'Later', dueDate: '2026-11-01', amount: 50 },
    ],
  };
  f.insert({
    status: 'partially_paid',
    dueDate: '2026-10-01',
    amountPaid: 60,
    balanceDue: 40,
    installmentPlan: plan,
  });
  const lateInstallment = f.insert({
    status: 'partially_paid',
    dueDate: '2026-11-01',
    amountPaid: 10,
    balanceDue: 90,
    installmentPlan: plan,
  });
  f.insert({ status: 'paid', dueDate: '2026-10-01', amountPaid: 100, balanceDue: 0, installmentPlan: plan });
  f.insert({ status: 'draft', dueDate: '2026-10-01' });
  f.insert({ status: 'sent', dueDate: TODAY });
  const overdue = await f.request<Page>(pagePath('status=overdue'));
  assert.equal(overdue.total, 2);
  assert.equal(overdue.statusCounts.overdue, 2);
  assert.deepEqual(
    overdue.items.map((document) => document.id),
    [lateInstallment.id, lateInvoice.id],
  );
  const sent = await f.request<Page>(pagePath('status=sent'));
  assert.equal(sent.total, 2, 'raw sent status includes the overdue sent invoice');
});

test('document page query validation rejects malformed, repeated and nested filters', async (t) => {
  const f = await fixture(t);
  for (const query of [
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1000001',
    'pageSize=0',
    'pageSize=101',
    'pageSize=NaN',
    'kind=unknown',
    'status=unknown',
    `search=${'a'.repeat(201)}`,
    'page=1&page=2',
    'pageSize=25&pageSize=50',
    'kind=invoice&kind=quotation',
    'status=draft&status=paid',
    'search=a&search=b',
    'businessProductId=one&businessProductId=two',
    'organizationId=at-facilities',
    'page[limit]=1',
    'search[value]=buyer',
    'status[value]=draft',
    'businessProductId[value]=one',
  ]) {
    await f.request(pagePath(query), 'GET', undefined, 400);
  }
  await f.request('/documents/page', 'GET', undefined, 400);
  await f.request(`${summaryPath}&organizationId=${OTHER}`, 'GET', undefined, 400);
});

test('dashboard summaries count every matching document and preserve global balances beyond the visible page', async (t) => {
  const f = await fixture(t);
  const base = f.insert({
    status: 'partially_paid',
    totals: { subtotal: 200, discount: 0, taxable: 200, cgst: 0, sgst: 0, igst: 0, total: 200 },
    amountPaid: 80,
    balanceDue: 120,
    installmentPlan: {
      name: 'Synthetic schedule',
      installments: [
        { id: 'paid', label: 'Paid', dueDate: '2026-10-01', amount: 50 },
        { id: 'overdue', label: 'Overdue', dueDate: '2026-10-05', amount: 50 },
        { id: 'future', label: 'Future', dueDate: '2026-11-01', amount: 100 },
      ],
    },
  });
  function valued(total: number, overrides: Partial<BusinessDocument> = {}) {
    return f.insert({
      totals: { subtotal: total, discount: 0, taxable: total, cgst: 0, sgst: 0, igst: 0, total },
      balanceDue: total,
      ...overrides,
    });
  }
  valued(300, { status: 'paid', amountPaid: 300, balanceDue: 0 });
  valued(50, { status: 'sent', dueDate: '2026-10-07' });
  valued(999, { status: 'draft' });
  valued(500, { status: 'cancelled' });
  for (let index = 0; index < 120; index++) valued(1, { status: 'sent' });
  valued(30, { kind: 'quotation', status: 'draft' });
  valued(70, { kind: 'quotation', status: 'sent' });
  valued(500, { kind: 'quotation', status: 'accepted' });
  valued(400, { kind: 'quotation', status: 'declined' });
  valued(600, { kind: 'quotation', status: 'cancelled' });
  valued(100, { kind: 'proforma', status: 'draft' });
  valued(200, { kind: 'proforma', status: 'accepted' });
  valued(60, { kind: 'delivery_note', status: 'dispatched' });
  valued(70, { kind: 'delivery_note', status: 'delivered' });
  const other = await f.template(OTHER);
  f.insert({ totals: { ...other.totals, total: 50000 } }, other);
  const summary = await f.request<Summary>(summaryPath);
  assert.deepEqual(
    [
      summary.invoiceCount,
      summary.invoicesWithPayments,
      summary.totalCollected,
      summary.outstanding,
      summary.overdueInvoices,
    ],
    [125, 2, 380, 290, 2],
  );
  assert.deepEqual([summary.openQuotationCount, summary.openQuotationValue], [2, 100]);
  assert.deepEqual([summary.remainingInstallments, summary.overdueInstallmentValue], [2, 20]);
  assert.equal(summary.nextInstallment?.dueDate, '2026-10-05');
  assert.equal(summary.nextInstallment?.document.id, base.id);
  assert.equal(summary.nextInstallment?.balanceDue, 20);
  assert.equal(summary.byKind.invoice.count, 125);
  assert.equal(summary.byKind.invoice.value, 1669);
  assert.equal(summary.byKind.invoice.collected, 380);
  assert.equal(summary.byKind.invoice.outstanding, 290);
  assert.equal(summary.byKind.invoice.drafts, 1);
  assert.deepEqual(summary.byKind.quotation, {
    count: 5,
    value: 1000,
    collected: 0,
    outstanding: 0,
    completed: 1,
    drafts: 1,
  });
  assert.deepEqual(summary.byKind.proforma, {
    count: 2,
    value: 300,
    collected: 0,
    outstanding: 0,
    completed: 1,
    drafts: 1,
  });
  assert.deepEqual(summary.byKind.delivery_note, {
    count: 2,
    value: 130,
    collected: 0,
    outstanding: 0,
    completed: 1,
    drafts: 0,
  });
  assert.equal(summary.recentDocuments.length, 5);
  assert.ok(summary.recentDocuments.every((document) => document.organizationId === ORG));
  const recent = await f.request<Page>(pagePath('pageSize=5'));
  assert.deepEqual(
    summary.recentDocuments.map((document) => document.id),
    recent.items.map((document) => document.id),
  );
});

test('CSV exports include all filtered matches rather than only the current or legacy page', async (t) => {
  const f = await fixture(t);
  const matches = Array.from({ length: 137 }, () => f.insert({ title: 'Export match', status: 'sent' }));
  const omitted = f.insert({ title: 'Unrelated record', status: 'sent' });
  f.insert({ title: 'Export match', kind: 'quotation', status: 'sent' });
  const response = await f.send(
    `/documents/export.csv?organizationId=${ORG}&kind=invoice&search=Export%20match&status=sent`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/csv/);
  assert.match(response.headers.get('content-disposition') || '', /attachment/);
  const csv = await response.text();
  assert.equal(csv.trim().split(/\r?\n/).length, 138);
  for (const document of matches) assert.equal(csv.split(document.number).length - 1, 1, document.number);
  assert.ok(!csv.includes(omitted.number));
  assert.ok(csv.indexOf(matches[136].number) < csv.indexOf(matches[0].number));
});

test('CSV exports preserve quoted contact names and neutralize spreadsheet formulas', async (t) => {
  const f = await fixture(t);
  const template = await f.template();
  f.insert({
    customerSnapshot: { ...template.customerSnapshot, name: '=HYPERLINK("https://example.invalid","open")' },
  });
  f.insert({ customerSnapshot: { ...template.customerSnapshot, name: 'Buyer, "quoted"\nsecond line' } });
  const response = await f.send(`/documents/export.csv?organizationId=${ORG}`);
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.invalid"",""open"")"'));
  assert.ok(csv.includes('"Buyer, ""quoted""\nsecond line"'));
});

test('staff cannot use paginated list, summary, CSV or direct detail to expose another organization', async (t) => {
  const f = await fixture(t, true);
  const own = f.insert({ status: 'sent' });
  const otherTemplate = await f.template(OTHER);
  const other = f.insert({ title: 'Private other-organization invoice', status: 'sent' }, otherTemplate);
  await f.request('/auth/signup', 'POST', { ...MEMBER, name: 'Synthetic pagination staff' }, 202, '');
  const users = await f.request<AuthUser[]>('/auth/users');
  const member = users.find((user) => user.email === MEMBER.email)!;
  await f.request(`/auth/users/${member.id}`, 'PATCH', {
    role: 'staff',
    status: 'active',
    organizationIds: [ORG],
  });
  const staff = await f.login(MEMBER);
  const page = await f.request<Page>(pagePath(), 'GET', undefined, 200, staff);
  assert.deepEqual(
    page.items.map((document) => document.id),
    [own.id],
  );
  assert.equal((await f.request<Summary>(summaryPath, 'GET', undefined, 200, staff)).invoiceCount, 1);
  for (const path of [
    `/documents/page?organizationId=${OTHER}`,
    `/documents/summary?organizationId=${OTHER}`,
    `/documents/export.csv?organizationId=${OTHER}`,
    `/documents/${other.id}?organizationId=${ORG}`,
    `/documents/${other.id}?organizationId=${OTHER}`,
    `/Documents/${other.id}?organizationId=${ORG}`,
  ]) {
    await f.request(path, 'GET', undefined, 403, staff);
  }
  const csv = await f.send(`/documents/export.csv?organizationId=${ORG}`, 'GET', undefined, staff);
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.ok(text.includes(own.number));
  assert.ok(!text.includes(other.number));
  await f.request(pagePath(), 'GET', undefined, 401, '');
  await f.request(summaryPath, 'GET', undefined, 401, '');
  await f.request(`/documents/${own.id}?organizationId=${ORG}`, 'GET', undefined, 401, '');
  await f.request(`/documents/export.csv?organizationId=${ORG}`, 'GET', undefined, 401, '');
});
