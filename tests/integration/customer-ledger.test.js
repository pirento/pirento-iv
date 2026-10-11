import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createFixture, integrationEnabled } from './fixture.js';
import { createCustomerLedgerQueries } from '../../src/models/customer-ledger-queries.js';
import { createWorkspaceQueries } from '../../src/models/workspace-queries.js';
import { documentStatus } from '../../shared/document-status.js';

const settings = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 120_000,
};
const organizationId = 'pipeline2-legal';

async function fixture(t, { authenticated = false } = {}) {
  let instant = '2026-10-10T12:00:00.000Z';
  const base = await createFixture(t, {
    ...(authenticated ? {} : { auth: false }),
    now: () => new Date(instant),
    environment: {
      INITIAL_ADMIN_EMAIL: 'ledger-owner@example.test',
      INITIAL_ADMIN_PASSWORD: 'SyntheticLedgerOwner123!',
      INITIAL_ADMIN_NAME: 'Ledger Owner',
    },
  });
  let cookie = '';
  async function request(path, method = 'GET', body, expected = 200, session = cookie) {
    const response = await fetch(`${base.base}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: session },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data).slice(0, 1000)}`);
    return { response, data };
  }
  const api = async (...args) => (await request(...args)).data;
  async function login(email, password) {
    const result = await request('/auth/login', 'POST', { email, password });
    cookie = result.response.headers.get('set-cookie').split(';')[0];
    return result.data.user;
  }
  if (authenticated)
    await login(base.environment.INITIAL_ADMIN_EMAIL, base.environment.INITIAL_ADMIN_PASSWORD);
  const customer = (name, extra = {}) =>
    api(
      '/customers',
      'POST',
      {
        organizationId,
        name,
        email: 'recipient@example.test',
        phone: '',
        gstin: '',
        address: 'Lucknow',
        stateCode: '09',
        contactPerson: '',
        ...extra,
      },
      201,
    );
  const invoice = (customerId, extra = {}) =>
    api(
      '/documents',
      'POST',
      {
        organizationId,
        customerId,
        kind: 'invoice',
        status: 'sent',
        issueDate: '2026-09-01',
        dueDate: '2026-09-15',
        title: 'Ledger invoice',
        items: [{ description: 'Fixture service', quantity: 1, rate: 100, hsn: '', gstRate: 0 }],
        discountPercent: 0,
        placeOfSupply: '09',
        notes: '',
        terms: '',
        ...extra,
      },
      201,
    );
  const pay = (document, amount, paidOn, extra = {}) =>
    api(
      `/documents/${document.id}/payments`,
      'POST',
      {
        amount,
        paidOn,
        method: 'bank_transfer',
        reference: '',
        notes: '',
        requestId: randomUUID(),
        finalizeWhenPaid: false,
        ...extra,
      },
      201,
    );
  return {
    ...base,
    request,
    api,
    login,
    customer,
    invoice,
    pay,
    cookie: () => cookie,
    setTime: (value) => {
      instant = value;
    },
  };
}

