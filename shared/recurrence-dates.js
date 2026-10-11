/** Calendar recurrence dates share the document editor's supported 2000–2199 range. */
export const RECURRENCE_LABELS = Object.freeze({
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
});

const dayMilliseconds = 86_400_000;
const monthSteps = { monthly: 1, quarterly: 3, yearly: 12 };

export function validRecurrenceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < '2000-01-01' || value > '2199-12-31') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireDate(value) {
  if (!validRecurrenceDate(value)) throw new RangeError('Use a valid calendar date between 2000 and 2199.');
}

export function addCalendarDays(value, days) {
  requireDate(value);
  if (!Number.isSafeInteger(days)) throw new RangeError('Use a whole number of calendar days.');
  const date = new Date(Date.parse(`${value}T00:00:00Z`) + days * dayMilliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  const result = date.toISOString().slice(0, 10);
  return validRecurrenceDate(result) ? result : null;
}

/**
 * Always calculate from the original anchor, never from the previous shortened month.
 * January 31 -> February 28/29 -> March 31; a leap-day yearly anchor returns on leap years.
 * null means that the next occurrence is outside the supported document date range.
 */
export function recurrenceDate(anchorDate, frequency, index) {
  requireDate(anchorDate);
  if (!Object.hasOwn(RECURRENCE_LABELS, frequency)) throw new RangeError('Choose a supported recurrence.');
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Use a nonnegative occurrence index.');
  if (frequency === 'weekly') return addCalendarDays(anchorDate, index * 7);
  const [year, month, day] = anchorDate.split('-').map(Number);
  const absoluteMonth = year * 12 + month - 1 + monthSteps[frequency] * index;
  const nextYear = Math.floor(absoluteMonth / 12);
  if (nextYear > 2199) return null;
  const nextMonth = absoluteMonth % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function scheduledDate(schedule, index = schedule.nextIndex) {
  if (
    schedule.maxOccurrences !== null &&
    schedule.maxOccurrences !== undefined &&
    index >= schedule.maxOccurrences
  )
    return null;
  const date = recurrenceDate(schedule.startDate, schedule.frequency, index);
  return date && (!schedule.endDate || date <= schedule.endDate) ? date : null;
}

/** Count due occurrences arithmetically, including a failed occurrence that has not advanced. */
export function dueOccurrenceCount(schedule, businessDate) {
  requireDate(businessDate);
  const nextDate = scheduledDate(schedule);
  const through = schedule.endDate && schedule.endDate < businessDate ? schedule.endDate : businessDate;
  if (!nextDate || nextDate > through) return 0;
  let lastIndex;
  if (schedule.frequency === 'weekly') {
    lastIndex = Math.floor(
      (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${schedule.startDate}T00:00:00Z`)) /
        (7 * dayMilliseconds),
    );
  } else {
    const [startYear, startMonth] = schedule.startDate.split('-').map(Number);
    const [endYear, endMonth] = through.split('-').map(Number);
    lastIndex = Math.floor(
      ((endYear - startYear) * 12 + endMonth - startMonth) / monthSteps[schedule.frequency],
    );
    if (recurrenceDate(schedule.startDate, schedule.frequency, lastIndex) > through) lastIndex -= 1;
  }
  if (schedule.maxOccurrences !== null && schedule.maxOccurrences !== undefined)
    lastIndex = Math.min(lastIndex, schedule.maxOccurrences - 1);
  return Math.max(0, lastIndex - schedule.nextIndex + 1);
}
