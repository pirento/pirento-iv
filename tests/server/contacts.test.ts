import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  contactFieldSchemas,
  validateContactFields,
  normalizeContact,
  isInvoiceRecipient,
} from '../../server/validation/contacts.ts';
import { contactRoles } from '../../shared/contact-types.ts';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';
import type { BusinessDocument, Customer, DocumentInput } from '../../shared/types.ts';

const schema = z
  .object({ gstin: z.string().default(''), ...contactFieldSchemas })
  .superRefine(validateContactFields);

test('legacy customers remain invoice recipients without changing the original snapshot', () => {
  const legacy = { id: 'old-customer', name: 'Existing customer' };
  const normalized = normalizeContact({ ...legacy, roles: undefined });
  assert.deepEqual(normalized.roles, ['customer']);
  assert.equal(normalized.active, true);
  assert.equal(normalized.paymentTermsDays, 0);
  assert.equal(isInvoiceRecipient(normalized), true);
  assert.deepEqual(legacy, { id: 'old-customer', name: 'Existing customer' });
  assert.deepEqual(contactRoles({}), ['customer']);
});

test('all saved contact roles can receive invoices, while archived contacts cannot', () => {
  assert.equal(isInvoiceRecipient({ roles: ['vendor'] }), true);
  assert.equal(isInvoiceRecipient({ roles: ['vendor', 'b2b_buyer'] }), true);
  assert.equal(isInvoiceRecipient({ roles: ['customer', 'vendor'], active: false }), false);
  assert.equal(isInvoiceRecipient({ roles: ['b2b_buyer'] }), true);
  assert.equal(isInvoiceRecipient({ roles: [] }), false);
});

test('contact schema validates multi-role input and safely defaults old records', () => {
  assert.deepEqual(schema.parse({}).roles, ['customer']);
  assert.deepEqual(schema.parse({ roles: ['vendor', 'customer'], active: false }).roles, [
    'vendor',
    'customer',
  ]);
  for (const roles of [[], ['vendor', 'vendor'], ['administrator']]) {
    assert.equal(schema.safeParse({ roles }).success, false);
  }
  assert.equal(schema.safeParse({ active: 'true' }).success, false);
});

test('PAN must have valid syntax and agree with GSTIN when both are supplied', () => {
  assert.equal(schema.parse({ pan: ' aaaca1234b ', gstin: '09AAACA1234B1ZG' }).pan, 'AAACA1234B');
  assert.equal(schema.safeParse({ pan: 'ABC' }).success, false);
  assert.equal(schema.safeParse({ pan: 'ABCDE1234F', gstin: '09AAACA1234B1ZG' }).success, false);
  assert.equal(schema.safeParse({ pan: 'AAACA1234B' }).success, true);
});

test('shipping, payment terms, and credit limits reject invalid or overprecise values', () => {
  assert.equal(
    schema.safeParse({ shippingStateCode: '09', paymentTermsDays: 30, creditLimit: 50000.55 }).success,
    true,
  );
  for (const input of [
    { shippingStateCode: '99' },
    { paymentTermsDays: -1 },
    { paymentTermsDays: 1.5 },
    { paymentTermsDays: 366 },
    { creditLimit: -0.01 },
    { creditLimit: 100.001 },
    { creditLimit: Infinity },
    { notes: 'x'.repeat(4001) },
  ])
    assert.equal(schema.safeParse(input).success, false);
});

const ORG = 'at-facilities';
const OTHER_ORG = 'at-elevators';

async function fixture(t: TestContext) {
  const db = initDb(':memory:');
  // This suite tests contact invariants independently of the authentication suite.
  const options = { db, auth: false as const };
  const server = createApp(options).listen(0, '127.0.0.1');
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
    status = 200,
  ): Promise<T> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
    return result as T;
  }
  async function contact(overrides: Partial<Customer> = {}) {
    return request<Customer>(
      '/customers',
      'POST',
      {
        organizationId: ORG,
        name: 'Directory contact',
        email: '',
        phone: '',
        gstin: '',
        address: '',
        stateCode: '',
        contactPerson: '',
        ...overrides,
      },
      201,
    );
  }
  function input(customerId: string, overrides: Partial<DocumentInput> = {}): DocumentInput {
    return {
      organizationId: ORG,
      customerId,
      kind: 'invoice',
      status: 'draft',
      issueDate: '2026-10-08',
      dueDate: '2026-10-28',
      title: 'Invoice',
      items: [{ description: 'Maintenance', quantity: 1, rate: 1000, gstRate: 0, hsn: '' }],
      discountPercent: 0,
      placeOfSupply: '',
      notes: '',
      terms: '',
      ...overrides,
    };
  }
  return { db, request, contact, input };
}

