import { z } from 'zod';

/**
 * API errors show zod messages to users ("field: message"). zod 4 reworded its built-in
 * messages; this keeps the wording users and clients already rely on. Schemas with their
 * own message are unaffected, and issue codes not handled here use zod's default text.
 */
const received = (input) =>
  input === null ? 'null' : Array.isArray(input) ? 'array' : Number.isNaN(input) ? 'nan' : typeof input;

function legacyMessage(issue) {
  // zod 4 reports a missing enum value as invalid_value; zod 3 reported every missing value as Required.
  if ((issue.code === 'invalid_type' || issue.code === 'invalid_value') && issue.input === undefined)
    return 'Required';
  if (issue.code === 'invalid_type' && issue.expected === 'int' && typeof issue.input === 'number')
    return 'Expected integer, received float';
  if (issue.code === 'invalid_type') return `Expected ${issue.expected}, received ${received(issue.input)}`;
  const limit = issue.code === 'too_small' ? issue.minimum : issue.maximum;
  if ((issue.code !== 'too_small' && issue.code !== 'too_big') || typeof limit === 'bigint') return undefined;
  const small = issue.code === 'too_small';
  if (issue.origin === 'number') {
    const relation = issue.exact
      ? 'exactly equal to'
      : small
        ? issue.inclusive
          ? 'greater than or equal to'
          : 'greater than'
        : issue.inclusive
          ? 'less than or equal to'
          : 'less than';
    return `Number must be ${relation} ${limit}`;
  }
  const unit = { string: ['String', 'character(s)'], array: ['Array', 'element(s)'] }[issue.origin];
  if (!unit) return undefined;
  const quantity = issue.exact
    ? 'exactly'
    : small
      ? issue.inclusive
        ? 'at least'
        : issue.origin === 'string'
          ? 'over'
          : 'more than'
      : issue.inclusive
        ? 'at most'
        : issue.origin === 'string'
          ? 'under'
          : 'less than';
  return `${unit[0]} must contain ${quantity} ${limit} ${unit[1]}`;
}

z.config({ customError: legacyMessage });
