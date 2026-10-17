/** Unit tests: exact-decimal line pricing and half-up rounding (normal, recurring and jewellery lines). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { decimal } from '../shared/decimal.js';
import { wholePaise } from '../shared/money.js';
import {
  calculateLineAmount,
  calculateTotals,
  DECIMAL_ROUNDING_POLICY,
  documentRoundingPolicy,
  LEGACY_ROUNDING_POLICY,
  linePriceBreakdown,
  roundMoney,
} from '../shared/types.js';
import { documentSchema } from '../src/services/validation/validation.js';

const line = (quantity, rate, gstRate = 0, pricing) => ({
  description: 'Decimal pricing example',
  hsn: '',
  quantity,
  rate,
  gstRate,
  ...(pricing ? { pricing } : {}),
});
const documentInput = (items) => ({
  organizationId: 'example-business',
  customerId: 'example-customer',
  kind: 'invoice',
  status: 'draft',
  issueDate: '2026-10-11',
  dueDate: '',
  title: 'Decimal pricing example',
  items,
  discountPercent: 0,
  placeOfSupply: '09',
  notes: '',
  terms: '',
});

test('equal supported quantity/rate products have the same half-up line amount', () => {
  // Both products are exactly 10.075 in decimal, with two-decimal input rates.
  const first = line(0.5, 20.15);
  const second = line(1.25, 8.06);
  assert.equal(documentSchema.safeParse(documentInput([first, second])).success, true);
  assert.equal(calculateLineAmount(first), 10.08);
  assert.equal(calculateLineAmount(second), 10.08);
  assert.equal(calculateTotals([first, second], 0, false).total, 20.16);
});

test('half-up distinguishes exact ties from values just below a tie', () => {
  for (const [value, expected] of [
    [1.005, 1.01],
    [10.075, 10.08],
    [-10.075, -10.08],
    [10.074999999999998, 10.07],
    [1.0049999999999997, 1],
    [0.005, 0.01],
    [-0.005, -0.01],
    [0.004999999999999999, 0],
  ])
    assert.equal(roundMoney(value), expected, String(value));
  // Receipt validation still rejects fractional paise; it does not round them.
  assert.ok(Number.isNaN(wholePaise(10.075)));
  assert.equal(wholePaise(10.08), 1008);
});

test('decimal inputs in exponent notation keep precision through all operations', () => {
  assert.equal(decimal(1e-7).times(1e8).plus(0.005).round().toNumber(), 10.01);
  assert.equal(decimal(1e21).times(1e-21).toNumber(), 1);
  assert.equal(decimal(1e308).times(1e-308).toNumber(), 1);
  assert.equal(decimal(5e-324).times(1e308).times(1e16).toNumber(), 5);
  assert.equal(decimal(1e-300).minus(5e-301).times(1e300).toNumber(), 0.5);
  assert.equal(calculateLineAmount(line(1e-6, 100000000)), 100);
  assert.equal(decimal(Number.MAX_VALUE).toNumber(), Number.MAX_VALUE);
  assert.equal(decimal(Number.MIN_VALUE).toNumber(), Number.MIN_VALUE);
});

test('invalid editor values do not cause BigInt conversion errors', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, '10.075']) {
    assert.ok(Number.isNaN(roundMoney(value)));
    assert.ok(Number.isNaN(decimal(1).plus(value).times(0.5).round().toNumber()));
  }
  // Keep the existing empty quantity/rate preview fallback.
  assert.equal(calculateLineAmount(line(NaN, 100)), 0);
  assert.equal(calculateLineAmount(line(2, NaN)), 0);
});

test('recurring pricing multiplies units, periods and rate before rounding', () => {
  const recurring = line(0.5, 16.12, 0, { mode: 'recurring', periods: 1.25, periodUnit: 'Month' });
  assert.equal(documentSchema.safeParse(documentInput([recurring])).success, true);
  assert.deepEqual(linePriceBreakdown(recurring), {
    base: 10.08,
    making: 0,
    wastage: 0,
    stones: 0,
    other: 0,
    netWeight: 0,
    periods: 1.25,
    total: 10.08,
  });
});

test('jewellery keeps the exact net weight through each separately rounded charge', () => {
  const jewellery = line(1, 23.85, 0, {
    mode: 'jewellery',
    jewellery: {
      grossWeight: 0.3,
      stoneWeight: 0.2,
      purity: '22K',
      makingChargeType: 'per_gram',
      makingCharge: 5.05,
      wastagePercent: 18,
      stoneAmount: 1.005,
      otherCharges: 0.335,
    },
  });
  assert.equal(documentSchema.safeParse(documentInput([jewellery])).success, true);
  // Net 0.1 g; metal 2.385, making 0.505, wastage 18% of rounded metal 2.39.
  assert.deepEqual(linePriceBreakdown(jewellery), {
    base: 2.39,
    making: 0.51,
    wastage: 0.43,
    stones: 1.01,
    other: 0.34,
    netWeight: 0.1,
    periods: 1,
    total: 4.68,
  });
});

test('percentage and fixed jewellery charges retain their existing bases', () => {
  const pricing = {
    mode: 'jewellery',
    jewellery: {
      grossWeight: 1,
      stoneWeight: 0,
      purity: '',
      makingChargeType: 'percent',
      makingCharge: 5,
      wastagePercent: 5,
      stoneAmount: 0,
      otherCharges: 0,
    },
  };
  const percent = linePriceBreakdown(line(1, 201.5, 0, pricing));
  assert.equal(percent.making, 10.08);
  assert.equal(percent.wastage, 10.08);
  assert.equal(percent.total, 221.66);
  const fixed = linePriceBreakdown(
    line(2, 100, 0, {
      ...pricing,
      jewellery: { ...pricing.jewellery, makingChargeType: 'fixed', makingCharge: 5.0375, wastagePercent: 0 },
    }),
  );
  assert.equal(fixed.base, 200);
  assert.equal(fixed.making, 10.08);
  assert.equal(fixed.total, 210.08);
});

test('mixed-rate GST rounds each line half-up and preserves CGST plus SGST', () => {
  const items = [line(1, 13.25, 18), line(1, 42.7, 5)];
  const totals = calculateTotals(items, 0, false);
  assert.deepEqual(totals, {
    subtotal: 55.95,
    discount: 0,
    taxable: 55.95,
    cgst: 2.27,
    sgst: 2.26,
    igst: 0,
    total: 60.48,
    roundingPolicy: DECIMAL_ROUNDING_POLICY,
  });
  const interstate = calculateTotals(items, 0, true);
  assert.equal(interstate.igst, 4.53);
  assert.equal(interstate.cgst, 0);
  assert.equal(interstate.sgst, 0);
  assert.equal(interstate.total, 60.48);
  assert.equal(wholePaise(totals.cgst) + wholePaise(totals.sgst), wholePaise(interstate.igst));
});

test('discount and tax keep the original document and per-line rounding stages', () => {
  // 2.5% of 403 is 10.075; tax uses 403 × 0.975 × 0.18 = 70.7265.
  assert.deepEqual(calculateTotals([line(1, 403, 18)], 2.5, false), {
    subtotal: 403,
    discount: 10.08,
    taxable: 392.92,
    cgst: 35.37,
    sgst: 35.36,
    igst: 0,
    total: 463.65,
    roundingPolicy: DECIMAL_ROUNDING_POLICY,
  });
  // Three per-line taxes of 0.0054 round to 0.01 each, not an aggregate 0.02.
  const smallLines = Array.from({ length: 3 }, () => line(1, 0.03, 18));
  const small = calculateTotals(smallLines, 0, true);
  assert.equal(small.igst, 0.03);
  assert.equal(small.total, 0.12);
  const fullyDiscounted = calculateTotals([line(1, 13.25, 18)], 100, false);
  assert.equal(fullyDiscounted.total, 0);
  assert.equal(fullyDiscounted.taxable, 0);
  assert.equal(fullyDiscounted.cgst, 0);
  assert.equal(fullyDiscounted.sgst, 0);
});

test('new totals are JSON-safe while unmarked saved document amounts remain legacy', () => {
  const item = line(0.5, 20.15);
  const legacyDocument = { items: [item], totals: { subtotal: 10.07, total: 10.07 } };
  const before = JSON.stringify(legacyDocument);
  assert.equal(documentRoundingPolicy(legacyDocument), LEGACY_ROUNDING_POLICY);
  assert.equal(calculateLineAmount(item, documentRoundingPolicy(legacyDocument)), 10.07);
  const totals = JSON.parse(JSON.stringify(calculateTotals([item], 0, false)));
  assert.equal(documentRoundingPolicy({ totals }), DECIMAL_ROUNDING_POLICY);
  assert.equal(calculateLineAmount(item, documentRoundingPolicy({ totals })), 10.08);
  assert.equal(JSON.stringify(legacyDocument), before);
});
