/**
 * GSTR-2B matching for the Expenses page: reads the B2B invoices from the GSTR-2B JSON file
 * downloaded from the GST portal and compares them with the month's expenses by vendor GSTIN and
 * bill number. Runs in the browser; nothing is uploaded to the server.
 */

const paise = (value) => Math.round((Number(value) || 0) * 100);
// Bill numbers are compared without case, punctuation or leading zeros: "PM/007" = "pm 7" = "PM007".
const billKey = (gstin, number) =>
  `${String(gstin ?? '')
    .trim()
    .toUpperCase()}|${String(number ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((part) => part.replace(/^0+(?=.)/, '').replace(/([A-Z])0+(?=\d)/g, '$1'))
    .join('')}`;

/** { period: 'YYYY-MM' | '', invoices: [{ gstin, name, number, date, taxable, tax }] } from the portal JSON. */
export function readGstr2b(json) {
  const data = json?.data ?? json;
  const docdata = data?.docdata;
  if (!docdata || typeof docdata !== 'object')
    throw new Error('This is not a GSTR-2B JSON file downloaded from the GST portal.');
  const period = /^(\d{2})(\d{4})$/.exec(String(data.rtnprd ?? ''));
  const invoices = (docdata.b2b ?? []).flatMap((supplier) =>
    (supplier.inv ?? []).map((invoice) => {
      // Totals are on the invoice; older files only have them per rate in items.
      const sum = (key) =>
        invoice[key] ?? (invoice.items ?? []).reduce((total, item) => total + (Number(item[key]) || 0), 0);
      const [day, month, year] = String(invoice.dt ?? '').split('-');
      return {
        gstin: String(supplier.ctin ?? ''),
        name: String(supplier.trdnm ?? ''),
        number: String(invoice.inum ?? ''),
        date: year ? `${year}-${month}-${day}` : '',
        taxable: paise(sum('txval')) / 100,
        tax: (paise(sum('igst')) + paise(sum('cgst')) + paise(sum('sgst')) + paise(sum('cess'))) / 100,
      };
    }),
  );
  return { period: period ? `${period[2]}-${period[1]}` : '', invoices };
}

/**
 * Compares portal invoices with expenses. Each row has status 'matched', 'different' (taxable value
 * or GST differs by more than ₹1), 'not-in-books' (in GSTR-2B only) or 'not-in-2b' (a bill with a
 * vendor GSTIN that the vendor has not reported). Bills without a vendor GSTIN are left out.
 */
export function matchGstr2b(invoices, expenses) {
  const books = new Map();
  for (const expense of expenses)
    if (expense.vendorGstin) books.set(billKey(expense.vendorGstin, expense.billNumber), expense);
  const rows = invoices.map((portal) => {
    const key = billKey(portal.gstin, portal.number);
    const book = books.get(key);
    books.delete(key);
    const close = (a, b) => Math.abs(paise(a) - paise(b)) <= 100;
    return {
      status: !book
        ? 'not-in-books'
        : close(portal.taxable, book.taxable) && close(portal.tax, book.tax)
          ? 'matched'
          : 'different',
      portal,
      book: book ?? null,
    };
  });
  for (const book of books.values()) rows.push({ status: 'not-in-2b', portal: null, book });
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    rows,
    counts: {
      matched: count('matched'),
      different: count('different'),
      notInBooks: count('not-in-books'),
      notIn2b: count('not-in-2b'),
    },
    portalTax: invoices.reduce((total, row) => total + paise(row.tax), 0) / 100,
  };
}
