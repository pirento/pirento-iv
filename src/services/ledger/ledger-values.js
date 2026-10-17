/** Small ledger helpers: query filter validation, paise arithmetic, totals, links and CSV rows. */

import { HttpError } from '../../middleware/errors.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';

// Notice shown on every statement explaining that it uses each invoice's current status.
export const CURRENT_STATUS_NOTICE = {
  code: 'current_invoice_status',
  message:
    'This statement uses current invoice status and saved issue/receipt dates. Issue and cancellation transitions are not fully dated in the existing history, so it is not a historical as-of account. Cancelled invoices and drafts are excluded from receivables.',
};

/** True for a real calendar date YYYY-MM-DD between 2000-01-01 and 2199-12-31. */
export function validLedgerDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < '2000-01-01' ||
    value > '2199-12-31'
  )
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Require an actual instant for a void/provider timestamp; never assume a local timezone. */
export function ledgerTimestampDate(value) {
  if (!(value instanceof Date)) {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value,
      ) ||
      !validLedgerDate(value.slice(0, 10))
    )
      return null;
  }
  try {
    const result = indiaBusinessDate(value);
    return validLedgerDate(result) ? result : null;
  } catch {
    return null;
  }
}

/** Validates a business/customer ID from the URL (400 when empty, too long or containing control characters). */
export function ledgerIdentifier(value) {
  // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
    throw new HttpError(400, 'Choose a valid organization and customer.');
  return value;
}
// Same check as ledgerIdentifier, but returns null instead of throwing.
export const linkedCustomerId = (value) =>
  // eslint-disable-next-line no-control-regex -- rejects control characters on purpose
  typeof value === 'string' && value.trim() && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;

function text(query, name, fallback = '') {
  const value = query[name] ?? fallback;
  if (typeof value !== 'string' || value.length > 200)
    throw new HttpError(400, 'The ledger filters are invalid.');
  return value;
}
function pagination(query) {
  const page = text(query, 'page', '1');
  const pageSize = text(query, 'pageSize', '50');
  if (!/^[1-9]\d{0,6}$/.test(page) || !/^[1-9]\d{0,2}$/.test(pageSize) || Number(pageSize) > 100)
    throw new HttpError(400, 'Choose a positive page and a page size between 1 and 100.');
  return { page: Number(page), pageSize: Number(pageSize) };
}
/** Validates balance list filters: q, active (all/active/archived), balance (all/outstanding/overdue), page. */
export function readLedgerListFilters(query = {}) {
  const active = text(query, 'active', 'all');
  const balance = text(query, 'balance', 'all');
  if (!['all', 'active', 'archived'].includes(active) || !['all', 'outstanding', 'overdue'].includes(balance))
    throw new HttpError(400, 'The ledger filters are invalid.');
  return { q: text(query, 'q').trim(), active, balance, ...pagination(query) };
}
/** Validates statement filters: from/to dates and page. */
export function readLedgerStatementFilters(query = {}) {
  const from = text(query, 'from');
  const to = text(query, 'to');
  if ((from && !validLedgerDate(from)) || (to && !validLedgerDate(to)) || (from && to && from > to))
    throw new HttpError(
      400,
      'Choose valid calendar dates from 2000 to 2199, with the start on or before the end.',
    );
  return { from, to, ...pagination(query) };
}

// Adds two integer-paise amounts; throws 409 LEDGER_DATA_INVALID if any value is not a safe integer.
export function safeAdd(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(sum))
    throw new HttpError(
      409,
      'Saved ledger amounts exceed the safe integer-paise range. Review the source records.',
      'LEDGER_DATA_INVALID',
    );
  return sum;
}
/** Match the rounding used by the existing saved invoice and balance helpers. */
export function amountPaise(value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new HttpError(
      409,
      'A saved ledger amount is invalid. Review the source records.',
      'LEDGER_DATA_INVALID',
    );
  return safeAdd(0, Math.round(value * 100));
}
// Integer paise -> "1234.50" text for CSV export; null/undefined -> ''.
export function decimalPaise(value) {
  if (value === null || value === undefined) return '';
  safeAdd(0, value);
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
// Zeroed totals object; addLedgerTotals() adds one totals object into another.
export function emptyLedgerTotals() {
  return {
    invoiceCount: 0,
    invoicedPaise: 0,
    receivedPaise: 0,
    outstandingPaise: 0,
    overduePaise: 0,
    overdueInvoiceCount: 0,
    unreceiptedCreditPaise: 0,
  };
}
export function addLedgerTotals(target, source) {
  for (const key of Object.keys(emptyLedgerTotals())) target[key] = safeAdd(target[key], source[key]);
  return target;
}
// Workspace links to an invoice preview and to a customer's ledger statement.
export const invoiceHref = (organizationId, id) =>
  `/workspace/${encodeURIComponent(organizationId)}/invoices/preview/${encodeURIComponent(id)}`;
export const customerLedgerHref = (organizationId, id) =>
  `/workspace/${encodeURIComponent(organizationId)}/ledger/preview/${encodeURIComponent(id)}`;

// Paginates an in-memory list: { total, page, pageSize, pageCount, rows }. allRows=true skips slicing (exports).
export function pageRows(rows, filters, allRows = false) {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, pageCount);
  return {
    total,
    page,
    pageSize: filters.pageSize,
    pageCount,
    rows: allRows ? rows : rows.slice((page - 1) * filters.pageSize, page * filters.pageSize),
  };
}
// One CSV line with quoted cells; formula-like text (= + - @ or a leading tab/newline) gets a leading '.
export function csvRow(values) {
  return (
    values
      .map((value) => {
        let text = String(value ?? '');
        // Negative numeric balances are valid amounts, not spreadsheet formulas.
        if (!/^-?\d+(?:\.\d+)?$/.test(text) && /^\s*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
        return `"${text.replaceAll('"', '""')}"`;
      })
      .join(',') + '\r\n'
  );
}
