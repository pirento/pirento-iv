/** Unit tests: reading bank statements and matching them with receipts and paid bills (shared/bank-match.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchStatement, parseCsv, statementDate, statementLines } from '../shared/bank-match.js';

test('statement dates are read in the usual Indian bank formats', () => {
  assert.equal(statementDate('15/10/2026'), '2026-10-15');
  assert.equal(statementDate('5-10-26'), '2026-10-05');
  assert.equal(statementDate('15-Oct-2026'), '2026-10-15');
  assert.equal(statementDate('15 Oct 2026'), '2026-10-15');
  assert.equal(statementDate('2026-10-15'), '2026-10-15');
  assert.equal(statementDate(46310), '2026-10-15', 'an Excel day number');
  assert.equal(statementDate('Opening balance'), '');
});

test('an HDFC-style CSV gives credit and debit lines; a single amount column with Cr/Dr works too', () => {
  const csv = [
    'HDFC BANK Ltd.,,,,,,',
    'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
    '15/10/26,"NEFT-SPARK DEVELOPERS, LUCKNOW",HDFC000123,15/10/26,,"63,000.00","1,63,000.00"',
    '16/10/26,UPI-PAPER MART,UPI555,16/10/26,1180.00,,1,61,820.00',
    ',Closing balance,,,,,',
  ].join('\n');
  assert.deepEqual(statementLines(parseCsv(csv)), [
    {
      date: '2026-10-15',
      narration: 'NEFT-SPARK DEVELOPERS, LUCKNOW',
      reference: 'HDFC000123',
      credit: 63000,
      debit: 0,
    },
    { date: '2026-10-16', narration: 'UPI-PAPER MART', reference: 'UPI555', credit: 0, debit: 1180 },
  ]);
  const single = statementLines([
    ['Txn Date', 'Description', 'Amount', 'Cr/Dr'],
    ['01-11-2026', 'Rent', '25,000.00', 'DR'],
    ['02-11-2026', 'Receipt', '500.00', 'CR'],
  ]);
  assert.deepEqual(
    single.map((line) => [line.credit, line.debit]),
    [
      [0, 25000],
      [500, 0],
    ],
  );
  assert.throws(() => statementLines([['Name', 'Value']]), /No statement header/);
});

test('lines match book entries by amount within three days, preferring a matching reference', () => {
  const lines = [
    { date: '2026-10-15', narration: 'NEFT AT/26-27/002 SPARK', reference: '', credit: 26550, debit: 0 },
    { date: '2026-10-20', narration: 'UPI PAPER', reference: '', credit: 0, debit: 1180 },
    { date: '2026-10-21', narration: 'Unknown', reference: '', credit: 999, debit: 0 },
  ];
  const receipts = [
    { date: '2026-10-14', amount: 26550, reference: 'OTHER', label: 'AT/26-27/009' },
    { date: '2026-10-16', amount: 26550, reference: 'AT/26-27/002', label: 'AT/26-27/002' },
    { date: '2026-10-18', amount: 500, reference: '', label: 'No line for this one' },
  ];
  const payments = [{ date: '2026-10-25', amount: 1180, reference: '', label: 'Too far apart' }];
  const result = matchStatement(lines, { receipts, payments });
  assert.equal(
    result.rows[0].book.label,
    'AT/26-27/002',
    'the reference in the narration wins over a closer date',
  );
  assert.deepEqual(
    result.counts,
    { matched: 1, bankOnly: 2, booksOnly: 1 },
    'only book entries within the statement dates count',
  );
});
