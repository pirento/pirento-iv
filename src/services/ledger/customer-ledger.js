import { createCustomerLedgerQueries } from '../../models/customer-ledger-queries.js';
import { HttpError } from '../../middleware/errors.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';
import { buildCustomerStatement, invoiceLedgerTotals } from './ledger-statement.js';
import {
  CURRENT_STATUS_NOTICE,
  addLedgerTotals,
  csvRow,
  customerLedgerHref,
  decimalPaise,
  emptyLedgerTotals,
  invoiceHref,
  ledgerIdentifier,
  linkedCustomerId,
  pageRows,
  readLedgerListFilters,
  readLedgerStatementFilters,
} from './ledger-values.js';

function customerIdentity(customer, organizationId, missingContact = false) {
  return {
    id: customer.id,
    name: String(customer.name || 'Customer record unavailable'),
    email: String(customer.email ?? ''),
    phone: String(customer.phone ?? ''),
    address: String(customer.address ?? ''),
    gstin: String(customer.gstin ?? ''),
    active: !missingContact && customer.active !== false,
    missingContact,
    href: customerLedgerHref(organizationId, customer.id),
  };
}
function snapshotCustomer(documents, customerId, organizationId) {
  const latest = [...documents].sort(
    (left, right) =>
      String(right.updatedAt ?? right.createdAt ?? '').localeCompare(
        String(left.updatedAt ?? left.createdAt ?? ''),
      ) || String(left.id).localeCompare(String(right.id)),
  )[0];
  return customerIdentity({ ...latest?.customerSnapshot, id: customerId }, organizationId, true);
}
const safeFilename = (value) =>
  String(value)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'workspace';

