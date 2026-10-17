/** Unit tests: GSTR-1 tables built from invoices (src/services/pages/gstr1.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGstr1,
  gstr1Csv,
  invoiceLines,
  monthRange,
  readGstr1Filters,
} from '../src/services/pages/gstr1.js';
import { calculateTotals } from '../shared/types.js';

const seller = { gstin: '09AAAAA0000A1Z5', stateCode: '09' };
let sequence = 0;
function invoice({
  buyerGstin = '',
  place = '09',
  items,
  discountPercent = 0,
  sellerGstin = seller.gstin,
  status = 'sent',
}) {
  sequence++;
  return {
    number: `INV-${String(sequence).padStart(3, '0')}`,
    status,
    issueDate: '2026-10-05',
    placeOfSupply: place,
    discountPercent,
    items,
    customerSnapshot: { name: `Buyer ${sequence}`, gstin: buyerGstin },
    organizationSnapshot: { ...seller, gstin: sellerGstin },
    totals: calculateTotals(items, discountPercent, place !== seller.stateCode),
  };
}
const line = (rate, gstRate, extra = {}) => ({
  description: 'Service',
  hsn: '9987',
  unit: 'Hour',
  quantity: 1,
  rate,
  gstRate,
  ...extra,
});

test('invoices are split into B2B, B2CL, B2CS, HSN and 0% tables', () => {
  const invoices = [
    invoice({ buyerGstin: '09BBBBB0000B1Z5', items: [line(1500, 18, { quantity: 2 })] }),
    invoice({ place: '27', items: [line(100000, 18, { hsn: '7113', unit: 'Gram' })] }),
    invoice({ place: '27', discountPercent: 10, items: [line(1000, 5)] }),
    invoice({ items: [line(500, 18), line(100, 0, { hsn: '0401', unit: 'Kg', quantity: 2 })] }),
    invoice({ sellerGstin: '', items: [line(10, 18)] }),
    invoice({ status: 'cancelled', items: [line(999, 18)] }),
  ];
  const report = buildGstr1(invoices, { month: '2026-10' });
  assert.equal(report.gstin, seller.gstin);
  assert.equal(report.withoutGstin, 1);
  assert.deepEqual(report.sections.b2b, [
    [
      '09BBBBB0000B1Z5',
      'Buyer 1',
      'INV-001',
      '05-Oct-2026',
      '3540.00',
      '09-Uttar Pradesh',
      'N',
      '',
      'Regular B2B',
      '',
      18,
      '3000.00',
      '0.00',
    ],
  ]);
  assert.deepEqual(report.sections.b2cl, [
    ['INV-002', '05-Oct-2026', '118000.00', '27-Maharashtra', '', 18, '100000.00', '0.00', ''],
  ]);
  assert.deepEqual(report.sections.b2cs, [
    ['OE', '09-Uttar Pradesh', '', 18, '500.00', '0.00', ''],
    ['OE', '27-Maharashtra', '', 5, '900.00', '0.00', ''],
  ]);
  assert.deepEqual(report.sections['hsn-b2b'], [
    ['9987', 'Service', 'NA', 2, '3540.00', 18, '3000.00', '0.00', '270.00', '270.00', '0.00'],
  ]);
  assert.deepEqual(report.sections['hsn-b2c'], [
    ['0401', 'Service', 'KGS-KILOGRAMS', 2, '200.00', 0, '200.00', '0.00', '0.00', '0.00', '0.00'],
    ['7113', 'Service', 'GMS-GRAMMES', 1, '118000.00', 18, '100000.00', '18000.00', '0.00', '0.00', '0.00'],
    ['9987', 'Service', 'NA', 1, '945.00', 5, '900.00', '45.00', '0.00', '0.00', '0.00'],
    ['9987', 'Service', 'NA', 1, '590.00', 18, '500.00', '0.00', '45.00', '45.00', '0.00'],
  ]);
  assert.deepEqual(report.sections.nil, [
    ['Intra-State supplies to unregistered persons', '200.00', '0.00', '0.00'],
  ]);
  assert.deepEqual(report.totals, { invoices: 4, value: '123275.00', taxable: '104600.00', tax: '18675.00' });
  // The cancelled INV-006 counts only in documents issued; INV-005 has no seller GSTIN.
  assert.deepEqual(report.sections.docs, [['Invoices for outward supply', 'INV-001', 'INV-006', 5, 1]]);
  const csv = gstr1Csv(report, 'b2cs');
  assert.equal(csv.filename, 'GSTR1-09AAAAA0000A1Z5-2026-10-b2cs.csv');
  assert.equal(csv.lines.length, 3);
});

test('line amounts always add up to the saved invoice totals', () => {
  const document = invoice({
    discountPercent: 3,
    items: [line(10.01, 18), line(10.01, 18), line(10.01, 12), line(0.33, 5)],
  });
  const lines = invoiceLines(document);
  const sum = (key) => lines.reduce((total, row) => total + row[key].toNumber() * 100, 0) / 100;
  assert.equal(Number(sum('taxable').toFixed(2)), document.totals.taxable);
  assert.equal(
    Number(sum('tax').toFixed(2)),
    Number((document.totals.cgst + document.totals.sgst).toFixed(2)),
  );
});

test('filters default to the current month and accept only valid values', () => {
  assert.deepEqual(readGstr1Filters({}, '2026-10-17'), { month: '2026-10', gstin: '' });
  assert.deepEqual(readGstr1Filters({ month: '2026-13', gstin: 'bad' }, '2026-10-17'), {
    month: '2026-10',
    gstin: '',
  });
  assert.deepEqual(monthRange('2026-12'), { from: '2026-12-01', to: '2027-01-01' });
});