test(
  'Native customer ledger reconciles partial/full receipts, voids and current cancellations without guessing legacy history',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Ledger Same Name [.*]');
    const first = await f.invoice(buyer.id);
    await f.pay(first, 40, '2026-09-05');
    let details = await f.pay(first, 30, '2026-09-25', { reference: '=HYPERLINK("example")' });
    const voided = details.payments.find((payment) => payment.amount === 30);
    f.setTime('2026-09-30T18:30:00.000Z');
    await f.api(`/payments/${voided.id}/void`, 'POST', { reason: 'Wrong receipt entry' });
    f.setTime('2026-10-10T12:00:00.000Z');
    const paid = await f.invoice(buyer.id, {
      items: [{ description: 'Settled service', quantity: 1, rate: 50, hsn: '', gstRate: 0 }],
    });
    details = await f.pay(paid, 50, '2026-09-15', { finalizeWhenPaid: true });
    assert.equal(details.document.status, 'paid');
    const cancelled = await f.invoice(buyer.id);
    details = await f.pay(cancelled, 10, '2026-09-09');
    details = await f.api(`/payments/${details.payments[0].id}/void`, 'POST', {
      reason: 'Payment entered on wrong invoice',
    });
    await f.api(`/documents/${cancelled.id}`, 'PUT', { ...details.document, status: 'cancelled' });
    await f.invoice(buyer.id, { status: 'draft' });
    const ignored = ['quotation', 'proforma', 'delivery_note'].map((kind) => ({
      ...structuredClone(first),
      id: randomUUID(),
      number: `IGNORED-${kind}`,
      kind,
      totals: { total: 999999 },
      amountPaid: 999999,
      balanceDue: 0,
    }));
    await f.backend.db.collection('documents').insertMany(ignored);
    await f.backend.db.collection('documents').updateOne(
      { id: first.id },
      {
        $set: {
          notes: 'PRIVATE_LEDGER_SNAPSHOT_CONTENT',
          'organizationSnapshot.bankName': 'PRIVATE_LEDGER_BANK_CONTENT',
        },
      },
    );

    const list = await f.api(`/ledger?organizationId=${organizationId}&q=${encodeURIComponent(buyer.name)}`);
    const customer = list.customers.find((row) => row.id === buyer.id);
    assert.equal(customer.invoiceCount, 2);
    assert.equal(customer.invoicedPaise, 15000);
    assert.equal(customer.receivedPaise, 9000);
    assert.equal(customer.outstandingPaise, 6000);
    assert.equal(customer.overduePaise, 6000);
    const period = await f.api(
      `/ledger/${buyer.id}?organizationId=${organizationId}&from=2026-09-10&to=2026-10-01&pageSize=1`,
    );
    assert.equal(period.summary.receivedPaise, 9000, 'Current totals are independent of the selected period');
    assert.equal(period.period.openingBalancePaise, 11000);
    assert.equal(period.period.receivedPaise, 8000);
    assert.equal(period.period.voidedPaise, 3000);
    assert.equal(period.period.closingBalancePaise, 6000);
    assert.equal(
      period.period.openingBalancePaise + period.period.debitsPaise - period.period.creditsPaise,
      period.period.closingBalancePaise,
    );
    assert.equal(period.history.complete, true);
    assert.equal(period.total, 3);
    assert.equal(period.rows.length, 1);
    assert.equal(period.rows[0].balancePaise, 6000);
    assert.ok(period.excludedDocuments.some((row) => row.id === cancelled.id && row.status === 'cancelled'));
    assert.doesNotMatch(JSON.stringify(period), /PRIVATE_LEDGER/);
    const second = await f.api(
      `/ledger/${buyer.id}?organizationId=${organizationId}&from=2026-09-10&to=2026-10-01&pageSize=1&page=2`,
    );
    assert.equal(second.rows[0].balancePaise, 3000, 'Later pages carry the full prior balance');
    const printed = await f.backend.ledger.statement(
      undefined,
      organizationId,
      buyer.id,
      { from: '2026-09-10', to: '2026-10-01', pageSize: '1' },
      { allRows: true },
    );
    assert.equal(printed.rows.length, 3);
    const exported = await f.request(
      `/ledger/${buyer.id}/export?organizationId=${organizationId}&from=2026-09-10&to=2026-10-01&pageSize=1`,
    );
    assert.match(exported.response.headers.get('content-type'), /text\/csv/);
    assert.match(exported.data, /receipt_void/);
    assert.match(exported.data, /'\=HYPERLINK/);
    assert.match(exported.data, /current invoice status|current invoice|Current invoice/);
    assert.match(exported.data, /excluded_invoice/);

    const archived = await f.customer(buyer.name, { active: false });
    const legacy = {
      ...structuredClone(first),
      id: randomUUID(),
      number: 'LEGACY-PAID',
      customerId: archived.id,
      customerSnapshot: archived,
      status: 'paid',
      totals: { total: 25 },
    };
    delete legacy.amountPaid;
    delete legacy.balanceDue;
    await f.backend.db.collection('documents').insertOne(legacy);
    const legacyStatement = await f.api(`/ledger/${archived.id}?organizationId=${organizationId}`);
    assert.equal(legacyStatement.customer.active, false);
    assert.equal(legacyStatement.summary.receivedPaise, 2500);
    assert.equal(legacyStatement.summary.outstandingPaise, 0);
    assert.equal(legacyStatement.period.openingBalancePaise, null);
    assert.equal(legacyStatement.period.closingBalancePaise, null);
    assert.equal(legacyStatement.history.unreceiptedCreditPaise, 2500);
    assert.ok(legacyStatement.rows.some((row) => row.type === 'legacy_balance' && row.date === null));

    const missingId = 'ledger-missing-contact';
    const orphan = {
      ...structuredClone(first),
      id: randomUUID(),
      number: 'MISSING-CONTACT',
      customerId: missingId,
      customerSnapshot: { name: buyer.name },
      amountPaid: 0,
      balanceDue: 100,
    };
    const unlinked = {
      ...structuredClone(first),
      id: randomUUID(),
      number: 'UNLINKED-INVOICE',
      amountPaid: 0,
      balanceDue: 100,
      customerSnapshot: { id: buyer.id, name: buyer.name },
    };
    delete unlinked.customerId;
    await f.backend.db.collection('documents').insertMany([orphan, unlinked]);
    const names = await f.api(`/ledger?organizationId=${organizationId}&q=${encodeURIComponent(buyer.name)}`);
    assert.equal(names.customers.length, 3, 'Same-name contacts and a missing stable ID remain distinct');
    assert.equal(new Set(names.customers.map((row) => row.id)).size, 3);
    assert.equal(names.customers.find((row) => row.id === buyer.id).outstandingPaise, 6000);
    assert.equal(names.unlinked.invoiceCount, 1);
    assert.equal(names.unlinked.outstandingPaise, 10000);
    assert.equal(names.unlinked.examples[0].id, unlinked.id);
    assert.equal(
      (await f.api(`/ledger/${missingId}?organizationId=${organizationId}`)).customer.missingContact,
      true,
    );
    assert.equal(
      (
        await f.api(
          `/ledger?organizationId=${organizationId}&active=archived&q=${encodeURIComponent(buyer.name)}`,
        )
      ).customers.length,
      2,
    );
    await f.api(`/ledger/__unlinked__?organizationId=${organizationId}`, 'GET', undefined, 404);
  },
);

