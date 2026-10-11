import { installmentBalances, money, paidAmount } from '/shared/types.js';
import { wholePaise } from '/shared/money.js';
import { escape, indiaDate, readableDate } from '/js/documents/document-ui.js';

export function validScheduleDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function recurringDate(start, index, frequency) {
  const date = new Date(`${start}T12:00:00Z`);
  if (frequency === 'weekly') date.setUTCDate(date.getUTCDate() + index * 7);
  else {
    const anchorDay = date.getUTCDate();
    const month = date.getUTCMonth() + index;
    date.setUTCDate(1);
    date.setUTCMonth(month);
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    date.setUTCDate(Math.min(anchorDay, end.getUTCDate()));
  }
  return date.toISOString().slice(0, 10);
}
const positiveAmount = (value) => {
  const amount = wholePaise(Number(value));
  return Boolean(String(value).trim()) && Number.isSafeInteger(amount) && amount >= 1;
};

export function createScheduleController({ getDocument, isBusy, isManualBlocked, onSave, onRecord }) {
  const section = document.querySelector('#payment-schedule');
  const view = document.querySelector('#payment-schedule-view');
  const form = document.querySelector('#payment-schedule-form');
  const error = document.querySelector('#payment-schedule-error');
  let rows = [];
  let editing = false;
  let removing = false;
  const field = (name) => form.elements.namedItem(name);
  const editable = () => !getDocument().finalizedAt && getDocument().status !== 'cancelled';
  const totalPaise = () => Math.round(getDocument().totals.total * 100);
  const plannedPaise = () =>
    rows.reduce(
      (sum, row) => sum + (Number.isFinite(Number(row.amount)) ? Math.round(Number(row.amount) * 100) : 0),
      0,
    );
  function fail(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }
  function renderTotals() {
    const difference = totalPaise() - plannedPaise();
    document.querySelector('#payment-schedule-totals').innerHTML =
      `<div><span>Scheduled total</span><strong>${money(plannedPaise() / 100)}</strong></div><div><span>Invoice total</span><strong>${money(totalPaise() / 100)}</strong></div><p>${difference === 0 ? 'The schedule matches the invoice total.' : difference > 0 ? `${money(difference / 100)} still needs to be scheduled.` : `${money(-difference / 100)} over the invoice total.`}</p>`;
    form.querySelector('[type="submit"]').disabled =
      isBusy() || !rows.length || difference !== 0 || rows.some((row) => !positiveAmount(row.amount));
    section.querySelector('[data-schedule-action="add"]').disabled = isBusy() || rows.length >= 120;
  }
  function renderRows() {
    document.querySelector('#payment-schedule-rows').innerHTML = rows
      .map(
        (row, index) =>
          `<div class="payment-plan-edit-row" data-row-id="${escape(row.id)}"><label class="payment-field">Label<input data-schedule-field="label" value="${escape(row.label)}" maxlength="200" aria-label="Installment ${index + 1} label"></label><label class="payment-field">Due date<input data-schedule-field="dueDate" type="date" value="${escape(row.dueDate)}" min="2000-01-01" max="2199-12-31" aria-label="Installment ${index + 1} due date"></label><label class="payment-field">Amount (INR)<input data-schedule-field="amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${escape(row.amount)}" aria-label="Installment ${index + 1} amount"></label><button type="button" class="payment-icon-button" data-remove-installment="${escape(row.id)}" aria-label="Remove installment ${index + 1}">Remove</button></div>`,
      )
      .join('');
    renderTotals();
  }
  function render() {
    const doc = getDocument();
    form.hidden = !editing || !editable();
    view.hidden = editing && editable();
    form.querySelector('fieldset').disabled = isBusy() || !editable();
    if (editing && editable()) {
      renderTotals();
      return;
    }
    const schedule = installmentBalances(doc);
    const next = schedule.find((entry) => entry.balanceDue > 0);
    const overdue =
      schedule
        .filter((entry) => entry.status === 'overdue')
        .reduce((sum, entry) => sum + Math.round(entry.balanceDue * 100), 0) / 100;
    const disabled = isBusy() ? 'disabled' : '';
    if (!doc.installmentPlan) {
      view.innerHTML = `<div class="payment-plan-empty"><div><strong>Offer a flexible payment schedule</strong><p>Add monthly, weekly or custom installments with an optional down payment.</p></div>${editable() ? `<button type="button" class="payment-secondary" data-schedule-action="edit" ${disabled}>Add payment plan</button>` : ''}</div>`;
      return;
    }
    const percentage =
      totalPaise() > 0 ? Math.min(100, (Math.round(paidAmount(doc) * 100) / totalPaise()) * 100) : 100;
    view.innerHTML = `<div class="payment-plan-heading"><div><strong>${escape(doc.installmentPlan.name)}</strong><span>${schedule.length} scheduled payments · ${schedule.filter((entry) => entry.status === 'paid').length} complete</span></div>${editable() ? `<button class="payment-secondary" type="button" data-schedule-action="edit" ${disabled}>Edit plan</button>` : ''}</div><div class="payment-plan-progress" role="progressbar" aria-label="Installment plan paid" aria-valuenow="${Math.round(percentage)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percentage}%"></span></div>${next ? `<div class="payment-next-installment"><div><span>${next.dueDate < indiaDate() ? 'EARLIEST UNPAID · OVERDUE' : 'NEXT PAYMENT DUE'}</span><strong>${escape(readableDate(next.dueDate))}</strong><small>${escape(next.label)}</small></div><div><strong>${money(next.balanceDue)}</strong>${overdue > 0 ? `<small>${money(overdue)} overdue in total</small>` : ''}</div></div>` : '<p class="payment-plan-complete">All scheduled payments are covered.</p>'}<p class="payment-plan-allocation">Receipts apply to the earliest unpaid installment first. Correcting a receipt recalculates the schedule.</p><div class="payment-installment-list">${schedule.map((entry) => `<article class="payment-installment payment-installment-${entry.status}"><div class="payment-installment-heading"><div><strong>${escape(entry.label)}</strong><span>${escape(readableDate(entry.dueDate))}</span></div><span class="payment-installment-status">${entry.status === 'paid' ? 'Paid' : entry.status === 'partially_paid' ? 'Partially paid' : entry.status === 'overdue' ? `Overdue${entry.amountPaid > 0 ? ' · partial' : ''}` : 'Pending'}</span></div><div class="payment-installment-amounts"><span>Amount<strong>${money(entry.amount)}</strong></span><span>Received<strong>${money(entry.amountPaid)}</strong></span><span>Balance<strong>${money(entry.balanceDue)}</strong></span>${editable() && entry.balanceDue > 0 ? `<button type="button" class="payment-installment-record" data-record-installment="${escape(entry.id)}" ${isBusy() || isManualBlocked() ? 'disabled' : ''}>Record</button>` : ''}</div></article>`).join('')}</div>${editable() ? (removing ? `<div class="payment-plan-remove"><strong>Remove this payment schedule?</strong><p>Recorded receipts and the invoice total stay unchanged. This change is saved in invoice activity.</p><div><button type="button" class="payment-secondary" data-schedule-action="keep" ${disabled}>Keep plan</button><button type="button" class="payment-danger" data-schedule-action="confirm-remove" ${disabled}>Remove plan</button></div></div>` : `<button type="button" class="payment-plan-remove-link" data-schedule-action="remove" ${disabled}>Remove payment plan</button>`) : ''}`;
  }
  function openEditor() {
    editing = true;
    removing = false;
    fail();
    const doc = getDocument();
    field('planName').value = doc.installmentPlan?.name || 'EMI payment plan';
    field('count').value = String(Math.min(60, Math.max(2, doc.installmentPlan?.installments.length || 3)));
    field('firstDate').value = doc.installmentPlan?.installments[0]?.dueDate || doc.dueDate || indiaDate();
    field('withDownPayment').checked = false;
    field('downPayment').value = '';
    field('downDate').value = indiaDate();
    document.querySelector('#schedule-down-payment').hidden = true;
    rows = (doc.installmentPlan?.installments || []).map((entry) => ({
      ...entry,
      amount: entry.amount.toFixed(2),
    }));
    render();
    renderRows();
    field('planName').focus();
  }
  function generateSchedule(milestones = false) {
    fail();
    const count = milestones ? 3 : Number(field('count').value);
    const firstDate = field('firstDate').value;
    const frequency = field('frequency').value;
    if (!Number.isInteger(count) || count < 2 || count > 60)
      return fail('Choose between 2 and 60 installments.');
    if (!validScheduleDate(firstDate)) return fail('Choose a valid first installment date.');
    if (milestones) {
      const first = Math.round(totalPaise() * 0.7);
      const second = Math.round(totalPaise() * 0.2);
      const amounts = [first, second, totalPaise() - first - second];
      if (amounts.some((amount) => amount <= 0))
        return fail('The invoice total is too small for three positive installments.');
      rows = amounts.map((amount, index) => ({
        id: crypto.randomUUID(),
        label: `${[70, 20, 10][index]}% payment`,
        dueDate: recurringDate(firstDate, index, frequency),
        amount: (amount / 100).toFixed(2),
      }));
      field('planName').value = '70% / 20% / 10% payment plan';
      renderRows();
      return;
    }
    const withDownPayment = field('withDownPayment').checked;
    const downPayment = field('downPayment').value;
    const downDate = field('downDate').value;
    if (withDownPayment && !positiveAmount(downPayment))
      return fail('Enter a positive down payment with no more than two decimal places.');
    if (withDownPayment && (!validScheduleDate(downDate) || downDate > firstDate))
      return fail('The down payment date must be on or before the first installment.');
    const downPaise = withDownPayment ? wholePaise(Number(downPayment)) : 0;
    const splitPaise = totalPaise() - downPaise;
    if (splitPaise < count) return fail('The down payment must leave at least ₹0.01 for each installment.');
    const each = Math.floor(splitPaise / count);
    const remainder = splitPaise % count;
    const generated = Array.from({ length: count }, (_, index) => ({
      id: crypto.randomUUID(),
      label: `Installment ${index + 1}`,
      dueDate: recurringDate(firstDate, index, frequency),
      amount: ((each + (index < remainder ? 1 : 0)) / 100).toFixed(2),
    }));
    if (generated.some((entry) => !validScheduleDate(entry.dueDate)))
      return fail('Choose an earlier first installment date.');
    rows = [
      ...(withDownPayment
        ? [
            {
              id: crypto.randomUUID(),
              label: 'Down payment',
              dueDate: downDate,
              amount: (downPaise / 100).toFixed(2),
            },
          ]
        : []),
      ...generated,
    ];
    renderRows();
  }
  form.addEventListener('input', (event) => {
    const target = event.target;
    if (target.dataset.scheduleField) {
      const row = rows.find((entry) => entry.id === target.closest('[data-row-id]').dataset.rowId);
      row[target.dataset.scheduleField] = target.value;
      fail();
      renderTotals();
    }
  });
  form.addEventListener('change', (event) => {
    if (event.target.name === 'withDownPayment')
      document.querySelector('#schedule-down-payment').hidden = !event.target.checked;
  });
  section.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || isBusy()) return;
    if (button.dataset.recordInstallment) {
      if (isManualBlocked()) return;
      const entry = installmentBalances(getDocument()).find(
        (item) => item.id === button.dataset.recordInstallment,
      );
      if (entry) onRecord(entry.balanceDue, entry.label);
      return;
    }
    if (!editable()) return;
    if (button.dataset.removeInstallment) {
      rows = rows.filter((row) => row.id !== button.dataset.removeInstallment);
      fail();
      renderRows();
      return;
    }
    switch (button.dataset.scheduleAction) {
      case 'edit':
        openEditor();
        break;
      case 'generate':
        generateSchedule();
        break;
      case 'milestones':
        generateSchedule(true);
        break;
      case 'cancel':
        editing = false;
        render();
        break;
      case 'add':
        if (rows.length < 120) {
          rows.push({
            id: crypto.randomUUID(),
            label: `Installment ${rows.length + 1}`,
            dueDate: rows.at(-1)?.dueDate || field('firstDate').value || indiaDate(),
            amount: '',
          });
          renderRows();
        }
        break;
      case 'remove':
        removing = true;
        render();
        break;
      case 'keep':
        removing = false;
        render();
        break;
      case 'confirm-remove':
        if (await onSave(null)) {
          removing = false;
          render();
        }
        break;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isBusy() || !editable()) return;
    fail();
    if (!field('planName').value.trim()) return fail('Give this payment plan a name.');
    if (!rows.length || rows.length > 120) return fail('Add between 1 and 120 installment entries.');
    if (rows.some((row) => !row.label.trim())) return fail('Give every installment a label.');
    if (rows.some((row) => !validScheduleDate(row.dueDate)))
      return fail('Choose a valid due date for every installment.');
    if (rows.some((row) => !positiveAmount(row.amount)))
      return fail('Each installment needs a positive amount with no more than two decimal places.');
    if (plannedPaise() !== totalPaise())
      return fail(
        `The installment total must equal the full invoice total of ${money(getDocument().totals.total)}.`,
      );
    const plan = {
      name: field('planName').value.trim(),
      installments: rows
        .map((row) => ({
          ...row,
          label: row.label.trim(),
          amount: wholePaise(Number(row.amount)) / 100,
        }))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    };
    if (await onSave(plan)) {
      editing = false;
      render();
    }
  });
  return { render };
}
