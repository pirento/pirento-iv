/** Group finance page (views/finance/index.ejs): matches a bank statement with the year's receipts and paid bills. */

import { escapeHtml } from '../core/api.js';
import { getPageData } from '../core/page.js';
import { readXlsxRows } from '../core/xlsx-read.js';
import { matchStatement, parseCsv, statementLines } from '/shared/bank-match.js';
import { money } from '/shared/types.js';

const finance = getPageData().finance;
const input = document.querySelector('[data-bank-file]');
const error = document.querySelector('[data-bank-error]');
const result = document.querySelector('[data-bank-result]');
const STATUS = { matched: 'Matched', 'bank-only': 'Only in bank', 'books-only': 'Only in books' };

input.addEventListener('change', async () => {
  error.hidden = true;
  result.innerHTML = '';
  const file = input.files[0];
  if (!file) return;
  try {
    const rows = /\.xlsx$/i.test(file.name)
      ? await readXlsxRows(await file.arrayBuffer())
      : parseCsv(await file.text());
    const lines = statementLines(rows);
    if (!lines.length) throw new Error('No dated credit or debit lines were found in this statement.');
    const match = matchStatement(lines, finance.bank);
    const cell = (value) => (value ? money(value) : '');
    result.innerHTML = `<p class="finance-basis">${lines.length} statement line(s) from ${escapeHtml(lines[0].date)} · ${match.counts.matched} matched · ${match.counts.bankOnly} only in the bank · ${match.counts.booksOnly} only in the books</p>
      <div tabindex="0" role="region" aria-label="Bank statement match" class="table-wrap"><table class="finance-table">
        <thead><tr><th>Result</th><th>Date</th><th>Bank narration</th><th class="text-right">Credit</th><th class="text-right">Debit</th><th>In the books</th></tr></thead>
        <tbody>${match.rows
          .map(
            ({ status, line, book, direction }) =>
              `<tr><td>${STATUS[status]}</td><td>${escapeHtml(line?.date ?? book.date)}</td><td>${escapeHtml(line ? `${line.narration} ${line.reference}`.trim() : '')}</td><td class="text-right">${cell(line ? line.credit : direction === 'credit' && book.amount)}</td><td class="text-right">${cell(line ? line.debit : direction === 'debit' && book.amount)}</td><td>${book ? `${escapeHtml(book.label)}<small>${escapeHtml(book.business)}</small>` : ''}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
});
