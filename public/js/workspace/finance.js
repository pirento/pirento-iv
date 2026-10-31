/**
 * Finance dashboard (views/finance/index.ejs): register search, and bank statement matching with
 * the year's receipts and paid bills. CSV/Excel statements are read here; PDF statements and
 * layouts the reader does not know go to the AI assistant when an administrator has set it up,
 * which can also suggest matches for the lines left over.
 */

import { api, escapeHtml, sendJson } from '../core/api.js';
import { getPageData } from '../core/page.js';
import { readXlsxRows } from '../core/xlsx-read.js';
import { matchStatement, parseCsv, statementLines } from '/shared/bank-match.js';
import { money } from '/shared/types.js';

const finance = getPageData().finance;
const input = document.querySelector('[data-bank-file]');
const useAi = document.querySelector('[data-bank-ai]');
const error = document.querySelector('[data-bank-error]');
const result = document.querySelector('[data-bank-result]');
const STATUS = { matched: 'Matched', 'bank-only': 'Only in bank', 'books-only': 'Only in books' };
const cell = (value) => (value ? money(value) : '');

// Register search: filters the rows of one register by any text in them (and unpaid only).
for (const register of document.querySelectorAll('[data-register]')) {
  const search = register.querySelector('[data-register-search]');
  const unpaid = register.querySelector('[data-register-unpaid]');
  const filter = () => {
    const words = search.value.trim().toLowerCase();
    for (const row of register.querySelectorAll('tbody tr'))
      row.hidden =
        (words && !row.textContent.toLowerCase().includes(words)) ||
        Boolean(unpaid?.checked && row.dataset.balance === '0');
  };
  search.addEventListener('input', filter);
  unpaid?.addEventListener('change', filter);
}

const dataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });

async function readWithAi(body) {
  if (!finance.ai?.configured)
    throw new Error(
      'This statement needs the AI assistant. Ask an administrator to add the OpenAI key in Payments & email.',
    );
  result.innerHTML = '<p class="finance-basis" role="status">Reading the statement with AI…</p>';
  const { lines } = await api('/finance/ai/statement', sendJson('POST', body));
  return lines;
}

async function readStatement(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    if (file.size > 8 * 1024 * 1024) throw new Error('Choose a PDF of 8 MB or less.');
    return readWithAi({ file: { name: file.name, data: await dataUrl(file) } });
  }
  const rows = /\.xlsx$/i.test(file.name)
    ? await readXlsxRows(await file.arrayBuffer())
    : parseCsv(await file.text());
  const asText = () => ({
    text: rows
      .map((row) => row.join(' | '))
      .join('\n')
      .slice(0, 300_000),
  });
  if (useAi?.checked) return readWithAi(asText());
  try {
    const lines = statementLines(rows);
    if (lines.length) return lines;
  } catch (failure) {
    if (!finance.ai?.configured) throw failure;
  }
  return readWithAi(asText());
}

function showMatch(lines) {
  const match = matchStatement(lines, finance.bank);
  const leftLines = match.rows.filter((row) => row.status === 'bank-only').map((row) => row.line);
  // Every book entry not matched yet (any date): TDS cuts and lump transfers can be days apart.
  const used = new Set(match.rows.filter((row) => row.status === 'matched').map((row) => row.book));
  const books = [
    ...finance.bank.receipts
      .filter((book) => !used.has(book))
      .map((book) => ({ ...book, direction: 'credit' })),
    ...finance.bank.payments
      .filter((book) => !used.has(book))
      .map((book) => ({ ...book, direction: 'debit' })),
  ].slice(0, 1000);
  result.innerHTML = `<p class="finance-basis">${lines.length} statement line(s) from ${escapeHtml(lines[0].date)} · ${match.counts.matched} matched · ${match.counts.bankOnly} only in the bank · ${match.counts.booksOnly} only in the books</p>
    ${finance.ai?.configured && leftLines.length && books.length ? '<p><button class="button" type="button" data-ai-suggest>Suggest matches with AI</button></p><div data-ai-suggestions aria-live="polite"></div>' : ''}
    <div tabindex="0" role="region" aria-label="Bank statement match" class="table-wrap"><table class="finance-table">
      <thead><tr><th>Result</th><th>Date</th><th>Bank narration</th><th class="text-right">Credit</th><th class="text-right">Debit</th><th>In the books</th></tr></thead>
      <tbody>${match.rows
        .map(
          ({ status, line, book, direction }) =>
            `<tr><td>${STATUS[status]}</td><td>${escapeHtml(line?.date ?? book.date)}</td><td>${escapeHtml(line ? `${line.narration} ${line.reference}`.trim() : '')}</td><td class="text-right">${cell(line ? line.credit : direction === 'credit' && book.amount)}</td><td class="text-right">${cell(line ? line.debit : direction === 'debit' && book.amount)}</td><td>${book ? `${escapeHtml(book.label)}<small>${escapeHtml(book.business)}</small>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  result.querySelector('[data-ai-suggest]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const target = result.querySelector('[data-ai-suggestions]');
    button.disabled = true;
    target.innerHTML = '<p class="finance-basis" role="status">Asking AI…</p>';
    try {
      const { suggestions } = await api(
        '/finance/ai/matches',
        sendJson('POST', { lines: leftLines.slice(0, 300), books }),
      );
      target.innerHTML = suggestions.length
        ? `<div tabindex="0" role="region" aria-label="AI match suggestions" class="table-wrap"><table class="finance-table"><thead><tr><th>Bank line</th><th>Likely book entries</th><th>Why</th></tr></thead><tbody>${suggestions
            .map(({ line, books: picked, reason }) => {
              const bank = leftLines[line];
              return `<tr><td>${escapeHtml(bank.date)} · ${cell(bank.credit || bank.debit)}<small>${escapeHtml(bank.narration)}</small></td><td>${picked.map((index) => `${escapeHtml(books[index].label)} · ${cell(books[index].amount)}<small>${escapeHtml(books[index].business)}</small>`).join('')}</td><td>${escapeHtml(reason)}</td></tr>`;
            })
            .join(
              '',
            )}</tbody></table></div><p class="finance-basis">Suggestions only: check each one before you record or change anything.</p>`
        : '<p class="finance-basis">AI found no likely matches for the lines left over.</p>';
    } catch (failure) {
      target.innerHTML = `<div class="alert alert-error" role="alert">${escapeHtml(failure.message)}</div>`;
    }
    button.disabled = false;
  });
}

input.addEventListener('change', async () => {
  error.hidden = true;
  result.innerHTML = '';
  const file = input.files[0];
  if (!file) return;
  try {
    const lines = await readStatement(file);
    if (!lines.length) throw new Error('No dated credit or debit lines were found in this statement.');
    showMatch(lines);
  } catch (failure) {
    result.innerHTML = '';
    error.textContent = failure.message;
    error.hidden = false;
  }
});
