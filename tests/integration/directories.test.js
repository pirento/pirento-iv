import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { DIRECTORY_COLLATION, DIRECTORY_SORT } from '../../src/models/directory-queries.js';

const org = 'pipeline2-legal';
const foreign = 'at-facilities';
const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run a test replica set.',
  timeout: 120000,
};

test(
  'directories paginate/filter/export all records, bound editor lookups and enforce business permissions',
  settings,
  async (t) => {
    const f = await createFixture(t, {
      environment: {
        INITIAL_ADMIN_EMAIL: 'directory-admin@example.test',
        INITIAL_ADMIN_PASSWORD: 'DirectoryAdminPassword123!',
        INITIAL_ADMIN_NAME: 'Directory reviewer',
      },
    });
    attachPageRoutes(f.backend);
    let cookie = '';
    async function api(path, method = 'GET', body, expected = 200, session = cookie) {
      const response = await fetch(f.base + '/api' + path, {
        method,
        headers: { 'content-type': 'application/json', cookie: session },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return value;
    }
    async function page(path, expected = 200) {
      const response = await fetch(f.base + path, { headers: { cookie }, redirect: 'manual' });
      const html = await response.text();
      assert.equal(response.status, expected, html.slice(0, 400));
      const serialized = html.match(/<script\b[^>]*id="page-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
      return { response, html, data: serialized ? JSON.parse(serialized) : undefined };
    }
    await api('/auth/login', 'POST', {
      email: f.environment.INITIAL_ADMIN_EMAIL,
      password: f.environment.INITIAL_ADMIN_PASSWORD,
    });
    const contacts = Array.from({ length: 131 }, (_, i) => ({
      id: `directory-contact-${i}`,
      organizationId: org,
      name: `Contact ${String(i).padStart(3, '0')}${i % 20 === 0 ? ' [special]*' : ''}`,
      email: `contact-${i}@example.test`,
      phone: '',
      gstin: '',
      pan: '',
      contactPerson: '',
      address: 'Lucknow',
      stateCode: '09',
      roles: [i % 2 ? 'vendor' : 'customer'],
      active: true,
      shippingAddress: '',
      shippingStateCode: '',
      paymentTermsDays: 0,
      creditLimit: 0,
      notes: 'Contact note ' + 'x'.repeat(300),
    }));
    const items = Array.from({ length: 131 }, (_, i) => ({
      id: `directory-catalog-${i}`,
      organizationId: org,
      name: `Offering ${String(i).padStart(3, '0')}${i % 20 === 0 ? ' [special]*' : ''}`,
      type: i % 2 ? 'product' : 'service',
      sku: `SKU-${i}`,
      hsn: '',
      description: 'Synthetic offering',
      unit: 'Nos',
      rate: 100,
      gstRate: 0,
      active: true,
      businessProductId: i % 3 === 0 ? 'directory-division' : '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await f.backend.db.collection('customers').insertMany([
      ...contacts,
      { ...contacts[0], id: 'foreign-contact', organizationId: foreign, name: 'FOREIGN CONTACT' },
      {
        ...contacts[0],
        id: 'tenant-case-contact',
        organizationId: org.toUpperCase(),
        name: 'TENANT ALIAS CASE',
      },
      {
        ...contacts[0],
        id: 'tenant-numeric-contact',
        organizationId: 'pipeline02-legal',
        name: 'TENANT ALIAS NUMBER',
      },
    ]);
    await f.backend.db.collection('catalog').insertMany([
      ...items,
      { ...items[0], id: 'foreign-item', organizationId: foreign, sku: 'FOREIGN', name: 'FOREIGN ITEM' },
      {
        ...items[0],
        id: 'tenant-case-item',
        organizationId: org.toUpperCase(),
        sku: 'ALIAS-CASE',
        name: 'TENANT ALIAS CASE',
      },
      {
        ...items[0],
        id: 'tenant-numeric-item',
        organizationId: 'pipeline02-legal',
        sku: 'ALIAS-NUMBER',
        name: 'TENANT ALIAS NUMBER',
      },
    ]);
    await f.backend.db.collection('business_products').insertOne({
      id: 'directory-division',
      organizationId: org,
      name: 'Research division',
      code: 'DIR',
      description: '',
      active: true,
    });
    const document = await api(
      '/documents',
      'POST',
      {
        organizationId: org,
        customerId: contacts.at(-1).id,
        kind: 'invoice',
        status: 'draft',
        issueDate: '2026-10-11',
        dueDate: '2026-11-11',
        title: 'Directory snapshot',
        items: [{ description: 'Work', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
      },
      201,
    );
    await f.backend.db
      .collection('customers')
      .updateOne({ id: contacts.at(-1).id }, { $set: { active: false } });
    await f.backend.db.collection('catalog').updateOne({ id: items.at(-1).id }, { $set: { active: false } });

    const customerRead = t.mock.method(f.backend.db.models.customers, 'list', () => {
      throw new Error('Unbounded contact list');
    });
    const catalogRead = t.mock.method(f.backend.db.models.catalog, 'list', () => {
      throw new Error('Unbounded catalog list');
    });
    for (const kind of ['customers', 'catalog']) {
      const first = await page(`/workspace/${org}/${kind}`);
      assert.equal(first.data[kind].length, 50);
      assert.equal(first.data.directory.total, 130);
      assert.equal(first.data.directory.pageCount, 3);
      assert.equal(first.data.directory.counts.archived, 1);
      assert.doesNotMatch(first.html, /FOREIGN (?:CONTACT|ITEM)/);
      assert.doesNotMatch(first.html, /TENANT ALIAS/);
      const second = await page(first.data.directory.nextUrl);
      const ids = new Set(first.data[kind].map((item) => item.id));
      assert.ok(second.data[kind].every((item) => !ids.has(item.id)));
      const last = await page(`/workspace/${org}/${kind}?page=99999`);
      assert.equal(last.data[kind].length, 30);
      assert.equal(last.data.directory.page, 3);
      const searched = await page(`/workspace/${org}/${kind}?q=%5Bspecial%5D*`);
      assert.equal(searched.data.directory.total, 7);
      const exported = await page(first.data.directory.exportUrl);
      assert.match(exported.response.headers.get('content-type'), /text\/csv/);
      assert.equal(exported.html.trim().split('\r\n').length, 131);
      assert.doesNotMatch(exported.html, /TENANT ALIAS/);
      const filtered = await page(searched.data.directory.exportUrl);
      assert.equal(filtered.html.trim().split('\r\n').length, 8);
      const archived = await page(
        `/workspace/${org}/${kind}?${kind === 'customers' ? 'role' : 'type'}=archived`,
      );
      assert.equal(archived.data[kind].length, 1);
      assert.match(archived.html, /Restore/);
      const form = await page(
        `/workspace/${org}/${kind}/edit/${kind === 'customers' ? contacts.at(-1).id : items.at(-1).id}`,
      );
      assert.equal(form.data[kind].length, 1);
      for (const query of ['q=a&q=b', 'page=-1', 'q=' + 'a'.repeat(201)])
        await page(`/workspace/${org}/${kind}?${query}`, 400);
      const lookup = await api(`/${kind}/lookup?organizationId=${org}`);
      assert.equal(lookup.items.length, 20);
      assert.equal(lookup.hasMore, true);
      const next = await api(`/${kind}/lookup?organizationId=${org}&page=2`);
      const firstIds = new Set(lookup.items.map((item) => item.id));
      assert.ok(next.items.every((item) => !firstIds.has(item.id)));
      const exact = await api(
        `/${kind}/lookup?organizationId=${org}&ids=${kind === 'customers' ? contacts.at(-1).id + ',foreign-contact' : items.at(-1).id + ',foreign-item'}`,
      );
      assert.equal(exact.items.length, 1);
      assert.equal(exact.items[0].active, false);
      await api(`/${kind}/lookup`, 'GET', undefined, 400);
      await api(`/${kind}/lookup?organizationId=${org}&q=a&q=b`, 'GET', undefined, 400);
    }
    const vendorPage = await page(`/workspace/${org}/customers?role=vendor`);
    assert.equal(vendorPage.data.directory.total, 65);
    assert.ok(vendorPage.data.customers.every((item) => item.roles.includes('vendor')));
    const productPage = await page(`/workspace/${org}/catalog?product=directory-division`);
    assert.equal(productPage.data.directory.total, 44);
    const productSearch = await page(`/workspace/${org}/catalog?q=Research`);
    assert.equal(productSearch.data.directory.total, 44);
    const selectedProduct = await api(`/catalog/lookup?organizationId=${org}&product=directory-division`);
    assert.ok(
      selectedProduct.items.every(
        (item) => !item.businessProductId || item.businessProductId === 'directory-division',
      ),
    );
    const newEditor = await page(`/workspace/${org}/invoices/new`);
    assert.equal(newEditor.data.customers.length, 20);
    assert.equal(newEditor.data.catalog.length, 20);
    const edit = await page(`/workspace/${org}/invoices/edit/${document.id}`);
    assert.equal(edit.data.customers.length, 21);
    assert.ok(edit.data.customers.some((item) => item.id === contacts.at(-1).id && item.active === false));
    assert.equal(edit.data.catalog.length, 20);
    assert.equal(customerRead.mock.callCount(), 0);
    assert.equal(catalogRead.mock.callCount(), 0);
    customerRead.mock.restore();
    catalogRead.mock.restore();
    assert.equal((await api(`/customers?organizationId=${org}`)).length, 131);
    assert.equal((await api(`/catalog?organizationId=${org}`)).length, 131);
    for (const kind of ['customers', 'catalog']) {
      const explain = await f.backend.db
        .collection(kind)
        .find({ organizationId: org }, { collation: DIRECTORY_COLLATION })
        .sort(DIRECTORY_SORT)
        .limit(50)
        .explain('executionStats');
      assert.ok(explain.executionStats.totalDocsExamined <= 50);
      assert.doesNotMatch(JSON.stringify(explain.queryPlanner.winningPlan), /"stage":"(?:COLLSCAN|SORT)"/);
    }
    t.diagnostic(
      `131 contacts + 131 items: new editor has ${newEditor.data.customers.length} contacts and ${newEditor.data.catalog.length} items (${Buffer.byteLength(JSON.stringify(newEditor.data))} page-data bytes).`,
    );

    for (const kind of ['customers', 'catalog']) {
      const { _id, ...source } = kind === 'customers' ? contacts[0] : items[0];
      await f.backend.db.collection(kind).insertMany(
        ['Alias1', 'alias1', 'alias01'].map((id, index) => ({
          ...source,
          id,
          name: 'Exact identity ' + id,
          ...(kind === 'catalog' ? { sku: 'EXACT-' + index } : {}),
        })),
      );
      const exact = await api(`/${kind}/lookup?organizationId=${org}&ids=Alias1`);
      assert.deepEqual(
        exact.items.map((item) => item.id),
        ['Alias1'],
      );
      const aliases = await api(`/${kind}/lookup?organizationId=${org}&q=TENANT%20ALIAS`);
      assert.equal(aliases.items.length, 0);
    }

    const adminCookie = cookie;
    await api(
      '/auth/signup',
      'POST',
      {
        name: 'Directory staff',
        email: 'directory-staff@example.test',
        password: 'DirectoryStaffPassword123!',
        company: 'Test',
      },
      202,
    );
    const staff = (await api('/auth/users')).find((user) => user.email === 'directory-staff@example.test');
    await api(`/auth/users/${staff.id}`, 'PATCH', {
      role: 'staff',
      status: 'active',
      organizationIds: [org],
    });
    await api('/auth/login', 'POST', { email: staff.email, password: 'DirectoryStaffPassword123!' }, 200, '');
    for (const kind of ['customers', 'catalog']) {
      await api(`/${kind}/lookup?organizationId=${org}`);
      await api(`/${kind}/lookup?organizationId=${foreign}`, 'GET', undefined, 403);
      await page(`/api/${kind}/export?organizationId=${foreign}`, 403);
      await page(`/workspace/${foreign}/${kind}`, 403);
    }
    await api(
      `/auth/users/${staff.id}`,
      'PATCH',
      { role: 'staff', status: 'disabled', organizationIds: [org] },
      200,
      adminCookie,
    );
    await api(`/customers/lookup?organizationId=${org}`, 'GET', undefined, 401);
  },
);
