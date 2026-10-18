/**
 * Reports page for one business and financial year (April to March): monthly sales, money received,
 * expenses and profit, the top customers, and how long unpaid invoices have been due (installments
 * count separately). Sums are done in whole paise.
 */

import { balanceDue, installmentBalances } from '../../../shared/types.js';

const paise = (rupees) => Math.round((rupees ?? 0) * 100);
const rupees = (value) => value / 100;
const MONTH_NAMES = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
export const AGING_BUCKETS = ['Not due yet', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'];

/** ?year=2026 means FY 2026-27; the default is the financial year of the business date. */
export function readReportYear(query = {}, businessDate) {
  const year = Number(query.year);
  if (/^\d{4}$/.test(String(query.year ?? '')) && year >= 2000 && year <= 2100) return year;
  const [current, month] = businessDate.split('-').map(Number);
  return month >= 4 ? current : current - 1;
}

/** { from, to } dates of a financial year: 1 April to 1 April of the next year (exclusive). */
export const financialYearRange = (year) => ({ from: `${year}-04-01`, to: `${year + 1}-04-01` });

const bucketOf = (dueDate, asOf) => {
  const days = Math.round((Date.parse(asOf) - Date.parse(dueDate)) / 86_400_000);
  return days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
};

/**
 * invoices: issued (not draft or cancelled) invoices of the year; payments: non-voided receipts of the year
 * (credit notes left out); creditNotes: issued credit notes of the year, taken off sales in their month;
 * expenses: expenses of the year; openInvoices: every invoice still owed (sent or partially paid).
 */
export function buildReport({ year, asOf, invoices, payments, creditNotes = [], expenses, openInvoices }) {
  const months = MONTH_NAMES.map((name, index) => ({
    key: `${index < 9 ? year : year + 1}-${String(((index + 3) % 12) + 1).padStart(2, '0')}`,
    label: `${name} ${index < 9 ? year : year + 1}`,
    sales: 0,
    salesWithGst: 0,
    received: 0,
    expenses: 0,
  }));
  const add = (date, field, amount) => {
    const month = months.find((row) => date?.startsWith(row.key));
    if (month) month[field] += paise(amount);
  };
  const customers = new Map();
  for (const invoice of invoices) {
    add(invoice.issueDate, 'sales', invoice.totals.taxable);
    add(invoice.issueDate, 'salesWithGst', invoice.totals.total);
    const key = invoice.customerId || invoice.customerSnapshot?.name || '';
    const row = customers.get(key) ?? {
      name: invoice.customerSnapshot?.name || 'Unknown',
      count: 0,
      total: 0,
    };
    row.count += 1;
    row.total += paise(invoice.totals.total);
    customers.set(key, row);
  }
  for (const note of creditNotes) {
    add(note.noteDate, 'sales', -note.taxable);
    add(note.noteDate, 'salesWithGst', -note.total);
    const row = customers.get(note.customerId);
    if (row) row.total -= paise(note.total);
  }
  for (const payment of payments) add(payment.paidOn, 'received', payment.amount);
  for (const expense of expenses) add(expense.billDate, 'expenses', expense.taxable);

  const aging = AGING_BUCKETS.map((label) => ({ label, count: 0, amount: 0 }));
  for (const invoice of openInvoices) {
    const dues = invoice.installmentPlan?.installments?.length
      ? installmentBalances(invoice, asOf)
      : [{ dueDate: invoice.dueDate, balanceDue: balanceDue(invoice) }];
    for (const due of dues) {
      if (due.balanceDue <= 0) continue;
      const bucket = aging[bucketOf(due.dueDate, asOf)];
      bucket.count += 1;
      bucket.amount += paise(due.balanceDue);
    }
  }

  const total = (field) => months.reduce((sum, month) => sum + month[field], 0);
  const sales = total('sales');
  const spent = total('expenses');
  return {
    year,
    label: `FY ${year}-${String(year + 1).slice(2)}`,
    months: months.map((month) => ({
      ...month,
      sales: rupees(month.sales),
      salesWithGst: rupees(month.salesWithGst),
      received: rupees(month.received),
      expenses: rupees(month.expenses),
      profit: rupees(month.sales - month.expenses),
    })),
    totals: {
      sales: rupees(sales),
      salesWithGst: rupees(total('salesWithGst')),
      received: rupees(total('received')),
      expenses: rupees(spent),
      profit: rupees(sales - spent),
    },
    topCustomers: [...customers.values()]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((row) => ({ ...row, total: rupees(row.total) })),
    aging: aging.map((row) => ({ ...row, amount: rupees(row.amount) })),
    outstanding: rupees(aging.reduce((sum, row) => sum + row.amount, 0)),
  };
}
