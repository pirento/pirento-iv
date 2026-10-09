import {
  buildDocumentDefinition,
  documentLogo,
  documentSigningBlocks,
  pdfFileName,
  type PdfImages,
} from '../../../shared/pdf';
import { getDocumentFormat, type BusinessDocument } from '../../../shared/types';

const PNG_JPEG = /^data:image\/(png|jpe?g);base64,/i;

/** Loads the original encoded image without resizing, recompressing or drawing it. */
async function originalImageForPdf(url: string): Promise<string> {
  if (PNG_JPEG.test(url)) return url;
  if (!/^https:\/\//i.test(url) && !/^data:image\/webp;base64,/i.test(url))
    throw new Error('Use a PNG, JPG or WebP image for PDF downloads.');
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Image could not be loaded');
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024) throw new Error('Image exceeds 12 MB');
    if (blob.type.toLowerCase() === 'image/webp') {
      // pdfmake cannot decode WebP. Preserve its pixels and original dimensions;
      // the saved original stays unchanged, while this PDF embeds lossless PNG.
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image could not be prepared');
        context.drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/png');
      } finally {
        bitmap.close();
      }
    }
    if (!/^image\/(png|jpe?g)$/i.test(blob.type)) throw new Error('Use an original PNG, JPG or WebP image');
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Image could not be read'));
      reader.readAsDataURL(blob);
    });
  } finally {
    window.clearTimeout(timer);
  }
}

/** PDF generation stays in the browser. Only configured remote images are fetched. */
export async function downloadDocumentPdf(doc: BusinessDocument): Promise<{ warning?: string }> {
  const images: PdfImages = {};
  const failed: string[] = [];
  const format = getDocumentFormat(doc);
  const sources: [keyof PdfImages, string | undefined, string, boolean][] = [
    ['logo', documentLogo(doc), 'logo', format.showLogo],
    ...documentSigningBlocks(doc).map(
      (block) =>
        [
          block.key,
          block.imageUrl,
          block.key === 'stamp'
            ? 'stamp'
            : block.key === 'secondarySignature'
              ? 'secondary signature'
              : 'primary signature',
          true,
        ] as [keyof PdfImages, string, string, boolean],
    ),
    [
      'paymentQr',
      doc.organizationSnapshot.paymentQrUrl,
      'payment QR',
      Boolean(format.showPaymentQr) && doc.kind !== 'delivery_note',
    ],
  ];
  await Promise.all(
    sources.map(async ([key, url, label, show]) => {
      if (!show || !url) return;
      try {
        images[key] = await originalImageForPdf(url);
      } catch {
        failed.push(label);
      }
    }),
  );
  const [pdfModule, fontsModule] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);
  const definition = buildDocumentDefinition(doc, images);
  const blob = await new Promise<Blob>((resolve, reject) => {
    try {
      const stream = pdfModule.default
        .createPdf(definition, undefined, undefined, fontsModule.default)
        .getStream();
      const chunks: BlobPart[] = [];
      stream.on('data', (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
      stream.on('error', reject);
      stream.on('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
      stream.end();
    } catch (error) {
      reject(error);
    }
  });
  const downloadUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = pdfFileName(doc);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
  return failed.length
    ? {
        warning: `PDF downloaded without the ${failed.join(' and ')} because the original image could not be loaded. Upload an original PNG, JPG or WebP image in Brand settings.`,
      }
    : {};
}