test(
  'Native ledger uses India void boundaries and enforces customer/org access in API, service and exports',
  settings,
  async (t) => {
    const f = await fixture(t, { authenticated: true });
    const adminCookie = f.cookie();
    const customer = await f.customer('Scoped ledger customer');
    const foreign = await f.customer('Scoped ledger customer', { organizationId: 'shri-sarraf' });
    const foreignInvoice = await f.invoice(foreign.id, { organizationId: 'shri-sarraf' });
    const invoice = await f.invoice(customer.id, {
      issueDate: '2026-10-10',
      dueDate: '2026-10-10',
      items: [{ description: 'Paise boundary', quantity: 1, rate: 1.15, hsn: '', gstRate: 0 }],
    });
    f.setTime('2026-10-10T18:29:59.999Z');
    const paid = await f.pay(invoice, 1.15, '2026-10-10', { finalizeWhenPaid: true });
    f.setTime('2026-10-10T18:30:00.000Z');
    await f.api(`/payments/${paid.payments[0].id}/void`, 'POST', { reason: 'Boundary correction' });
    const before = await f.api(
      `/ledger/${customer.id}?organizationId=${organizationId}&from=2026-10-10&to=2026-10-10`,
    );
    assert.equal(before.businessDate, '2026-10-11');
    assert.equal(before.period.closingBalancePaise, 0);
    assert.equal(before.summary.outstandingPaise, 115);
    assert.equal(before.summary.overduePaise, 115);
    const after = await f.api(
      `/ledger/${customer.id}?organizationId=${organizationId}&from=2026-10-11&to=2026-10-11`,
    );
    assert.equal(after.rows.length, 1);
    assert.equal(after.rows[0].type, 'receipt_void');
    assert.equal(after.rows[0].date, '2026-10-11');
    assert.equal(after.period.openingBalancePaise, 0);
    assert.equal(after.period.closingBalancePaise, 115);

    await f.api(
      '/auth/signup',
      'POST',
      {
        name: 'Ledger Staff',
        email: 'ledger-staff@example.test',
        password: 'SyntheticLedgerStaff123!',
        company: 'Test',
      },
      202,
      '',
    );
    const staffRecord = (await f.api('/auth/users', 'GET', undefined, 200, adminCookie)).find(
      (user) => user.email === 'ledger-staff@example.test',
    );
    await f.api(
      `/auth/users/${staffRecord.id}`,
      'PATCH',
      { role: 'staff', status: 'active', organizationIds: [organizationId] },
      200,
      adminCookie,
    );
    const staff = await f.login('ledger-staff@example.test', 'SyntheticLedgerStaff123!');
    const permitted = await f.api(`/ledger?organizationId=${organizationId}`);
    assert.equal(
      permitted.customers.some((row) => row.id === foreign.id),
      false,
    );
    for (const path of [
      `/ledger?organizationId=shri-sarraf`,
      `/ledger/export?organizationId=shri-sarraf`,
      `/ledger/${foreign.id}?organizationId=shri-sarraf`,
      `/ledger/${foreign.id}/export?organizationId=shri-sarraf`,
    ])
      await f.api(path, 'GET', undefined, 403);
    for (const suffix of ['', '/export'])
      await f.api(`/ledger/${foreign.id}${suffix}?organizationId=${organizationId}`, 'GET', undefined, 404);
    await f.api(`/ledger?organizationId=${organizationId}`, 'GET', undefined, 401, '');
    await assert.rejects(() => f.backend.ledger.list(staff, 'shri-sarraf'), { status: 403 });
    await assert.rejects(() => f.backend.ledger.statement(staff, organizationId, foreign.id), {
      status: 404,
    });
    await assert.rejects(() => f.backend.ledger.exportStatement(staff, 'shri-sarraf', foreign.id), {
      status: 403,
    });
    await assert.rejects(() => f.backend.ledger.list(undefined, organizationId), { status: 401 });
    const allowedStatement = await f.api(`/ledger/${customer.id}?organizationId=${organizationId}`);
    assert.doesNotMatch(JSON.stringify(allowedStatement), new RegExp(foreignInvoice.id));
    for (const query of [
      'from=2026-02-29',
      'from=2026-10-11&to=2026-10-10',
      'page=0',
      'pageSize=101',
      'from=2026-10-10T00%3A00%3A00Z',
    ])
      await f.api(`/ledger/${customer.id}?organizationId=${organizationId}&${query}`, 'GET', undefined, 400);
    for (const query of ['active=deleted', 'balance=%24gt', 'q=a&q=b', 'pageSize=0'])
      await f.api(`/ledger?organizationId=${organizationId}&${query}`, 'GET', undefined, 400);
  },
);

