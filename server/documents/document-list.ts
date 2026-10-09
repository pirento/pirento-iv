import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { BusinessDocument, DocumentKind } from '../../shared/types.ts';
import type { DocumentPage, DocumentSummary, DocumentKindSummary } from '../../shared/document-list.ts';

const kinds = ['invoice', 'quotation', 'proforma', 'delivery_note'] as const;
const statuses = [
  'draft',
  'sent',
  'paid',
  'partially_paid',
  'accepted',
  'declined',
  'cancelled',
  'dispatched',
  'delivered',
  'overdue',
] as const;
const positiveInteger = (maximum: number, fallback: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .refine((value) => Number.isSafeInteger(value) && value <= maximum)
    .default(String(fallback));
const filtersSchema = z.object({
  kind: z.enum(kinds).optional(),
  search: z.string().trim().max(200).default(''),
  status: z.enum(statuses).optional(),
  businessProductId: z.string().trim().min(1).max(100).optional(),
});
const pageSchema = filtersSchema.extend({
  page: positiveInteger(1_000_000, 1),
  pageSize: positiveInteger(100, 25),
});
export type DocumentFilters = z.infer<typeof filtersSchema>;
function rejectComplexQuery(query: Record<string, unknown>) {
  const key = Object.keys(query).find((name) =>
    /^(?:organizationId|kind|search|status|businessProductId|page|pageSize)\[/.test(name),
  );
  if (key)
    throw new z.ZodError([{ code: 'custom', path: [key], message: 'Provide simple query parameters.' }]);
}
export function parseDocumentFilters(query: Record<string, unknown>) {
  rejectComplexQuery(query);
  return filtersSchema.parse(query);
}
export function parseDocumentPage(query: Record<string, unknown>) {
  rejectComplexQuery(query);
  return pageSchema.parse(query);
}
const caseFoldDatabases = new WeakSet<DatabaseSync>();
function registerCaseFold(db: DatabaseSync) {
  if (caseFoldDatabases.has(db)) return;
  // SQLite lower() only covers ASCII. Preserve the previous browser search's Unicode behavior.
  db.function('iv_casefold', { deterministic: true }, (value) => String(value ?? '').toLowerCase());
  caseFoldDatabases.add(db);
}

/** Keep monetary sums in paise and allocate installments in the same due-date order as the UI. */
function scopedSql(organizationId: string, asOf: string, filters: DocumentFilters) {
  const conditions = ['d.organization_id = ?'];
  const parameters: SQLInputValue[] = [organizationId];
  if (filters.kind) {
    conditions.push('d.kind = ?');
    parameters.push(filters.kind);
  }
  if (filters.businessProductId) {
    conditions.push("json_extract(d.data, '$.businessProductId') = ?");
    parameters.push(filters.businessProductId);
  }
  if (filters.search) {
    conditions.push(
      "instr(iv_casefold(d.number || ' ' || COALESCE(json_extract(d.data, '$.customerSnapshot.name'), '') || ' ' || COALESCE(json_extract(d.data, '$.title'), '') || ' ' || COALESCE(json_extract(d.data, '$.businessProductSnapshot.name'), '')), iv_casefold(?)) > 0",
    );
    parameters.push(filters.search);
  }
  parameters.push(asOf, asOf);
  return {
    parameters,
    sql: `WITH scoped AS (
      SELECT d.rowid AS document_rowid, d.id, d.kind,
        json_extract(d.data, '$.status') AS status,
        json_extract(d.data, '$.dueDate') AS invoice_due_date,
        json_extract(d.data, '$.installmentPlan.installments') AS installments,
        CAST(ROUND(json_extract(d.data, '$.totals.total') * 100) AS INTEGER) AS total_paise,
        CAST(ROUND(COALESCE(json_extract(d.data, '$.amountPaid'), CASE WHEN d.kind = 'invoice' AND json_extract(d.data, '$.status') = 'paid' THEN json_extract(d.data, '$.totals.total') ELSE 0 END) * 100) AS INTEGER) AS paid_paise,
        CASE WHEN d.kind = 'invoice' THEN CAST(ROUND(COALESCE(json_extract(d.data, '$.balanceDue'), MAX(0, json_extract(d.data, '$.totals.total') - COALESCE(json_extract(d.data, '$.amountPaid'), CASE WHEN json_extract(d.data, '$.status') = 'paid' THEN json_extract(d.data, '$.totals.total') ELSE 0 END))) * 100) AS INTEGER) ELSE 0 END AS balance_paise
      FROM documents d WHERE ${conditions.join(' AND ')}
    ), installment_amounts AS (
      SELECT s.id AS document_id, s.document_rowid, s.status, s.paid_paise,
        CAST(i.key AS INTEGER) AS installment_index, json_extract(i.value, '$.dueDate') AS due_date,
        CAST(ROUND(json_extract(i.value, '$.amount') * 100) AS INTEGER) AS amount_paise
      FROM scoped s, json_each(s.installments) i WHERE s.kind = 'invoice'
    ), installment_allocations AS (
      SELECT *, COALESCE(SUM(amount_paise) OVER (PARTITION BY document_id ORDER BY due_date, installment_index ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS preceding_paise
      FROM installment_amounts
    ), unpaid_installments AS (
      SELECT *, MAX(0, amount_paise - MAX(0, paid_paise - preceding_paise)) AS remaining_paise FROM installment_allocations
    ), classified AS (
      SELECT s.*, CASE WHEN s.kind = 'invoice' AND s.status IN ('sent', 'partially_paid') AND
        CASE WHEN json_array_length(s.installments) > 0
          THEN EXISTS(SELECT 1 FROM unpaid_installments i WHERE i.document_id = s.id AND i.remaining_paise > 0 AND i.due_date < ?)
          ELSE COALESCE(s.invoice_due_date, '') != '' AND s.invoice_due_date < ? END
        THEN 'overdue' ELSE s.status END AS display_status FROM scoped s
    )`,
  };
}
function statusCondition(filters: DocumentFilters) {
  return filters.status
    ? { sql: 'WHERE (status = ? OR display_status = ?)', parameters: [filters.status, filters.status] }
    : { sql: '', parameters: [] };
}
export function getDocumentPage(
  db: DatabaseSync,
  organizationId: string,
  asOf: string,
  query: Record<string, unknown>,
): DocumentPage {
  registerCaseFold(db);
  const input = parseDocumentPage(query);
  const scoped = scopedSql(organizationId, asOf, input);
  const status = statusCondition(input);
  const count = db
    .prepare(`${scoped.sql} SELECT COUNT(*) AS total FROM classified ${status.sql}`)
    .get(...scoped.parameters, ...status.parameters) as { total: number };
  const totalPages = Math.max(1, Math.ceil(count.total / input.pageSize));
  const page = Math.min(input.page, totalPages);
  const items = (
    db
      .prepare(
        `${scoped.sql}, visible AS (SELECT id, document_rowid FROM classified ${status.sql} ORDER BY document_rowid DESC LIMIT ? OFFSET ?) SELECT d.data FROM visible v JOIN documents d ON d.id = v.id ORDER BY v.document_rowid DESC`,
      )
      .all(...scoped.parameters, ...status.parameters, input.pageSize, (page - 1) * input.pageSize) as {
      data: string;
    }[]
  ).map((row) => JSON.parse(row.data) as BusinessDocument);
  const counts = db
    .prepare(
      `${scoped.sql} SELECT status, display_status, COUNT(*) AS count FROM classified GROUP BY status, display_status`,
    )
    .all(...scoped.parameters) as { status: string; display_status: string; count: number }[];
  const statusCounts: DocumentPage['statusCounts'] = { all: 0 };
  for (const row of counts) {
    const raw = row.status as keyof typeof statusCounts;
    statusCounts.all! += row.count;
    statusCounts[raw] = (statusCounts[raw] ?? 0) + row.count;
    if (row.display_status !== row.status) statusCounts.overdue = (statusCounts.overdue ?? 0) + row.count;
  }
  return { items, total: count.total, page, pageSize: input.pageSize, totalPages, statusCounts };
}
export function getDocumentSummary(db: DatabaseSync, organizationId: string, asOf: string): DocumentSummary {
  const scoped = scopedSql(organizationId, asOf, { search: '' });
  const groups = db
    .prepare(
      `${scoped.sql} SELECT kind, COUNT(*) AS count,
    COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total_paise ELSE 0 END), 0) AS value,
    COALESCE(SUM(paid_paise), 0) AS collected,
    COALESCE(SUM(CASE WHEN status IN ('sent', 'partially_paid') THEN balance_paise ELSE 0 END), 0) AS outstanding,
    SUM(CASE WHEN status IN ('accepted', 'delivered') THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
    SUM(CASE WHEN paid_paise > 0 THEN 1 ELSE 0 END) AS with_payments,
    SUM(CASE WHEN display_status = 'overdue' THEN 1 ELSE 0 END) AS overdue,
    SUM(CASE WHEN status IN ('draft', 'sent') THEN 1 ELSE 0 END) AS open_count,
    SUM(CASE WHEN status IN ('draft', 'sent') THEN total_paise ELSE 0 END) AS open_value
    FROM classified GROUP BY kind`,
    )
    .all(...scoped.parameters) as unknown as (DocumentKindSummary & {
    kind: DocumentKind;
    with_payments: number;
    overdue: number;
    open_count: number;
    open_value: number;
  })[];
  const byKind = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      { count: 0, value: 0, collected: 0, outstanding: 0, completed: 0, drafts: 0 },
    ]),
  ) as DocumentSummary['byKind'];
  for (const group of groups)
    byKind[group.kind] = {
      count: group.count,
      value: group.value / 100,
      collected: group.collected / 100,
      outstanding: group.outstanding / 100,
      completed: group.completed,
      drafts: group.drafts,
    };
  const invoices = groups.find((group) => group.kind === 'invoice');
  const quotations = groups.find((group) => group.kind === 'quotation');
  const installments = db
    .prepare(
      `${scoped.sql} SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN due_date < ? THEN remaining_paise ELSE 0 END), 0) AS overdue FROM unpaid_installments WHERE remaining_paise > 0 AND status NOT IN ('draft', 'cancelled')`,
    )
    .get(...scoped.parameters, asOf) as { count: number; overdue: number };
  const next = db
    .prepare(
      `${scoped.sql} SELECT d.data, i.due_date, i.remaining_paise FROM (SELECT document_id, due_date, remaining_paise FROM unpaid_installments WHERE remaining_paise > 0 AND status NOT IN ('draft', 'cancelled') ORDER BY due_date, document_rowid DESC, installment_index LIMIT 1) i JOIN documents d ON d.id = i.document_id`,
    )
    .get(...scoped.parameters) as { data: string; due_date: string; remaining_paise: number } | undefined;
  const recentDocuments = (
    db
      .prepare('SELECT data FROM documents WHERE organization_id = ? ORDER BY rowid DESC LIMIT 5')
      .all(organizationId) as { data: string }[]
  ).map((row) => JSON.parse(row.data) as BusinessDocument);
  return {
    invoiceCount: invoices?.count ?? 0,
    invoicesWithPayments: invoices?.with_payments ?? 0,
    totalCollected: byKind.invoice.collected,
    outstanding: byKind.invoice.outstanding,
    overdueInvoices: invoices?.overdue ?? 0,
    openQuotationCount: quotations?.open_count ?? 0,
    openQuotationValue: (quotations?.open_value ?? 0) / 100,
    remainingInstallments: installments.count,
    overdueInstallmentValue: installments.overdue / 100,
    ...(next
      ? {
          nextInstallment: {
            document: JSON.parse(next.data) as BusinessDocument,
            dueDate: next.due_date,
            balanceDue: next.remaining_paise / 100,
          },
        }
      : {}),
    recentDocuments,
    byKind,
  };
}
type DocumentExportData = Pick<
  BusinessDocument,
  'number' | 'kind' | 'issueDate' | 'dueDate' | 'status' | 'totals'
