/**
 * Expenses page (views/expenses/index.ejs): fills the vendor from contacts, shows the GST split
 * while typing, saves the expense form and deletes an expense after confirmation.
 */

import { api, formValues, sendJson, setBusy, showError } from '../core/api.js';
import { getPageData, rememberToast, workspacePath } from '../core/page.js';
import { gstAmounts, money } from '/shared/types.js';

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