test(
  'Native ledger paginates complete balances/CSV, reads projections and uses a consistent read-only snapshot',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Ledger page 000');
    const invoice = await f.invoice(buyer.id);
    const customers = Array.from({ length: 104 }, (_, index) => ({
      ...buyer,
      id: randomUUID(),
      name: `Ledger page ${String(index + 1).padStart(3, '0')}`,
    }));
    await f.backend.db.collection('customers').insertMany(customers);
    const documents = Array.from({ length: 70 }, (_, index) => ({
      ...structuredClone(invoice),
      id: randomUUID(),
      number: `LEDGER-PAGE-${index}`,
      totals: { total: 1.15 },
      amountPaid: 0,
      balanceDue: 1.15,
      notes: 'PRIVATE_PAGE_LEDGER_CONTENT_' + 'x'.repeat(2000),
    }));
    await f.backend.db.collection('documents').insertMany(documents);
    const coordinationBefore = await f.backend.db
      .collection('transaction_locks')
      .find({})
      .sort({ _id: 1 })
      .toArray();
    const first = await f.api(`/ledger?organizationId=${organizationId}&q=Ledger%20page`);
    assert.equal(first.total, 105);
    assert.equal(first.customers.length, 50);
    assert.equal(first.totals.invoiceCount, 71);
    assert.equal(first.totals.outstandingPaise, 18050);
    const last = await f.api(`/ledger?organizationId=${organizationId}&q=Ledger%20page&page=99999`);
    assert.equal(last.page, 3);
    assert.equal(last.customers.length, 5);
    const csv = await f.api(
      `/ledger/export?organizationId=${organizationId}&q=Ledger%20page&pageSize=1&page=2`,
    );
    assert.equal(
      csv.trim().split('\r\n').length,
      106,
      'Directory CSV includes all matching customers, not the current page',
    );
    const statement = await f.api(`/ledger/${buyer.id}?organizationId=${organizationId}`);
    assert.equal(statement.total, 71);
    assert.equal(statement.rows.length, 50);
    assert.equal(statement.period.closingBalancePaise, 18050);
    const printed = await f.backend.ledger.statement(
      undefined,
      organizationId,
      buyer.id,
      { pageSize: '1', page: '2' },
      { allRows: true },
    );
    assert.equal(printed.rows.length, 71);
    const statementCsv = await f.api(
      `/ledger/${buyer.id}/export?organizationId=${organizationId}&pageSize=1&page=2`,
    );
    assert.equal(statementCsv.split('\r\n').filter((line) => line.includes(',"invoice",')).length, 71);
    assert.doesNotMatch(JSON.stringify(statement), /PRIVATE_PAGE_LEDGER_CONTENT|organizationSnapshot|items/);
    assert.deepEqual(
      await f.backend.db.collection('transaction_locks').find({}).sort({ _id: 1 }).toArray(),
      coordinationBefore,
      'Ledger reads never acquire a workspace or organization write lock',
    );

    const queries = createCustomerLedgerQueries(f.backend.db);
    await queries.read(async (reader) => {
      await reader.organization(organizationId);
      const old = (await reader.invoices(organizationId, buyer.id).toArray()).find(
        (record) => record.id === invoice.id,
      );
      assert.equal(old.amountPaid, 0);
      await f.backend.db
        .collection('documents')
        .updateOne(
          { id: invoice.id },
          { $set: { status: 'partially_paid', amountPaid: 40, balanceDue: 60 } },
        );
      await f.backend.db.collection('payments').insertOne({
        id: randomUUID(),
        requestId: randomUUID(),
        organizationId,
        documentId: invoice.id,
        amount: 40,
        paidOn: '2026-09-05',
        voidedAt: null,
      });
      const sameSnapshot = (await reader.invoices(organizationId, buyer.id).toArray()).find(
        (record) => record.id === invoice.id,
      );
      assert.equal(sameSnapshot.amountPaid, 0);
      assert.deepEqual(await reader.payments(organizationId, [invoice.id]).toArray(), []);
    });
    const refreshed = await f.api(`/ledger/${buyer.id}?organizationId=${organizationId}`);
    assert.equal(refreshed.summary.receivedPaise, 4000);
    assert.equal(refreshed.period.closingBalancePaise, 14050);
  },
);

