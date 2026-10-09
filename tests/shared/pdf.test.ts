import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import pdfMake from 'pdfmake/build/pdfmake.js';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import {
  amountInWords,
  buildDocumentDefinition,
  documentBusinessIdentity,
  documentColors,
  documentDueDate,
  documentGeometry,
  documentLogo,
  documentSigningBlocks,
  linePricingNote,
  pdfFileName,
} from '../../shared/pdf.ts';
import {
  blankShipping,
  calculateLineAmount,
  calculateTotals,
  COMPANY_NAME,
  defaultDocumentBranding,
  defaultFormatFor,
  installmentBalances,
  money,
  pricingDescription,
} from '../../shared/types.ts';
import { presetFormatsFor } from '../../shared/template-presets.ts';
import type { BusinessDocument, InvoiceFormat, Organization } from '../../shared/types.ts';

const organization: Organization = {
  id: 'pdf-test',
  name: 'Test division',
  legalName: COMPANY_NAME,
  gstin: '27AAPFU0939F1ZV',
  email: 'accounts@example.test',
  phone: '1234567890',
  address: 'First line\nSecond line',
  stateCode: '27',
  accentColor: '#26705b',
  logoUrl: '',
  invoicePrefix: 'TEST',
  quotationPrefix: 'TESTQ',
  bankName: 'Example bank',
  accountName: 'Account holder',
  accountNumber: '123456',
  ifsc: 'TEST0000001',
  terms: '',
  signature: 'Authorized person',
  template: 'modern',
};

function fixture(): BusinessDocument {
  const items = [
    {
      description: 'Consulting & planning',
      hsn: '998399',
      quantity: 3,
      unit: 'Hour',
      rate: 199.99,
      gstRate: 18,
    },
  ];
  return {
    id: 'pdf-test',
    number: 'TEST/2627/0001',
    organizationId: organization.id,
    customerId: 'customer',
    kind: 'invoice',
    status: 'draft',
    issueDate: '2026-10-08',
    dueDate: '2026-11-08',
    title: 'Project details',
    items,
    discountPercent: 10,
    placeOfSupply: '27',
    notes: 'Please quote the invoice number.',
    terms: 'Pay within 30 days.',
    createdAt: '',
    updatedAt: '',
    organizationSnapshot: organization,
    customerSnapshot: {
      id: 'customer',
      organizationId: organization.id,
      name: 'Sample customer',
      email: '',
      phone: '',
      gstin: '',
      address: 'Customer address',
      stateCode: '27',
      contactPerson: '',
    },
    totals: calculateTotals(items, 10, false),
    convertedInvoiceId: null,
    sourceQuotationId: null,
    formatSnapshot: defaultFormatFor(organization),
  };
}

function textValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, child]) =>
      key === 'text' && typeof child === 'string' ? [child.replace(/\u200b/g, '')] : textValues(child),
    );
  return [];
}

async function renderPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const stream = pdfMake.createPdf(definition, undefined, undefined, pdfFonts).getStream();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.end();
  });
}

// Synthetic, solid-color images exercise original dimensions without real company assets.
function syntheticPng(width: number, height: number, color: number): string {
  function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(kind: string, data: Buffer) {
    const name = Buffer.from(kind);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height, color);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

test('Indian amount words cover paise, carry, zero, lakhs and crores', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(amountInWords(0.01), 'Rupees Zero and One Paise Only');
  assert.equal(amountInWords(637.17), 'Rupees Six Hundred Thirty Seven and Seventeen Paise Only');
  assert.equal(amountInWords(999.999), 'Rupees One Thousand Only');
  assert.equal(
    amountInWords(12345678.9),
    'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Ninety Paise Only',
  );
  assert.equal(amountInWords(100000000), 'Rupees Ten Crore Only');
  assert.equal(amountInWords(Number.NaN), 'Amount unavailable');
});