/** Read-only customer balances: no duplicate ledger, inferred name match or financial mutation. */
export function createCustomerLedger({ db, now = () => new Date(), auth = true }) {
  const queries = createCustomerLedgerQueries(db);

  function authorize(user, organizationId) {
    if (auth) {
      if (!user || user.status !== 'active') throw new HttpError(401, 'Sign in to continue.');
      if (
        user.role !== 'admin' &&
        (!Array.isArray(user.organizationIds) || !user.organizationIds.includes(organizationId))
      )
        throw new HttpError(403, 'Your account does not have access to this organization.');
    }
    return ledgerIdentifier(organizationId);
  }
  async function organization(reader, id) {
    const result = await reader.organization(id);
    if (!result) throw new HttpError(404, 'Organization not found.');
    return { ...result, legalName: result.legalName || result.name };
  }

  async function loadList(user, requestedOrganizationId, query, allRows = false) {
    const organizationId = authorize(user, requestedOrganizationId);
    const filters = readLedgerListFilters(query);
    const businessDate = indiaBusinessDate(now());
    return queries.read(async (reader) => {
      const selectedOrganization = await organization(reader, organizationId);
      const identities = new Map();
      const customerCursor = reader.customers(organizationId);
      try {
        for await (const customer of customerCursor)
          identities.set(customer.id, {
            ...customerIdentity(customer, organizationId),
            ...emptyLedgerTotals(),
          });
      } finally {
        await customerCursor.close();
      }
      const missingSnapshots = new Map();
      const unlinked = { ...emptyLedgerTotals(), documentCount: 0, examples: [] };
      const invoiceCursor = reader.invoices(organizationId);
      try {
        for await (const document of invoiceCursor) {
          const totals = invoiceLedgerTotals(document, businessDate);
          const customerId = linkedCustomerId(document.customerId);
          if (!customerId) {
            addLedgerTotals(unlinked, totals);
            unlinked.documentCount++;
            if (unlinked.examples.length < 5)
              unlinked.examples.push({
                id: document.id,
                number: document.number,
                href: invoiceHref(organizationId, document.id),
              });
            continue;
          }
          if (!identities.has(customerId)) {
            const identity = customerIdentity(
              { ...document.customerSnapshot, id: customerId },
              organizationId,
              true,
            );
            identities.set(customerId, { ...identity, ...emptyLedgerTotals() });
            missingSnapshots.set(customerId, document);
          } else if (identities.get(customerId).missingContact) {
            const previous = missingSnapshots.get(customerId);
            const latest = [previous, document].sort(
              (left, right) =>
                String(right.updatedAt ?? right.createdAt ?? '').localeCompare(
                  String(left.updatedAt ?? left.createdAt ?? ''),
                ) || String(left.id).localeCompare(String(right.id)),
            )[0];
            missingSnapshots.set(customerId, latest);
            Object.assign(
              identities.get(customerId),
              customerIdentity({ ...latest.customerSnapshot, id: customerId }, organizationId, true),
            );
          }
          addLedgerTotals(identities.get(customerId), totals);
        }
      } finally {
        await invoiceCursor.close();
      }
      const search = filters.q.toLocaleLowerCase('en-IN');
      const matches = [...identities.values()]
        .filter(
          (customer) =>
            (filters.active === 'all' ||
              (filters.active === 'active' ? customer.active : !customer.active)) &&
            (filters.balance === 'all' ||
              (filters.balance === 'outstanding'
                ? customer.outstandingPaise > 0
                : customer.overduePaise > 0)) &&
            (!search ||
              [customer.id, customer.name, customer.email, customer.phone, customer.gstin].some((value) =>
                String(value).toLocaleLowerCase('en-IN').includes(search),
              )),
        )
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name, 'en-IN', { sensitivity: 'base' }) ||
            left.id.localeCompare(right.id),
        );
      const totals = emptyLedgerTotals();
      for (const customer of matches) addLedgerTotals(totals, customer);
      const page = pageRows(matches, filters, allRows);
      const notices = [{ ...CURRENT_STATUS_NOTICE }];
      if (
        matches.some(
          (customer) =>
            customer.unreceiptedCreditPaise !== 0 ||
            customer.invoicedPaise - customer.receivedPaise !== customer.outstandingPaise,
        )
      )
        notices.push({
          code: 'legacy_balance',
          message:
            'Some saved paid/balance values differ from receipt records or invoice totals. Open the statement for its current totals and history limitations.',
        });
      if (missingSnapshots.size)
        notices.push({
          code: 'missing_contacts',
          count: missingSnapshots.size,
          message:
            'Some invoices retain a stable customer ID whose contact record is missing. Their saved customer snapshot is shown; identities are not merged by name.',
        });
      if (unlinked.documentCount)
        notices.push({
          code: 'unlinked_invoices',
          count: unlinked.documentCount,
          message:
            'Invoices without a usable saved customer ID are shown separately for this organization. Their names are not matched to contacts and their amounts are outside the customer-list totals.',
        });
      return {
        organization: selectedOrganization,
        businessDate,
        filters,
        page: page.page,
        pageSize: page.pageSize,
        pageCount: page.pageCount,
        total: page.total,
        customers: page.rows,
        totals,
        unlinked,
        notices,
      };
    });
  }

  async function statement(
    user,
    requestedOrganizationId,
    requestedCustomerId,
    query = {},
    { allRows = false } = {},
  ) {
    const organizationId = authorize(user, requestedOrganizationId);
    const customerId = ledgerIdentifier(requestedCustomerId);
    const filters = readLedgerStatementFilters(query);
    const businessDate = indiaBusinessDate(now());
    return queries.read(async (reader) => {
      const selectedOrganization = await organization(reader, organizationId);
      const savedCustomer = await reader.customer(organizationId, customerId);
      const documents = await reader
        .invoices(organizationId, customerId, { withReceiptSummary: false })
        .toArray();
      if (!savedCustomer && !documents.length)
        throw new HttpError(404, 'Customer not found in this organization.');
      const customer = savedCustomer
        ? customerIdentity(savedCustomer, organizationId)
        : snapshotCustomer(documents, customerId, organizationId);
      const documentIds = documents.map((document) => document.id);
      const payments = documentIds.length ? await reader.payments(organizationId, documentIds).toArray() : [];
      const events = documentIds.length ? await reader.eventCounts(documentIds).toArray() : [];
      const data = buildCustomerStatement(documents, payments, events, { businessDate, ...filters });
      const page = pageRows(data.rows, filters, allRows);
      if (customer.missingContact)
        data.history.notices.push({
          code: 'missing_contact',
          message:
            'The contact record is missing. This statement uses invoices with this exact saved customer ID and their latest customer snapshot.',
        });
      return {
        organization: selectedOrganization,
        customer,
        businessDate,
        filters,
        page: page.page,
        pageSize: page.pageSize,
        pageCount: page.pageCount,
        total: page.total,
        ...data,
        rows: page.rows,
      };
    });
  }

  async function exportCustomers(user, organizationId, query = {}) {
    const data = await loadList(user, organizationId, query, true);
    async function* lines() {
      yield '\uFEFF' +
        csvRow([
          'Customer ID',
          'Customer',
          'Contact state',
          'Email',
          'Phone',
          'Invoices',
          'Invoiced (INR)',
          'Received (INR)',
          'Outstanding (INR)',
          'Overdue (INR)',
          'Undated receipt difference (INR)',
          'Statement URL',
          'Basis',
        ]);
      for (const customer of data.customers)
        yield csvRow([
          customer.id,
          customer.name,
          customer.missingContact ? 'missing contact' : customer.active ? 'active' : 'archived',
          customer.email,
          customer.phone,
          customer.invoiceCount,
          decimalPaise(customer.invoicedPaise),
          decimalPaise(customer.receivedPaise),
          decimalPaise(customer.outstandingPaise),
          decimalPaise(customer.overduePaise),
          decimalPaise(customer.unreceiptedCreditPaise),
          customer.href,
          CURRENT_STATUS_NOTICE.message,
        ]);
      if (
        data.unlinked.documentCount &&
        !data.filters.q &&
        data.filters.active === 'all' &&
        data.filters.balance === 'all'
      ) {
        const unlinked = data.unlinked;
        yield csvRow([
          '',
          'Unlinked invoices — organization total, outside customer totals',
          'unlinked',
          '',
          '',
          unlinked.invoiceCount,
          decimalPaise(unlinked.invoicedPaise),
          decimalPaise(unlinked.receivedPaise),
          decimalPaise(unlinked.outstandingPaise),
          decimalPaise(unlinked.overduePaise),
          decimalPaise(unlinked.unreceiptedCreditPaise),
          '',
          CURRENT_STATUS_NOTICE.message,
        ]);
      }
    }
    return { filename: `${safeFilename(data.organization.name)}-customer-balances.csv`, lines: lines() };
  }

  async function exportStatement(user, organizationId, customerId, query = {}) {
    const data = await statement(user, organizationId, customerId, query, { allRows: true });
    async function* lines() {
      yield '\uFEFF' +
        csvRow([
          'Date',
          'Type',
          'Invoice',
          'Receipt ID',
          'Reference',
          'Description',
          'Debit (INR)',
          'Credit (INR)',
          'Balance (INR)',
          'Document URL',
        ]);
      const note = (type, description) => csvRow(['', type, '', '', '', description, '', '', '', '']);
      yield note(
        'statement',
        `${data.organization.name} | Customer: ${data.customer.name} | Customer ID: ${data.customer.id} | Generated on ${data.businessDate} (Asia/Kolkata)`,
      );
      yield note(
        'period',
        `${data.filters.from || 'Beginning of recorded dates'} to ${data.filters.to || 'End of recorded dates'} (inclusive)`,
      );
      yield csvRow([
        data.filters.from,
        'opening_balance',
        '',
        '',
        '',
        data.history.complete
          ? 'Opening balance on current invoice status basis'
          : 'Opening balance unavailable: incomplete dated history',
        '',
        '',
        decimalPaise(data.period.openingBalancePaise),
        '',
      ]);
      for (const row of data.rows)
        yield csvRow([
          row.date,
          row.type,
          row.documentNumber,
          row.paymentId,
          row.reference,
          row.description,
          decimalPaise(row.debitPaise),
          decimalPaise(row.creditPaise),
          decimalPaise(row.balancePaise),
          row.href,
        ]);
      yield csvRow([
        data.filters.to,
        'closing_balance',
        '',
        '',
        '',
        data.history.complete
          ? 'Closing balance on current invoice status basis'
          : 'Closing balance unavailable: incomplete dated history',
        '',
        '',
        decimalPaise(data.period.closingBalancePaise),
        '',
      ]);
      yield csvRow([
        '',
        'current_totals',
        '',
        '',
        '',
        'Current issued invoice totals, independent of date filters',
        decimalPaise(data.summary.invoicedPaise),
        decimalPaise(data.summary.receivedPaise),
        decimalPaise(data.summary.outstandingPaise),
        '',
      ]);
      for (const notice of data.history.notices)
        yield note('notice', notice.message + (notice.count ? ` Records: ${notice.count}.` : ''));
      for (const document of data.excludedDocuments)
        yield csvRow([
          document.issueDate,
          'excluded_invoice',
          document.number,
          '',
          '',
          `${document.reason} Saved total INR ${decimalPaise(document.amountPaise)}.`,
          '',
          '',
          '',
          document.href,
        ]);
    }
    return {
      filename: `${safeFilename(data.organization.name)}-${safeFilename(data.customer.name)}-statement.csv`,
      lines: lines(),
    };
  }

  return {
    list: (user, organizationId, query = {}) => loadList(user, organizationId, query),
    statement,
    exportCustomers,
    exportStatement,
  };
}
