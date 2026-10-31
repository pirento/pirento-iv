/** Integration tests: admin-created logins, the Accounts access level and Group finance with its downloads. */

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { attachPageRoutes } from '../../src/routes/pages.js';
import { createFixture, integrationEnabled } from './fixture.js';

const options = {
  skip: !integrationEnabled && 'Set MONGODB_TEST_URI to run against a test replica set.',
  timeout: 180_000,
};
const owner = { email: 'finance-owner@example.test', password: 'FinanceOwnerPassword2026!' };

// Entries of a ZIP buffer by name (central directory), inflated.
function unzip(buffer) {
  let end = buffer.length - 22;
  while (buffer.readUInt32LE(end) !== 0x06054b50) end--;
  const files = new Map();
  for (let i = 0, offset = buffer.readUInt32LE(end + 16); i < buffer.readUInt16LE(end + 10); i++) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = buffer.readUInt32LE(offset + 42);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buffer.subarray(start, start + buffer.readUInt32LE(offset + 20))));
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return files;
}

test(
  'admins create logins; Accounts logins see Group finance and download it, read-only',
  options,
  async (t) => {
    const { base, backend } = await createFixture(t, {
      now: () => new Date('2026-10-31T06:00:00Z'),
      environment: { INITIAL_ADMIN_EMAIL: owner.email, INITIAL_ADMIN_PASSWORD: owner.password },
    });
    attachPageRoutes(backend);
    const call = async (path, { method = 'GET', body, cookie = '', status = 200 } = {}) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? cookie };
    };
    const admin = (await call('/auth/login', { method: 'POST', body: owner })).cookie;
    const accounts = {
      name: 'Group Accountant',
      email: 'accounts@example.test',
      password: 'AccountsLogin2026!',
      role: 'staff',
      organizationIds: ['at-elevators', 'pipeline2-legal'],
      permission: 'accounts',
    };
    const created = await call('/auth/users', { method: 'POST', body: accounts, cookie: admin, status: 201 });
    assert.deepEqual(
      [created.data.status, created.data.permission, created.data.organizationIds],
      ['active', 'accounts', ['at-elevators', 'pipeline2-legal']],
    );
    await call('/auth/users', { method: 'POST', body: accounts, cookie: admin, status: 409 });
    await call('/auth/users', {
      method: 'POST',
      body: { ...accounts, email: 'x@example.test', organizationIds: [] },
      cookie: admin,
      status: 400,
    });
    const substaff = await call('/auth/users', {
      method: 'POST',
      body: {
        ...accounts,
        name: 'Sub staff',
        email: 'substaff@example.test',
        permission: 'no-delete',
        organizationIds: ['at-elevators'],
      },
      cookie: admin,
      status: 201,
    });
    assert.equal(substaff.data.permission, 'no-delete');

    // Business data: one invoice with a bank-transfer receipt and one paid expense.
    const organizationId = 'at-elevators';
    const organization = await backend.db.models.organizations.findById(organizationId);
    await backend.db.models.organizations.save({
      ...organization,
      gstin: '09AAJCV6240P1ZL',
      stateCode: '09',
    });
    const buyer = (
      await call('/customers', {
        method: 'POST',
        cookie: admin,
        status: 201,
        body: {
          organizationId,
          name: 'SPARK DEVELOPERS',
          email: '',
          phone: '',
          gstin: '09ADAFS7767B1ZW',
          address: 'Lucknow',
          stateCode: '09',
          contactPerson: '',
        },
      })
    ).data;
    const invoice = (
      await call('/documents', {
        method: 'POST',
        cookie: admin,
        status: 201,
        body: {
          organizationId,
          customerId: buyer.id,
          kind: 'invoice',
          status: 'sent',
          issueDate: '2026-10-15',
          dueDate: '2026-10-15',
          title: 'Lift repair',
          items: [
            {
              description: 'Lift repair and commissioning',
              hsn: '998718',
              quantity: 1,
              rate: 90000,
              gstRate: 18,
            },
          ],
          discountPercent: 0,
          placeOfSupply: '09',
          notes: '',
          terms: '',
        },
      })
    ).data;
    await call(`/documents/${invoice.id}/payments`, {
      method: 'POST',
      cookie: admin,
      status: 201,
      body: {
        amount: 63000,
        paidOn: '2026-10-15',
        method: 'bank_transfer',
        reference: 'HDFC XX4507',
        notes: '1st payment',
        requestId: 'first-payment',
        finalizeWhenPaid: false,
      },
    });
    await call('/expenses', {
      method: 'POST',
      cookie: admin,
      status: 201,
      body: {
        organizationId,
        vendorName: 'Landlord',
        billDate: '2026-10-01',
        category: 'Rent',
        taxable: 10000,
        gstRate: 18,
        paidOn: '2026-10-02',
        paymentMethod: 'bank_transfer',
      },
    });

    const accountant = (
      await call('/auth/login', {
        method: 'POST',
        body: { email: accounts.email, password: accounts.password },
      })
    ).cookie;
    await call('/customers', {
      method: 'POST',
      cookie: accountant,
      status: 403,
      body: {
        organizationId,
        name: 'Nope',
        email: '',
        phone: '',
        gstin: '',
        address: '',
        stateCode: '09',
        contactPerson: '',
      },
    });
    const page = await fetch(`${base}/workspace/${organizationId}/finance?year=2026`, {
      headers: { Cookie: accountant },
    });
    assert.equal(page.status, 200);
    const html = (await page.text()).replace(/\s+/g, ' ');
    assert.match(html, /Group finance/);
    assert.match(html, /2 business\(es\)/, 'only the businesses assigned to the login');
    assert.match(html, />A T Elevator<\/a>.*?₹90,000\.00.*?₹16,200\.00.*?₹63,000\.00/);
    const substaffLogin = (
      await call('/auth/login', {
        method: 'POST',
        body: { email: 'substaff@example.test', password: accounts.password },
      })
    ).cookie;
    const blocked = await fetch(`${base}/workspace/${organizationId}/finance`, {
      headers: { Cookie: substaffLogin },
    });
    assert.equal(blocked.status, 403, 'other staff do not see Group finance');

    const download = async (format, extra = '') => {
      const response = await fetch(
        `${base}/workspace/${organizationId}/finance?year=2026&download=${format}${extra}`,
        {
          headers: { Cookie: accountant },
        },
      );
      assert.equal(response.status, 200);
      return {
        type: response.headers.get('content-type'),
        name: response.headers.get('content-disposition'),
        body: Buffer.from(await response.arrayBuffer()),
      };
    };
    const excel = await download('xlsx');
    assert.match(excel.type, /spreadsheetml/);
    assert.match(excel.name, /Group-finance-FY202627\.xlsx/);
    const sheets = unzip(excel.body);
    assert.match(
      sheets.get('xl/workbook.xml').toString(),
      /name="Summary".*name="Invoices".*name="Payment Ledger".*name="Expenses".*name="GSTR-1 B2B"/,
    );
    const ledger = sheets.get('xl/worksheets/sheet3.xml').toString();
    for (const value of [
      '15-10-2026',
      'SPARK DEVELOPERS',
      '09ADAFS7767B1ZW',
      'Bank transfer',
      'HDFC XX4507',
      '<v>63000</v>',
      '<v>53389.83</v>',
      '<v>4805.09</v>',
      '<v>4805.08</v>',
    ])
      assert.ok(ledger.includes(value), `Payment Ledger has ${value}`);
    const pdf = await download('pdf', `&business=${organizationId}`);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.name, /A-T-Elevator-finance-FY202627\.pdf/);
    const bundle = unzip((await download('zip', `&business=${organizationId}`)).body);
    assert.ok([...bundle.keys()].some((name) => name.startsWith('A-T-Elevator/') && name.endsWith('.pdf')));
    assert.ok(bundle.has('A-T-Elevator-finance-FY202627.xlsx'));
    const other = await fetch(
      `${base}/workspace/${organizationId}/finance?download=xlsx&business=shri-sarraf`,
      { headers: { Cookie: accountant } },
    );
    assert.equal(other.status, 404, 'a business outside the login is not downloadable');
  },
);
