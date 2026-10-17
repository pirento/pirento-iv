/** Integration tests: page queries (document lists, overview, overdue) and backup inventory. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, integrationEnabled } from './fixture.js';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createWorkspaceQueries, DOCUMENT_SUMMARY_FIELDS } from '../../src/models/workspace-queries.js';
import { readDocumentFilters } from '../../src/services/pages/document-list.js';
import { documentStatus } from '../../shared/document-status.js';
import { paidAmount, balanceDue, installmentBalances } from '../../shared/types.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const clock = () => new Date('2026-10-10T12:00:00.000Z');
const day = '2026-10-10';
const orgId = 'pipeline2-legal';

async function pageFixture(t) {
  const fixture = await createFixture(t, {
    now: clock,
    environment: {
      INITIAL_ADMIN_EMAIL: 'phase2-pages@example.test',
      INITIAL_ADMIN_PASSWORD: 'SyntheticPageChecks123!',
      INITIAL_ADMIN_NAME: 'Page Reviewer',
    },
  });
  attachPageRoutes(fixture.backend);
  let cookie = '';
  async function api(path, method = 'GET', input, expected = 200, session = cookie) {
    const response = await fetch(fixture.base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: session },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return value;
  }
  const { user } = await api('/auth/login', 'POST', {
    email: fixture.environment.INITIAL_ADMIN_EMAIL,
    password: fixture.environment.INITIAL_ADMIN_PASSWORD,
  });
  const buyer = await api(
    '/customers',
    'POST',
    {
      organizationId: orgId,
      name: 'Page Buyer',
      email: 'buyer@example.test',
      phone: '',
      gstin: '',
      address: 'Lucknow',
      stateCode: '09',
      contactPerson: '',
    },
    201,
  );
  const original = await api(
    '/documents',
    'POST',
    {
      organizationId: orgId,
      customerId: buyer.id,
      kind: 'invoice',
      status: 'draft',
      issueDate: day,
      dueDate: '2026-10-31',
      title: 'Original invoice',
      items: [{ description: 'Service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
      discountPercent: 0,
      placeOfSupply: '09',
      notes: '',
      terms: '',
    },
    201,
  );
  async function page(path, expected = 200, session = cookie) {
    const response = await fetch(fixture.base + path, { headers: { cookie: session }, redirect: 'manual' });
    const html = await response.text();
    assert.equal(response.status, expected, html.slice(0, 400));
    const encoded = html.match(/<script\b[^>]*id="page-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    return { response, html, data: encoded ? JSON.parse(encoded) : null };
  }
  return { ...fixture, api, page, user, buyer, original, cookie: () => cookie };
}

test(
  'Page queries bound document lists, preserve complete search/CSV and enforce organization access',
  settings,
  async (t) => {
    const f = await pageFixture(t);
    const { backend, original } = f;
    for (const path of ['/favicon.svg', '/favicon.ico']) {
      const icon = await fetch(f.base + path);
      assert.equal(icon.status, 200, path);
      assert.match(icon.headers.get('content-type'), /^image\/svg\+xml/);
      assert.match(await icon.text(), /^<svg /);
    }
    const products = [];
    for (const code of ['PAGE-A', 'PAGE-B']) {
      products.push(
        await f.api(
          '/business-products',
          'POST',
          {
            organizationId: orgId,
            code,
            name: `Product ${code}`,
            description: 'Synthetic page checks',
            logoUrl: '',
            active: true,
          },
          201,
        ),
      );
    }
    const records = Array.from({ length: 150 }, (_, index) => ({
      ...structuredClone(original),
      id: `phase2-list-${index}`,
      number: `PHASE2/${String(index).padStart(4, '0')}`,
      title: index % 5 === 0 ? 'Literal [special]* invoice' : `Page invoice ${index}`,
      notes: 'PRIVATE_SNAPSHOT_CONTENT_' + 'x'.repeat(16_000),
      status: index % 3 === 0 ? 'sent' : 'draft',
      dueDate: index % 3 === 0 ? '2026-10-09' : '2026-10-31',
      businessProductId: products[index % products.length].id,
      businessProductSnapshot: { name: products[index % products.length].name },
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    }));
    await backend.db.collection('documents').insertMany(records);
    const root = `/workspace/${orgId}`;
    const first = await f.page(root + '/invoices');
    assert.equal(first.data.documents.length, 50);
    assert.equal(first.data.documentList.total, 151);
    assert.equal(first.data.documentList.pageCount, 4);
    assert.ok(first.data.documents.every((row) => !row.items && !row.notes && !row.organizationSnapshot));
    assert.doesNotMatch(first.html, /PRIVATE_SNAPSHOT_CONTENT_/);
    const second = await f.page(first.data.documentList.nextUrl);
    assert.equal(second.data.documentList.page, 2);
    const firstIds = new Set(first.data.documents.map((row) => row.id));
    assert.ok(second.data.documents.every((row) => !firstIds.has(row.id)));
    const last = await f.page(root + '/invoices?page=99999');
    assert.equal(last.data.documentList.page, 4);
    assert.equal(last.data.documents.length, 1);
    const matching = records.filter(
      (row) => row.title.includes('[special]*') && documentStatus(row, day) === 'overdue',
    );
    const searched = await f.page(root + '/invoices?q=%5Bspecial%5D*&status=overdue');
    assert.equal(searched.data.documentList.total, matching.length);
    assert.deepEqual(
      new Set(searched.data.documents.map((row) => row.id)),
      new Set(matching.map((row) => row.id)),
    );
    const product = await f.page(root + '/invoices?product=' + encodeURIComponent(products[0].id));
    assert.ok(product.data.documents.every((row) => row.businessProductId === products[0].id));
    assert.equal((await f.page(root + '/invoices?q=not-a-matching-document')).data.documentList.total, 0);
    for (const query of ['page=0', 'page=-2', 'status=%24ne', 'product=%24where'])
      await f.page(root + '/invoices?' + query, 400);
    assert.equal((await f.page(root + '/invoices?q%5B%24ne%5D=x')).data.documentList.total, 151);

    const exported = await f.page(first.data.documentList.exportUrl);
    assert.match(exported.response.headers.get('content-type'), /text\/csv/);
    assert.match(exported.response.headers.get('content-disposition'), /attachment/);
    assert.equal(exported.html.trim().split('\r\n').length, 152);
    const filteredExport = await f.page(searched.data.documentList.exportUrl);
    assert.equal(filteredExport.html.trim().split('\r\n').length, matching.length + 1);
    assert.doesNotMatch(exported.html, /PRIVATE_SNAPSHOT_CONTENT_/);
    assert.equal((await f.api(`/documents?organizationId=${orgId}&kind=invoice`)).length, 151);

    const inventory = t.mock.method(backend.backupStorage, 'listBackupMetadata', async () => {
      throw new Error('Unrelated navigation must not inspect backups');
    });
    for (const view of [
      'overview',
      'invoices',
      'quotations',
      'proformas',
      'shipping',
      'customers',
      'catalog',
      'formats',
      'business_products',
      'organizations',
      'business_settings',
      'dashboard_branding',
      'team',
      'integrations',
      'help',
    ]) {
      const result = await f.page(root + '/' + view);
      if (view !== 'team') assert.equal(result.data.teamUsers, undefined);
      if (view !== 'integrations') assert.equal(result.data.integrationStatus, undefined);
      assert.equal(result.data.backups, undefined);
    }
    assert.equal(inventory.mock.callCount(), 0);
    inventory.mock.restore();
    const edited = await f.page(root + `/invoices/edit/${records[0].id}`);
    assert.equal(edited.data.document.id, records[0].id);
    assert.match(edited.data.document.notes, /PRIVATE_SNAPSHOT_CONTENT_/);
    assert.equal(edited.data.documents.length, 0);
    assert.equal(edited.data.customers.length, 1);
    const preview = await f.page(root + `/invoices/preview/${records[0].id}`);
    assert.equal(preview.data.customers.length, 0);
    assert.equal(preview.data.catalog.length, 0);
    assert.equal(preview.data.document.id, records[0].id);
    await f.page(root + `/quotations/preview/${original.id}`, 404);
    await f.page(root + '/invoices?download=csv', 302, '');

    const baseline = await backend.app.locals.workspaceData(f.user, orgId);
    const beforeBytes = Buffer.byteLength(JSON.stringify(baseline));
    const afterBytes = Buffer.byteLength(JSON.stringify(first.data));
    assert.ok(afterBytes < beforeBytes / 10, `${afterBytes} vs ${beforeBytes}`);
    t.diagnostic(
      `Synthetic 151-invoice payload: full internal data ${beforeBytes} bytes; list page data ${afterBytes} bytes.`,
    );

    const explain = await backend.db
      .collection('documents')
      .find({ organizationId: orgId, kind: 'invoice' }, { projection: DOCUMENT_SUMMARY_FIELDS })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .explain('executionStats');
    assert.ok(explain.executionStats.totalDocsExamined <= 50);
    assert.doesNotMatch(JSON.stringify(explain.queryPlanner.winningPlan), /"stage":"(?:COLLSCAN|SORT)"/);
    t.diagnostic(
      `Indexed first page examined ${explain.executionStats.totalDocsExamined} documents for 50 returned rows.`,
    );

    const brokenSettings = t.mock.method(backend.db.models.settings, 'get', async () => {
      throw new Error('PRIVATE_PAGE_ERROR_DETAILS');
    });
    const failedPage = await f.page(root + '/overview', 500);
    assert.doesNotMatch(failedPage.html, /PRIVATE_PAGE_ERROR_DETAILS/);
    assert.ok(failedPage.html.includes(failedPage.response.headers.get('x-request-id')));
    brokenSettings.mock.restore();

    const adminCookie = f.cookie();
    await f.api(
      '/auth/signup',
      'POST',
      {
        name: 'Scoped Staff',
        email: 'phase2-staff@example.test',
        password: 'SyntheticStaffChecks123!',
        company: 'Test',
      },
      202,
    );
    const staff = (await f.api('/auth/users')).find((row) => row.email === 'phase2-staff@example.test');
    await f.api('/auth/users/' + staff.id, 'PATCH', {
      role: 'staff',
      status: 'active',
      organizationIds: [orgId],
    });
    await f.api('/auth/login', 'POST', { email: staff.email, password: 'SyntheticStaffChecks123!' }, 200, '');
    await f.page(root + '/invoices');
    await f.page('/workspace/at-facilities/invoices?download=csv', 403);
    await f.page(`/workspace/at-facilities/invoices/preview/${original.id}`, 403);
    await f.page(root + '/backups', 403);
    await f.page(root + '/team', 403);
    await f.api(
      '/auth/users/' + staff.id,
      'PATCH',
      { role: 'staff', status: 'disabled', organizationIds: [orgId] },
      200,
      adminCookie,
    );
    await f.page(root + '/invoices?download=csv', 302);
  },
);

test(
  'Streamed overview and overdue queries preserve shared financial and installment calculations',
  settings,
  async (t) => {
    const f = await pageFixture(t);
    const docs = [];
    const statuses = ['draft', 'sent', 'partially_paid', 'paid', 'cancelled'];
    for (let index = 0; index < 25; index += 1) {
      const status = statuses[index % statuses.length];
      docs.push({
        ...structuredClone(f.original),
        id: `overview-${index}`,
        number: `OVERVIEW/${index}`,
        kind: index % 7 === 0 ? 'quotation' : 'invoice',
        status,
        amountPaid: status === 'paid' ? 100 : status === 'partially_paid' ? 70 : 0,
        dueDate: index % 2 ? '2026-10-09' : '2026-10-10',
        issueDate: `2026-${String(5 + (index % 6)).padStart(2, '0')}-01`,
        installmentPlan:
          index % 3
            ? null
            : {
                name: '70/20/10',
                installments: [
                  { id: 'last', label: 'Final', dueDate: '2026-10-31', amount: 10 },
                  { id: 'first', label: 'Initial', dueDate: '2026-10-09', amount: 70 },
                  { id: 'second', label: 'Second', dueDate: '2026-10-10', amount: 20 },
                ],
              },
      });
    }
    // Retain the old paid-status fallback when an imported document lacks amountPaid.
    delete docs[3].amountPaid;
    await f.backend.db.collection('documents').insertMany(docs);
    const all = await f.backend.db.models.documents.list(orgId);
    const queries = createWorkspaceQueries(f.backend.db);
    const actual = await queries.overview(orgId, clock(), day);
    const invoices = all.filter((row) => row.kind === 'invoice');
    const quotes = all.filter((row) => row.kind === 'quotation' && ['draft', 'sent'].includes(row.status));
    assert.equal(actual.invoiceCount, invoices.length);
    assert.equal(
      actual.received,
      invoices.reduce((sum, row) => sum + paidAmount(row), 0),
    );
    assert.equal(
      actual.outstanding,
      invoices
        .filter((row) => ['sent', 'partially_paid'].includes(row.status))
        .reduce((sum, row) => sum + balanceDue(row), 0),
    );
    assert.equal(
      actual.overdueCount,
      invoices.filter((row) => documentStatus(row, day) === 'overdue').length,
    );
    assert.equal(actual.openQuoteCount, quotes.length);
    assert.equal(
      actual.openQuoteTotal,
      quotes.reduce((sum, row) => sum + row.totals.total, 0),
    );
    const scheduled = invoices
      .filter((row) => row.installmentPlan && !['draft', 'cancelled'].includes(row.status))
      .flatMap((document) =>
        installmentBalances(document, day)
          .filter((row) => row.balanceDue > 0)
          .map((row) => ({ ...row, document })),
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    assert.equal(actual.pendingInstallmentCount, scheduled.length);
    assert.deepEqual(
      actual.scheduled.map((row) => [row.document.id, row.id, row.balanceDue, row.status]),
      scheduled.slice(0, 8).map((row) => [row.document.id, row.id, row.balanceDue, row.status]),
    );
    for (const month of actual.monthly)
      assert.equal(
        month.total,
        invoices
          .filter((row) => row.issueDate.startsWith(month.key))
          .reduce((sum, row) => sum + paidAmount(row), 0),
      );
    const overdue = await queries.documentPage(
      orgId,
      'invoice',
      readDocumentFilters({ status: 'overdue' }),
      day,
    );
    assert.deepEqual(
      new Set(overdue.documents.map((row) => row.id)),
      new Set(invoices.filter((row) => documentStatus(row, day) === 'overdue').map((row) => row.id)),
    );
    assert.equal(actual.recent.length, 6);
    assert.ok(actual.recent.every((row) => !row.items && !row.notes && !row.organizationSnapshot));
  },
);

test(
  'Backup inventory avoids full content reads while downloads still reject same-size tampering',
  settings,
  async (t) => {
    const f = await pageFixture(t);
    const saved = await f.backend.backups.create();
    assert.equal(saved.verified, true);
    const storage = f.backend.backupStorage;
    const listed = await storage.listBackupMetadata();
    assert.equal(listed[0].id, saved.id);
    assert.equal(listed[0].verified, false);
    assert.equal(listed[0].verification, 'on_download');
    const databasePath = join(f.environment.DATABASE_BACKUP_DIR, saved.id, 'database.ejson');
    const original = await readFile(databasePath);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 123 ? 91 : 123;
    await writeFile(databasePath, changed, { mode: 0o600 });
    assert.equal((await storage.listBackupMetadata())[0].byteLength, saved.byteLength);
    await assert.rejects(storage.getVerifiedDatabasePath(saved.id), /checksum/);
    await assert.rejects(storage.verifyBackup(saved.id), /checksum/);
    await f.api(`/backups/${saved.id}/manifest`, 'GET', undefined, 503);
    const denied = await fetch(`${f.base}/api/backups/${saved.id}/download`, {
      headers: { cookie: f.cookie() },
    });
    assert.equal(denied.status, 503);
    await writeFile(databasePath, original, { mode: 0o600 });
    assert.equal((await storage.verifyBackup(saved.id)).verified, true);
    const download = await fetch(`${f.base}/api/backups/${saved.id}/download`, {
      headers: { cookie: f.cookie() },
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), original);
    await f.page(`/workspace/${orgId}/backups`);
  },
);
