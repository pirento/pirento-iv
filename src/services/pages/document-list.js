/** Document list pages (invoices, quotations, proformas, delivery challans): filters, URLs and CSV rows. */

import { HttpError } from '../../middleware/errors.js';
import { STATUS_LABELS, paidAmount, balanceDue } from '../../../shared/types.js';
import { documentStatus } from '../../../shared/document-status.js';

// Workspace view name -> stored document kind.
export const DOCUMENT_KINDS = {
  invoices: 'invoice',
  quotations: 'quotation',
  proformas: 'proforma',
  shipping: 'delivery_note',
};
const statuses = new Set(['all', 'overdue', ...Object.keys(STATUS_LABELS)]);

/** Validates ?q=&status=&product=&page= from the URL (400 on anything unexpected). Page size is 50. */
export function readDocumentFilters(query = {}) {
  const value = (name, fallback = '') => {
    const result = query[name] ?? fallback;
    if (typeof result !== 'string' || result.length > 200)
      throw new HttpError(400, 'The document filters are invalid.');
    return result;
  };
  const status = value('status', 'all');
  const product = value('product');
  const page = value('page', '1');
  if (!statuses.has(status) || (product && !/^[a-zA-Z0-9_-]+$/.test(product)) || !/^[1-9]\d{0,6}$/.test(page))
    throw new HttpError(400, 'The document filters are invalid.');
  return { search: value('q'), status, product, page: Number(page), pageSize: 50 };
}

/** Builds a document list URL that keeps the current filters. */
export function documentListUrl(organizationId, view, filters, extra = {}) {
  const query = new URLSearchParams();
  if (filters.search) query.set('q', filters.search);
  if (filters.status !== 'all') query.set('status', filters.status);
  if (filters.product) query.set('product', filters.product);
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, String(value));
  const path = `/workspace/${encodeURIComponent(organizationId)}/${view}`;
  return `${path}${query.size ? `?${query}` : ''}`;
}

const csvCell = (value) =>
  `"${String(value ?? '')
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""')}"`;
const csvRow = (values) => values.map(csvCell).join(',') + '\r\n';

/** Export every matching row, independent of the currently visible page. */
export async function* documentCsv(cursor, asOf) {
  try {
    yield '\uFEFF' +
      csvRow([
        'Number',
        'Type',
        'Business product',
        'Customer',
        'Date',
        'Due date',
        'Status',
        'Taxable (INR)',
        'GST (INR)',
        'Total (INR)',
        'Received (INR)',
        'Balance (INR)',
        'Finalized',
      ]);
    for await (const document of cursor) {
      yield csvRow([
        document.number,
        document.kind,
        document.businessProductSnapshot?.name || '',
        document.customerSnapshot.name,
        document.issueDate,
        document.dueDate,
        documentStatus(document, asOf),
        document.totals.taxable,
        document.totals.cgst + document.totals.sgst + document.totals.igst,
        document.kind === 'delivery_note' ? '' : document.totals.total,
        paidAmount(document),
        balanceDue(document),
        document.finalizedAt || '',
      ]);
    }
  } finally {
    await cursor.close();
  }
}
