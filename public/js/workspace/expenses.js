/**
 * Expenses page (views/expenses/index.ejs): fills the vendor from contacts, shows the GST split
 * while typing, saves the expense form, deletes an expense after confirmation and matches the
 * month's bills with a GSTR-2B JSON file (shared/gstr2b.js).
 */

import { api, escapeHtml, formValues, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast, workspacePath } from '../core/page.js';
import { gstAmounts, money } from '/shared/types.js';
import { matchGstr2b, readGstr2b } from '/shared/gstr2b.js';

const data = getPageData();
const organizationId = data.organization.id;
const form = document.querySelector('[data-expense-form]');
const preview = form.querySelector('[data-expense-preview]');
const fields = form.elements;

function goToMonth(message, month = data.expensePage.month) {
  try {
    rememberToast(message);
  } catch {
    /* Saved work is not changed by unavailable browser storage. */
  }
  location.assign(workspacePath('expenses', '', '', { month }));
}

function readForm() {
  const values = formValues(form);
  return {
    ...values,
    organizationId,
    vendorGstin: values.vendorGstin.trim().toUpperCase(),
    taxable: Number(values.taxable),
    gstRate: Number(values.gstRate),
    interstate: values.interstate === 'true',
  };
}

function showPreview() {
  const values = readForm();
  if (!(values.taxable > 0)) return (preview.textContent = '');
  const amounts = gstAmounts(values);
  const split = values.interstate
    ? `IGST ${money(amounts.igst)}`
    : `CGST ${money(amounts.cgst)} + SGST ${money(amounts.sgst)}`;
  preview.textContent = `GST ${money(amounts.tax)} (${split}) · Total ${money(amounts.total)}`;
}

// A contact's saved name and GSTIN fill the form; its state decides IGST or CGST + SGST.
fields.vendorId.addEventListener('change', () => {
  const option = fields.vendorId.selectedOptions[0];
  if (option.value) {
    fields.vendorName.value = option.textContent.trim();
    fields.vendorGstin.value = option.dataset.gstin;
    if (option.dataset.state && form.dataset.businessState)
      fields.interstate.value = String(option.dataset.state !== form.dataset.businessState);
  }
  showPreview();
});
form.addEventListener('input', showPreview);
showPreview();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  if (button.disabled) return;
  showError(form, '');
  const id = form.dataset.expenseId;
  const body = readForm();
  setBusy(button, true, 'Saving…');
  try {
    await api(id ? `/expenses/${encodeURIComponent(id)}` : '/expenses', sendJson(id ? 'PUT' : 'POST', body));
    goToMonth(id ? 'Expense saved.' : 'Expense added.', body.billDate.slice(0, 7));
  } catch (error) {
    showError(form, error.message);
    setBusy(button, false);
  }
});

for (const button of document.querySelectorAll('[data-expense-delete]')) {
  button.addEventListener('click', async () => {
    if (button.disabled || !confirm(`Delete the expense from ${button.dataset.expenseName}?`)) return;
    setBusy(button, true, 'Deleting…');
    try {
      await api(`/expenses/${encodeURIComponent(button.dataset.expenseDelete)}`, sendJson('DELETE'));
      goToMonth('Expense deleted.');
    } catch (error) {
      showError(null, error.message);
      setBusy(button, false);
    }
  });
}

const STATUS = {
  matched: 'Matched',
  different: 'Amounts differ',
  'not-in-books': 'Not in your expenses',
  'not-in-2b': 'Not in GSTR-2B',
};
const fileInput = document.querySelector('[data-gstr2b-file]');
fileInput?.addEventListener('change', async () => {
  const error = document.querySelector('[data-gstr2b-error]');
  const result = document.querySelector('[data-gstr2b-result]');
  error.hidden = true;
  result.innerHTML = '';
  const file = fileInput.files[0];
  if (!file) return;
  try {
    const { period, invoices } = readGstr2b(JSON.parse(await file.text()));
    const match = matchGstr2b(invoices, data.expensePage.expenses);
    const cell = (value) => (value === undefined ? '' : money(value));
    const warning =
      period && period !== data.expensePage.month
        ? `<div class="alert alert-info">This file is for ${escapeHtml(period)}, but the page shows ${escapeHtml(data.expensePage.month)}. Choose the same month above.</div>`
        : '';
    result.innerHTML = `${warning}<p class="finance-basis">${match.counts.matched} matched · ${match.counts.different} with different amounts · ${match.counts.notInBooks} not in your expenses · ${match.counts.notIn2b} not in GSTR-2B · GST in GSTR-2B ${money(match.portalTax)}</p>
      <div tabindex="0" role="region" aria-label="GSTR-2B match" class="table-wrap"><table class="finance-table">
        <thead><tr><th>Result</th><th>Vendor</th><th>Bill</th><th class="text-right">Taxable (2B)</th><th class="text-right">Taxable (books)</th><th class="text-right">GST (2B)</th><th class="text-right">GST (books)</th></tr></thead>
        <tbody>${match.rows
          .map(
            ({ status, portal, book }) =>
              `<tr><td>${STATUS[status]}</td><td>${escapeHtml(portal?.name || book?.vendorName || '')}<small>${escapeHtml(portal?.gstin || book?.vendorGstin || '')}</small></td><td>${escapeHtml(portal?.number || book?.billNumber || '')}</td><td class="text-right">${cell(portal?.taxable)}</td><td class="text-right">${cell(book?.taxable)}</td><td class="text-right">${cell(portal?.tax)}</td><td class="text-right">${cell(book?.tax)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
  } catch (failure) {
    error.textContent = failure instanceof SyntaxError ? 'This file is not valid JSON.' : failure.message;
    error.hidden = false;
  }
});
