/** Display status of a document, e.g. an unpaid invoice past its due date shows as "overdue". */

import { installmentBalances } from './types.js';
import { indiaBusinessDate } from './business-date.js';

/** The displayed overdue state does not mutate the document's stored status. */
export function documentStatus(document, asOf = indiaBusinessDate()) {
  if (document.kind !== 'invoice' || !['sent', 'partially_paid'].includes(document.status))
    return document.status;
  if (document.installmentPlan?.installments.length)
    return installmentBalances(document, asOf).some((row) => row.status === 'overdue')
      ? 'overdue'
      : document.status;
  return document.dueDate && document.dueDate < asOf ? 'overdue' : document.status;
}