test(
  'Native ledger rounds legacy receipts like JavaScript without inventing missing settlement history',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Legacy rounding customer');
    const invoice = await f.invoice(buyer.id, {
      items: [{ description: 'Legacy paise', quantity: 1, rate: 1, hsn: '', gstRate: 0 }],
    });
    const receipt = {
      id: randomUUID(),
      organizationId,
      documentId: invoice.id,
      amount: 0.125,
      paidOn: '2026-09-05',
      voidedAt: null,
    };
    await f.backend.db
      .collection('documents')
      .updateOne(
        { id: invoice.id },
        { $set: { amountPaid: 0.13, balanceDue: 0.87, status: 'partially_paid' } },
      );
    await f.backend.db.collection('payments').insertOne(receipt);
    const listed = await f.api(`/ledger?organizationId=${organizationId}&q=Legacy%20rounding`);
    assert.equal(listed.customers[0].receivedPaise, 13);
    assert.equal(listed.customers[0].unreceiptedCreditPaise, 0);
    const statement = await f.api(`/ledger/${buyer.id}?organizationId=${organizationId}`);
    assert.deepEqual(statement.summary, {
      invoiceCount: 1,
      invoicedPaise: 100,
      receivedPaise: 13,
      outstandingPaise: 87,
      overduePaise: 87,
      overdueInvoiceCount: 1,
      unreceiptedCreditPaise: 0,
    });
    assert.equal(statement.history.complete, true);
    assert.equal(statement.history.undatedRowCount, 0);
    assert.equal(statement.period.closingBalancePaise, 87);
    assert.deepEqual(
      statement.rows.map((row) => row.type),
      ['invoice', 'receipt'],
    );
    assert.equal(statement.rows[1].creditPaise, 13);
    assert.equal(statement.rows[1].balancePaise, 87);
    assert.ok(
      statement.history.notices.every(
        (notice) => !['legacy_balance', 'receipt_rounding_difference'].includes(notice.code),
      ),
    );

    await f.backend.db
      .collection('payments')
      .updateOne(
        { id: receipt.id },
        { $set: { voidedAt: '2026-09-10T12:00:00.000Z', voidReason: 'Corrected legacy receipt' } },
      );
    await f.backend.db
      .collection('documents')
      .updateOne({ id: invoice.id }, { $set: { amountPaid: 0, balanceDue: 1, status: 'sent' } });
    const afterVoid = await f.api(`/ledger/${buyer.id}?organizationId=${organizationId}`);
    assert.equal(afterVoid.history.complete, true);
    assert.equal(afterVoid.summary.unreceiptedCreditPaise, 0);
    assert.equal(afterVoid.period.receivedPaise, 13);
    assert.equal(afterVoid.period.voidedPaise, 13);
    assert.equal(afterVoid.period.closingBalancePaise, 100);
    const voidList = await f.api(`/ledger?organizationId=${organizationId}&q=Legacy%20rounding`);
    assert.equal(voidList.customers[0].unreceiptedCreditPaise, 0);

    const ordinary = await f.customer('Ordinary decimal customer');
    const ordinaryInvoice = await f.invoice(ordinary.id, {
      items: [{ description: 'Ordinary paise', quantity: 1, rate: 1.15, hsn: '', gstRate: 0 }],
    });
    await f.pay(ordinaryInvoice, 1.15, '2026-09-05');
    const ordinaryStatement = await f.api(`/ledger/${ordinary.id}?organizationId=${organizationId}`);
    assert.equal(ordinaryStatement.summary.receivedPaise, 115);
    assert.equal(ordinaryStatement.summary.unreceiptedCreditPaise, 0);
    assert.equal(ordinaryStatement.period.closingBalancePaise, 0);
    assert.equal(ordinaryStatement.history.complete, true);

    // A safe large odd integer must not increase merely because an aggregation
    // adds 0.5 to an already integral paise value before applying $floor.
    const largeAmount = 45035996273704.97;
    const largePaise = Math.round(largeAmount * 100);
    assert.equal(largePaise, 4503599627370497);
    await f.backend.db
      .collection('documents')
      .updateOne(
        { id: invoice.id },
        { $set: { 'totals.total': largeAmount, amountPaid: largeAmount, balanceDue: 0, status: 'paid' } },
      );
    await f.backend.db
      .collection('payments')
      .updateOne({ id: receipt.id }, { $set: { amount: largeAmount, voidedAt: null } });
    const largeList = await f.api(`/ledger?organizationId=${organizationId}&q=Legacy%20rounding`);
    assert.equal(largeList.customers[0].receivedPaise, largePaise);
    assert.equal(largeList.customers[0].unreceiptedCreditPaise, 0);
    const largeStatement = await f.api(`/ledger/${buyer.id}?organizationId=${organizationId}`);
    assert.equal(largeStatement.history.complete, true);
    assert.equal(largeStatement.period.closingBalancePaise, 0);
  },
);

