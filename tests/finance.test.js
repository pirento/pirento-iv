/** Unit tests: receipt GST split, the Excel workbook rows and the ZIP / .xlsx writer. */

import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { receiptSplit, groupTotals } from '../src/services/pages/finance.js';
import { xlsx, zip } from '../src/services/exports/xlsx.js';

test('a receipt is split like its invoice: taxable share, then CGST + SGST or IGST', () => {
  const document = (placeOfSupply) => ({
    totals: { taxable: 90000, total: 106200 },
    placeOfSupply,
    organizationSnapshot: { stateCode: '09' },
  });
  assert.deepEqual(receiptSplit({ amount: 63000, document: document('09') }), {
    taxable: 53389.83,
    cgst: 4805.09,
    sgst: 4805.08,
    igst: 0,
  });
  assert.deepEqual(receiptSplit({ amount: 26550, document: document('27') }), {
    taxable: 22500,
    cgst: 0,
    sgst: 0,
    igst: 4050,
  });
  assert.deepEqual(groupTotals([{ sales: 0.1 }, { sales: 0.2 }]).sales, 0.3);
});

test('the ZIP holds its entries and the workbook has escaped text, numbers and a bold header', () => {
  const archive = zip([
    { name: 'a.txt', data: 'hello' },
    { name: 'folder/b.txt', data: Buffer.from('world') },
  ]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  const local = 30 + 'a.txt'.length;
  assert.equal(inflateRawSync(archive.subarray(local, local + archive.readUInt32LE(18))).toString(), 'hello');
  const book = xlsx([
    {
      name: 'Payment/Ledger',
      rows: [
        ['Party', 'Amount'],
        ['A & <B>', 63000.5],
      ],
    },
  ]);
  assert.ok(book.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  assert.ok(book.includes(Buffer.from('[Content_Types].xml')));
});
