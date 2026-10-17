/**
 * Builds a customer statement from invoices and receipts: dated rows, opening/closing balances
 * and notices where older records lack dates (shown, never guessed).
 */

import { balanceDue, installmentBalances, paidAmount } from '../../../shared/types.js';
import { HttpError } from '../../middleware/errors.js';
import {
  CURRENT_STATUS_NOTICE,
  addLedgerTotals,
  amountPaise,
  decimalPaise,
  emptyLedgerTotals,
  invoiceHref,
  ledgerTimestampDate,
  safeAdd,
  validLedgerDate,
} from './ledger-values.js';

// Issued invoices count as receivables; drafts and cancelled invoices do not.
export const isReceivableInvoice = (document) =>
  document.kind === 'invoice' && ['sent', 'partially_paid', 'paid'].includes(document.status);
const isVoided = (payment) => payment.voidedAt !== null && payment.voidedAt !== undefined;
const receiptSummary = (document) => document.receiptSummary?.[0] ?? { activePaise: 0, receiptCount: 0 };

/** Preserve the same current paid/balance and oldest-due-first installment calculations. */
export function invoiceLedgerTotals(document, businessDate) {
  if (!isReceivableInvoice(document)) return emptyLedgerTotals();
  const receipts = receiptSummary(document);
  if (receipts.invalidAmounts)
    throw new HttpError(
      409,
      'A saved receipt amount is invalid. Review the source records.',
      'LEDGER_DATA_INVALID',
    );
  const invoicedPaise = amountPaise(document.totals.total);
  const receivedPaise = amountPaise(paidAmount(document));
  const outstandingPaise = amountPaise(balanceDue(document));
  if (invoicedPaise < 0 || receivedPaise < 0)
    throw new HttpError(
      409,
      'A saved invoice amount is invalid. Review the source records.',
      'LEDGER_DATA_INVALID',
    );
  let overduePaise = 0;
  if (['sent', 'partially_paid'].includes(document.status) && outstandingPaise > 0) {
    if (document.installmentPlan?.installments?.length) {
      for (const row of installmentBalances(document, businessDate))
        if (row.status === 'overdue') overduePaise = safeAdd(overduePaise, amountPaise(row.balanceDue));
    } else if (validLedgerDate(document.dueDate) && document.dueDate < businessDate)
      overduePaise = outstandingPaise;
  }
  return {
    invoiceCount: 1,
    invoicedPaise,
    receivedPaise,
    outstandingPaise,
    overduePaise,
    overdueInvoiceCount: overduePaise > 0 ? 1 : 0,
    unreceiptedCreditPaise: safeAdd(receivedPaise, -safeAdd(0, receipts.activePaise)),
  };
}

const rowOrder = { invoice: 0, receipt: 1, receipt_void: 2, legacy_balance: 3 };
const compareRows = (left, right) =>
  (left.date ?? '9999-12-31').localeCompare(right.date ?? '9999-12-31') ||
  rowOrder[left.type] - rowOrder[right.type] ||
  left.documentNumber.localeCompare(right.documentNumber) ||
  left.id.localeCompare(right.id);

/**
 * This is a view over existing records, not a second ledger. Undated differences
 * are visible but never assigned an invented receipt/cancellation date.
 */