test('each saved layout preserves document values and respects optional sections', () => {
  for (const layout of ['modern', 'classic', 'minimal', 'ledger', 'sidebar'] as InvoiceFormat['layout'][]) {
    const doc = fixture();
    doc.formatSnapshot = { ...doc.formatSnapshot!, layout, footerText: 'Our custom footer' };
    const values = textValues(buildDocumentDefinition(doc).content);
    for (const expected of [
      'TAX INVOICE',
      'TEST/2627/0001',
      COMPANY_NAME,
      'Sample customer',
      'Consulting & planning',
      'Hour',
      '18%',
      'CGST',
      'SGST / UTGST',
      '₹637.17',
      'BANK DETAILS',
      'Authorized person',
      'Our custom footer',
      amountInWords(637.17),
    ])
      assert.ok(values.includes(expected), `${layout}: ${expected}`);
    assert.ok(!values.includes('IGST'));
    doc.formatSnapshot = {
      ...doc.formatSnapshot,
      showHsn: false,
      showUnit: false,
      showGstRate: false,
      showBankDetails: false,
      showSignature: false,
      showAmountInWords: false,
    };
    const hiddenValues = textValues(buildDocumentDefinition(doc).content);
    for (const hidden of [
      'HSN / SAC',
      '998399',
      'Unit',
      'Hour',
      'GST',
      '18%',
      'BANK DETAILS',
      'Authorized person',
      'Authorized signatory',
      'AMOUNT IN WORDS',
    ])
      assert.ok(!hiddenValues.includes(hidden), `${layout}: hides ${hidden}`);
    assert.ok(hiddenValues.includes('₹637.17'), 'hiding columns never alters totals');
  }
});

test('quotation and zero-tax labels never invent GST or bank data', () => {
  const doc = fixture();
  doc.kind = 'quotation';
  doc.items[0].gstRate = 0;
  doc.totals = calculateTotals(doc.items, doc.discountPercent, false);
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    gstin: '',
    bankName: '',
    accountName: '',
    accountNumber: '',
    ifsc: '',
  };
  const values = textValues(buildDocumentDefinition(doc).content);
  assert.ok(values.includes('QUOTATION'));
  assert.ok(values.includes('VALID UNTIL'));
  assert.ok(values.includes('0%'));
  for (const missing of ['TAX INVOICE', 'CGST', 'SGST / UTGST', 'IGST', 'BANK DETAILS'])
    assert.ok(!values.includes(missing));
});

test('PDF filenames cannot create paths and accent colors retain readable text', () => {
  const doc = fixture();
  doc.number = '../TEST/2627\\0001';
  assert.ok(!/[\\/]/.test(pdfFileName(doc)));
  assert.ok(pdfFileName(doc).endsWith('.pdf'));
  assert.equal(documentColors('#ffffff').onAccent, '#000000');
  assert.equal(documentColors('#000000').onAccent, '#ffffff');
  assert.equal(documentColors('invalid').accent, '#26705b');
});

