import pdfMake from 'pdfmake/build/pdfmake.js';
import pdfFonts from 'pdfmake/build/vfs_fonts.js';
import sharp from 'sharp';
import {
  buildDocumentDefinition,
  documentLogo,
  documentSigningBlocks,
  pdfFileName,
  type PdfImages,
} from '../../shared/pdf.ts';
import { getDocumentFormat, type BusinessDocument } from '../../shared/types.ts';

/** Email uses the same saved layout as browser download, with uploaded assets only. */
export async function renderInvoiceAttachment(
  doc: BusinessDocument,
): Promise<{ filename: string; content: string }> {
  const format = getDocumentFormat(doc);
  const sources: [keyof PdfImages, string | undefined, boolean][] = [
    ['logo', documentLogo(doc), format.showLogo],
    ...documentSigningBlocks(doc).map(
      (block) => [block.key, block.imageUrl, true] as [keyof PdfImages, string, boolean],
    ),
    [
      'paymentQr',
      doc.organizationSnapshot.paymentQrUrl,
      Boolean(format.showPaymentQr) && doc.kind !== 'delivery_note',
    ],
  ];
  const images: PdfImages = {};
  let linkedImageOmitted = false;
  for (const [key, source, show] of sources) {
    if (!show || !source) continue;
    const parsed = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    // Never fetch arbitrary image URLs from the server (including internal hosts).
    if (!parsed) {
      linkedImageOmitted = true;
      continue;
    }
    const buffer = Buffer.from(parsed[2], 'base64');
    if (buffer.length > 500 * 1024) throw new Error('An uploaded invoice image exceeds the supported size.');
    // Byte size alone does not bound decoded memory: small PNG/JPEG files can
    // declare enormous dimensions. Inspect every raster before pdfmake sees it.
    const image = sharp(buffer, { limitInputPixels: 16_000_000, pages: 1 });
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
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    try {
      const stream = pdfMake.createPdf(definition, undefined, undefined, pdfFonts).getStream();
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Uint8Array) => {
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
  return { filename: pdfFileName(doc), content: buffer.toString('base64') };
}