test(
  'Native ledger rejects invalid and unsafe receipt amounts consistently in lists and statements',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Invalid receipt review');
    const invoice = await f.invoice(buyer.id);
    const receiptId = randomUUID();
    await f.backend.db.collection('payments').insertOne({
      id: receiptId,
      organizationId,
      documentId: invoice.id,
      amount: 0.13,
      paidOn: '2026-09-05',
      voidedAt: null,
    });
    for (const [label, amount, voidedAt] of [
      ['non-numeric', '0.13', null],
      ['not a number', NaN, null],
      ['infinite', Infinity, null],
      ['unsafe paise', 100000000000000, null],
      ['negative', -1, null],
      ['invalid voided', Infinity, '2026-09-10T12:00:00.000Z'],
    ]) {
      await f.backend.db.collection('payments').updateOne({ id: receiptId }, { $set: { amount, voidedAt } });
      await assert.rejects(
        f.backend.ledger.list(undefined, organizationId),
        { status: 409, code: 'LEDGER_DATA_INVALID' },
        label,
      );
      await assert.rejects(
        f.backend.ledger.statement(undefined, organizationId, buyer.id),
        { status: 409, code: 'LEDGER_DATA_INVALID' },
        label,
      );
    }
    const individuallySafe = Number.MAX_SAFE_INTEGER / 100;
    assert.ok(Number.isSafeInteger(Math.round(individuallySafe * 100)));
    await f.backend.db
      .collection('payments')
      .updateOne({ id: receiptId }, { $set: { amount: individuallySafe, voidedAt: null } });
    await f.backend.db.collection('payments').insertOne({
      id: randomUUID(),
      requestId: randomUUID(),
      organizationId,
      documentId: invoice.id,
      amount: individuallySafe,
      paidOn: '2026-09-05',
      voidedAt: null,
    });
    await assert.rejects(f.backend.ledger.list(undefined, organizationId), { code: 'LEDGER_DATA_INVALID' });
    await assert.rejects(f.backend.ledger.statement(undefined, organizationId, buyer.id), {
      code: 'LEDGER_DATA_INVALID',
    });
  },
);