test('PDF generator renders 200 lines with repeated headers, long text and Unicode currency', async () => {
  const doc = fixture();
  doc.items = Array.from({ length: 200 }, (_, index) => ({
    ...doc.items[0],
    description: `Line ${index + 1}: Complete service description with details that wrap across more than one line.`,
    quantity: index + 1,
  }));
  doc.notes = 'Details: ' + 'Long note retained. '.repeat(80);
  doc.terms = 'Term retained. '.repeat(100);
  doc.totals = calculateTotals(doc.items, doc.discountPercent, false);
  const definition = buildDocumentDefinition(doc);
  const content = definition.content as Array<{ table?: { headerRows?: number; body?: unknown[] } }>;
  const table = content.find((node) => node.table?.headerRows === 1)?.table;
  assert.equal(table?.body?.length, 201);
  assert.ok(textValues(definition.content).some((value) => value.startsWith('Line 200:')));
  const buffer = await renderPdf(definition);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.ok(
    (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length > 1,
    'long documents span multiple PDF pages',
  );
  assert.ok(buffer.byteLength > 10000);
});

test('all 15 format presets generate readable PDFs with the selected physical page size', async () => {
  const formats = presetFormatsFor(organization, '2026-10-08T00:00:00Z');
  assert.equal(formats.length, 15);
  for (const format of formats) {
    const doc = fixture();
    doc.formatSnapshot = format;
    const definition = buildDocumentDefinition(doc);
    const geometry = documentGeometry(format);
    assert.equal(definition.pageOrientation, geometry.orientation);
    assert.equal(definition.defaultStyle?.fontSize, geometry.fontSize);
    assert.equal(definition.pageSize, geometry.pageSize);
    const buffer = await renderPdf(definition);
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-', format.name);
    const box = buffer.toString('latin1').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(box, `${format.name}: page dimensions present`);
    assert.ok(Math.abs(Number(box[1]) - (geometry.widthMm * 72) / 25.4) < 0.1, `${format.name}: page width`);
    assert.ok(
      Math.abs(Number(box[2]) - (geometry.heightMm * 72) / 25.4) < 0.1,
      `${format.name}: page height`,
    );
  }
});

test('A4, A5 and Letter both orientations render with extreme valid typography and margins', async () => {
  for (const pageSize of ['A4', 'A5', 'LETTER'] as const)
    for (const orientation of ['portrait', 'landscape'] as const) {
      const doc = fixture();
      doc.formatSnapshot = {
        ...doc.formatSnapshot!,
        pageSize,
        orientation,
        fontSize: 14,
        pageMargin: 24,
        logoWidth: 140,
        tableStyle: 'striped',
      };
      doc.terms = 'Long terms remain complete. '.repeat(160) + 'FINAL TERMS MARKER';
      const definition = buildDocumentDefinition(doc);
      assert.ok(textValues(definition.content).some((value) => value.endsWith('FINAL TERMS MARKER')));
      const buffer = await renderPdf(definition);
      assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
      const box = buffer.toString('latin1').match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
      assert.equal(Number(box[1]) > Number(box[2]), orientation === 'landscape');
    }
});

test('proforma, delivery, partial payments and final invoices carry the correct financial meaning', async () => {
  const doc = fixture();
  doc.kind = 'proforma';
  let values = textValues(buildDocumentDefinition(doc).content);
  assert.ok(values.includes('PROFORMA INVOICE'));
  assert.ok(values.includes('Proforma invoice — not a tax invoice.'));
  assert.ok(!values.includes('Amount received'));
  assert.ok(!values.includes('QUOTATION'));
  doc.kind = 'invoice';
  doc.status = 'partially_paid';
  doc.amountPaid = 100;
  doc.balanceDue = 537.17;
  values = textValues(buildDocumentDefinition(doc).content);
  for (const expected of ['PARTIALLY PAID', 'Amount received', 'Balance due', '₹100.00', '₹537.17'])
    assert.ok(values.includes(expected));
  doc.status = 'paid';
  doc.amountPaid = 637.17;
  doc.balanceDue = 0;
  doc.finalizedAt = '2026-10-08T14:00:00Z';
  values = textValues(buildDocumentDefinition(doc).content);
  assert.ok(values.includes('PAID · FINAL'));
  assert.ok(values.includes('₹0.00'));
  doc.kind = 'delivery_note';
  doc.status = 'dispatched';
  doc.finalizedAt = null;
  doc.shipping = {
    ...blankShipping(),
    recipientName: 'Warehouse recipient',
    address: 'Receiving gate 2',
    carrier: 'Test carrier',
    trackingNumber: 'SHIP-TEST-42',
    vehicleNumber: 'TEST VEHICLE',
    dispatchDate: '2026-10-08',
    reference: 'Order 42',
  };
  const delivery = buildDocumentDefinition(doc);
  values = textValues(delivery.content);
  for (const expected of [
    'DELIVERY CHALLAN',
    'SHIPPING DETAILS',
    'Recipient: Warehouse recipient',
    'Carrier: Test carrier',
    'Tracking no.: SHIP-TEST-42',
    'Reference: Order 42',
    'Qty',
    '3',
    'Hour',
  ])
    assert.ok(values.includes(expected), expected);
  for (const forbidden of [
    'Rate',
    'GST',
    'Amount',
    'Subtotal',
    'Taxable amount',
    'CGST',
    'SGST / UTGST',
    'Total INR',
    'AMOUNT IN WORDS',
    'BANK DETAILS',
    'SCAN TO PAY',
    'Amount received',
    'Balance due',
  ])
    assert.ok(!values.includes(forbidden), `delivery hides ${forbidden}`);
  assert.ok(!values.some((value) => value.includes('₹')));
  assert.equal((await renderPdf(delivery)).subarray(0, 5).toString(), '%PDF-');
});

test('original tall logo, wide signature and QR are embedded without changed pixels or dimensions', async () => {
  const doc = fixture();
  const originalLogo = syntheticPng(30, 52, 120);
  const originalSignature = syntheticPng(96, 31, 160);
  const originalQr = syntheticPng(35, 35, 10);
  const templateLogo = syntheticPng(48, 48, 90);
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    logoUrl: originalLogo,
    signatureImageUrl: originalSignature,
    paymentQrUrl: originalQr,
    pan: 'TESTPAN123',
    cin: 'TEST-COMPANY-ID',
    bankBranch: 'Test branch',
    accountType: 'Current',
  };
  assert.equal(documentLogo(doc), originalLogo);
  const definition = buildDocumentDefinition(doc);
  assert.equal(definition.images?.brandLogo, originalLogo);
  assert.equal(definition.images?.signatureImage, originalSignature);
  assert.equal(definition.images?.paymentQr, originalQr);
  const values = textValues(definition.content);
  for (const expected of [
    'PAN: TESTPAN123',
    'CIN: TEST-COMPANY-ID',
    'Branch: Test branch',
    'Account type: Current',
    'SCAN TO PAY',
    `For ${COMPANY_NAME}`,
  ])
    assert.ok(values.includes(expected));
  const output = (await renderPdf(definition)).toString('latin1');
  for (const width of [30, 96, 35]) assert.match(output, new RegExp(`/Width ${width}\\b`));
  for (const height of [52, 31, 35]) assert.match(output, new RegExp(`/Height ${height}\\b`));
  doc.formatSnapshot = { ...doc.formatSnapshot!, logoUrl: templateLogo };
  assert.equal(documentLogo(doc), templateLogo);
  assert.equal(buildDocumentDefinition(doc).images?.brandLogo, templateLogo);
  doc.formatSnapshot = { ...doc.formatSnapshot, showLogo: false, showSignature: false, showPaymentQr: false };
  assert.deepEqual(buildDocumentDefinition(doc).images, {});
});