export function buildCustomerStatement(
  documents,
  payments,
  eventCounts,
  { businessDate, from = '', to = '' },
) {
  const notices = new Map([[CURRENT_STATUS_NOTICE.code, { ...CURRENT_STATUS_NOTICE }]]);
  const summary = emptyLedgerTotals();
  const rows = [];
  const excludedDocuments = [];
  let complete = true;
  function notice(code, message, incomplete = false) {
    const previous = notices.get(code);
    notices.set(code, { code, message, count: (previous?.count ?? 0) + 1 });
    if (incomplete) complete = false;
  }
  const paymentsByDocument = new Map();
  for (const payment of payments) {
    const list = paymentsByDocument.get(payment.documentId) ?? [];
    list.push(payment);
    paymentsByDocument.set(payment.documentId, list);
  }
  const audit = new Map();
  for (const event of eventCounts) {
    const entry = audit.get(event._id.documentId) ?? {};
    entry[event._id.type] = event.count;
    audit.set(event._id.documentId, entry);
  }

  for (const document of documents) {
    const receipts = paymentsByDocument.get(document.id) ?? [];
    let activePaise = 0;
    for (const payment of receipts) {
      const amount = amountPaise(payment.amount);
      if (amount < 0)
        throw new HttpError(
          409,
          'A saved receipt amount is invalid. Review the source records.',
          'LEDGER_DATA_INVALID',
        );
      if (!isVoided(payment)) activePaise = safeAdd(activePaise, amount);
    }
    const stored = document.receiptSummary?.[0];
    const financialDocument = stored
      ? document
      : { ...document, receiptSummary: [{ activePaise, receiptCount: receipts.length }] };
    const href = invoiceHref(document.organizationId, document.id);
    const documentNumber = String(document.number ?? document.id);
    if (!isReceivableInvoice(document)) {
      excludedDocuments.push({
        id: document.id,
        number: documentNumber,
        status: document.status,
        issueDate: validLedgerDate(document.issueDate) ? document.issueDate : null,
        amountPaise: amountPaise(document.totals.total),
        href,
        receiptCount: receipts.length,
        reason:
          document.status === 'draft'
            ? 'Unissued draft; excluded from receivables.'
            : document.status === 'cancelled'
              ? 'Currently cancelled; cancellation date is not reconstructed.'
              : 'This invoice status is outside the current receivable states.',
      });
      if (receipts.length)
        notice(
          'excluded_invoice_receipts',
          'Receipt history exists on an excluded invoice. Its invoice and receipt movements are excluded together; no cancellation date or refund is inferred.',
        );
      continue;
    }
    const totals = invoiceLedgerTotals(financialDocument, businessDate);
    addLedgerTotals(summary, totals);
    const common = { documentId: document.id, documentNumber, href, paymentId: null, reference: '' };
    const invoiceDate = validLedgerDate(document.issueDate) ? document.issueDate : null;
    if (!invoiceDate)
      notice(
        'invoice_date_missing',
        'An invoice has no valid saved issue date. Historical balances are unavailable because the movement cannot be assigned to a period.',
        true,
      );
    rows.push({
      ...common,
      id: `invoice:${document.id}`,
      type: 'invoice',
      date: invoiceDate,
      description: `Invoice ${documentNumber}`,
      debitPaise: totals.invoicedPaise,
      creditPaise: 0,
    });

    for (const payment of receipts) {
      const amount = amountPaise(payment.amount);
      const paidOn = validLedgerDate(payment.paidOn)
        ? payment.paidOn
        : ledgerTimestampDate(payment.providerPaidAt);
      if (!paidOn)
        notice(
          'receipt_date_missing',
          'A receipt has no valid payment date or provider timestamp. Its creation time is not used as an invented payment date.',
          true,
        );
      else if (!validLedgerDate(payment.paidOn))
        notice(
          'receipt_date_from_provider',
          'A receipt without a saved payment date uses its original provider timestamp in Asia/Kolkata.',
        );
      const paymentCommon = { ...common, paymentId: payment.id, reference: String(payment.reference ?? '') };
      rows.push({
        ...paymentCommon,
        id: `receipt:${payment.id}`,
        type: 'receipt',
        date: paidOn,
        description: `Receipt${payment.method ? ` — ${String(payment.method).replaceAll('_', ' ')}` : ''}`,
        debitPaise: 0,
        creditPaise: amount,
      });
      if (isVoided(payment)) {
        const voidDate = ledgerTimestampDate(payment.voidedAt);
        if (!voidDate)
          notice(
            'void_date_missing',
            'A voided receipt has no valid void timestamp. Its reversal remains undated; an audit description is not used to guess which date belongs to it.',
            true,
          );
        else if (paidOn && voidDate < paidOn)
          notice(
            'void_before_receipt',
            'A saved void date precedes its receipt date. Review these source dates before treating the statement as a dated account.',
            true,
          );
        rows.push({
          ...paymentCommon,
          id: `receipt_void:${payment.id}`,
          type: 'receipt_void',
          date: voidDate,
          description: `Receipt void${payment.voidReason ? ` — ${payment.voidReason}` : ''}`,
          debitPaise: amount,
          creditPaise: 0,
        });
      }
    }
    if (stored && activePaise !== stored.activePaise)
      notice(
        'receipt_rounding_difference',
        'Legacy receipt rounding differs from the current saved ledger total. The source amounts need review.',
        true,
      );

    // A paid legacy snapshot may have no receipt rows. Preserve its current
    // financial total while making the missing settlement date explicit.
    const knownCurrentBalance = safeAdd(totals.invoicedPaise, -activePaise);
    const undatedCredit = safeAdd(knownCurrentBalance, -totals.outstandingPaise);
    const savedBalanceDifference = safeAdd(
      safeAdd(totals.invoicedPaise, -totals.receivedPaise),
      -totals.outstandingPaise,
    );
    if (undatedCredit !== 0 || totals.unreceiptedCreditPaise !== 0 || savedBalanceDifference !== 0) {
      notice(
        'legacy_balance',
        'Saved paid/balance values include an undated difference from the receipt records. Current totals are retained, but opening, closing and running historical balances are unavailable. This is not evidence of a new receipt.',
        true,
      );
      rows.push({
        ...common,
        id: `legacy_balance:${document.id}`,
        type: 'legacy_balance',
        date: null,
        description: `Undated saved-balance difference of INR ${decimalPaise(undatedCredit)}; no payment date is inferred.`,
        debitPaise: Math.max(0, -undatedCredit),
        creditPaise: Math.max(0, undatedCredit),
      });
    }
    const events = audit.get(document.id) ?? {};
    if (
      (events.payment_recorded ?? 0) > receipts.length ||
      (events.payment_voided ?? 0) > receipts.filter(isVoided).length
    )
      notice(
        'receipt_history_missing',
        'The activity history refers to receipt or void records that are not present. Amounts and dates are not reconstructed from free-text event descriptions.',
        true,
      );
  }
  if (excludedDocuments.length)
    notices.set('excluded_invoices', {
      code: 'excluded_invoices',
      message:
        'Draft, cancelled or unsupported-status invoices are listed separately and do not change this statement balance.',
      count: excludedDocuments.length,
    });

  rows.sort(compareRows);
  let opening = 0;
  if (from)
    for (const row of rows)
      if (row.date && row.date < from) opening = safeAdd(opening, safeAdd(row.debitPaise, -row.creditPaise));
  const selected = rows.filter(
    (row) => !row.date || ((!from || row.date >= from) && (!to || row.date <= to)),
  );
  const period = {
    from,
    to,
    openingBalancePaise: complete ? opening : null,
    invoicedPaise: 0,
    receivedPaise: 0,
    voidedPaise: 0,
    debitsPaise: 0,
    creditsPaise: 0,
    closingBalancePaise: null,
    knownOpeningBalancePaise: opening,
    knownClosingBalancePaise: opening,
  };
  let running = opening;
  for (const row of selected) {
    if (row.date) {
      period.debitsPaise = safeAdd(period.debitsPaise, row.debitPaise);
      period.creditsPaise = safeAdd(period.creditsPaise, row.creditPaise);
      if (row.type === 'invoice') period.invoicedPaise = safeAdd(period.invoicedPaise, row.debitPaise);
      if (row.type === 'receipt') period.receivedPaise = safeAdd(period.receivedPaise, row.creditPaise);
      if (row.type === 'receipt_void') period.voidedPaise = safeAdd(period.voidedPaise, row.debitPaise);
      running = safeAdd(running, safeAdd(row.debitPaise, -row.creditPaise));
    }
    row.balancePaise = complete && row.date ? running : null;
    row.knownBalancePaise = row.date ? running : null;
  }
  period.knownClosingBalancePaise = running;
  period.closingBalancePaise = complete ? running : null;
  return {
    rows: selected,
    summary,
    period,
    excludedDocuments,
    history: {
      complete,
      basis: 'current_invoice_status',
      unreceiptedCreditPaise: summary.unreceiptedCreditPaise,
      undatedRowCount: rows.filter((row) => !row.date).length,
      notices: [...notices.values()],
    },
  };
}
