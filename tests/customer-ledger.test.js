/** Unit tests: customer ledger filters, opening/closing balances, integer-paise totals and CSV export. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomerStatement, invoiceLedgerTotals } from '../src/services/ledger/ledger-statement.js';
import {
  amountPaise,
  csvRow,
  decimalPaise,
  ledgerTimestampDate,
  readLedgerListFilters,
  readLedgerStatementFilters,
  safeAdd,
  validLedgerDate,
} from '../src/services/ledger/ledger-values.js';

const document = (extra = {}) => ({
  id: 'invoice-one',
  organizationId: 'org-one',
  customerId: 'customer-one',
  kind: 'invoice',
  status: 'sent',
  number: 'INV/1',
  issueDate: '2026-09-01',
  dueDate: '2026-09-15',
  totals: { total: 100 },
  amountPaid: 0,
  balanceDue: 100,
  ...extra,
});
const payment = (extra = {}) => ({
  id: 'receipt-one',
  documentId: 'invoice-one',
  amount: 40,
  paidOn: '2026-09-05',
  createdAt: '2026-10-10T12:00:00.000Z',
  method: 'bank_transfer',
  reference: '',
  voidedAt: null,
  ...extra,
});
const build = (documents, payments = [], extra = {}, events = []) =>
  buildCustomerStatement(documents, payments, events, { businessDate: '2026-10-10', ...extra });

test('Ledger filters use exact calendar dates, literal search and bounded pages', () => {
  for (const date of ['2000-02-29', '2024-02-29', '2199-12-31']) assert.equal(validLedgerDate(date), true);
  for (const date of [
    '1999-12-31',
    '2200-01-01',
    '2100-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-1-01',
    '2026-01-01 ',
    null,
  ])
    assert.equal(validLedgerDate(date), false);
  assert.deepEqual(readLedgerListFilters(), { q: '', active: 'all', balance: 'all', page: 1, pageSize: 50 });
  assert.equal(readLedgerListFilters({ q: '[.*] $where' }).q, '[.*] $where');
  assert.equal(readLedgerListFilters({ pageSize: '100' }).pageSize, 100);
  for (const query of [
    { q: ['x'] },
    { page: '0' },
    { page: '-1' },
    { page: '1.1' },
    { pageSize: '101' },
    { pageSize: '0' },
    { pageSize: 50 },
    { active: 'deleted' },
    { balance: '$gt' },
  ])
    assert.throws(() => readLedgerListFilters(query), { status: 400 });
  assert.deepEqual(readLedgerStatementFilters({ from: '2024-02-29', to: '2024-02-29' }), {
    from: '2024-02-29',
    to: '2024-02-29',
    page: 1,
    pageSize: 50,
  });
  for (const query of [
    { from: '2026-02-29' },
    { to: '2026-10-10T00:00:00Z' },
    { from: '2026-10-11', to: '2026-10-10' },
    { from: { $ne: '' } },
  ])
    assert.throws(() => readLedgerStatementFilters(query), { status: 400 });
  assert.equal(ledgerTimestampDate('2026-10-10T18:29:59.999Z'), '2026-10-10');
  assert.equal(ledgerTimestampDate('2026-10-10T18:30:00.000Z'), '2026-10-11');
  assert.equal(ledgerTimestampDate('2026-10-11T00:00:00+05:30'), '2026-10-11');
  for (const value of ['2026-10-10', '2026-10-10T18:30:00', '2026-02-30T12:00:00Z', '2026-10-10T24:00:00Z'])
    assert.equal(ledgerTimestampDate(value), null);
});

test('Dated invoice, receipt and void rows reconcile opening plus movements to closing', () => {
  const records = [
    payment(),
    payment({
      id: 'receipt-two',
      amount: 30,
      paidOn: '2026-09-25',
      voidedAt: '2026-09-30T18:30:00.000Z',
      voidReason: 'Wrong entry',
    }),
  ];
  const data = build([document({ amountPaid: 40, balanceDue: 60, status: 'partially_paid' })], records, {
    from: '2026-09-10',
    to: '2026-10-01',
  });
  assert.equal(data.history.complete, true);
  assert.equal(data.period.openingBalancePaise, 6000);
  assert.equal(data.period.invoicedPaise, 0);
  assert.equal(data.period.receivedPaise, 3000);
  assert.equal(data.period.voidedPaise, 3000);
  assert.equal(data.period.closingBalancePaise, 6000);
  assert.equal(
    data.period.openingBalancePaise + data.period.debitsPaise - data.period.creditsPaise,
    data.period.closingBalancePaise,
  );
  assert.deepEqual(
    data.rows.map((row) => [row.type, row.date, row.balancePaise]),
    [
      ['receipt', '2026-09-25', 3000],
      ['receipt_void', '2026-10-01', 6000],
    ],
  );
  assert.deepEqual(data.summary, {
    invoiceCount: 1,
    invoicedPaise: 10000,
    receivedPaise: 4000,
    outstandingPaise: 6000,
    overduePaise: 6000,
    overdueInvoiceCount: 1,
    unreceiptedCreditPaise: 0,
  });
  assert.match(data.rows[0].href, /^\/workspace\/org-one\/invoices\/preview\/invoice-one$/);
  const oneDay = build([document({ amountPaid: 40, balanceDue: 60 })], records, {
    from: '2026-10-01',
    to: '2026-10-01',
  });
  assert.equal(oneDay.rows.length, 1);
  assert.equal(oneDay.rows[0].type, 'receipt_void');
  assert.equal(oneDay.period.openingBalancePaise, 3000);
  assert.equal(oneDay.period.closingBalancePaise, 6000);
});

test('Current invoice and installment totals retain integer-paise semantics', () => {
  const totals = invoiceLedgerTotals(
    document({
      amountPaid: 25,
      balanceDue: 75,
      status: 'partially_paid',
      receiptSummary: [{ activePaise: 2500 }],
      installmentPlan: {
        installments: [
          { id: 'a', amount: 50, dueDate: '2026-10-09' },
          { id: 'b', amount: 50, dueDate: '2026-11-01' },
        ],
      },
    }),
    '2026-10-10',
  );
  assert.equal(totals.overduePaise, 2500);
  assert.equal(totals.outstandingPaise, 7500);
  assert.equal(amountPaise(0.1 + 0.2), 30);
  assert.equal(amountPaise(1.15), 115);
  assert.equal(decimalPaise(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(decimalPaise(-101), '-1.01');
  assert.equal(decimalPaise(null), '');
  assert.throws(() => safeAdd(Number.MAX_SAFE_INTEGER, 1), { code: 'LEDGER_DATA_INVALID' });
  assert.throws(() => amountPaise(Infinity), { code: 'LEDGER_DATA_INVALID' });
  for (const extra of [
    { status: 'draft' },
    { status: 'cancelled' },
    { kind: 'quotation' },
    { kind: 'proforma' },
    { kind: 'delivery_note' },
  ])
    assert.equal(invoiceLedgerTotals(document(extra), '2026-10-10').invoiceCount, 0);
});

test('Legacy paid balances stay current without inventing a dated receipt', () => {
  const legacy = document({ status: 'paid' });
  delete legacy.amountPaid;
  delete legacy.balanceDue;
  const data = build([legacy], [], { from: '2026-10-01', to: '2026-10-10' });
  assert.equal(data.summary.receivedPaise, 10000);
  assert.equal(data.summary.outstandingPaise, 0);
  assert.equal(data.history.complete, false);
  assert.equal(data.history.unreceiptedCreditPaise, 10000);
  assert.equal(data.period.openingBalancePaise, null);
  assert.equal(data.period.closingBalancePaise, null);
  assert.equal(data.period.knownOpeningBalancePaise, 10000);
  assert.equal(data.period.knownClosingBalancePaise, 10000);
  assert.equal(data.rows.length, 1);
  assert.deepEqual(
    [data.rows[0].type, data.rows[0].date, data.rows[0].creditPaise, data.rows[0].balancePaise],
    ['legacy_balance', null, 10000, null],
  );
});

test('Missing dates and audit-only history remain explicitly incomplete; cancellation is not backdated', () => {
  const unknown = build([document()], [payment({ paidOn: '', voidedAt: 'not-a-timestamp' })]);
  assert.equal(unknown.history.complete, false);
  assert.equal(unknown.rows.filter((row) => row.date === null).length, 2);
  assert.equal(
    unknown.rows.every((row) => row.balancePaise === null),
    true,
  );
  assert.equal(unknown.period.knownClosingBalancePaise, 10000);
  const provider = build(
    [document({ amountPaid: 40, balanceDue: 60 })],
    [payment({ paidOn: '', providerPaidAt: '2026-10-10T18:30:00Z' })],
  );
  assert.equal(provider.history.complete, true);
  assert.equal(provider.rows.find((row) => row.type === 'receipt').date, '2026-10-11');
  const auditOnly = build([document()], [], {}, [
    { _id: { documentId: 'invoice-one', type: 'payment_recorded' }, count: 1 },
  ]);
  assert.equal(auditOnly.history.complete, false);
  assert.equal(auditOnly.rows.length, 1, 'Free-text audit events never fabricate receipt rows');
  const cancelled = build(
    [document({ status: 'cancelled' })],
    [payment({ voidedAt: '2026-10-10T12:00:00Z' })],
  );
  assert.equal(cancelled.rows.length, 0);
  assert.equal(cancelled.summary.invoicedPaise, 0);
  assert.equal(cancelled.summary.receivedPaise, 0);
  assert.equal(cancelled.period.closingBalancePaise, 0);
  assert.equal(cancelled.excludedDocuments[0].status, 'cancelled');
  assert.equal(Object.hasOwn(cancelled.excludedDocuments[0], 'cancelledAt'), false);
});

test('CSV quotes content and neutralizes spreadsheet formulas without losing exact paise', () => {
  assert.equal(csvRow([decimalPaise(-101)]), '"-1.01"\r\n');
  assert.equal(
    csvRow(['=HYPERLINK("x")', ' @SUM(1)', 'A,B', '"quoted"', decimalPaise(115)]),
    '"\'=HYPERLINK(""x"")","\' @SUM(1)","A,B","""quoted""","1.15"\r\n',
  );
});

test('A recorded payment before the invoice issue date retains a numeric credit balance', () => {
  const data = build([document({ issueDate: '2026-10-01', amountPaid: 40, balanceDue: 60 })], [payment()], {
    from: '2026-09-05',
    to: '2026-09-05',
  });
  assert.equal(data.history.complete, true);
  assert.equal(data.period.openingBalancePaise, 0);
  assert.equal(data.period.closingBalancePaise, -4000);
  assert.equal(data.rows[0].balancePaise, -4000);
  assert.equal(csvRow([decimalPaise(data.rows[0].balancePaise)]), '"-40.00"\r\n');
});