test('standard A4 fits three typical lines, shipping, banking and original images on one page', async () => {
  const doc = fixture();
  doc.title = 'Invoice';
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    address: 'Building 12, Example Business Road\nSample City, Example District - 123456',
    pan: 'TESTPAN123',
    cin: 'TEST-COMPANY-REFERENCE-123',
    bankBranch: 'Example Business Branch',
    accountType: 'Current',
    accountName: COMPANY_NAME,
    logoUrl: syntheticPng(30, 52, 90),
    signatureImageUrl: syntheticPng(96, 31, 130),
    paymentQrUrl: syntheticPng(35, 35, 20),
    signature: 'Test Authorized Signatory',
  };
  doc.items = Array.from({ length: 3 }, (_, index) => ({
    ...doc.items[0],
    description: `Service ${index + 1}: project support and planning`,
    quantity: 1,
  }));
  doc.totals = calculateTotals(doc.items, 0, false);
  doc.discountPercent = 0;
  doc.shipping = {
    ...blankShipping(),
    recipientName: 'Sample receiving team',
    address: 'Example receiving address',
    stateCode: '27',
    carrier: 'Example carrier',
    trackingNumber: 'TEST-REFERENCE',
    dispatchDate: '2026-10-08',
    reference: 'Sample order',
  };
  doc.terms =
    'Payment is due by the date shown. Please include the document reference when arranging payment.';
  const definition = buildDocumentDefinition(doc);
  const values = textValues(definition.content);
  assert.ok(!values.includes('SUBJECT'), 'the default title must not repeat as a subject');
  assert.ok(values.includes('Test Authorized Signatory'), 'image caption uses the saved signature label');
  const buffer = await renderPdf(definition);
  assert.equal((buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length, 1);
  doc.title = 'Custom work scope';
  assert.ok(textValues(buildDocumentDefinition(doc).content).includes('Custom work scope'));
});

