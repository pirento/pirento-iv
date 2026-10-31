/**
 * Loads the data each workspace page needs (the "model" side of the EJS pages).
 *
 * Every page gets the user's allowed businesses, the selected business and workspace settings;
 * then only what that view shows is loaded (e.g. one page of 50 invoices, or one document for
 * the editor), so normal navigation stays fast. Also provides the document CSV export.
 */

import { HttpError } from '../../middleware/errors.js';
import { normalizeContact } from '../validation/contacts.js';
import { integrationEnvironmentPrefix } from '../../../shared/business-identity.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';
import { createWorkspaceQueries } from '../../models/workspace-queries.js';
import { DOCUMENT_KINDS, readDocumentFilters, documentListUrl, documentCsv } from './document-list.js';
import { createDirectoryQueries } from '../../models/directory-queries.js';
import { readDirectoryFilters, directoryPageLinks } from './directory-list.js';
import { buildGstr1, gstr1Csv, GSTR1_SECTIONS, monthRange, readGstr1Filters } from './gstr1.js';
import { expenseCsv, expenseTotals, readExpenseMonth } from '../expenses/expenses.js';
import { buildReport, financialYearRange, readReportYear } from './reports.js';
import { einvoiceProblems } from '../documents/einvoice.js';
import { businessSummary, financePdf, financeWorkbook, groupTotals } from './finance.js';
import { PAYMENT_METHODS } from '../../../shared/types.js';
import { renderInvoiceAttachment, renderPdfBuffer } from '../documents/invoice-pdf.js';
import { xlsx, zip } from '../exports/xlsx.js';
import { CREDIT_NOTE_REASONS, DEBIT_NOTE_REASONS, EXPENSE_CATEGORIES } from '../validation/validation.js';
import { safeWorkspaceReturn } from '../../../public/js/core/workspace-route.js';

