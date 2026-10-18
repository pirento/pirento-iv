/** Unit tests: e-invoice and e-way bill files built from an invoice (src/services/documents/einvoice.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { einvoiceJson, einvoiceProblems, ewayBillJson } from '../src/services/documents/einvoice.js';
import { calculateTotals } from '../shared/types.js';

const items = [
  { description: 'Steel chair', hsn: '9401', unit: 'Nos', quantity: 2, rate: 1000, gstRate: 18 },
  { description: 'Fitting', hsn: '998719', quantity: 1, rate: 500, gstRate: 18 },
];
const invoice = (extra = {}) => ({
  kind: 'invoice',
  status: 'sent',
  number: 'P2LI/2627/0007',
  issueDate: '2026-10-05',
  placeOfSupply: '27',
  discountPercent: 10,
  items,
  totals: calculateTotals(items, 10, true),
  organizationSnapshot: {
    name: 'Pirento',
    legalName: 'Pirento Pvt Ltd',
    gstin: '09AAACA1234A1Z5',
    stateCode: '09',
    address: '12 Hazratganj\nLucknow 226001',
  },
  customerSnapshot: {
    name: 'Buyer Ltd',
    gstin: '27AAACR5055K1Z7',
    stateCode: '27',
    address: 'Andheri East, Mumbai - 400069',
  },
  ...extra,
});

test('problems list what is missing before an e-invoice or e-way bill file can be made', () => {
  assert.deepEqual(einvoiceProblems(invoice()), []);
  const missing = einvoiceProblems(
    invoice({
      status: 'draft',
      customerSnapshot: { name: 'Walk-in', address: 'Mumbai' },
      items: [{ ...items[0], hsn: '' }],
    }),
  );
  assert.equal(missing.length, 4);
  assert.match(missing.join(' '), /issued invoice.*B2B.*PIN code to the buyer.*HSN/);
  assert.match(
    einvoiceProblems(invoice({ items: [items[1]] }), { ewayBill: true }).join(' '),
    /E-way bills are for goods/,
  );
});

test('the e-invoice JSON follows NIC schema 1.1 and its lines add up to the invoice', () => {
  const doc = invoice();
  const json = einvoiceJson(doc);
  assert.deepEqual(json.DocDtls, { Typ: 'INV', No: 'P2LI/2627/0007', Dt: '05/10/2026' });
  assert.deepEqual(
    [json.SellerDtls.Loc, json.SellerDtls.Pin, json.BuyerDtls.Loc, json.BuyerDtls.Pin, json.BuyerDtls.Pos],
    ['Lucknow', 226001, 'Mumbai', 400069, '27'],
  );
  assert.deepEqual(json.ItemList[0], {
    SlNo: '1',
    PrdDesc: 'Steel chair',
    IsServc: 'N',
    HsnCd: '9401',
    Qty: 2,
    Unit: 'NOS',
    UnitPrice: 1000,
    TotAmt: 2000,
    Discount: 200,
    AssAmt: 1800,
    GstRt: 18,
    IgstAmt: 324,
    CgstAmt: 0,
    SgstAmt: 0,
    TotItemVal: 2124,
  });
  assert.equal(json.ItemList[1].IsServc, 'Y');
  const sum = (key) => Math.round(json.ItemList.reduce((total, line) => total + line[key], 0) * 100) / 100;
  assert.equal(sum('AssAmt'), json.ValDtls.AssVal);
  assert.equal(sum('TotItemVal'), json.ValDtls.TotInvVal);
  assert.equal(einvoiceJson({ ...doc, debitNoteFor: { id: 'x' } }).DocDtls.Typ, 'DBN');
});

test('the e-way bill JSON carries parties, transport and per-line GST rates', () => {
  const bill = ewayBillJson(invoice(), {
    mode: 'road',
    distanceKm: 1400,
    vehicleNo: 'UP32AB1234',
    transporterId: '',
    transporterName: '',
  }).billLists[0];
  assert.deepEqual(
    [
      bill.fromPincode,
      bill.toPincode,
      bill.fromStateCode,
      bill.toStateCode,
      bill.transMode,
      bill.transDistance,
    ],
    [226001, 400069, 9, 27, 1, '1400'],
  );
  assert.deepEqual(
    [
      bill.itemList[0].igstRate,
      bill.itemList[0].cgstRate,
      bill.itemList[0].qtyUnit,
      bill.itemList[0].hsnCode,
    ],
    [18, 0, 'NOS', 9401],
  );
  assert.equal(bill.totInvValue, invoice().totals.total);
});
