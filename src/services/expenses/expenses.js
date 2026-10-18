/**
 * Expenses and purchase bills for one business: monthly lists, totals and CSV export. The GST split
 * (input tax credit) is gstAmounts() in shared/types.js, so the browser preview matches.
 * Amounts are rupees with exact decimal rounding, like documents.
 */

import { decimal } from '../../../shared/decimal.js';
import { csvRow } from '../ledger/ledger-values.js';

const round = (value) => decimal(value).round().toNumber();

/** ?month=YYYY-MM (default: the current month). */
export function readExpenseMonth(query = {}, businessDate) {
  return typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)
    ? query.month
    : businessDate.slice(0, 7);
}

/** Sum of taxable, GST and total for a list of expenses. */
export function expenseTotals(expenses) {
  const sum = (key) => round(expenses.reduce((total, expense) => total.plus(expense[key] ?? 0), decimal(0)));
  return { count: expenses.length, taxable: sum('taxable'), tax: sum('tax'), total: sum('total') };
}

const CSV_COLUMNS = [
  'Bill date',
  'Bill number',
  'Vendor',
  'Vendor GSTIN',
  'Category',
  'Description',
  'Taxable (INR)',
  'GST rate %',
  'CGST (INR)',
  'SGST (INR)',
  'IGST (INR)',
  'Total (INR)',
  'Paid on',
];

/** CSV lines for a list of expenses. */
export function expenseCsv(expenses) {
  return [
    '﻿' + csvRow(CSV_COLUMNS),
    ...expenses.map((expense) =>
      csvRow([
        expense.billDate,
        expense.billNumber,
        expense.vendorName,
        expense.vendorGstin,
        expense.category,
        expense.description,
        expense.taxable.toFixed(2),
        expense.gstRate,
        expense.cgst.toFixed(2),
        expense.sgst.toFixed(2),
        expense.igst.toFixed(2),
        expense.total.toFixed(2),
        expense.paidOn,
      ]),
    ),
  ];
}
