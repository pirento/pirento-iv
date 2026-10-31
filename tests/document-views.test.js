/** Unit tests: server-rendered document preview, editor, payment and email pages (EJS output). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { helpers } from '../src/controllers/pages/view-helpers.js';
import { buildDocumentDefinition } from '../shared/pdf.js';

const root = fileURLToPath(new URL('../views/', import.meta.url));
function fixture(kind = 'invoice', layout = 'modern') {
  const organization = {
    id: 'test-business',
    name: 'Example Elevator',
    legalName: 'Example Services',
    businessType: 'independent',
    billingProfile: 'elevator',
    enableProductSelection: true,
    gstin: '09ABCDE1234F1Z5',
    stateCode: '09',
    address: 'Saved seller address',
    email: 'billing@example.invalid',
    supportEmail: 'support@example.invalid',
    phone: '',
    logoUrl: '',
    signature: 'Authorised Signatory',
    signatureImageUrl: '',
    paymentQrUrl: '',
    bankName: 'Example Bank',
    accountName: 'Example Services',
    accountNumber: '123456789',
    ifsc: 'TEST0000123',
    terms: 'Payment on the agreed dates.',
    template: 'modern',
    accentColor: '#26705b',
    invoicePrefix: 'INV',
    quotationPrefix: 'QUO',
  };
  const customer = {
    id: 'test-customer',
    organizationId: organization.id,
    name: 'Saved Customer',
    email: 'customer@example.invalid',
    phone: '',
    gstin: '',
    address: 'Saved customer address',
    stateCode: '09',
    contactPerson: '',
    roles: ['customer'],
    active: true,
  };
  const line = {
    description: 'Maintenance services',
    hsn: '9987',
    quantity: 5,
    unit: 'Lift',
    rate: kind === 'delivery_note' ? 0 : 60000,
    gstRate: kind === 'delivery_note' ? 0 : 18,
    ...(kind !== 'delivery_note' ? { pricing: { mode: 'recurring', periods: 1, periodUnit: 'Year' } } : {}),
  };
  const format = {
    ...helpers.defaultFormatFor(organization),
    id: 'saved-format',
    name: 'Saved format',
    layout,
  };
  const document = {
    id: 'test-document',
    organizationId: organization.id,
    kind,
    number: 'TEST/2026/001',
    status: 'sent',
    customerId: customer.id,
    customerSnapshot: customer,
    organizationSnapshot: organization,
    title: 'Maintenance agreement',
    items: [line],
    totals: helpers.calculateTotals([line], 0, false),
    issueDate: '2026-10-10',
    dueDate: '2026-11-10',
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: organization.terms,
    formatId: format.id,
    formatSnapshot: format,
    branding: helpers.defaultDocumentBranding(organization),
    shipping: helpers.blankShipping(),
    createdAt: '2026-10-10T12:00:00Z',
    updatedAt: '2026-10-10T12:00:00Z',
    amountPaid: 0,
    finalizedAt: null,
  };
  return {
    organization,
    organizations: [organization],
    route: {
      organizationId: organization.id,
      view: helpers.documentViews[kind],
      action: 'preview',
      id: document.id,
    },
    user: { id: 'test-user', name: 'Test user', role: 'admin' },
    customers: [customer],
    catalog: [],
    formats: [format],
    businessProducts: [],
    documents: [document],
    document,
  };
}
const render = (view, data) => ejs.renderFile(`${root}${view}.ejs`, { data, helpers });

test('all original document kinds render their correct financial or shipping fields on the server', async () => {
  for (const kind of ['invoice', 'quotation', 'proforma', 'delivery_note']) {
    const data = fixture(kind);
    const html = await render('documents/preview', data);
    assert.match(html, /Saved seller address/);
    assert.match(html, /Saved customer address/);
    assert.match(html, /Maintenance services/);
    assert.match(html, /TEST\/2026\/001/);
    if (kind === 'delivery_note') {
      assert.doesNotMatch(html, /<th class="doc-align-right">Rate<\/th>/);
      assert.doesNotMatch(html, /<span>Taxable amount<\/span>/);
    } else {
      assert.ok(html.includes(helpers.money(354000)));
      assert.match(html, /CGST/);
      assert.match(html, /SGST \/ UTGST/);
    }
    if (kind === 'proforma') assert.match(html, /not a tax invoice/);
    if (kind === 'quotation') assert.match(html, /Convert to invoice/);
  }
});

test('preview uses saved identity and format while supporting all five layouts', async () => {
  for (const layout of ['modern', 'classic', 'minimal', 'ledger', 'sidebar']) {
    const data = fixture('invoice', layout);
    data.organization = { ...data.organization, address: 'Changed current organization address' };
    data.document.formatSnapshot = {
      ...data.document.formatSnapshot,
      pageSize: 'A5',
      orientation: 'landscape',
      pageMargin: 12,
      showHsn: false,
      showUnit: false,
      showGstRate: false,
    };
    const html = await render('documents/preview', data);
    assert.match(html, new RegExp(`doc-template-${layout}`));
    assert.match(html, /size:\s*A5\s+landscape/);
    assert.match(html, /Saved seller address/);
    assert.doesNotMatch(html, /Changed current organization address/);
    assert.doesNotMatch(html, /<th>HSN \/ SAC<\/th>/);
    assert.doesNotMatch(html, /<th>Unit<\/th>/);
  }
});

test('document templates escape saved customer content and render editable form controls without React', async () => {
  const data = fixture();
  data.document.customerSnapshot = { ...data.document.customerSnapshot, name: '<script>alert("x")</script>' };
  data.document.notes = '<img src=x onerror=alert(1)>';
  const preview = await render('documents/preview', data);
  assert.doesNotMatch(preview, /<script>alert/);
  assert.doesNotMatch(preview, /<img src=x/);
  assert.match(preview, /&lt;script&gt;/);
  data.route.action = 'edit';
  const editor = await render('documents/editor', data);
  assert.match(editor, /name="customerId" disabled/);
  assert.match(editor, /data-line="quantity"/);
  assert.match(editor, /data-pricing="periods"/);
  assert.match(editor, /data-shipping="trackingNumber"/);
  assert.match(editor, /data-brand-upload="secondarySignatureImageUrl"/);
  assert.doesNotMatch(editor, /createRoot|ReactDOM|jsx/);
});

test('payment and email pages contain server-rendered balances and initially safe action gating', async () => {
  const data = fixture();
  data.route.action = 'payments';
  const payments = await render('payments/panel', data);
  assert.ok(payments.includes(helpers.money(354000)));
  assert.match(payments, /id="payment-record-fields" disabled/);
  assert.match(payments, /Use 70% \/ 20% \/ 10%/);
  assert.match(payments, /name="withDownPayment"/);
  data.route.action = 'email';
  const email = await render('documents/email', data);
  assert.match(email, /customer@example.invalid/);
  assert.match(email, /id="messaging-send"[^>]*disabled/);
  assert.match(email, /PDF attachment/);
});

test('a document on the letterhead puts its content in the blank area in the preview and PDF', async () => {
  const image =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  for (const kind of ['invoice', 'quotation', 'delivery_note']) {
    const data = fixture(kind);
    data.document.letterhead = { image, top: 45, bottom: 30, left: 15, right: 20 };
    const html = await render('documents/preview', data);
    assert.match(html, /class="doc-paper [^"]*doc-on-letterhead"/);
    assert.match(html, /--doc-lh-top:45mm;--doc-lh-right:20mm;--doc-lh-bottom:30mm;--doc-lh-left:15mm/);
    assert.doesNotMatch(html, /data-preview-action="print"/, 'letterhead documents print through the PDF');
    const definition = buildDocumentDefinition(data.document);
    const mm = 72 / 25.4;
    assert.deepEqual(
      definition.pageMargins.map((value) => Math.round(value / mm)),
      [15, 45, 20, 30],
    );
    assert.equal(definition.images.letterhead, image);
    assert.equal(definition.footer, undefined);
    assert.equal(definition.background().image, 'letterhead');
  }
  const plain = buildDocumentDefinition(fixture('invoice').document);
  assert.equal(plain.images.letterhead, undefined);
  assert.equal(typeof plain.footer, 'function');
});
