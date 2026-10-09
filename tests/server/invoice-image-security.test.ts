import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderInvoiceAttachment } from '../../server/documents/invoice-pdf.ts';
import { initDb } from '../../server/db/db.ts';
import { defaultDocumentBranding, type BusinessDocument, type Organization } from '../../shared/types.ts';

function document(logo: string): BusinessDocument {
  const db = initDb(':memory:');
  const row = db.prepare('SELECT data FROM organizations WHERE id = ?').get('shri-sarraf') as {
    data: string;
  };
  const organization: Organization = { ...JSON.parse(row.data), logoUrl: logo };
  db.close();
  return {
    id: 'image-fixture',
    number: 'IMAGE/26/1',
    kind: 'invoice',
    status: 'draft',
    organizationId: organization.id,
    organizationSnapshot: organization,
    customerId: 'synthetic-customer',
    customerSnapshot: {
      id: 'synthetic-customer',
      organizationId: organization.id,
      name: 'Synthetic customer',
      email: '',
      phone: '',
      gstin: '',
      address: '',
      stateCode: '09',
      contactPerson: '',
    },
    issueDate: '2026-10-08',
    dueDate: '',
    title: 'Image safety fixture',
    items: [{ description: 'Fixture item', quantity: 1, rate: 100, gstRate: 0, hsn: '' }],
    discountPercent: 0,
    placeOfSupply: '09',
    notes: '',
    terms: '',
    totals: { subtotal: 100, discount: 0, taxable: 100, cgst: 0, sgst: 0, igst: 0, total: 100 },
    sourceQuotationId: null,
    convertedInvoiceId: null,
    createdAt: '',
    updatedAt: '',
    branding: defaultDocumentBranding(organization),
  };
}
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('email PDFs reject oversized PNG and JPEG dimensions before a decoder allocates their advertised pixel buffers', async () => {
  // Header-only adversarial fixtures avoid allocating any large images in the test.
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  png.writeUInt32BE(5000, 16);
  png.writeUInt32BE(5000, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  const jpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
    .jpeg()
    .toBuffer();
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  jpeg.writeUInt16BE(5000, sof + 5);
  jpeg.writeUInt16BE(5000, sof + 7);
  for (const [mime, bytes] of [
    ['png', png],
    ['jpeg', jpeg],
  ] as const) {
    assert.ok(bytes.length < 1024);
    await assert.rejects(
      renderInvoiceAttachment(document(`data:image/${mime};base64,${bytes.toString('base64')}`)),
      /pixel limit|megapixel/i,
    );
  }
});

test('ordinary uploaded PNG, JPEG and WebP still generate PDFs while JPEG bytes remain unchanged', async () => {
  for (const mime of ['png', 'jpeg', 'webp'] as const) {
    const pipeline = sharp({ create: { width: 12, height: 8, channels: 3, background: '#204038' } });
    const bytes = await pipeline[mime]().toBuffer();
    const result = await renderInvoiceAttachment(
      document(`data:image/${mime};base64,${bytes.toString('base64')}`),
    );
    const pdf = Buffer.from(result.content, 'base64');
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.toString('latin1'), /\/Width 12/);
    assert.match(pdf.toString('latin1'), /\/Height 8/);
    if (mime === 'jpeg')
      assert.equal(
        pdf.includes(bytes),
        true,
        'accepted JPEG is embedded without rewriting the original asset',
      );
  }
});
