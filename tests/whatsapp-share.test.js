/** Unit tests: the WhatsApp share link on the document preview (whatsappShareUrl in view-helpers.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { whatsappShareUrl } from '../src/controllers/pages/view-helpers.js';

const invoice = (phone, extra = {}) => ({
  kind: 'invoice',
  number: 'INV-1',
  dueDate: '2026-10-31',
  totals: { total: 1180 },
  balanceDue: 1180,
  organizationSnapshot: { name: 'Shop' },
  customerSnapshot: { phone },
  ...extra,
});
const parse = (url) => {
  const parsed = new URL(url);
  return { phone: parsed.pathname.slice(1), text: parsed.searchParams.get('text') };
};

test('Indian mobile numbers get the 91 country code; other forms are cleaned or left to WhatsApp', () => {
  assert.equal(parse(whatsappShareUrl(invoice('98765 43210'))).phone, '919876543210');
  assert.equal(parse(whatsappShareUrl(invoice('09876543210'))).phone, '919876543210');
  assert.equal(parse(whatsappShareUrl(invoice('+91 98765-43210'))).phone, '919876543210');
  assert.equal(parse(whatsappShareUrl(invoice(''))).phone, '');
  assert.equal(parse(whatsappShareUrl(invoice('12345'))).phone, '');
});

test('the message carries the number, amount, balance, due date and payment link', () => {
  const full = parse(whatsappShareUrl(invoice('9876543210'))).text.split('\n');
  assert.deepEqual(full, ['Invoice INV-1 from Shop', 'Amount: ₹1,180.00', 'Due date: 31 Oct 2026']);
  const partly = parse(whatsappShareUrl(invoice('9876543210', { balanceDue: 680 }), 'https://rzp.io/x')).text;
  assert.match(partly, /Balance due: ₹680\.00/);
  assert.match(partly, /Pay online: https:\/\/rzp\.io\/x$/);
  const quotation = parse(whatsappShareUrl(invoice('9876543210', { kind: 'quotation' }))).text;
  assert.match(quotation, /^Quotation INV-1 from Shop\nAmount: ₹1,180\.00\nValid until: 31 Oct 2026$/);
});
