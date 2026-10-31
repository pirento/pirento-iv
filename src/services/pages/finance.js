/**
 * Group finance: one financial year across the businesses a login can open. Builds the summary
 * per business, the Excel workbook (Summary, Invoices, Payment Ledger, Expenses, GSTR-1 B2B in the
 * GST offline tool's columns) and a PDF summary. Sums are done in whole paise.
 */

import { PAYMENT_METHODS } from '../../../shared/types.js';
import { buildGstr1, GSTR1_SECTIONS } from './gstr1.js';

const paise = (value) => Math.round((Number(value) || 0) * 100);
const rupees = (value) => value / 100;
const sum = (rows, key) => rows.reduce((total, row) => total + paise(row[key]), 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonthYear = (iso) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');

/** Summary figures for one business from its year report (reports.js) and expenses. */
export function businessSummary(organization, report, expenses) {
  const inYear = (date) => report.months.some((month) => date?.startsWith(month.key));
  const spent = expenses.filter((row) => inYear(row.billDate));
  return {
    id: organization.id,
    name: organization.name,
    gstin: organization.gstin ?? '',
    sales: report.totals.sales,
    gstOnSales: rupees(paise(report.totals.salesWithGst) - paise(report.totals.sales)),
    salesWithGst: report.totals.salesWithGst,
    received: report.totals.received,
    outstanding: report.outstanding,
    overdue: rupees(report.aging.slice(1).reduce((total, row) => total + paise(row.amount), 0)),
    expenses: report.totals.expenses,
    gstOnExpenses: rupees(sum(spent, 'tax')),
    profit: report.totals.profit,
  };
}

/** Group total of the business summaries. */
export function groupTotals(rows) {
  const keys = [
    'sales',
    'gstOnSales',
    'salesWithGst',
    'received',
    'outstanding',
    'overdue',
    'expenses',
    'gstOnExpenses',
    'profit',
  ];
  return Object.fromEntries(keys.map((key) => [key, rupees(sum(rows, key))]));
}

/**
 * A receipt split like the invoice it paid: taxable value in the invoice's proportion, the rest as
 * GST, CGST + SGST halves within the state (CGST takes the odd paisa) or IGST across states.
 */
export function receiptSplit(payment) {
  const document = payment.document;
  const amount = paise(payment.amount);
  const total = paise(document.totals?.total);
  const taxable = total ? Math.round((amount * paise(document.totals.taxable)) / total) : amount;
  const tax = amount - taxable;
  const interstate = document.placeOfSupply !== document.organizationSnapshot?.stateCode;
  const cgst = interstate ? 0 : Math.ceil(tax / 2);
  return {
    taxable: rupees(taxable),
    cgst: rupees(cgst),
    sgst: rupees(interstate ? 0 : tax - cgst),
    igst: rupees(interstate ? tax : 0),
  };
}

const SUMMARY_COLUMNS = [
  'Business',
  'GSTIN',
  'Sales (before GST)',
  'GST on sales',
  'Sales incl. GST',
  'Money received',
  'Outstanding today',
  'Overdue today',
  'Expenses (before GST)',
  'GST on expenses (input credit)',
  'Profit (before GST)',
];
const summaryRow = (row) => [
  row.name,
  row.gstin,
  row.sales,
  row.gstOnSales,
  row.salesWithGst,
  row.received,
  row.outstanding,
  row.overdue,
  row.expenses,
  row.gstOnExpenses,
  row.profit,
];

/** Excel sheets for the year: [{ name, rows }]; each business entry is { summary, detail, expenses }. */
export function financeWorkbook(label, businesses) {
  const summaries = businesses.map((business) => business.summary);
  const invoices = businesses.flatMap(({ summary, detail }) =>
    detail.invoices
      .slice()
      .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number))
      .map((doc) => [
        summary.name,
        doc.number,
        dayMonthYear(doc.issueDate),
        doc.debitNoteFor ? 'Debit note' : 'Invoice',
        doc.customerSnapshot?.name ?? '',
        doc.customerSnapshot?.gstin ?? '',
        doc.totals.taxable,
        doc.totals.cgst ?? 0,
        doc.totals.sgst ?? 0,
        doc.totals.igst ?? 0,
        doc.totals.total,
        doc.status === 'cancelled' ? 0 : (doc.amountPaid ?? 0),
        doc.status === 'cancelled' ? 0 : (doc.balanceDue ?? 0),
        doc.status,
      ]),
  );
  const ledger = businesses.flatMap(({ summary, detail }) =>
    detail.payments.map((payment) => {
      const split = receiptSplit(payment);
      return [
        dayMonthYear(payment.paidOn),
        payment.document.number,
        payment.document.customerSnapshot?.name ?? '',
        payment.document.customerSnapshot?.gstin ?? '',
        payment.notes || `Payment against ${payment.document.title || payment.document.number}`,
        PAYMENT_METHODS[payment.method] ?? payment.method ?? '',
        payment.reference ?? '',
        payment.amount,
        split.taxable,
        split.cgst,
        split.sgst,
        split.igst,
        summary.name,
      ];
    }),
  );
  const expenses = businesses.flatMap(({ summary, expenses: rows }) =>
    rows
      .slice()
      .sort((a, b) => a.billDate.localeCompare(b.billDate))
      .map((row) => [
        summary.name,
        dayMonthYear(row.billDate),
        row.billNumber,
        row.vendorName,
        row.vendorGstin,
        row.category,
        row.taxable,
        row.cgst,
        row.sgst,
        row.igst,
        row.total,
        dayMonthYear(row.paidOn),
      ]),
  );
  const b2b = businesses.flatMap(({ detail }) => buildGstr1(detail.invoices, { month: label }).sections.b2b);
  const totals = groupTotals(summaries);
  return [
    {
      name: 'Summary',
      rows: [
        SUMMARY_COLUMNS,
        ...summaries.map(summaryRow),
        summaryRow({ ...totals, name: `Group total ${label}`, gstin: '' }),
      ],
    },
    {
      name: 'Invoices',
      rows: [
        [
          'Business',
          'Document no.',
          'Date',
          'Type',
          'Party',
          'Party GSTIN',
          'Taxable value',
          'CGST',
          'SGST',
          'IGST',
          'Total (incl. GST)',
          'Received',
          'Balance',
          'Status',
        ],
        ...invoices,
      ],
    },
    {
      name: 'Payment Ledger',
      rows: [
        [
          'Date',
          'Document no.',
          'Party',
          'Party GSTIN',
          'Particulars',
          'Mode',
          'Bank reference',
          'Amount received (incl. GST)',
          'Taxable value',
          'CGST',
          'SGST',
          'IGST',
          'Business',
        ],
        ...ledger,
      ],
    },
    {
      name: 'Expenses',
      rows: [
        [
          'Business',
          'Bill date',
          'Bill no.',
          'Vendor',
          'Vendor GSTIN',
          'Category',
          'Taxable value',
          'CGST',
          'SGST',
          'IGST',
          'Total',
          'Paid on',
        ],
        ...expenses,
      ],
    },
    { name: 'GSTR-1 B2B', rows: [GSTR1_SECTIONS.b2b.columns, ...b2b] },
  ];
}