test('document logo modes respect saved product, format and custom choices without dashboard fallback', () => {
  const doc = fixture();
  const organizationLogo = syntheticPng(10, 12, 10);
  const productLogo = syntheticPng(12, 14, 20);
  const formatLogo = syntheticPng(14, 16, 30);
  const customLogo = syntheticPng(16, 18, 40);
  doc.organizationSnapshot = { ...doc.organizationSnapshot, logoUrl: organizationLogo };
  doc.businessProductSnapshot = {
    id: 'product',
    organizationId: organization.id,
    name: 'Saved business product',
    code: 'TEST',
    description: '',
    logoUrl: productLogo,
    active: true,
    createdAt: '',
    updatedAt: '',
  };
  doc.branding = defaultDocumentBranding(doc.organizationSnapshot);
  assert.equal(documentLogo(doc), productLogo);
  assert.ok(textValues(buildDocumentDefinition(doc).content).includes('Product: Saved business product'));
  doc.formatSnapshot!.logoUrl = formatLogo;
  assert.equal(documentLogo(doc), formatLogo);
  doc.branding.logoMode = 'custom';
  doc.branding.logoUrl = customLogo;
  assert.equal(documentLogo(doc), customLogo);
  doc.branding.logoUrl = '';
  assert.equal(documentLogo(doc), '', 'an empty custom logo never restores another logo');
  doc.branding.logoMode = 'none';
  assert.equal(documentLogo(doc), '');
  assert.equal(buildDocumentDefinition(doc).images?.brandLogo, undefined);
  doc.branding.logoMode = 'inherit';
  doc.formatSnapshot!.logoUrl = '';
  doc.businessProductSnapshot.logoUrl = '';
  assert.equal(documentLogo(doc), organizationLogo);
  doc.organizationSnapshot.logoUrl = '';
  Object.assign(doc, { dashboardLogoUrl: customLogo });
  assert.equal(documentLogo(doc), '', 'dashboard-only logo is never a document fallback');
});

test('recurring and jewellery descriptions explain the same amounts used by financial totals', async () => {
  const doc = fixture();
  doc.items = [
    {
      description: 'Monthly professional support',
      hsn: '998399',
      quantity: 3,
      rate: 2000,
      gstRate: 18,
      unit: 'Person',
      pricing: { mode: 'recurring', periods: 4, periodUnit: 'Month' },
    },
    {
      description: 'Gold jewellery',
      hsn: '7113',
      quantity: 2,
      rate: 6000,
      gstRate: 3,
      unit: 'Piece',
      pricing: {
        mode: 'jewellery',
        jewellery: {
          grossWeight: 10,
          stoneWeight: 1,
          purity: '22K',
          makingChargeType: 'percent',
          makingCharge: 5,
          stoneAmount: 500,
          otherCharges: 100,
          wastagePercent: 2,
        },
      },
    },
  ];
  doc.discountPercent = 0;
  doc.totals = calculateTotals(doc.items, 0, false);
  assert.equal(calculateLineAmount(doc.items[0]), 24000);
  assert.equal(calculateLineAmount(doc.items[1]), 116760);
  const definition = buildDocumentDefinition(doc);
  const values = textValues(definition.content);
  for (const item of doc.items) {
    assert.ok(values.includes(money(calculateLineAmount(item))));
    assert.ok(values.includes(pricingDescription(item)));
  }
  assert.ok(values.includes(money(doc.totals.total)));
  assert.equal((await renderPdf(definition)).subarray(0, 5).toString(), '%PDF-');
  doc.kind = 'delivery_note';
  const deliveryValues = textValues(buildDocumentDefinition(doc).content);
  assert.ok(deliveryValues.includes(linePricingNote(doc, doc.items[1])));
  assert.ok(deliveryValues.some((value) => value.includes('gross 10 g, stone 1 g, net 9 g')));
  assert.ok(
    !deliveryValues.some((value) => value.includes('₹')),
    'challans keep weight details and omit all prices',
  );
});

