import { api, sendJson } from '/js/core/api.js';
import { getPageData } from '/js/core/page.js';
import {
  addCalendarDays,
  dueOccurrenceCount,
  scheduledDate,
  validRecurrenceDate,
} from '/shared/recurrence-dates.js';

const data = getPageData();
const recurring = data.recurring;
const schedule = recurring.schedule;
const source = recurring.source;
const base = `/workspace/${encodeURIComponent(data.organization.id)}/recurring`;
const form = document.querySelector('#recurring-form');
const inputs = form?.querySelector('[data-recurring-inputs]');
const saveButton = form?.querySelector('[data-recurring-save]');
const feedback = document.querySelector('[data-recurring-feedback]');
const conflictPanel = document.querySelector('[data-recurring-conflict]');
const confirmation = document.querySelector('#recurring-confirm');
const editable = data.user?.role === 'admin' && (!schedule || ['paused', 'error'].includes(schedule.status));
const storageKey = source ? `vc:recurring-create:${data.organization.id}:${source.id}` : '';
let creationId = null;
let pendingCreate = null;
let storageAvailable = true;
let busy = false;
let conflicted = false;
let dirty = false;
let confirmedAction = null;
let confirmationTrigger = null;

function showFeedback(message) {
  feedback.textContent = message;
  feedback.hidden = !message;
  if (message) feedback.focus({ preventScroll: true });
}
function rememberToast(message) {
  try {
    sessionStorage.setItem('vc:toast', message);
  } catch {
    /* The destination still shows the saved result. */
  }
}
function storeCreation(payload) {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({ requestId: creationId, sourceDocumentId: source.id, payload }),
  );
}
function values() {
  const value = (name) => form.elements.namedItem(name).value;
  return {
    name: value('name').trim(),
    dueDays: Number(value('dueDays')),
    endDate: value('endDate'),
    maxOccurrences: value('maxOccurrences') ? Number(value('maxOccurrences')) : null,
  };
}
function updateControls() {
  if (inputs) inputs.disabled = !editable || busy || Boolean(pendingCreate);
  if (saveButton) {
    saveButton.disabled = busy || conflicted || (!schedule && !storageAvailable);
    saveButton.textContent = busy
      ? 'Saving…'
      : pendingCreate
        ? 'Retry saved request'
        : schedule
          ? 'Save settings'
          : 'Create schedule';
  }
  document.querySelector('[data-recurring-pending]')?.toggleAttribute('hidden', !pendingCreate);
  for (const button of document.querySelectorAll('[data-recurring-state], [data-recurring-generate]'))
    button.disabled =
      busy || conflicted || (button.hasAttribute('data-recurring-generate') && !schedule.dueCount);
}
function showConflict(error) {
  conflicted = true;
  conflictPanel.hidden = false;
  const link = conflictPanel.querySelector('[data-recurring-latest]');
  const text = conflictPanel.querySelector('[data-recurring-conflict-copy]');
  if (schedule) {
    link.href = `${base}/edit/${encodeURIComponent(schedule.id)}`;
    text.textContent =
      'Your entries are still in this form. Open the latest schedule in another tab and compare before applying changes.';
  } else if (error.code === 'RECURRING_VERSION_CONFLICT') {
    link.href = `${base}/new?documentId=${encodeURIComponent(source.id)}`;
    link.textContent = 'Review latest source invoice';
    text.textContent =
      'The source invoice changed before this schedule was created. Your settings are still here. Open its latest version in another tab before creating the schedule.';
  } else {
    link.href = base;
    link.textContent = 'Review saved schedules';
    text.textContent =
      'This request is already linked to a saved schedule. Its original request is kept here. Review the saved schedules before creating another one.';
  }
  showFeedback(error.message);
}
function refreshDates() {
  if (!form) return;
  const target = document.querySelector('[data-recurrence-preview]');
  const startDate = form.elements.namedItem('startDate').value;
  const frequency = form.elements.namedItem('frequency').value;
  const config = { ...values(), startDate, frequency, nextIndex: schedule?.nextIndex || 0 };
  form.elements.namedItem('endDate').min = schedule?.nextDate || startDate || '2000-01-01';
  target.replaceChildren();
  if (
    !validRecurrenceDate(startDate) ||
    !Number.isSafeInteger(config.dueDays) ||
    config.dueDays < 0 ||
    config.dueDays > recurring.limits.dueDays
  )
    return;
  try {
    const nextDates = [0, 1, 2]
      .map((offset) => scheduledDate(config, config.nextIndex + offset))
      .filter(Boolean);
    const heading = document.createElement('strong');
    heading.textContent = nextDates.length
      ? 'Upcoming scheduled dates'
      : 'The current limits allow no further occurrences.';
    target.append(heading);
    const list = document.createElement('ol');
    for (const date of nextDates) {
      const item = document.createElement('li');
      item.textContent = `${date} · due ${addCalendarDays(date, config.dueDays) || 'outside the supported date range'}`;
      list.append(item);
    }
    if (nextDates.length) target.append(list);
    const count = dueOccurrenceCount(config, recurring.businessDate);
    if (count > 1) {
      const backlog = document.createElement('p');
      backlog.textContent = `${count} occurrences are already due. Activation starts at the oldest pending date, one draft per automatic run.`;
      target.append(backlog);
    }
  } catch {
    /* Native form validation explains incomplete or invalid dates on submit. */
  }
}