/** Page-specific loading keeps unrelated financial snapshots and operations off normal navigation. */
export function createWorkspacePageData({
  ai,
  db,
  auth,
  online,
  mailer,
  backups,
  backupStorage,
  gstStatus,
  now,
  logger,
  ledger,
  reminders,
  recurringInvoices,
}) {
  const queries = createWorkspaceQueries(db);
  const directories = createDirectoryQueries(db);

  // Data every page needs; throws 403 if the requested business is not assigned to this user.
  async function base(user, requestedOrganizationId) {
    if (auth && (!user || user.status !== 'active')) throw new HttpError(401, 'Please sign in to continue.');
    const allOrganizations = await db.models.organizations.list();
    const organizations =
      auth && user.role !== 'admin'
        ? allOrganizations.filter((item) => user.organizationIds.includes(item.id))
        : allOrganizations;
    const organization =
      organizations.find((item) => item.id === requestedOrganizationId) ??
      (requestedOrganizationId ? undefined : organizations[0]);
    if (!organization) throw new HttpError(403, 'This organization is outside your access.');
    return {
      user,
      organizations,
      organization,
      workspaceSettings: await db.models.settings.get(),
      businessDate: indiaBusinessDate(now()),
      customers: [],
      catalog: [],
      formats: [],
      businessProducts: [],
      documents: [],
    };
  }

  // Group finance is for administrators and Accounts logins, across the businesses they can open.
  const financeAllowed = (user) => !auth || user.role === 'admin' || user.permission === 'accounts';
  async function financeData(organizations, query, businessDate) {
    const year = readReportYear(query, businessDate);
    const range = financialYearRange(year);
    const businesses = await Promise.all(
      organizations.map(async (organization) => {
        const [rows, expenses, detail] = await Promise.all([
          queries.reportData(organization.id, range),
          db.models.expenses.listBetween(organization.id, range),
          queries.financeRows(organization.id, range),
        ]);
        const report = buildReport({ ...rows, expenses, year, asOf: businessDate });
        return { summary: businessSummary(organization, report, expenses), detail, expenses };
      }),
    );
    return { year, label: `FY ${year}-${String(year + 1).slice(2)}`, businesses };
  }

  // Full page data for a route ({ view, action, id, query }) - one branch per workspace view.
  async function load(user, requestedOrganizationId, route) {
    const result = await base(user, requestedOrganizationId);
    const organizationId = result.organization.id;
    // The optional full-data form remains available to existing internal preview integrations.
    const legacy = !route;
    const kind = DOCUMENT_KINDS[route?.view];
    const editor = kind && ['new', 'edit'].includes(route.action);
    const tasks = [];
    const read = (key, action) =>
      tasks.push(
        Promise.resolve()
          .then(action)
          .then((value) => {
            result[key] = value;
          }),
      );
    if (legacy)
      read('customers', async () => (await db.models.customers.list(organizationId)).map(normalizeContact));
    if (legacy) read('catalog', () => db.models.catalog.list(organizationId));
    if (['customers', 'catalog'].includes(route?.view)) {
      const kind = route.view;
      if (route.action) {
        read(kind, async () => {
          if (!route.id) return [];
          const record = await db.models[kind].findById(route.id);
          return record?.organizationId === organizationId
            ? [kind === 'customers' ? normalizeContact(record) : record]
            : [];
        });
      } else {
        read('directory', async () => {
          const filters = readDirectoryFilters(kind, route.query);
          const { items, ...page } = await directories.page(kind, organizationId, filters);
          result[kind] = items;
          const returnTo =
            typeof route.query?.returnTo === 'string' ? safeWorkspaceReturn(route.query.returnTo) : '';
          return directoryPageLinks(organizationId, kind, page, returnTo);
        });
      }
    }
    if (legacy || editor || route.view === 'formats')
      read('formats', () => db.models.formats.list(organizationId));
    if (legacy || editor || (kind && !route.action) || ['catalog', 'business_products'].includes(route.view))
      read('businessProducts', () => db.models.businessProducts.list(organizationId));
    if (legacy) read('documents', () => db.models.documents.list(organizationId));
    else if (kind && route.id) {
      read('document', async () => {
        const document = await db.models.documents.findById(route.id);
        if (!document || document.organizationId !== organizationId || document.kind !== kind)
          throw new HttpError(404, 'This document is unavailable in the selected business.');
        return document;
      });
      // The invoice's open online payment link, for the WhatsApp message on the preview page.
      if (kind === 'invoice' && route.action === 'preview')
        read('paymentLinkUrl', async () => {
          const { links } = await online.getDocumentPayments(route.id).catch(() => ({ links: [] }));
          return (
            links.find((link) => ['created', 'partially_paid'].includes(link.state) && link.url)?.url ?? ''
          );
        });
    } else if (kind && !route.action) {
      tasks.push(
        (async () => {
          const filters = readDocumentFilters(route.query);
          const page = await queries.documentPage(organizationId, kind, filters, result.businessDate);
          result.documents = page.documents;
          const href = (extra) => documentListUrl(organizationId, route.view, filters, extra);
          result.documentList = {
            total: page.total,
            page: page.page,
            pageCount: page.pageCount,
            pageSize: page.pageSize,
            filters,
            previousUrl: page.page > 1 ? href({ page: page.page - 1 }) : '',
            nextUrl: page.page < page.pageCount ? href({ page: page.page + 1 }) : '',
            exportUrl: href({ download: 'csv' }),
          };
        })(),
      );
    }
    if (route?.view === 'overview')
      read('overview', () => queries.overview(organizationId, now(), result.businessDate));
    if (route?.view === 'ledger') {
      if (route.id) {
        result.ledgerPrint = route.query?.print === '1';
        read('ledgerStatement', () =>
          ledger.statement(user, organizationId, route.id, route.query, { allRows: result.ledgerPrint }),
        );
      } else read('ledger', () => ledger.list(user, organizationId, route.query));
    }
    if (route?.view === 'reminders') {
      read('reminders', async () => ({
        ...(await reminders.list(organizationId, route.query)),
        filters: { q: route.query?.q ?? '', status: route.query?.status ?? 'all' },
      }));
      read('reminderHistory', () =>
        reminders.history(organizationId, { page: route.query?.historyPage ?? '1' }),
      );
    }
    if (route?.view === 'recurring') read('recurring', () => recurringInvoices.page(organizationId, route));
    if (route?.view === 'gst_returns')
      read('gstr1', () => gstr1Report(organizationId, route, result.businessDate));
    if (route?.view === 'expenses')
      read('expensePage', () => expensePage(organizationId, route, result.businessDate));
    if (route?.view === 'credit_notes')
      read('creditNotePage', () => creditNotePage(organizationId, route, result.businessDate));
    if (route?.view === 'stock') read('stockPage', () => queries.stockLevels(organizationId));
    if (route?.view === 'finance') {
      if (!financeAllowed(user))
        throw new HttpError(403, 'The finance dashboard is for administrators and Finance logins.');
      read('finance', async () => {
        const finance = await financeData(result.organizations, route.query, result.businessDate);
        const rows = finance.businesses.map((business) => business.summary);
        // shortcut: every receipt and paid bill of the year goes into the page for bank matching; page by month if a year grows large.
        const bank = {
          receipts: finance.businesses.flatMap(({ summary, detail }) =>
            detail.payments.map((payment) => ({
              date: payment.paidOn,
              amount: payment.amount,
              reference: payment.reference ?? '',
              label: `${payment.document.number} · ${payment.document.customerSnapshot?.name ?? ''}`,
              business: summary.name,
            })),
          ),
          payments: finance.businesses.flatMap(({ summary, expenses }) =>
            expenses
              .filter((row) => row.paidOn)
              .map((row) => ({
                date: row.paidOn,
                amount: row.total,
                reference: row.billNumber ?? '',
                label: `${row.vendorName}${row.billNumber ? ` · ${row.billNumber}` : ''}`,
                business: summary.name,
              })),
          ),
        };
        // Registers across every business, newest first.
        // shortcut: each register shows the newest 500 rows; the Excel download has all of them.
        const newest = (rows) => rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500);
        const registers = {
          invoices: newest(
            finance.businesses.flatMap(({ summary, detail }) =>
              detail.invoices.map((doc) => ({
                id: doc.id,
                businessId: summary.id,
                business: summary.name,
                date: doc.issueDate,
                number: doc.number,
                type: doc.debitNoteFor ? 'Debit note' : 'Invoice',
                party: doc.customerSnapshot?.name ?? '',
                total: doc.totals.total,
                balance: doc.status === 'cancelled' ? 0 : (doc.balanceDue ?? 0),
                status: doc.status,
              })),
            ),
          ),
          receipts: newest(
            finance.businesses.flatMap(({ summary, detail }) =>
              detail.payments.map((payment) => ({
                business: summary.name,
                date: payment.paidOn,
                number: payment.document.number,
                party: payment.document.customerSnapshot?.name ?? '',
                mode: PAYMENT_METHODS[payment.method] ?? payment.method ?? '',
                reference: payment.reference ?? '',
                amount: payment.amount,
              })),
            ),
          ),
          expenses: newest(
            finance.businesses.flatMap(({ summary, expenses }) =>
              expenses.map((row) => ({
                business: summary.name,
                date: row.billDate,
                vendor: row.vendorName,
                billNumber: row.billNumber ?? '',
                category: row.category ?? '',
                total: row.total,
                paidOn: row.paidOn ?? '',
              })),
            ),
          ),
        };
        return {
          year: finance.year,
          label: finance.label,
          rows,
          totals: groupTotals(rows),
          bank,
          registers,
          ai: ai ? await ai.status() : { configured: false },
        };
      });
    }
    if (route?.view === 'e_invoice')
      read('einvoicePage', async () => {
        const doc = await db.models.documents.findById(route.id);
        if (doc?.organizationId !== organizationId || doc.kind !== 'invoice')
          throw new HttpError(404, 'Invoice not found.');
        return {
          document: {
            id: doc.id,
            number: doc.number,
            status: doc.status,
            customerName: doc.customerSnapshot?.name ?? '',
            total: doc.totals.total,
            einvoice: doc.einvoice ?? null,
            ewayBill: doc.ewayBill ?? null,
          },
          einvoiceProblems: einvoiceProblems(doc),
          ewayProblems: einvoiceProblems(doc, { ewayBill: true }),
        };
      });
    if (route?.view === 'reports')
      read('report', async () => {
        const year = readReportYear(route.query, result.businessDate);
        const range = financialYearRange(year);
        const [rows, expenses] = await Promise.all([
          queries.reportData(organizationId, range),
          db.models.expenses.listBetween(organizationId, range),
        ]);
        return buildReport({ ...rows, expenses, year, asOf: result.businessDate });
      });
    if (legacy || route.view === 'integrations')
      read('integrationStatus', async () => {
        const payment = await online.getStatus(organizationId);
        return {
          email: await mailer.status(organizationId),
          payment,
          razorpay: payment,
          gst: gstStatus(),
          ai: ai ? await ai.status() : { configured: false },
          environmentPrefix: integrationEnvironmentPrefix(result.organization),
          webhookPath:
            payment.provider === 'none' ? '' : `/api/webhooks/${payment.provider}/${organizationId}`,
        };
      });
    if (!auth || user.role === 'admin') {
      if (legacy || ['team', 'security'].includes(route.view))
        read('teamUsers', () => (auth ? auth.listUsers() : []));
      if (legacy || route.view === 'backups') {
        result.backupStatus = backups.status();
        read('backups', async () => {
          try {
            return await backupStorage.listBackupMetadata();
          } catch (error) {
            logger?.error('backup_failed', { error });
            result.backupStatus.lastFailure = true;
            return [];
          }
        });
      }
      if (route?.view === 'letterhead')
        read('letterhead', async () => (await db.models.letterheads.findById(organizationId)) ?? null);
    } else if (
      [
        'team',
        'security',
        'backups',
        'integrations',
        'business_settings',
        'dashboard_branding',
        'letterhead',
      ].includes(route?.view)
    ) {
      throw new HttpError(403, 'Administrator access is required for this page.');
    }
    await Promise.all(tasks);
    if (editor) {
      // Only whether a letterhead exists and is the default; the image stays out of page data.
      const letterhead = await db.models.letterheads.findById(organizationId);
      result.letterhead = letterhead ? { defaultOn: letterhead.defaultOn } : null;
      const [contactPage, catalogPage] = await Promise.all([
        directories.lookup(
          'customers',
          organizationId,
          readDirectoryFilters('customers', {}, { lookup: true }),
        ),
        directories.lookup(
          'catalog',
          organizationId,
          readDirectoryFilters(
            'catalog',
            { product: result.document?.businessProductId || 'shared' },
            { lookup: true },
          ),
        ),
      ]);
      result.customers = contactPage.items;
      result.catalog = catalogPage.items;
      // A selected archived contact is retained without loading the rest of the directory.
      if (
        result.document?.customerId &&
        !result.customers.some((item) => item.id === result.document.customerId)
      ) {
        const selected = await db.models.customers.findById(result.document.customerId);
        if (selected?.organizationId === organizationId) result.customers.push(normalizeContact(selected));
      }
      result.lookupPages = Object.fromEntries(
        [
          ['customers', contactPage],
          ['catalog', catalogPage],
        ].map(([key, { items, ...page }]) => [key, page]),
      );
    }
    return result;
  }

  // GSTR-1 tables for /workspace/<business>/gst_returns?month=YYYY-MM&gstin=..., with download links.
  async function gstr1Report(organizationId, route, businessDate) {
    const filters = readGstr1Filters(route.query, businessDate);
    const range = monthRange(filters.month);
    const report = buildGstr1(
      await queries.gstr1Invoices(organizationId, range),
      filters,
      await db.models.creditNotes.listBetween(organizationId, range),
    );
    const pageUrl = `/workspace/${encodeURIComponent(organizationId)}/gst_returns`;
    const downloads = Object.fromEntries(
      Object.keys(GSTR1_SECTIONS).map((section) => [
        section,
        `${pageUrl}?${new URLSearchParams({ month: report.month, gstin: report.gstin, download: 'csv', section })}`,
      ]),
    );
    return { ...report, sections: GSTR1_SECTIONS, rows: report.sections, downloads };
  }

  // Expenses page: the month's expenses, totals, vendor choices and the expense being edited.
  async function expensePage(organizationId, route, businessDate) {
    const month = readExpenseMonth(route.query, businessDate);
    const expenses = await db.models.expenses.listBetween(organizationId, monthRange(month));
    let editing = null;
    if (route.action === 'edit' && route.id) {
      editing = await db.models.expenses.findById(route.id);
      if (editing?.organizationId !== organizationId) throw new HttpError(404, 'Expense not found.');
    }
    // shortcut: the vendor list is capped at 500 contacts; switch to a search box if businesses outgrow it.
    const vendors = await db
      .collection('customers')
      .find(
        { organizationId, roles: 'vendor', active: { $ne: false } },
        { ...db.options(), projection: { _id: 0, id: 1, name: 1, gstin: 1, stateCode: 1 } },
      )
      .sort({ name: 1 })
      .limit(500)
      .toArray();
    const pageUrl = `/workspace/${encodeURIComponent(organizationId)}/expenses`;
    return {
      month,
      expenses,
      totals: expenseTotals(expenses),
      vendors,
      editing,
      categories: EXPENSE_CATEGORIES,
      downloadUrl: `${pageUrl}?${new URLSearchParams({ month, download: 'csv' })}`,
    };
  }

  // Credit notes page: one credit note to print, or the month's credit notes and, with ?documentId=,
  // the invoice a new credit note is issued against.
  async function creditNotePage(organizationId, route, businessDate) {
    if (route.id) {
      const note = await db.models.creditNotes.findById(route.id);
      if (note?.organizationId !== organizationId) throw new HttpError(404, 'Credit note not found.');
      return { note };
    }
    const { month } = readGstr1Filters(route.query, businessDate);
    const notes = await db.models.creditNotes.listBetween(organizationId, monthRange(month));
    let invoice = null;
    if (route.documentId) {
      const document = await db.models.documents.findById(route.documentId);
      if (document?.organizationId !== organizationId || document.kind !== 'invoice')
        throw new HttpError(404, 'Invoice not found.');
      const credited = (await db.models.creditNotes.forInvoice(document.id))
        .filter((note) => note.status === 'issued')
        .reduce((sum, note) => sum + Math.round(note.total * 100), 0);
      const creditable = (Math.round(document.totals.total * 100) - credited) / 100;
      invoice = {
        id: document.id,
        number: document.number,
        issueDate: document.issueDate,
        customerName: document.customerSnapshot?.name ?? '',
        status: document.status,
        total: document.totals.total,
        balanceDue: document.balanceDue ?? 0,
        interstate: document.placeOfSupply !== document.organizationSnapshot?.stateCode,
        rates: [...new Set(document.items.map((item) => Number(item.gstRate) || 0))].sort((a, b) => a - b),
        creditable,
        canCredit: ['sent', 'partially_paid', 'paid'].includes(document.status) && creditable > 0,
        canDebit: !document.debitNoteFor && !['draft', 'cancelled'].includes(document.status),
      };
    }
    return { month, notes, invoice, reasons: CREDIT_NOTE_REASONS, debitReasons: DEBIT_NOTE_REASONS };
  }

  // CSV of one month's expenses: /workspace/<business>/expenses?month=YYYY-MM&download=csv.
  async function exportExpenses(user, organizationId, route) {
    const data = await base(user, organizationId);
    const month = readExpenseMonth(route.query, data.businessDate);
    const expenses = await db.models.expenses.listBetween(data.organization.id, monthRange(month));
    return {
      filename: `Expenses-${data.organization.name.replace(/[^a-z0-9]+/gi, '-')}-${month}.csv`,
      lines: expenseCsv(expenses),
    };
  }

  // CSV for one GSTR-1 section: /workspace/<business>/gst_returns?download=csv&section=b2b.
  async function exportGstr1(user, organizationId, route) {
    const data = await base(user, organizationId);
    const filters = readGstr1Filters(route.query, data.businessDate);
    const range = monthRange(filters.month);
    const [invoices, creditNotes] = await Promise.all([
      queries.gstr1Invoices(data.organization.id, range),
      db.models.creditNotes.listBetween(data.organization.id, range),
    ]);
    return gstr1Csv(buildGstr1(invoices, filters, creditNotes), String(route.query.section ?? ''));
  }

  // Streams the CSV for /workspace/<business>/<invoices|quotations|...>?download=csv.
  async function exportDocuments(user, organizationId, route) {
    const kind = DOCUMENT_KINDS[route.view];
    if (!kind || route.action) throw new HttpError(404, 'This document export is unavailable.');
    const data = await base(user, organizationId);
    const filters = readDocumentFilters(route.query);
    const cursor = queries.documentExport(data.organization.id, kind, filters, data.businessDate);
    return {
      filename: `${data.organization.name.replace(/[^a-z0-9]+/gi, '-')}-${route.view}.csv`,
      lines: documentCsv(cursor, data.businessDate),
    };
  }

  // Group finance downloads: ?download=xlsx | pdf | zip (invoice PDFs and the workbook), &business=<id> for one.
  async function exportFinance(user, organizationId, route) {
    const data = await base(user, organizationId);
    if (!financeAllowed(user))
      throw new HttpError(403, 'Group finance is for administrators and Accounts logins.');
    const business = typeof route.query.business === 'string' ? route.query.business : '';
    const organizations = business
      ? data.organizations.filter((organization) => organization.id === business)
      : data.organizations;
    if (!organizations.length) throw new HttpError(404, 'Business not found.');
    const finance = await financeData(organizations, route.query, data.businessDate);
    const name = `${business ? organizations[0].name.replace(/[^a-z0-9]+/gi, '-') : 'Group'}-finance-${finance.label.replace(/\W+/g, '')}`;
    const workbook = () => xlsx(financeWorkbook(finance.label, finance.businesses));
    const format = String(route.query.download);
    if (format === 'xlsx')
      return {
        filename: `${name}.xlsx`,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body: workbook(),
      };
    if (format === 'pdf')
      return {
        filename: `${name}.pdf`,
        type: 'application/pdf',
        body: await renderPdfBuffer(
          financePdf(
            finance.label,
            finance.businesses.map((row) => row.summary),
            data.businessDate,
          ),
        ),
      };
    if (format === 'zip') {
      // shortcut: at most 300 invoice PDFs per download, rendered one by one; choose one business for more.
      const issued = finance.businesses
        .flatMap(({ summary, detail }) =>
          detail.invoices
            .filter((doc) => doc.status !== 'cancelled')
            .map((doc) => ({ business: summary.name, id: doc.id })),
        )
        .slice(0, 300);
      const entries = [{ name: `${name}.xlsx`, data: workbook() }];
      for (const item of issued) {
        const pdf = await renderInvoiceAttachment(await db.models.documents.findById(item.id));
        entries.push({
          name: `${item.business.replace(/[^a-z0-9]+/gi, '-')}/${pdf.filename}`,
          data: Buffer.from(pdf.content, 'base64'),
        });
      }
      return { filename: `${name}.zip`, type: 'application/zip', body: zip(entries) };
    }
    throw new HttpError(404, 'Choose an Excel, PDF or ZIP download.');
  }

  return { load, exportDocuments, exportGstr1, exportExpenses, exportFinance };
}
