/** Unit tests: payment reminder dates, targets, policy validation, eligibility and de-duplication keys. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { indiaBusinessDate } from '../shared/business-date.js';
import {
  defaultReminderPolicy,
  isReminderDate,
  reminderDate,
  reminderEligibility,
  reminderEventKey,
  reminderOffsetsSchema,
  reminderTargets,
} from '../src/services/integrations/email/reminder-rules.js';

const invoice = (extra = {}) => ({
  id: 'invoice-a',
  organizationId: 'business-a',
  kind: 'invoice',
  number: 'INV/001',
  status: 'sent',
  dueDate: '2026-10-10',
  totals: { total: 100 },
  customerSnapshot: { name: 'Buyer', email: 'buyer@example.test' },
  ...extra,
});
const manual = (extra = {}) => ({
  automatic: false,
  installmentId: null,
  dueDate: '2026-10-10',
  scheduledFor: '2026-10-10',
  ...extra,
});

test('Reminder dates use Indian business days and handle month/year/leap boundaries', () => {
  assert.equal(indiaBusinessDate('2026-10-09T20:00:00.000Z'), '2026-10-10');
  assert.equal(reminderDate('2026-01-01', -3), '2025-12-29');
  assert.equal(reminderDate('2024-03-01', -1), '2024-02-29');
  assert.equal(reminderDate('2026-10-31', 3), '2026-11-03');
  assert.equal(isReminderDate('2026-02-29'), false);
  assert.equal(isReminderDate('2026-10-10T00:00:00Z'), false);
});

test('Reminder targets use exact existing installment allocation and exclude paid balances', () => {
  const targets = reminderTargets(
    invoice({
      status: 'partially_paid',
      amountPaid: 75,
      balanceDue: 25,
      installmentPlan: {
        name: '70/20/10',
        installments: [
          { id: 'third', label: 'Final', dueDate: '2026-11-01', amount: 10 },
          { id: 'first', label: 'Initial', dueDate: '2026-10-09', amount: 70 },
          { id: 'second', label: 'Second', dueDate: '2026-10-10', amount: 20 },
        ],
      },
    }),
    '2026-10-10',
  );
  assert.deepEqual(
    targets.map((row) => [row.installmentId, row.balanceDue, row.status]),
    [
      ['second', 15, 'due_today'],
      ['third', 10, 'upcoming'],
    ],
  );
  assert.ok(targets.every((row) => row.invoiceBalance === 25 && row.canSend));
  for (const extra of [
    { status: 'paid' },
    { status: 'cancelled' },
    { status: 'draft' },
    { kind: 'quotation' },
    { balanceDue: 0 },
    { dueDate: '' },
  ])
    assert.deepEqual(reminderTargets(invoice(extra), '2026-10-10'), []);
  const missingEmail = reminderTargets(
    invoice({ customerSnapshot: { name: 'Buyer', email: '' } }),
    '2026-10-11',
  )[0];
  assert.equal(missingEmail.status, 'overdue');
  assert.equal(missingEmail.canSend, false);
});

test('Automatic reminder policies start disabled and validate a bounded, unique schedule', () => {
  assert.equal(defaultReminderPolicy('business-a').enabled, false);
  assert.deepEqual(reminderOffsetsSchema.parse([7, -3, 0, 3]), [-3, 0, 3, 7]);
  for (const offsets of [[], [0, 0], [-31], [91], [0.5], Array.from({ length: 13 }, (_, i) => i)])
    assert.equal(reminderOffsetsSchema.safeParse(offsets).success, false);
});

test('Eligibility rejects paid targets, changed due dates and obsolete automatic policy revisions', () => {
  const policy = {
    ...defaultReminderPolicy('business-a'),
    enabled: true,
    version: 1,
    effectiveFrom: '2026-10-10',
  };
  const automatic = manual({ automatic: true, offset: 0, policyVersion: 1 });
  assert.equal(reminderEligibility(invoice(), automatic, policy, '2026-10-10').reason, '');
  for (const changedPolicy of [
    { ...policy, enabled: false },
    { ...policy, version: 2 },
    { ...policy, offsets: [3] },
  ])
    assert.match(reminderEligibility(invoice(), automatic, changedPolicy, '2026-10-10').reason, /policy/);
  assert.match(
    reminderEligibility(invoice({ dueDate: '2026-10-11' }), manual(), null, '2026-10-10').reason,
    /due date/,
  );
  assert.match(
    reminderEligibility(invoice({ balanceDue: 0 }), manual(), null, '2026-10-10').reason,
    /outstanding/,
  );
  // Queued, still-payable messages can be prepared on the next day; the scheduler does not backfill missed events.
  assert.equal(reminderEligibility(invoice(), automatic, policy, '2026-10-11').reason, '');
});

test('Reminder dedup keys distinguish businesses, targets, due dates and rules', () => {
  const args = ['business-a', 'invoice-a', null, '2026-10-10', true, 0];
  const key = reminderEventKey(...args);
  assert.equal(key, reminderEventKey(...args));
  for (const [index, value] of [
    [0, 'business-b'],
    [1, 'invoice-b'],
    [2, 'installment-a'],
    [3, '2026-10-11'],
    [5, 3],
  ]) {
    const changed = [...args];
    changed[index] = value;
    assert.notEqual(key, reminderEventKey(...changed));
  }
  assert.notEqual(
    reminderEventKey(...args),
    reminderEventKey('business-a', 'invoice-a', null, '2026-10-10', false, '2026-10-10'),
  );
});