test('document signature overrides, blank secondary spaces and stamp toggles apply to every preset', async () => {
  const primary = syntheticPng(96, 24, 40);
  const secondary = syntheticPng(82, 26, 100);
  const stamp = syntheticPng(44, 44, 180);
  for (const format of presetFormatsFor(organization)) {
    const doc = fixture();
    doc.formatSnapshot = format;
    doc.organizationSnapshot = { ...doc.organizationSnapshot, signatureImageUrl: syntheticPng(80, 20, 200) };
    doc.branding = {
      ...defaultDocumentBranding(doc.organizationSnapshot),
      logoMode: 'none',
      primarySignatureLabel: 'First authorized person',
      primarySignatureImageUrl: primary,
      secondarySignatureLabel: 'Second authorized person',
      secondarySignatureImageUrl: secondary,
      stampLabel: 'Approved company stamp',
      stampImageUrl: stamp,
    };
    const definition = buildDocumentDefinition(doc);
    assert.equal(definition.images?.signatureImage, primary, format.name);
    assert.equal(definition.images?.secondarySignatureImage, secondary, format.name);
    assert.equal(definition.images?.stampImage, stamp, format.name);
    const values = textValues(definition.content);
    for (const label of [
      'First authorized person',
      'Second authorized person',
      'Approved company stamp',
      `For ${COMPANY_NAME}`,
    ])
      assert.ok(values.includes(label), `${format.name}: ${label}`);
    const buffer = await renderPdf(definition);
    for (const width of [96, 82, 44])
      assert.match(buffer.toString('latin1'), new RegExp(`/Width ${width}\\b`));
    doc.branding.secondarySignatureImageUrl = '';
    doc.branding.stampImageUrl = '';
    const blank = buildDocumentDefinition(doc);
    assert.equal(blank.images?.secondarySignatureImage, undefined);
    assert.equal(blank.images?.stampImage, undefined);
    assert.ok(textValues(blank.content).includes('Second authorized person'));
    doc.formatSnapshot = { ...format, showSecondarySignature: false, showStamp: false };
    assert.deepEqual(
      documentSigningBlocks(doc).map((block) => block.key),
      ['signature'],
    );
    doc.formatSnapshot = { ...format, showSignature: false };
    assert.deepEqual(
      documentSigningBlocks(doc).map((block) => block.key),
      ['secondarySignature', 'stamp'],
    );
    doc.branding.showSecondarySignature = false;
    doc.branding.showStamp = false;
    assert.deepEqual(documentSigningBlocks(doc), []);
  }
});

