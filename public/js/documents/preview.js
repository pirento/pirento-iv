/**
 * Document preview page (views/documents/preview.ejs): Print, Download PDF (browser-pdf.js) and
 * the convert / delivery-challan actions shown above the document.
 */

import { api, sendJson } from '/js/core/api.js';
import { getPageData } from '/js/core/page.js';
import { documentUrl } from './document-ui.js';
import { downloadDocumentPdf } from './browser-pdf.js';

const doc = getPageData().document;
let working = false;
const feedback = document.querySelector('#doc-preview-feedback');
function setFeedback(message, error = false) {
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.classList.toggle('doc-save-error', error);
  feedback.setAttribute('role', error ? 'alert' : 'status');
}
document.querySelector('.doc-preview').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-preview-action]');
  if (!button || working) return;
  const action = button.dataset.previewAction;
  if (action === 'print') {
    const title = document.title;
    document.title = `${doc.number} — ${doc.organizationSnapshot.name}`;
    try {
      window.print();
    } finally {
      document.title = title;
    }
    return;
  }
  working = true;
  const oldLabel = button.textContent;
  for (const item of document.querySelectorAll('[data-preview-action]')) item.disabled = true;
  button.textContent =
    action === 'pdf' ? 'Preparing PDF…' : action === 'convert' ? 'Converting…' : 'Opening challan…';
  setFeedback('');
  try {
    if (action === 'pdf') {
      const result = await downloadDocumentPdf(doc);
      setFeedback(result.warning || 'PDF downloaded.');
    } else if (action === 'convert' || action === 'delivery') {
      const result = await api(
        `/documents/${encodeURIComponent(doc.id)}/${action === 'convert' ? 'convert' : 'delivery-note'}`,
        sendJson('POST'),
      );
      location.assign(documentUrl(result));
    }
  } catch (error) {
    setFeedback(
      error.message ||
        (action === 'pdf'
          ? 'The PDF could not be downloaded. Try again or use Print to save a copy.'
          : 'The document could not be updated. Please try again.'),
      true,
    );
  } finally {
    working = false;
    for (const item of document.querySelectorAll('[data-preview-action]')) item.disabled = false;
    button.textContent = oldLabel;
  }
});
for (const image of document.querySelectorAll('.doc-paper img')) {
  image.addEventListener('error', () => {
    image.hidden = true;
    if (image.classList.contains('doc-brand-logo'))
      image.closest('.doc-paper').classList.remove('doc-has-logo');
  });
}