const money = (value) =>
  `Rs ${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** pdfmake definition of the group finance summary (A4 landscape). */
export function financePdf(label, rows, generatedOn) {
  const totals = groupTotals(rows);
  const headers = [
    'Business',
    'Sales',
    'GST on sales',
    'Received',
    'Outstanding',
    'Overdue',
    'Expenses',
    'Input GST',
    'Profit',
  ];
  const line = (row, bold = false) =>
    [
      row.name,
      row.sales,
      row.gstOnSales,
      row.received,
      row.outstanding,
      row.overdue,
      row.expenses,
      row.gstOnExpenses,
      row.profit,
    ].map((value, index) => ({
      text: index ? money(value) : value,
      alignment: index ? 'right' : 'left',
      bold,
    }));
  const [year, month, day] = generatedOn.split('-');
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [32, 36, 32, 36],
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#13303b' },
    content: [
      { text: 'Group finance', fontSize: 18, bold: true, color: '#0e4d64' },
      {
        text: `${label} · generated ${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`,
        margin: [0, 2, 0, 12],
        color: '#5c6b73',
      },
      {
        table: {
          headerRows: 1,
          widths: ['*', ...headers.slice(1).map(() => 'auto')],
          body: [
            headers.map((text, index) => ({
              text,
              bold: true,
              color: '#fff',
              alignment: index ? 'right' : 'left',
            })),
            ...rows.map((row) => line(row)),
            line({ ...totals, name: 'Group total' }, true),
          ],
        },
        layout: {
          fillColor: (index) => (index === 0 ? '#0e4d64' : index === rows.length + 1 ? '#fbe4da' : null),
          hLineColor: () => '#efdfd2',
          vLineWidth: () => 0,
        },
      },
      {
        text: 'Sales and expenses are before GST; outstanding and overdue are as of the generation date. Credit notes are taken off sales.',
        margin: [0, 10, 0, 0],
        fontSize: 8,
        color: '#5c6b73',
      },
    ],
  };
}