test('EMI receipts allocate by due date without changing the invoice ledger, with repeated schedule headings', async () => {
  const doc = fixture();
  doc.items = [{ description: 'Project delivery', hsn: '', quantity: 1, rate: 36000, gstRate: 0 }];
  doc.discountPercent = 0;
  doc.totals = calculateTotals(doc.items, 0, false);
  doc.status = 'partially_paid';
  doc.amountPaid = 13000;
  doc.balanceDue = 23000;
  doc.installmentPlan = {
    name: 'Three-part payment plan',
    installments: [
      { id: 'first', label: 'Booking', dueDate: '2020-01-01', amount: 12000 },
      { id: 'second', label: 'Work completion', dueDate: '2020-02-01', amount: 12000 },
      { id: 'third', label: 'Final handover', dueDate: '2099-03-01', amount: 12000 },
    ],
  };
  const originalTotals = { ...doc.totals };
  assert.equal(documentDueDate(doc), '2099-03-01');
  const balances = installmentBalances(doc, '2026-10-08');
  assert.deepEqual(
    balances.map((entry) => [entry.amountPaid, entry.balanceDue, entry.status]),
    [
      [12000, 0, 'paid'],
      [1000, 11000, 'overdue'],
      [0, 12000, 'pending'],
    ],
  );
  const definition = buildDocumentDefinition(doc);
  const values = textValues(definition.content);
  for (const expected of [
    'PAYMENT SCHEDULE / EMI',
    'Three-part payment plan',
    'Booking',
    'Work completion',
    'Final handover',
    '₹1,000.00',
    '₹11,000.00',
    'Paid',
    'Overdue',
    'Pending',
    'FINAL INSTALLMENT',
    '₹36,000.00',
    '₹13,000.00',
    '₹23,000.00',
  ])
    assert.ok(values.includes(expected), expected);
  assert.deepEqual(doc.totals, originalTotals);
  assert.equal(doc.dueDate, '2026-11-08', 'schedule rendering never changes the saved original due date');
  assert.equal((await renderPdf(definition)).subarray(0, 5).toString(), '%PDF-');
  doc.installmentPlan = {
    name: 'Long monthly plan',
    installments: Array.from({ length: 120 }, (_, index) => ({
      id: `term-${index}`,
      label: `Installment ${index + 1}`,
      dueDate: `2099-${String((index % 12) + 1).padStart(2, '0')}-01`,
      amount: 300,
    })),
  };
  const long = buildDocumentDefinition(doc);
  const schedule = (long.content as Array<{ table?: { headerRows?: number; body?: unknown[] } }>).find(
    (node) => node.table?.headerRows === 2,
  )?.table;
  assert.equal(schedule?.body?.length, 122);
  const buffer = await renderPdf(long);
  assert.ok((buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length > 2);
  assert.ok(textValues(long.content).includes('Installment 120'));
  doc.kind = 'delivery_note';
  assert.ok(!textValues(buildDocumentDefinition(doc).content).includes('PAYMENT SCHEDULE / EMI'));
});

test('independent sellers keep their own trade, proprietor, GST, support and payment identity in every document kind', () => {
  const independent: Organization = {
    ...organization,
    id: 'independent-shop',
    name: 'Example Jewellers',
    legalName: 'Example Proprietor',
    tradeName: 'Example Jewellery Trading',
    businessType: 'independent',
    businessConstitution: 'Proprietorship',
    gstin: '09ABCDE1234F1Z5',
    stateCode: '09',
    address: 'Saved shop address',
    supportEmail: 'help@jeweller.example.test',
    email: 'accounts@jeweller.example.test',
    accountName: 'Example Jewellery Trading',
    accountNumber: '987654',
    bankName: 'Jeweller bank',
    paymentQrUrl: syntheticPng(25, 25, 80),
  };
  for (const kind of ['invoice', 'quotation', 'proforma', 'delivery_note'] as const) {
    const doc = fixture();
    doc.kind = kind;
    doc.organizationId = independent.id;
    doc.organizationSnapshot = structuredClone(independent);
    doc.shipping = {
      ...blankShipping(),
      address: 'Saved shipping destination',
      recipientName: 'Saved recipient',
    };
    const definition = buildDocumentDefinition(doc);
    const values = textValues(definition.content);
    for (const expected of [
      'Example Jewellers',
      'Trade name: Example Jewellery Trading',
      'Proprietor',
      'Example Proprietor',
      'Proprietor: Example Proprietor',
      'GSTIN: 09ABCDE1234F1Z5',
      'Support: help@jeweller.example.test',
      'accounts@jeweller.example.test',
      'For Example Jewellery Trading',
      'Address: Saved shipping destination',
      'Recipient: Saved recipient',
    ])
      assert.ok(values.includes(expected), `${kind}: ${expected}`);
    for (const forbidden of [
      COMPANY_NAME,
      'A division of',
      'Support: support@pirento.com',
      organization.gstin,
      `Account no.: ${organization.accountNumber}`,
    ])
      assert.ok(!values.some((value) => value.includes(forbidden)), `${kind}: excludes ${forbidden}`);
    assert.equal(definition.info?.author, independent.legalName);
    if (kind !== 'delivery_note') {
      assert.ok(values.includes('Account no.: 987654'));
      assert.equal(definition.images?.paymentQr, independent.paymentQrUrl);
    } else assert.equal(definition.images?.paymentQr, undefined);
    assert.equal(typeof definition.footer, 'function');
    if (typeof definition.footer === 'function')
      assert.ok(
        textValues(definition.footer(1, 1, { width: 595, height: 842, orientation: 'portrait' })).includes(
          independent.tradeName!,
        ),
      );
  }
});

test('support defaults and division labels are separate from seller contact addresses and saved legacy identities', () => {
  const doc = fixture();
  assert.equal(documentBusinessIdentity(doc).supportEmail, 'support@pirento.com');
  assert.ok(textValues(buildDocumentDefinition(doc).content).includes('A division of'));
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    id: 'shri-sarraf',
    businessType: 'independent',
    legalName: 'Saved historical legal entity',
    email: 'billing@example.test',
  };
  let values = textValues(buildDocumentDefinition(doc).content);
  assert.ok(values.includes('Support: support@shrisarraf.com'));
  assert.ok(values.includes('billing@example.test'));
  assert.ok(values.includes('Legal name'));
  assert.ok(values.includes('Saved historical legal entity'));
  assert.ok(!values.includes('A division of'));
  assert.equal(
    doc.organizationSnapshot.gstin,
    organization.gstin,
    'rendering never replaces a historical GST snapshot',
  );
  doc.organizationSnapshot.supportEmail = 'saved-support@example.test';
  values = textValues(buildDocumentDefinition(doc).content);
  assert.ok(values.includes('Support: saved-support@example.test'));
  assert.ok(!values.includes('Support: support@shrisarraf.com'));
});