if (source && editable) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved && (typeof saved.requestId !== 'string' || saved.sourceDocumentId !== source.id))
      throw new Error('Unrecognized saved request');
    creationId = saved?.requestId || crypto.randomUUID();
    pendingCreate = saved?.payload || null;
    if (pendingCreate) {
      for (const name of ['name', 'frequency', 'startDate', 'dueDays', 'endDate', 'maxOccurrences'])
        form.elements.namedItem(name).value = pendingCreate[name] ?? '';
      form.elements.namedItem('active').checked = pendingCreate.active;
    }
    storeCreation(pendingCreate);
  } catch {
    storageAvailable = false;
    showFeedback(
      'This browser could not read or keep the schedule request safely. Allow session storage, then reload before creating a schedule.',
    );
  }
}
form?.addEventListener('input', () => {
  dirty = true;
  refreshDates();
});
form?.addEventListener('change', refreshDates);
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editable || busy || conflicted) return;
  if (!pendingCreate && !form.reportValidity()) return;
  if (!schedule && !storageAvailable) return;
  let input;
  if (schedule) input = { organizationId: data.organization.id, version: schedule.version, ...values() };
  else {
    input = pendingCreate || {
      organizationId: data.organization.id,
      sourceDocumentId: source.id,
      sourceVersion: source.version,
      requestId: creationId,
      ...values(),
      frequency: form.elements.namedItem('frequency').value,
      startDate: form.elements.namedItem('startDate').value,
      active: form.elements.namedItem('active').checked,
    };
    try {
      storeCreation(input);
    } catch {
      storageAvailable = false;
      showFeedback(
        'The browser could not keep this request. No schedule was submitted. Allow session storage and reload.',
      );
      updateControls();
      return;
    }
    pendingCreate = structuredClone(input);
  }
  busy = true;
  showFeedback('');
  updateControls();
  try {
    const result = await api(
      schedule ? `/recurring-invoices/${encodeURIComponent(schedule.id)}` : '/recurring-invoices',
      sendJson(schedule ? 'PUT' : 'POST', input),
    );
    if (!schedule) {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* A replay still resolves the same saved schedule. */
      }
    }
    dirty = false;
    rememberToast(
      schedule
        ? 'Recurring settings saved.'
        : 'Recurring schedule saved. Every occurrence creates a draft for review.',
    );
    location.assign(`${base}/edit/${encodeURIComponent(schedule?.id || result.schedule.id)}`);
  } catch (error) {
    if (
      !schedule &&
      ([400, 403, 404].includes(error.status) || error.code === 'RECURRING_VERSION_CONFLICT')
    ) {
      pendingCreate = null;
      try {
        storeCreation(null);
      } catch {
        storageAvailable = false;
      }
    }
    if (['RECURRING_VERSION_CONFLICT', 'RECURRING_REQUEST_CONFLICT'].includes(error.code))
      showConflict(error);
    else
      showFeedback(
        pendingCreate
          ? `${error.message} The result is not confirmed. Retry the saved request; its settings and request ID are unchanged.`
          : error.message,
      );
    busy = false;
    updateControls();
  }
});

