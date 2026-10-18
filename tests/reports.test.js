/** Unit tests: the Reports page figures (src/services/pages/reports.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, financialYearRange, readReportYear } from '../src/services/pages/reports.js';

test('the financial year runs April to March and defaults to the year of the business date', () => {
  assert.equal(readReportYear({}, '2026-03-31'), 2025);
  assert.equal(readReportYear({}, '2026-04-01'), 2026);
  assert.equal(readReportYear({ year: '2024' }, '2026-10-17'), 2024);
  assert.equal(readReportYear({ year: '24' }, '2026-10-17'), 2026);
  assert.deepEqual(financialYearRange(2026), { from: '2026-04-01', to: '2027-04-01' });
});

test('monthly sales, receipts, expenses and profit add up in paise; customers rank by billed total', () => {
  const invoice = (customerId, name, issueDate, taxable, total) => ({
    customerId,
    customerSnapshot: { name },
    issueDate,
    totals: { taxable, total },
  });
  const report = buildReport({
    year: 2026,
    asOf: '2026-10-17',
    invoices: [
      invoice('a', 'Asha', '2026-04-02', 0.1, 0.12),
      invoice('a', 'Asha', '2026-04-30', 0.2, 0.24),
      invoice('b', 'Bala', '2027-03-31', 1000, 1180),
    ],
    payments: [{ paidOn: '2026-04-15', amount: 0.36 }],
    creditNotes: [
      { customerId: 'b', noteDate: '2027-03-31', taxable: 100, total: 118 },
      // Dated last year, refunded this year: only the refund counts.
      {
        customerId: 'a',
        noteDate: '2026-03-20',
        taxable: 10,
        total: 11.8,
        refundDue: 0.3,
        refund: { paidOn: '2026-04-20' },
      },
    ],
    expenses: [{ billDate: '2027-03-01', taxable: 400 }],
    openInvoices: [],
  });
  assert.equal(report.label, 'FY 2026-27');
  assert.deepEqual(
    report.months.map((month) => month.key),
    [
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
    ],
  );
  assert.deepEqual(report.months[0], {
    key: '2026-04',
    label: 'Apr 2026',
    sales: 0.3,
    salesWithGst: 0.36,
    received: 0.06,
    expenses: 0,
    profit: 0.3,
  });
  assert.equal(report.months[11].profit, 500, 'the credit note comes off March sales');
  assert.deepEqual(report.totals, {
    sales: 900.3,
    salesWithGst: 1062.36,
    received: 0.06,
    expenses: 400,
    profit: 500.3,
  });
  assert.deepEqual(
    report.topCustomers.map((row) => [row.name, row.count, row.total]),
    [
      ['Bala', 1, 1062],
      ['Asha', 2, 0.36],
    ],
  );
});

test('unpaid amounts are aged from each due date, and each installment from its own', () => {
  const report = buildReport({
    year: 2026,
    asOf: '2026-10-17',
    invoices: [],
    payments: [],
    expenses: [],
    openInvoices: [
      {
        kind: 'invoice',
        status: 'sent',
        dueDate: '2026-10-17',
        totals: { total: 100 },
        amountPaid: 0,
        balanceDue: 100,
      },
      {
        kind: 'invoice',
        status: 'sent',
        dueDate: '2026-09-17',
        totals: { total: 50 },
        amountPaid: 0,
        balanceDue: 50,
      },
      {
        kind: 'invoice',
        status: 'sent',
        dueDate: '2026-01-01',
        totals: { total: 10 },
        amountPaid: 0,
        balanceDue: 10,
      },
      {
        kind: 'invoice',
        status: 'partially_paid',
        dueDate: '2026-12-01',
        totals: { total: 300 },
        amountPaid: 150,
        balanceDue: 150,
        installmentPlan: {
          installments: [
            { id: 'one', dueDate: '2026-08-01', amount: 100 },
            { id: 'two', dueDate: '2026-09-01', amount: 100 },
            { id: 'three', dueDate: '2026-12-01', amount: 100 },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    report.aging.map((row) => [row.label, row.count, row.amount]),
    [
      ['Not due yet', 2, 200],
      ['1–30 days', 1, 50],
      ['31–60 days', 1, 50],
      ['61–90 days', 0, 0],
      ['Over 90 days', 1, 10],
    ],
  );
  assert.equal(report.outstanding, 310);
});
