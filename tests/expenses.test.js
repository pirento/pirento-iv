/** Unit tests: expense GST split, monthly totals and the CSV export (src/services/expenses/expenses.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expenseAmounts,
  expenseCsv,
  expenseTotals,
  readExpenseMonth,
} from '../src/services/expenses/expenses.js';

test('GST splits into CGST + SGST in the same state and IGST across states, with exact rounding', () => {
  assert.deepEqual(expenseAmounts({ taxable: 1000, gstRate: 18, interstate: false }), {
    taxable: 1000,
    cgst: 90,
    sgst: 90,
    igst: 0,
    tax: 180,
    total: 1180,
  });
  assert.deepEqual(expenseAmounts({ taxable: 1000, gstRate: 18, interstate: true }), {
    taxable: 1000,
    cgst: 0,
    sgst: 0,
    igst: 180,
    tax: 180,
    total: 1180,
  });
  // 0.1 x 5% = 0.005 rounds half-up to 0.01; the half-paise tie goes to CGST and SGST is the remainder.
  const odd = expenseAmounts({ taxable: 0.1, gstRate: 5, interstate: false });
  assert.deepEqual([odd.tax, odd.cgst, odd.sgst, odd.total], [0.01, 0.01, 0, 0.11]);
});

test('month comes from ?month=YYYY-MM or the business date; totals and CSV add up exactly', () => {
  assert.equal(readExpenseMonth({ month: '2026-09' }, '2026-10-17'), '2026-09');
  assert.equal(readExpenseMonth({ month: '2026-13' }, '2026-10-17'), '2026-10');
  assert.equal(readExpenseMonth({}, '2026-10-17'), '2026-10');
  const expenses = [
    {
      billDate: '2026-10-02',
      vendorName: 'A',
      category: 'Rent',
      gstRate: 18,
      ...expenseAmounts({ taxable: 0.1, gstRate: 18 }),
    },
    {
      billDate: '2026-10-03',
      vendorName: 'B, "Ltd"',
      category: 'Rent',
      gstRate: 18,
      ...expenseAmounts({ taxable: 0.2, gstRate: 18 }),
    },
  ];
  assert.deepEqual(expenseTotals(expenses), { count: 2, taxable: 0.3, tax: 0.06, total: 0.36 });
  const csv = expenseCsv(expenses);
  assert.ok(csv[0].startsWith('﻿"Bill date"'));
  assert.equal(csv.length, 3);
  assert.match(csv[2], /"B, ""Ltd"""/);
  assert.match(csv[1], /"0\.10","18","0\.01","0\.01","0\.00","0\.12",""\r\n$/);
});