test(
  'Native legacy receipt writes keep exact paise through overpayment rejection, replay and void',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Legacy receipt write regression');
    const invoice = await f.invoice(buyer.id, {
      items: [{ description: 'One rupee', quantity: 1, rate: 1, hsn: '', gstRate: 0 }],
    });
    const initial = await f.pay(invoice, 0.13, '2026-09-05');
    const legacy = initial.payments[0];
    await f.backend.db.collection('payments').updateOne({ id: legacy.id }, { $set: { amount: 0.125 } });
    const statementPath = `/ledger/${buyer.id}?organizationId=${organizationId}`;
    const before = await f.api(statementPath);
    assert.equal(before.history.complete, true);
    assert.equal(before.period.closingBalancePaise, 87);

    const paymentPath = `/documents/${invoice.id}/payments`;
    const remaining = {
      amount: 0.87,
      paidOn: '2026-09-06',
      method: 'bank_transfer',
      reference: 'Remaining legacy balance',
      notes: '',
      requestId: randomUUID(),
      finalizeWhenPaid: true,
    };
    await f.api(paymentPath, 'POST', { ...remaining, amount: 0.88 }, 409);
    let details = await f.api(paymentPath);
    assert.equal(details.payments.length, 1);
    assert.equal(details.document.version, initial.document.version);
    assert.equal(details.document.amountPaid, 0.13);
    assert.equal(details.document.balanceDue, 0.87);

    details = await f.api(paymentPath, 'POST', remaining, 201);
    assert.equal(details.document.amountPaid, 1);
    assert.equal(details.document.balanceDue, 0);
    assert.equal(details.document.status, 'paid');
    assert.ok(details.document.finalizedAt);
    const receipt = details.payments.find((row) => row.requestId === remaining.requestId);
    const replay = await f.api(paymentPath, 'POST', remaining);
    assert.equal(replay.payments.length, 2);
    assert.equal(replay.document.version, details.document.version);
    assert.equal(replay.payments.find((row) => row.requestId === remaining.requestId).id, receipt.id);
    const settled = await f.api(statementPath);
    assert.equal(settled.summary.receivedPaise, 100);
    assert.equal(settled.summary.unreceiptedCreditPaise, 0);
    assert.equal(settled.history.complete, true);
    assert.equal(settled.history.undatedRowCount, 0);
    assert.equal(settled.period.closingBalancePaise, 0);

    const reason = { reason: 'Correct the later receipt' };
    details = await f.api(`/payments/${receipt.id}/void`, 'POST', reason);
    assert.equal(details.document.amountPaid, 0.13);
    assert.equal(details.document.balanceDue, 0.87);
    assert.equal(details.document.status, 'partially_paid');
    assert.equal(details.document.finalizedAt, null);
    const repeatedVoid = await f.api(`/payments/${receipt.id}/void`, 'POST', reason);
    assert.equal(repeatedVoid.document.version, details.document.version);
    assert.equal(repeatedVoid.events.length, details.events.length);
    const reopened = await f.api(statementPath);
    assert.equal(reopened.history.complete, true);
    assert.equal(reopened.period.receivedPaise, 100);
    assert.equal(reopened.period.voidedPaise, 87);
    assert.equal(reopened.period.closingBalancePaise, 87);

    details = await f.api(`/payments/${legacy.id}/void`, 'POST', { reason: 'Correct the legacy receipt' });
    assert.equal(details.document.amountPaid, 0);
    assert.equal(details.document.balanceDue, 1);
    assert.equal(details.document.status, 'sent');
    const voidedReplay = await f.api(paymentPath, 'POST', remaining);
    assert.equal(voidedReplay.document.version, details.document.version);
    assert.equal(voidedReplay.payments.length, 2);
    assert.equal(voidedReplay.document.amountPaid, 0);
    const corrected = await f.api(statementPath);
    assert.equal(corrected.history.complete, true);
    assert.equal(corrected.summary.unreceiptedCreditPaise, 0);
    assert.equal(corrected.period.voidedPaise, 100);
    assert.equal(corrected.period.closingBalancePaise, 100);
  },
);

test(
  'Native payment totals reject invalid active receipts while numeric void corrections can proceed',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Invalid active payment totals');
    const invoice = await f.invoice(buyer.id);
    const initial = await f.pay(invoice, 0.1, '2026-09-05');
    const invalid = { ...initial.payments[0], id: randomUUID(), requestId: randomUUID() };
    await f.backend.db.collection('payments').insertOne(invalid);
    const paymentPath = `/documents/${invoice.id}/payments`;
    for (const [label, amount] of [
      ['nonnumeric', '0.13'],
      ['NaN', NaN],
      ['infinite', Infinity],
      ['negative infinity', -Infinity],
      ['negative', -1],
      ['unsafe amount', 100000000000000],
      ['unsafe combined total', Number.MAX_SAFE_INTEGER / 100],
    ]) {
      await f.backend.db
        .collection('payments')
        .updateOne({ id: invalid.id }, { $set: { amount, voidedAt: null, voidReason: '' } });
      const before = await f.api(paymentPath);
      const rejected = await f.api(
        paymentPath,
        'POST',
        {
          amount: 1,
          paidOn: '2026-09-06',
          method: 'bank_transfer',
          reference: label,
          notes: '',
          requestId: randomUUID(),
          finalizeWhenPaid: false,
        },
        409,
      );
      assert.equal(rejected.code, 'PAYMENT_DATA_INVALID', label);
      const unchanged = await f.api(paymentPath);
      assert.equal(unchanged.document.version, before.document.version, label);
      assert.equal(unchanged.events.length, before.events.length, label);
      assert.equal(unchanged.payments.length, 2, label);

      // Numeric historical errors can still be voided. They are excluded before
      // recomputing the active total, so correction does not deadlock on validation.
      if (typeof amount === 'number') {
        const corrected = await f.api(`/payments/${invalid.id}/void`, 'POST', {
          reason: `Correct saved ${label}`,
        });
        assert.equal(corrected.document.amountPaid, 0.1, label);
        assert.equal(corrected.document.balanceDue, 99.9, label);
        assert.deepEqual(await f.backend.db.models.payments.activeTotal(invoice.id), { paid: 10 }, label);
      }
    }
    const largeAmount = 45035996273704.97;
    await f.backend.db
      .collection('payments')
      .updateOne({ id: invalid.id }, { $set: { amount: largeAmount, voidedAt: null, voidReason: '' } });
    assert.deepEqual(await f.backend.db.models.payments.activeTotal(invoice.id), {
      paid: Math.round(largeAmount * 100) + 10,
    });
  },
);