> & {
  customerSnapshot: Pick<BusinessDocument['customerSnapshot'], 'name'>;
  businessProductSnapshot: { name: string };
  amountPaid: number | null;
  balanceDue: number | null;
  finalizedAt: string | null;
};
/** Batches contain only CSV fields; full image, seller and item snapshots never enter the export buffer. */
export function* documentExportRows(
  db: DatabaseSync,
  organizationId: string,
  asOf: string,
  filters: DocumentFilters,
) {
  registerCaseFold(db);
  const scoped = scopedSql(organizationId, asOf, filters);
  const selected = statusCondition(filters);
  const where = selected.sql ? `${selected.sql} AND document_rowid < ?` : 'WHERE document_rowid < ?';
  let cursor = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = db
      .prepare(
        `${scoped.sql}, visible AS (SELECT id, document_rowid, display_status FROM classified ${where} ORDER BY document_rowid DESC LIMIT 25)
        SELECT v.document_rowid, v.display_status,
          json_object('number', d.number, 'kind', d.kind,
            'issueDate', json_extract(d.data, '$.issueDate'), 'dueDate', json_extract(d.data, '$.dueDate'),
            'status', json_extract(d.data, '$.status'), 'totals', json_extract(d.data, '$.totals'),
            'customerSnapshot', json_object('name', json_extract(d.data, '$.customerSnapshot.name')),
            'businessProductSnapshot', json_object('name', COALESCE(json_extract(d.data, '$.businessProductSnapshot.name'), '')),
            'amountPaid', json_extract(d.data, '$.amountPaid'), 'balanceDue', json_extract(d.data, '$.balanceDue'),
            'finalizedAt', json_extract(d.data, '$.finalizedAt')) AS data
        FROM visible v JOIN documents d ON d.id = v.id ORDER BY v.document_rowid DESC`,
      )
      .all(...scoped.parameters, ...selected.parameters, cursor) as {
      document_rowid: number;
      data: string;
      display_status: string;
    }[];
    if (!rows.length) return;
    for (const row of rows) {
      cursor = row.document_rowid;
      yield { document: JSON.parse(row.data) as DocumentExportData, status: row.display_status };
    }
  }
}
