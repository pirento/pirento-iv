/** Unit tests: recurring invoice dates (month ends, leap days, end dates, limits). */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCalendarDays,
  dueOccurrenceCount,
  recurrenceDate,
  scheduledDate,
  validRecurrenceDate,
} from '../shared/recurrence-dates.js';

test('monthly and quarterly short-month dates retain the original day anchor', () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => recurrenceDate('2025-01-31', 'monthly', index)),
    ['2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30'],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => recurrenceDate('2023-11-30', 'quarterly', index)),
    ['2023-11-30', '2024-02-29', '2024-05-30', '2024-08-30'],
  );
});

test('leap-day annual schedules regain February 29 and weekly schedules cross years', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => recurrenceDate('2024-02-29', 'yearly', index)),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'],
  );
  assert.equal(recurrenceDate('2025-12-28', 'weekly', 1), '2026-01-04');
  assert.equal(addCalendarDays('2024-02-28', 2), '2024-03-01');
});

test('end dates and maximum occurrences are inclusive and never skip a due occurrence', () => {
  const schedule = {
    startDate: '2025-01-31',
    frequency: 'monthly',
    nextIndex: 1,
    endDate: '',
    maxOccurrences: null,
  };
  assert.equal(dueOccurrenceCount(schedule, '2025-02-27'), 0);
  assert.equal(dueOccurrenceCount(schedule, '2025-03-30'), 1);
  assert.equal(dueOccurrenceCount(schedule, '2025-03-31'), 2);
  assert.equal(dueOccurrenceCount({ ...schedule, endDate: '2025-02-28' }, '2026-01-01'), 1);
  assert.equal(scheduledDate({ ...schedule, maxOccurrences: 1 }), null);
  assert.equal(dueOccurrenceCount({ ...schedule, maxOccurrences: 3 }, '2029-12-31'), 2);
  assert.equal(scheduledDate({ ...schedule, endDate: '2025-02-27' }), null);
});

test('invalid dates, unsupported frequencies and range overflow are explicit', () => {
  for (const value of ['2025-02-29', '2025-02-31', '1999-12-31', '2200-01-01', '2026-1-01', '', null])
    assert.equal(validRecurrenceDate(value), false);
  assert.throws(() => recurrenceDate('2025-02-31', 'monthly', 1), RangeError);
  assert.throws(() => recurrenceDate('2025-01-01', 'daily', 1), RangeError);
  assert.throws(() => recurrenceDate('2025-01-01', 'weekly', -1), RangeError);
  assert.equal(recurrenceDate('2199-12-31', 'monthly', 1), null);
  assert.equal(addCalendarDays('2199-12-31', 1), null);
});
