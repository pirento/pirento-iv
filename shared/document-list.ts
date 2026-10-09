import type { BusinessDocument, DocumentKind, DocumentStatus } from './types';

export type DocumentListStatus = DocumentStatus | 'overdue';
export interface DocumentPage {
  items: BusinessDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Counts include the other filters, before applying the selected status. */
  statusCounts: Partial<Record<DocumentListStatus | 'all', number>>;
}
export interface DocumentKindSummary {
  count: number;
  value: number;
  collected: number;
  outstanding: number;
  completed: number;
  drafts: number;
}
export interface DocumentSummary {
  invoiceCount: number;
  invoicesWithPayments: number;
  totalCollected: number;
  outstanding: number;
  overdueInvoices: number;
  openQuotationCount: number;
  openQuotationValue: number;
  remainingInstallments: number;
  overdueInstallmentValue: number;
  nextInstallment?: { document: BusinessDocument; dueDate: string; balanceDue: number };
  recentDocuments: BusinessDocument[];
  byKind: Record<DocumentKind, DocumentKindSummary>;
}
