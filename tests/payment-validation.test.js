import assert from 'node:assert/strict';
import test from 'node:test';
import { indiaBusinessDate } from '../shared/business-date.js';
import { wholePaise } from '../shared/money.js';
import { installmentPlanSchema, paymentSchema } from '../src/services/validation/validation.js';

const receipt = (amount) => ({
  amount,
  paidOn: '2026-10-10',
  method: 'bank_transfer',
  reference: 'Test receipt',
  notes: '',
  requestId: 'validation-test',
});

test('Receipt amounts require positive whole paise and normalize ordinary decimal noise', () => {
  for (const [input, expectedPaise] of [
    [0.01, 1],
    [0.29, 29],
    [0.1 + 0.2, 30],
    [1.01, 101],
    [1.15, 115],
    [1.1500000000000001, 115],
    [100.01, 10001],
    [1399999999.99, 139999999999],
    [1400000000, 140000000000],
  ]) {
    assert.equal(wholePaise(input), expectedPaise, String(input));
    assert.equal(paymentSchema.parse(receipt(input)).amount, expectedPaise / 100);
  }
  for (const amount of [
    0,
    -0.01,
    1e-9,
    0.001,
    0.005,
    0.010000001,
    1.001,
    1.00000001,
    1400000000.01,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(paymentSchema.safeParse(receipt(amount)).success, false, String(amount));
  }
  assert.equal(Number.isNaN(wholePaise('1.00')), true);
  assert.equal(Number.isNaN(wholePaise(Number.MAX_SAFE_INTEGER)), true);
});

test('Installments use the same whole-paise rule and keep future scheduled dates', () => {
  const plan = (amount) => ({
    name: 'Future installments',
    installments: [{ id: 'first', label: 'First payment', dueDate: '2199-01-01', amount }],
  });
  assert.equal(installmentPlanSchema.parse(plan(0.1 + 0.2)).installments[0].amount, 0.3);
  assert.equal(installmentPlanSchema.parse(plan(0.01)).installments[0].amount, 0.01);
  for (const amount of [0, 1e-9, 0.005, 1.001])
    assert.equal(installmentPlanSchema.safeParse(plan(amount)).success, false, String(amount));
});

test('Indian business dates cross midnight correctly without depending on process timezone', () => {
  assert.equal(indiaBusinessDate('2026-10-10T18:29:59.999Z'), '2026-10-10');
  assert.equal(indiaBusinessDate('2026-10-10T18:30:00.000Z'), '2026-10-11');
  assert.equal(indiaBusinessDate('2026-10-11T00:30:00+05:30'), '2026-10-11');
  assert.equal(indiaBusinessDate('2026-12-31T18:30:00.000Z'), '2027-01-01');
  assert.equal(indiaBusinessDate('2000-02-28T18:30:00.000Z'), '2000-02-29');
  assert.throws(() => indiaBusinessDate(new Date('invalid')), RangeError);
});

test('Public payment input cannot claim a trusted provider timestamp', () => {
  const input = paymentSchema.parse({ ...receipt(1), providerPaidAt: '2026-10-10T19:00:00.000Z' });
  assert.equal(Object.hasOwn(input, 'providerPaidAt'), false);
});
