/**
 * MongoDB queries for workspace pages: paged document lists with search/filters, overview
 * totals (received, outstanding, overdue) and CSV export of matching documents.
 */

import { paidAmount, balanceDue, installmentBalances } from '../../shared/types.js';
import { documentStatus } from '../../shared/document-status.js';
import { roundedPaise } from './money-expressions.js';

// List pages never need line items, addresses, bank details or embedded image snapshots.
export const DOCUMENT_SUMMARY_FIELDS = {
  _id: 0,
  id: 1,
  organizationId: 1,
  kind: 1,
  number: 1,
  title: 1,
  businessProductId: 1,
  'businessProductSnapshot.name': 1,
  'customerSnapshot.name': 1,
  issueDate: 1,
  dueDate: 1,
  status: 1,
  createdAt: 1,
  amountPaid: 1,
  balanceDue: 1,
  finalizedAt: 1,
  convertedInvoiceId: 1,
  deliveryNoteId: 1,
  totals: 1,
  'installmentPlan.installments.id': 1,
  'installmentPlan.installments.label': 1,
  'installmentPlan.installments.amount': 1,
  'installmentPlan.installments.dueDate': 1,
};
const newest = { createdAt: -1, _id: -1 };

const received = {
  $ifNull: ['$amountPaid', { $cond: [{ $eq: ['$status', 'paid'] }, '$totals.total', 0] }],
};

/** Filter for issued invoices with a balance whose due date (or an installment's) is before `asOf`. */
function overdueFilter(asOf) {
  const installments = { $ifNull: ['$installmentPlan.installments', []] };
  const earlierInstallments = {
    $filter: { input: installments, as: 'entry', cond: { $lt: ['$$entry.dueDate', asOf] } },
  };
  return {
    $and: [
      { $eq: ['$kind', 'invoice'] },
      { $in: ['$status', ['sent', 'partially_paid']] },
      {
        $cond: [
          { $gt: [{ $size: installments }, 0] },
          {
            $gt: [
              {
                $sum: {
                  $map: { input: earlierInstallments, as: 'entry', in: roundedPaise('$$entry.amount') },
                },
              },
              roundedPaise(received),
            ],
          },
          {
            $and: [{ $ne: [{ $ifNull: ['$dueDate', ''] }, ''] }, { $lt: ['$dueDate', asOf] }],
          },
        ],
      },
    ],
  };
}

/** User input is always a value in a fixed query shape; regex metacharacters are escaped. */
export function documentListFilter(organizationId, kind, filters, asOf) {
  const filter = { organizationId, kind };
  const expressions = [];
  if (filters.product) filter.businessProductId = filters.product;
  if (filters.search) {
    expressions.push({
      $regexMatch: {
        input: {
          $concat: [
            { $ifNull: ['$number', ''] },
            ' ',
            { $ifNull: ['$customerSnapshot.name', ''] },
            ' ',
            { $ifNull: ['$title', ''] },
            ' ',
            { $ifNull: ['$businessProductSnapshot.name', ''] },
          ],
        },
        regex: filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        options: 'i',
      },
    });
  }
  if (filters.status === 'overdue') expressions.push(overdueFilter(asOf));
  else if (filters.status !== 'all') filter.status = filters.status;
  if (expressions.length) filter.$expr = expressions.length === 1 ? expressions[0] : { $and: expressions };
  return filter;
}

/** Returns the list/summary/export queries bound to the database. */
export function createWorkspaceQueries(db) {
  const options = () => db.options();
  const summaries = (filter) =>
    db.collection('documents').find(filter, { ...options(), projection: DOCUMENT_SUMMARY_FIELDS });

  async function documentPage(organizationId, kind, filters, asOf) {
    const filter = documentListFilter(organizationId, kind, filters, asOf);
    const total = await db.collection('documents').countDocuments(filter, options());
    const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pageCount);
    const documents = await summaries(filter)
      .sort(newest)
      .skip((page - 1) * filters.pageSize)
      .limit(filters.pageSize)
      .toArray();
    return { documents, total, page, pageCount, pageSize: filters.pageSize, filters };
  }

  function documentExport(organizationId, kind, filters, asOf) {
    return summaries(documentListFilter(organizationId, kind, filters, asOf))
      .sort(newest)
      .batchSize(100);
  }

  async function overview(organizationId, now, asOf) {
    const monthly = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(now);
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - 5 + index);
      return {
        key: date.toISOString().slice(0, 7),
        label: date.toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' }),
        total: 0,
      };
    });
    const summary = {
      invoiceCount: 0,
      received: 0,
      outstanding: 0,
      overdueCount: 0,
      openQuoteCount: 0,
      openQuoteTotal: 0,
      pendingInstallmentCount: 0,
      scheduled: [],
      monthly,
    };
    // Stream only the summary fields. Keep at most eight pending rows in application memory.
    const cursor = summaries({ organizationId, kind: { $in: ['invoice', 'quotation'] } })
      .sort({ _id: -1 })
      .batchSize(200);
    try {
      for await (const document of cursor) {
        if (document.kind === 'quotation') {
          if (['draft', 'sent'].includes(document.status)) {
            summary.openQuoteCount += 1;
            summary.openQuoteTotal += document.totals.total;
          }
          continue;
        }
        summary.invoiceCount += 1;
        summary.received += paidAmount(document);
        if (['sent', 'partially_paid'].includes(document.status)) summary.outstanding += balanceDue(document);
        if (documentStatus(document, asOf) === 'overdue') summary.overdueCount += 1;
        const month = monthly.find((item) => document.issueDate.startsWith(item.key));
        if (month) month.total += paidAmount(document);
        if (document.installmentPlan && !['draft', 'cancelled'].includes(document.status)) {
          for (const row of installmentBalances(document, asOf)) {
            if (row.balanceDue <= 0) continue;
            summary.pendingInstallmentCount += 1;
            summary.scheduled.push({
              ...row,
              document: {
                id: document.id,
                number: document.number,
                customerSnapshot: document.customerSnapshot,
              },
            });
            summary.scheduled.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
            if (summary.scheduled.length > 8) summary.scheduled.pop();
          }
        }
      }
    } finally {
      await cursor.close();
    }
    const [recent, activeContacts, activeCatalog, availableFormats] = await Promise.all([
      summaries({ organizationId }).sort(newest).limit(6).toArray(),
      db.collection('customers').countDocuments({ organizationId, active: { $ne: false } }, options()),
      db.collection('catalog').countDocuments({ organizationId, active: true }, options()),
      db.collection('formats').countDocuments({ organizationId }, options()),
    ]);
    return { ...summary, recent, activeContacts, activeCatalog, availableFormats };
  }

  /** Issued and cancelled invoices dated in [from, to) with the fields GSTR-1 needs (services/pages/gstr1.js). */
  function gstr1Invoices(organizationId, { from, to }) {
    return db
      .collection('documents')
      .find(
        {
          organizationId,
          kind: 'invoice',
          status: { $ne: 'draft' },
          issueDate: { $gte: from, $lt: to },
        },
        {
          ...options(),
          projection: {
            _id: 0,
            number: 1,
            status: 1,
            issueDate: 1,
            placeOfSupply: 1,
            discountPercent: 1,
            items: 1,
            totals: 1,
            'customerSnapshot.name': 1,
            'customerSnapshot.gstin': 1,
            'organizationSnapshot.gstin': 1,
            'organizationSnapshot.stateCode': 1,
          },
        },
      )
      .toArray();
  }

  return { documentPage, documentExport, overview, gstr1Invoices };
}
