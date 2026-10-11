import { buildDocumentDefinition, documentLogo, documentSigningBlocks, pdfFileName } from '/shared/pdf.js';
import { getDocumentFormat } from '/shared/types.js';

const PNG_JPEG = /^data:image\/(png|jpe?g);base64,/i;
let pdfRuntime;

function loadScript(source) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.onload = resolve;
    script.onerror = () => {
      script.remove();
      reject(new Error('The local PDF library could not be loaded. Refresh and try again.'));
    };
    document.head.append(script);
  });
}
async function loadPdfRuntime() {
  if (!pdfRuntime)
    pdfRuntime = (async () => {
      if (!window.pdfMake) await loadScript('/vendor/pdfmake.min.js');
      // vfs_fonts.js registers the bundled Roboto fonts through pdfMake.addVirtualFileSystem.
      await loadScript('/vendor/vfs_fonts.js');
      return window.pdfMake;
    })().catch((error) => {
      pdfRuntime = undefined;
      throw error;
    });
  return pdfRuntime;
}

/** Keep original PNG/JPEG encoding. WebP is converted losslessly at its original dimensions. */
async function originalImageForPdf(url) {
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
    if (!response.ok) throw new Error('Image could not be loaded.');
    const blob = await response.blob();
    if (blob.size > 12 * 1024 * 1024) throw new Error('Image exceeds 12 MB.');
    if (blob.type.toLowerCase() === 'image/webp') {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Image could not be prepared.');
        context.drawImage(bitmap, 0, 0);
        return canvas.toDataURL('image/png');
      } finally {
        bitmap.close();
      }
    }
    if (!/^image\/(png|jpe?g)$/i.test(blob.type)) throw new Error('Use an original PNG, JPG or WebP image.');
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Image could not be read.'));
      reader.readAsDataURL(blob);
    });
  } finally {
    window.clearTimeout(timer);
  }
}

/** PDF layout and maths come from the same shared definition used for email attachments. */
export async function downloadDocumentPdf(doc) {
  const images = {};
  const failed = [];
  const format = getDocumentFormat(doc);
  const sources = [
    ['logo', documentLogo(doc), 'logo', format.showLogo],
    ...documentSigningBlocks(doc).map((block) => [
      block.key,
      block.imageUrl,
      block.key === 'stamp'
        ? 'stamp'
        : block.key === 'secondarySignature'
          ? 'secondary signature'
          : 'primary signature',
      true,
    ]),
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
  const pdfMake = await loadPdfRuntime();
  const definition = buildDocumentDefinition(doc, images);
  const synthetic = document.documentElement.dataset.ivDeploymentMode === 'disposable-synthetic-preview';
  if (synthetic)
    definition.watermark = {
      text: 'TEST PREVIEW — NOT A VALID INVOICE',
      color: '#9b1c20',
      opacity: 0.18,
      bold: true,
    };
  const blob = await pdfMake.createPdf(definition).getBlob();
  const downloadUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = `${synthetic ? 'TEST-PREVIEW-' : ''}${pdfFileName(doc)}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 30000);
  return failed.length
    ? {
        warning: `PDF downloaded without the ${failed.join(' and ')} because the original image could not be loaded. Upload an original PNG, JPG or WebP image in Brand settings.`,
      }
    : {};
}
