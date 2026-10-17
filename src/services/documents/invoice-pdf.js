/**
 * Server-side invoice PDF, attached to invoice emails. Uses the same document layout as the
 * browser's "Download PDF" (shared/pdf.js). Uploaded images are checked with sharp and WebP is
 * converted to PNG; the PDF is limited to 15 MB.
 */

import pdfmake from 'pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import sharp from 'sharp';
import {
  buildDocumentDefinition,
  documentLogo,
  documentSigningBlocks,
  pdfFileName,
} from '../../../shared/pdf.js';
import { getDocumentFormat } from '../../../shared/types.js';

// Fonts come from pdfmake's bundled virtual file system and images are inline data, so the
// renderer never needs the network or local files (pdfmake 0.3 can fetch both by default).
for (const [name, data] of Object.entries(pdfFonts))
  pdfmake.virtualfs.writeFileSync(name, Buffer.from(data, 'base64'));
pdfmake.setFonts({
  Roboto: {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf',
  },
});
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);

/** Renders a saved document to { filename, content (base64 PDF) }. */
export async function renderInvoiceAttachment(doc) {
  const format = getDocumentFormat(doc);
  const sources = [
    ['logo', documentLogo(doc), format.showLogo],
    ...documentSigningBlocks(doc).map((block) => [block.key, block.imageUrl, true]),
    [
      'paymentQr',
      doc.organizationSnapshot.paymentQrUrl,
      Boolean(format.showPaymentQr) && doc.kind !== 'delivery_note',
    ],
  ];
  const images = {};
  let linkedImageOmitted = false;
  for (const [key, source, show] of sources) {
    if (!show || !source) continue;
    const parsed = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    if (!parsed) {
      linkedImageOmitted = true;
      continue;
    }
    const buffer = Buffer.from(parsed[2], 'base64');
    if (buffer.length > 500 * 1024) throw new Error('An uploaded invoice image exceeds the supported size.');
    const image = sharp(buffer, {
      limitInputPixels: 16_000_000,
      pages: 1,
    });
    const metadata = await image.metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > 16_000_000 ||
      (metadata.pages ?? 1) > 1
    ) {
      throw new Error('Invoice images must be static and no larger than 16 megapixels.');
    }
    images[key] =
      parsed[1] === 'webp'
        ? `data:image/png;base64,${(await image.png().toBuffer()).toString('base64')}`
        : source;
  }
  const definition = buildDocumentDefinition(doc, images);
  if (linkedImageOmitted && Array.isArray(definition.content))
    definition.content.push({
      text: 'Linked images are omitted from email PDFs. Upload images to include them.',
      fontSize: 7,
      color: '#66736a',
      margin: [0, 8, 0, 0],
    });
  const stream = await pdfmake.createPdf(definition).getStream();
  const buffer = await new Promise((resolve, reject) => {
    try {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > 15 * 1024 * 1024) {
          stream.destroy(new Error('The invoice PDF is too large to email.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.end();
    } catch (error) {
      reject(error);
    }
  });
  return {
    filename: pdfFileName(doc),
    content: buffer.toString('base64'),
  };
}