async function changeStatus(action) {
  if (busy || conflicted || data.user?.role !== 'admin') return;
  if (dirty) return showFeedback('Save the changed settings before changing the schedule status.');
  busy = true;
  showFeedback('');
  updateControls();
  try {
    await api(
      `/recurring-invoices/${encodeURIComponent(schedule.id)}/status`,
      sendJson('POST', {
        organizationId: data.organization.id,
        version: schedule.version,
        action,
      }),
    );
    rememberToast(
      action === 'pause'
        ? 'Schedule paused. Its pending dates and history are retained.'
        : 'Schedule reviewed and resumed.',
    );
    location.assign(`${base}/edit/${encodeURIComponent(schedule.id)}`);
  } catch (error) {
    if (error.code === 'RECURRING_VERSION_CONFLICT') showConflict(error);
    else showFeedback(error.message);
    busy = false;
    updateControls();
  }
}
for (const button of document.querySelectorAll('[data-recurring-state]'))
  button.addEventListener('click', () => {
    if (dirty) return showFeedback('Save the changed settings before changing the schedule status.');
    if (button.dataset.recurringState === 'pause') return changeStatus('pause');
    confirmedAction = () => changeStatus('resume');
    confirmationTrigger = button;
    document.querySelector('#recurring-confirm-title').textContent = 'Resume this schedule?';
    document.querySelector('#recurring-confirm-copy').textContent = schedule.dueCount
      ? `${schedule.dueCount} occurrence${schedule.dueCount === 1 ? ' is' : 's are'} due. Generation resumes from ${schedule.nextDate}, one draft per automatic run. Check the history first if this schedule was restored from a backup. Each draft still needs review before you issue it.`
      : `The next occurrence is ${schedule.nextDate}. Automatic generation will create a draft for review when that date is due.`;
    document.querySelector('[data-recurring-confirm]').textContent = 'Resume draft generation';
    document.body.classList.add('recurring-dialog-open');
    confirmation.showModal();
  });
confirmation?.querySelector('[data-recurring-cancel]').addEventListener('click', () => confirmation.close());
confirmation?.querySelector('[data-recurring-confirm]').addEventListener('click', () => {
  const action = confirmedAction;
  confirmation.close();
  action?.();
});
confirmation?.addEventListener('close', () => {
  document.body.classList.remove('recurring-dialog-open');
  confirmedAction = null;
  confirmationTrigger?.focus({ preventScroll: true });
});
confirmation?.addEventListener('click', (event) => {
  if (event.target !== confirmation) return;
  const box = confirmation.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    confirmation.close();
});
document.querySelector('[data-recurring-generate]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (busy || conflicted || data.user?.role !== 'admin') return;
  if (dirty) return showFeedback('Save the changed settings before generating a draft.');
  busy = true;
  showFeedback('');
  updateControls();
  try {
    const result = await api(
      `/recurring-invoices/${encodeURIComponent(schedule.id)}/generate`,
      sendJson('POST', {
        organizationId: data.organization.id,
        version: schedule.version,
        occurrenceDate: schedule.nextDate,
      }),
    );
    if (result.document) {
      rememberToast(`${result.document.number} is ready for review. The source invoice is unchanged.`);
      location.assign(
        `/workspace/${encodeURIComponent(data.organization.id)}/invoices/edit/${encodeURIComponent(result.document.id)}`,
      );
    } else {
      rememberToast(
        'This occurrence already ran. Its draft is no longer available; the history is retained.',
      );
      location.assign(`${base}/edit/${encodeURIComponent(schedule.id)}`);
    }
  } catch (error) {
    if (error.code === 'RECURRING_GENERATION_FAILED') {
      location.assign(`${base}/edit/${encodeURIComponent(schedule.id)}`);
      return;
    }
    if (error.code === 'RECURRING_VERSION_CONFLICT') showConflict(error);
    else {
      showFeedback(
        `${error.message} Review the history or retry this same occurrence. A saved occurrence will not create another invoice.`,
      );
      button.textContent = 'Retry same occurrence';
    }
    busy = false;
    updateControls();
  }
});

refreshDates();
updateControls();
