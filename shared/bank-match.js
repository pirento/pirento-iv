/**
 * Bank statement matching for Group finance (runs in the browser): reads statement rows from a
 * bank's CSV or Excel export, then matches credits to receipts and debits to paid bills by amount
 * and date (a few days apart), preferring a book entry whose reference appears in the narration.
 */

const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const paise = (value) => Math.round((Number(value) || 0) * 100);

/** Rows of cells from CSV text (quoted fields, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') ((cell += '"'), index++);
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') (row.push(cell), (cell = ''));
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      (row.push(cell), rows.push(row), (row = []), (cell = ''));
    } else cell += char;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows.map((cells) => cells.map((value) => value.trim()));
}

/** ISO date from a statement cell: 15/10/2026, 15-10-26, 15-Oct-2026, 2026-10-15 or an Excel day number. */
export function statementDate(value) {
  if (typeof value === 'number' && value > 20000 && value < 80000)
    return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000).toISOString().slice(0, 10);
  const text = String(value ?? '').trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = /^(\d{1,2})[/\-. ]([A-Za-z]{3}|\d{1,2})[A-Za-z]*[/\-. ,]+(\d{2}|\d{4})\b/.exec(text);
  if (!match) return '';
  const month = /\d/.test(match[2]) ? Number(match[2]) : MONTHS[match[2].toLowerCase()];
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  if (!month || month > 12 || Number(match[1]) > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

const amount = (value) => {
  const text = String(value ?? '').replace(/[,₹\s]|INR|Rs\.?/gi, '');
  const number = Number(text.replace(/(cr|dr)$/i, ''));
  return Number.isFinite(number) ? Math.abs(number) : 0;
};

/**
 * Statement lines { date, narration, reference, credit, debit } from rows of cells. The header row is
 * the first with a date column and a credit/deposit or debit/withdrawal (or amount) column.
 */
export function statementLines(rows) {
  const find = (header, pattern, skip = -1) =>
    header.findIndex((cell, index) => index !== skip && pattern.test(cell));
  const headerIndex = rows.findIndex(
    (row) =>
      row.some((cell) => /date/i.test(cell)) &&
      row.some((cell) => /deposit|credit|withdraw|debit|amount/i.test(cell)),
  );
  if (headerIndex < 0)
    throw new Error(
      'No statement header found. The file needs Date and Deposit/Credit or Withdrawal/Debit columns.',
    );
  const header = rows[headerIndex].map((cell) => String(cell).toLowerCase());
  const valueDate = find(header, /value\s*date/);
  const date = find(header, /date/, valueDate) >= 0 ? find(header, /date/, valueDate) : valueDate;
  const narration = find(header, /narration|description|particular|remark|details/);
  const reference = find(header, /ref|chq|cheque|utr/);
  // A 'Cr/Dr' (or type) column says which way a single amount column goes.
  const kind = find(header, /cr\s*\/\s*dr|dr\s*\/\s*cr|type/);
  const credit = find(header, /deposit|credit|\bcr\b/, kind);
  const debit = find(header, /withdraw|debit|\bdr\b/, kind);
  const single = credit < 0 && debit < 0 ? find(header, /amount/) : -1;
  return rows
    .slice(headerIndex + 1)
    .map((row) => {
      const iso = statementDate(row[date]);
      if (!iso) return null;
      let credited = credit >= 0 ? amount(row[credit]) : 0;
      let debited = debit >= 0 ? amount(row[debit]) : 0;
      if (single >= 0) {
        const value = amount(row[single]);
        const isDebit =
          /dr|debit|withdraw/i.test(String(row[kind] ?? '')) || /dr$/i.test(String(row[single]));
        credited = isDebit ? 0 : value;
        debited = isDebit ? value : 0;
      }
      if (!credited && !debited) return null;
      return {
        date: iso,
        narration: String(row[narration] ?? ''),
        reference: String(row[reference] ?? ''),
        credit: credited,
        debit: debited,
      };
    })
    .filter(Boolean);
}

const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const normal = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Matches statement lines with book entries { date, amount, reference, label, business }:
 * credits with receipts, debits with paid bills. Returns rows with status 'matched',
 * 'bank-only' (no book entry) or 'books-only' (a book entry in the statement's dates with no line).
 */
export function matchStatement(lines, { receipts, payments }, toleranceDays = 3) {
  const used = new Set();
  const rows = lines.map((line) => {
    const pool = line.credit ? receipts : payments;
    const value = paise(line.credit || line.debit);
    const text = normal(`${line.narration} ${line.reference}`);
    const candidates = pool.filter(
      (book) =>
        !used.has(book) && paise(book.amount) === value && days(book.date, line.date) <= toleranceDays,
    );
    const book =
      candidates.find(
        (entry) => normal(entry.reference).length >= 4 && text.includes(normal(entry.reference)),
      ) ?? candidates.sort((a, b) => days(a.date, line.date) - days(b.date, line.date))[0];
    if (book) used.add(book);
    return { status: book ? 'matched' : 'bank-only', line, book: book ?? null };
  });
  const dates = lines.map((line) => line.date).sort();
  const inRange = (book) => dates.length && book.date >= dates[0] && book.date <= dates.at(-1);
  for (const [pool, direction] of [
    [receipts, 'credit'],
    [payments, 'debit'],
  ])
    for (const book of pool)
      if (!used.has(book) && inRange(book)) rows.push({ status: 'books-only', direction, line: null, book });
  const count = (status) => rows.filter((row) => row.status === status).length;
  return {
    rows,
    counts: { matched: count('matched'), bankOnly: count('bank-only'), booksOnly: count('books-only') },
  };
}