test('contact API saves multiple roles and business details within one organization', async (t) => {
  const { request, contact } = await fixture(t);
  const saved = await contact({
    name: 'Business buyer and supplier',
    roles: ['b2b_buyer', 'vendor'],
    pan: 'AAACA1234B',
    gstin: '09AAACA1234B1ZG',
    stateCode: '09',
    email: 'buyer@example.com',
    phone: '+91 9999999999',
    contactPerson: 'Accounts team',
    address: 'Billing address',
    shippingAddress: 'Warehouse address',
    shippingStateCode: '07',
    paymentTermsDays: 45,
    creditLimit: 80000.25,
    notes: 'Call the delivery contact first',
  });
  const rows = await request<Customer[]>(`/customers?organizationId=${ORG}`);
  assert.deepEqual(rows, [saved]);
  assert.deepEqual(saved.roles, ['b2b_buyer', 'vendor']);
  assert.equal(saved.shippingAddress, 'Warehouse address');
  assert.equal(saved.paymentTermsDays, 45);
  assert.equal(saved.creditLimit, 80000.25);
  assert.equal(saved.pan, 'AAACA1234B');
  assert.equal(saved.active, true);
  assert.deepEqual(await request(`/customers?organizationId=${OTHER_ORG}`), []);
  await request(`/customers/${saved.id}`, 'PUT', { ...saved, organizationId: OTHER_ORG }, 400);
  await request(`/customers/${saved.id}`, 'PUT', { ...saved, pan: 'ABCDE1234F' }, 400);
  const restored = await request<Customer>(`/customers/${saved.id}`, 'PUT', { ...saved, active: false });
  assert.equal(restored.active, false);
  assert.equal(restored.notes, saved.notes);
});

test('contact API allows vendors and B2B buyers, but rejects archived and cross-organization recipients', async (t) => {
  const { request, contact, input } = await fixture(t);
  const vendor = await contact({ name: 'Supplier', roles: ['vendor'] });
  for (const kind of ['invoice', 'quotation', 'proforma', 'delivery_note'] as const) {
    const draft = input(vendor.id, { kind });
    if (kind === 'delivery_note') draft.items = draft.items.map((item) => ({ ...item, rate: 0 }));
    const document = await request<BusinessDocument>('/documents', 'POST', draft, 201);
    assert.equal(document.customerId, vendor.id);
    assert.deepEqual(document.customerSnapshot.roles, ['vendor']);
  }
  await request(`/customers/${vendor.id}`, 'PUT', { ...vendor, active: false });
  await request('/documents', 'POST', input(vendor.id), 400);
  const buyer = await contact({ name: 'Trade buyer', roles: ['b2b_buyer'] });
  const invoice = await request<BusinessDocument>('/documents', 'POST', input(buyer.id), 201);
  assert.deepEqual(invoice.customerSnapshot.roles, ['b2b_buyer']);
  await request(`/customers/${buyer.id}`, 'PUT', { ...buyer, active: false });
  await request('/documents', 'POST', input(buyer.id), 400);
  const outside = await contact({
    organizationId: OTHER_ORG,
    name: 'Other organization buyer',
    roles: ['b2b_buyer'],
  });
  await request('/documents', 'POST', input(outside.id), 400);
});

test('archiving a used contact preserves document history and allows metadata edits', async (t) => {
  const { request, contact, input } = await fixture(t);
  const buyer = await contact({
    name: 'Original customer',
    roles: ['customer'],
    address: 'Original billing address',
  });
  const draftInput = input(buyer.id);
  const invoice = await request<BusinessDocument>('/documents', 'POST', draftInput, 201);
  await request(`/customers/${buyer.id}`, 'PUT', {
    ...buyer,
    name: 'Renamed and archived',
    active: false,
    address: 'New billing address',
  });
  const updated = await request<BusinessDocument>(`/documents/${invoice.id}`, 'PUT', {
    ...draftInput,
    notes: 'Updated instructions',
    dueDate: '2026-11-15',
  });
  assert.deepEqual(updated.customerSnapshot, invoice.customerSnapshot);
  assert.deepEqual(updated.totals, invoice.totals);
  assert.equal(updated.notes, 'Updated instructions');
  const revised = await request<BusinessDocument>(`/documents/${invoice.id}`, 'PUT', {
    ...draftInput,
    items: [{ ...draftInput.items[0], rate: 1500 }],
  });
  assert.equal(revised.customerSnapshot.name, 'Renamed and archived');
  assert.equal(revised.customerSnapshot.address, 'New billing address');
  assert.equal(revised.customerSnapshot.active, false);
  assert.equal(revised.totals.total, 1500);
  assert.equal(invoice.customerSnapshot.name, 'Original customer');
  await request(`/customers/${buyer.id}`, 'DELETE', undefined, 409);
  const vendor = await contact({ name: 'Vendor only', roles: ['vendor'] });
  const changed = await request<BusinessDocument>(`/documents/${invoice.id}`, 'PUT', {
    ...draftInput,
    customerId: vendor.id,
  });
  assert.equal(changed.customerId, vendor.id);
  assert.deepEqual(changed.customerSnapshot.roles, ['vendor']);
  await request(`/customers/${vendor.id}`, 'PUT', { ...vendor, active: false });
  await request('/documents', 'POST', input(vendor.id), 400);
});

test('pre-upgrade customer records normalize as active customers without losing IDs', async (t) => {
  const { db, request, input } = await fixture(t);
  const legacy: Customer = {
    id: 'legacy-contact',
    organizationId: ORG,
    name: 'Legacy customer',
    email: '',
    phone: '',
    gstin: '',
    address: 'Retained address',
    stateCode: '',
    contactPerson: '',
  };
  db.prepare('INSERT INTO customers (id, organization_id, data) VALUES (?, ?, ?)').run(
    legacy.id,
    ORG,
    JSON.stringify(legacy),
  );
  const [loaded] = await request<Customer[]>(`/customers?organizationId=${ORG}`);
  assert.equal(loaded.id, legacy.id);
  assert.deepEqual(loaded.roles, ['customer']);
  assert.equal(loaded.active, true);
  const document = await request<BusinessDocument>('/documents', 'POST', input(legacy.id), 201);
  assert.equal(document.customerId, legacy.id);
  assert.equal(document.customerSnapshot.address, legacy.address);
});