test('organization edits cannot change issued document seller, registration, support, bank or QR snapshots', () => {
  const current = structuredClone(organization);
  Object.assign(current, {
    tradeName: 'Saved trading name',
    supportEmail: 'saved-support@example.test',
    paymentQrUrl: syntheticPng(24, 24, 30),
    gstRegistrations: [
      {
        id: 'saved-branch',
        label: 'Saved branch',
        gstin: '09ABCDE1234F1Z5',
        stateCode: '09',
        address: 'Saved branch address',
      },
    ],
  });
  const doc = fixture();
  doc.status = 'sent';
  const registration = current.gstRegistrations![0];
  doc.organizationSnapshot = {
    ...structuredClone(current),
    gstin: registration.gstin,
    stateCode: registration.stateCode,
    address: registration.address,
  };
  const original = buildDocumentDefinition(doc);
  Object.assign(current, {
    legalName: 'New legal entity',
    tradeName: 'New trading name',
    gstin: '29NEWGSTVALUE',
    supportEmail: 'new-support@example.test',
    accountNumber: '999999',
    paymentQrUrl: syntheticPng(36, 36, 190),
  });
  current.gstRegistrations![0].address = 'Changed branch address';
  const afterEdit = buildDocumentDefinition(doc);
  assert.equal(JSON.stringify(afterEdit.content), JSON.stringify(original.content));
  assert.deepEqual(afterEdit.images, original.images);
  assert.deepEqual(afterEdit.info, original.info);
  const values = textValues(afterEdit.content);
  for (const expected of [
    'GSTIN: 09ABCDE1234F1Z5',
    'Saved branch address',
    'Support: saved-support@example.test',
    'Account no.: 123456',
  ])
    assert.ok(values.includes(expected));
  assert.ok(
    !values.some((value) =>
      /New legal entity|New trading name|Changed branch address|new-support/.test(value),
    ),
  );
});

test('long independent trade and legal names remain renderable across all 15 saved templates', async () => {
  const doc = fixture();
  doc.organizationSnapshot = {
    ...doc.organizationSnapshot,
    businessType: 'independent',
    businessConstitution: 'Proprietorship',
    legalName: 'Example proprietor with a long registered legal name',
    tradeName: 'Example Independent Jewellery and Precious Metals Trading Business With A Long Trade Name',
    name: 'Example Independent Jewellery Business',
    supportEmail: 'long-support-address@example.test',
  };
  for (const format of presetFormatsFor(doc.organizationSnapshot)) {
    doc.formatSnapshot = format;
    const definition = buildDocumentDefinition(doc);
    assert.ok(textValues(definition.content).includes(`Trade name: ${doc.organizationSnapshot.tradeName}`));
    assert.ok(textValues(definition.content).includes(doc.organizationSnapshot.legalName));
    assert.equal((await renderPdf(definition)).subarray(0, 5).toString(), '%PDF-', format.name);
  }
});
