import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import '../src/services/validation/messages.js';
import { createApiErrorHandler } from '../src/middleware/api-errors.js';

const message = (schema, value) => schema.safeParse(value).error.issues[0].message;

test('built-in validation messages keep the wording the API has always returned', () => {
  assert.equal(message(z.object({ name: z.string() }), {}), 'Required');
  assert.equal(message(z.object({ kind: z.enum(['invoice']) }), {}), 'Required');
  assert.equal(message(z.string(), 5), 'Expected string, received number');
  assert.equal(message(z.number(), null), 'Expected number, received null');
  assert.equal(message(z.number().int(), 1.5), 'Expected integer, received float');
  assert.equal(message(z.string().max(3), 'abcd'), 'String must contain at most 3 character(s)');
  assert.equal(message(z.string().min(2), 'a'), 'String must contain at least 2 character(s)');
  assert.equal(message(z.number().max(5), 9), 'Number must be less than or equal to 5');
  assert.equal(message(z.number().positive(), 0), 'Number must be greater than 0');
  assert.equal(message(z.array(z.string()).min(1), []), 'Array must contain at least 1 element(s)');
  assert.equal(message(z.string().min(1, 'This field is required.'), ''), 'This field is required.');
});

test('invalid choices are reported without echoing the submitted value', () => {
  const schema = z.object({ kind: z.enum(['invoice', 'quotation']), status: z.enum(['draft']) });
  let body;
  const res = { headersSent: false, status: () => res, json: (payload) => (body = payload) };
  createApiErrorHandler(() => {})(schema.safeParse({ kind: 'SECRET_VALUE' }).error, {}, res, () => {});
  assert.equal(body.error, 'kind: Choose one of the supported values. status: Required');
  assert.doesNotMatch(body.error, /SECRET_VALUE/);
});
