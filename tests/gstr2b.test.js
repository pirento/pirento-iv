/** Unit tests: reading the GSTR-2B JSON and matching it with expenses (shared/gstr2b.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchGstr2b, readGstr2b } from '../shared/gstr2b.js';

const portalFile = {
  chksum: 'x',
  data: {
    gstin: '09AAACA1234A1Z5',
    rtnprd: '092026',
    docdata: {
      b2b: [
        {
          ctin: '27AAACR5055K1Z7',
          trdnm: 'Paper Mart',
          inv: [
            {
              inum: 'PM/007',
              dt: '12-09-2026',
              val: 1180,
              txval: 1000,
              igst: 180,
              cgst: 0,
              sgst: 0,
              cess: 0,
            },
            { inum: 'PM-8', dt: '15-09-2026', val: 590, items: [{ rt: 18, txval: 500, igst: 90 }] },
          ],
        },
        {
          ctin: '09BBBBB0000B1Z5',
          trdnm: 'Local Supplier',
          inv: [{ inum: 'A1', dt: '20-09-2026', val: 105, txval: 100, cgst: 2.5, sgst: 2.5 }],
        },
      ],
    },
  },
};

test('the portal file gives the period and each B2B invoice with taxable value and GST', () => {
  const { period, invoices } = readGstr2b(portalFile);
  assert.equal(period, '2026-09');
  assert.deepEqual(invoices[1], {
    gstin: '27AAACR5055K1Z7',
    name: 'Paper Mart',
    number: 'PM-8',
    date: '2026-09-15',
    taxable: 500,
    tax: 90,
  });
  assert.equal(invoices[2].tax, 5);
  assert.throws(() => readGstr2b({ data: {} }), /not a GSTR-2B JSON/);
});

test('bills match by GSTIN and bill number; amounts within ₹1 count as matched', () => {
  const expense = (vendorGstin, billNumber, taxable, tax) => ({ vendorGstin, billNumber, taxable, tax });
  const result = matchGstr2b(readGstr2b(portalFile).invoices, [
    expense('27aaacr5055k1z7', 'pm 7', 1000.5, 180),
    expense('09BBBBB0000B1Z5', 'A0001', 100, 6.5),
    expense('27AAACR5055K1Z7', 'PM-8', 500, 50),
    expense('29CCCCC0000C1Z5', 'X-1', 200, 36),
    expense('', 'cash bill', 50, 0),
  ]);
  assert.deepEqual(
    result.rows.map((row) => [row.status, row.portal?.number ?? row.book.billNumber]),
    [
      ['matched', 'PM/007'],
      ['different', 'PM-8'],
      ['different', 'A1'],
      ['not-in-2b', 'X-1'],
    ],
  );
  assert.deepEqual(result.counts, { matched: 1, different: 2, notInBooks: 0, notIn2b: 1 });
  assert.equal(result.portalTax, 275);
});