test('Native overdue queries preserve large safe integer-paise installment balances', settings, async (t) => {
  const f = await fixture(t);
  const buyer = await f.customer('Large paise overdue boundary');
  const invoice = await f.invoice(buyer.id);
  const paid = 45035996273704.97;
  const firstDue = 45035996273704.98;
  assert.equal(Math.round(firstDue * 100) - Math.round(paid * 100), 1);
  await f.backend.db.collection('documents').updateOne(
    { id: invoice.id },
    {
      $set: {
        'totals.total': firstDue + 1,
        amountPaid: paid,
        balanceDue: 1.01,
        status: 'partially_paid',
        installmentPlan: {
          installments: [
            { id: 'past', label: 'Past installment', dueDate: '2026-09-15', amount: firstDue },
            { id: 'future', label: 'Future installment', dueDate: '2026-12-15', amount: 1 },
          ],
        },
      },
    },
  );
  const saved = await f.backend.db.models.documents.findById(invoice.id);
  assert.equal(documentStatus(saved, '2026-10-10'), 'overdue');
  const queries = createWorkspaceQueries(f.backend.db);
  const filters = { page: 1, pageSize: 50, status: 'overdue', search: '', product: '' };
  const page = await queries.documentPage(organizationId, 'invoice', filters, '2026-10-10');
  assert.equal(page.total, 1);
  assert.deepEqual(
    page.documents.map((document) => document.id),
    [invoice.id],
  );
  const exported = await queries.documentExport(organizationId, 'invoice', filters, '2026-10-10').toArray();
  assert.deepEqual(
    exported.map((document) => document.id),
    [invoice.id],
  );
});

test(
  'Native statements read each receipt once in a shared read-only snapshot and inactive invoices skip summary joins',
  settings,
  async (t) => {
    const f = await fixture(t);
    const buyer = await f.customer('Statement query review');
    const invoice = await f.invoice(buyer.id);
    await f.pay(invoice, 40, '2026-09-05');
    const draft = await f.invoice(buyer.id, { status: 'draft' });
    await f.backend.db.collection('payments').insertOne({
      id: randomUUID(),
      organizationId,
      documentId: draft.id,
      amount: 2,
      paidOn: '2026-09-06',
      voidedAt: null,
    });
    const reads = [];
    const collection = f.backend.db.collection;
    f.backend.db.collection = (name) => {
      const result = collection(name);
      if (['documents', 'payments', 'document_events'].includes(name)) {
        for (const operation of ['find', 'aggregate']) {
          const original = result[operation].bind(result);
          result[operation] = (query, options) => {
            reads.push({ name, operation, query, session: options?.session });
            return original(query, options);
          };
        }
      }
      return result;
    };
    try {
      const statement = await f.backend.ledger.statement(undefined, organizationId, buyer.id);
      assert.equal(statement.summary.receivedPaise, 4000);
      assert.equal(statement.period.closingBalancePaise, 6000);
      assert.equal(statement.excludedDocuments.find((row) => row.id === draft.id).receiptCount, 1);
      assert.equal(
        reads.filter((read) => read.name === 'documents' && read.operation === 'aggregate').length,
        0,
      );
      assert.equal(reads.filter((read) => read.name === 'documents' && read.operation === 'find').length, 1);
      assert.equal(reads.filter((read) => read.name === 'payments' && read.operation === 'find').length, 1);
      assert.ok(reads[0].session);
      assert.ok(reads.every((read) => read.session === reads[0].session));
    } finally {
      f.backend.db.collection = collection;
    }
    const queries = createCustomerLedgerQueries(f.backend.db);
    await queries.read(async (reader) => {
      const documents = await reader.invoices(organizationId, buyer.id).toArray();
      assert.equal(documents.find((row) => row.id === invoice.id).receiptSummary[0].activePaise, 4000);
      assert.deepEqual(documents.find((row) => row.id === draft.id).receiptSummary, []);
    });
  },
);
