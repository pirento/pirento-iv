import { z } from 'zod';
import { indiaBusinessDate } from '../../../../shared/business-date.js';
import { DOCUMENT_SUMMARY_FIELDS } from '../../../models/workspace-queries.js';
import { reminderCandidateFilter } from '../../../models/reminder-queries.js';
import { transactionForRecord } from '../../transaction-ownership.js';
import { EmailQueueError } from './mailer.js';
import {
  isReminderDate,
  readReminderPolicy,
  reminderDate,
  reminderDocumentReason,
  reminderEligibility,
  reminderEventKey,
  reminderOffsetsSchema,
  reminderSubject,
  reminderTargets,
} from './reminder-rules.js';

const PAGE_SIZE = 50;
const policyInput = z.object({
  version: z.number().int().nonnegative().safe(),
  enabled: z.boolean(),
  offsets: reminderOffsetsSchema,
});
const targetInput = z.object({
  installmentId: z.string().min(1).max(100).nullable().default(null),
});
const manualInput = targetInput.extend({
  dueDate: z.string().refine(isReminderDate, 'Use a valid due date.'),
});
const summaryProjection = { ...DOCUMENT_SUMMARY_FIELDS, 'customerSnapshot.email': 1 };

function pageQuery(query = {}) {
  const string = (key, fallback) => {
    const value = query[key] ?? fallback;
    if (typeof value !== 'string' || value.length > 200)
      throw new EmailQueueError('The reminder filters are invalid.');
    return value;
  };
  const page = string('page', '1');
  const status = string('status', 'all');
  if (!/^[1-9]\d{0,6}$/.test(page) || !['all', 'overdue', 'due_today', 'upcoming'].includes(status))
    throw new EmailQueueError('The reminder filters are invalid.');
  const q = string('q', '');
  return { page: Number(page), status, q, search: q.toLocaleLowerCase('en-IN') };
}

function publicEmail(configuration) {
  const { configured, provider, from, organizationId, reason } = configuration;
  return { configured, provider, from, organizationId, reason };
}

function availableItem(item, email) {
  return email.configured
    ? item
    : { ...item, canSend: false, unavailableReason: item.unavailableReason || email.reason };
}

/** Explicit per-business policy; invoice/payment EMAIL_AUTOMATION keeps its existing meaning. */
export function createPaymentReminders({ db, mailer, now = () => new Date(), logger }) {
  let stopping = false;
  let activeRun = null;

  async function requireOrganization(organizationId) {
    if (typeof organizationId !== 'string' || !organizationId)
      throw new EmailQueueError('Select an organization for payment reminders.');
    const organization = await db.models.organizations.findById(organizationId);
    if (!organization) throw new EmailQueueError('This organization is unavailable.', 404);
    return organization;
  }

  async function getPolicy(organizationId) {
    await requireOrganization(organizationId);
    return await readReminderPolicy(db, organizationId);
  }

  async function updatePolicy(organizationId, input, actorId) {
    const settings = policyInput.parse(input);
    return await db.transaction(
      async () => {
        await requireOrganization(organizationId);
        const current = await readReminderPolicy(db, organizationId);
        if (settings.version !== current.version)
          throw new EmailQueueError('The reminder policy changed. Refresh it before saving.', 409);
        if (
          settings.enabled === current.enabled &&
          JSON.stringify(settings.offsets) === JSON.stringify(current.offsets)
        )
          return current;
        if (settings.enabled) {
          const email = await mailer.status(organizationId);
          if (!email.configured) throw new EmailQueueError(email.reason, 503);
        }
        const timestamp = now().toISOString();
        const next = {
          organizationId,
          enabled: settings.enabled,
          offsets: settings.offsets,
          version: current.version + 1,
          effectiveFrom: settings.enabled ? indiaBusinessDate(now()) : current.effectiveFrom,
          updatedAt: timestamp,
          updatedBy: actorId ?? null,
        };
        await db
          .collection('payment_reminder_policies')
          .updateOne(
            { _id: organizationId },
            { $set: next, $setOnInsert: { createdAt: timestamp } },
            { ...db.options(), upsert: true },
          );
        // The same transaction lock protects policy edits, enqueue and first transport.
        await db.models.email.holdUnattemptedRemindersForPolicy(
          organizationId,
          'The automatic reminder policy changed or is disabled. This unattempted reminder is on hold.',
          timestamp,
        );
        return await readReminderPolicy(db, organizationId);
      },
      { organizationId },
    );
  }

  async function list(organizationId, query = {}) {
    await requireOrganization(organizationId);
    const filters = pageQuery(query);
    const asOf = indiaBusinessDate(now());
    const [policy, configuration] = await Promise.all([
      readReminderPolicy(db, organizationId),
      mailer.status(organizationId),
    ]);
    const email = publicEmail(configuration);
    const counters = {
      total: { count: 0, amount: 0 },
      overdue: { count: 0, amount: 0 },
      dueToday: { count: 0, amount: 0 },
      upcoming: { count: 0, amount: 0 },
      unavailableCount: 0,
    };
    const rows = [];
    const cursor = db
      .collection('documents')
      .find(
        { organizationId, kind: 'invoice', status: { $in: ['sent', 'partially_paid'] } },
        { ...db.options(), projection: summaryProjection },
      )
      .batchSize(100);
    try {
      for await (const document of cursor) {
        for (const target of reminderTargets(document, asOf)) {
          const item = availableItem(target, email);
          const group = item.status === 'due_today' ? 'dueToday' : item.status;
          for (const key of ['total', group]) {
            counters[key].count += 1;
            counters[key].amount += Math.round(item.balanceDue * 100);
          }
          if (!item.canSend) counters.unavailableCount += 1;
          if (filters.status !== 'all' && item.status !== filters.status) continue;
          const searchable =
            `${item.documentNumber} ${item.customerName} ${item.customerEmail} ${item.label}`.toLocaleLowerCase(
              'en-IN',
            );
          if (filters.search && !searchable.includes(filters.search)) continue;
          rows.push(item);
        }
      }
    } finally {
      await cursor.close();
    }
    for (const key of ['total', 'overdue', 'dueToday', 'upcoming']) counters[key].amount /= 100;
    rows.sort(
      (a, b) =>
        a.dueDate.localeCompare(b.dueDate) ||
        a.documentId.localeCompare(b.documentId) ||
        String(a.installmentId).localeCompare(String(b.installmentId)),
    );
    const total = rows.length;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(filters.page, pageCount);
    return {
      asOf,
      policy,
      email,
      counters,
      filters: { q: filters.q, status: filters.status },
      items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      pagination: { page, pageSize: PAGE_SIZE, total, pageCount },
    };
  }

  async function history(organizationId, query = {}) {
    await requireOrganization(organizationId);
    const { page } = pageQuery(query);
    return await mailer.listReminderMessages(organizationId, page, PAGE_SIZE);
  }

  async function preview(documentId, input = {}) {
    const { installmentId } = targetInput.parse(input);
    const document = await db.models.documents.findById(documentId);
    const reason = reminderDocumentReason(document);
    if (reason) throw new EmailQueueError(reason, document ? 409 : 404);
    await requireOrganization(document.organizationId);
    const asOf = indiaBusinessDate(now());
    const item = reminderTargets(document, asOf).find((entry) => entry.installmentId === installmentId);
    if (!item)
      throw new EmailQueueError('Choose an unpaid installment, or add a due date to this invoice.', 409);
    const [policy, configuration] = await Promise.all([
      readReminderPolicy(db, document.organizationId),
      mailer.status(document.organizationId),
    ]);
    const email = publicEmail(configuration);
    return { asOf, item: availableItem(item, email), subject: reminderSubject(document), policy, email };
  }

  async function enqueueManual(documentId, input) {
    const target = manualInput.parse(input);
    const getDocument = async () => {
      const document = await db.models.documents.findById(documentId);
      if (!document) throw new EmailQueueError(reminderDocumentReason(document), 404);
      return document;
    };
    // Select the coordination scope from the saved owner, then reload and verify
    // it under that scope before checking balances or queueing the message.
    return await transactionForRecord(db, getDocument, async (document) => {
      const reason = reminderDocumentReason(document);
      if (reason) throw new EmailQueueError(reason, document ? 409 : 404);
      await requireOrganization(document.organizationId);
      const scheduledFor = indiaBusinessDate(now());
      const reminder = { ...target, automatic: false, offset: null, policyVersion: null, scheduledFor };
      const eligibility = reminderEligibility(document, reminder, null, scheduledFor);
      if (eligibility.reason) throw new EmailQueueError(eligibility.reason, 409);
      const email = await mailer.status(document.organizationId);
      if (!email.configured) throw new EmailQueueError(email.reason, 503);
      const eventKey = reminderEventKey(
        document.organizationId,
        document.id,
        target.installmentId,
        target.dueDate,
        false,
        scheduledFor,
      );
      const existing = await db.models.email.findByEvent(eventKey);
      if (existing) return { message: await mailer.get(existing.id), duplicate: true };
      const message = await mailer.enqueueReminder(document, { reminder, eventKey });
      return { message, duplicate: false };
    });
  }

  async function enqueueScheduled(organizationId, documentId, target, policy) {
    return await db.transaction(
      async () => {
        if (stopping) return 'skipped';
        const current = await readReminderPolicy(db, organizationId);
        if (!current.enabled || current.version !== policy.version) return 'skipped';
        const asOf = indiaBusinessDate(now());
        if (target.scheduledFor !== asOf) return 'skipped';
        const document = await db.models.documents.findById(documentId);
        if (!document || document.organizationId !== organizationId) return 'skipped';
        const eligibility = reminderEligibility(document, target, current, asOf);
        if (eligibility.reason) return 'skipped';
        const email = await mailer.status(organizationId);
        if (!email.configured) return 'skipped';
        const eventKey = reminderEventKey(
          organizationId,
          documentId,
          target.installmentId,
          target.dueDate,
          true,
          target.offset,
        );
        if (await db.models.email.findByEvent(eventKey)) return 'duplicates';
        await mailer.enqueueReminder(document, { reminder: target, eventKey });
        return 'queued';
      },
      { organizationId },
    );
  }

  async function runDue(limit) {
    const result = { scanned: 0, queued: 0, duplicates: 0, skipped: 0, failed: 0, stopped: false };
    const policies = db
      .collection('payment_reminder_policies')
      .find({ enabled: true }, db.options())
      .sort({ _id: 1 })
      .batchSize(50);
    try {
      for await (const stored of policies) {
        if (stopping || result.queued >= limit) break;
        const policy = await readReminderPolicy(db, stored.organizationId);
        if (!policy.enabled || !(await mailer.status(policy.organizationId)).configured) continue;
        const scanDate = indiaBusinessDate(now());
        if (scanDate < policy.effectiveFrom) continue;
        const dueDates = policy.offsets.map((offset) => reminderDate(scanDate, -offset));
        const cursor = db
          .collection('documents')
          .find(reminderCandidateFilter(policy.organizationId, dueDates), {
            ...db.options(),
            projection: summaryProjection,
          })
          .sort({ _id: 1 })
          .batchSize(100);
        try {
          for await (const document of cursor) {
            if (stopping || result.queued >= limit) break;
            const asOf = indiaBusinessDate(now());
            // The query selected this calendar day's due dates. A new pass must
            // select the new day's candidates after midnight; never backfill an
            // old rule or silently apply today's rule to yesterday's selection.
            if (asOf !== scanDate) break;
            result.scanned += 1;
            for (const item of reminderTargets(document, asOf)) {
              if (stopping || result.queued >= limit) break;
              const offset = policy.offsets.find((value) => reminderDate(item.dueDate, value) === asOf);
              if (offset === undefined || !item.canSend || asOf < policy.effectiveFrom) continue;
              try {
                const outcome = await enqueueScheduled(
                  policy.organizationId,
                  document.id,
                  {
                    automatic: true,
                    installmentId: item.installmentId,
                    dueDate: item.dueDate,
                    scheduledFor: asOf,
                    offset,
                    policyVersion: policy.version,
                  },
                  policy,
                );
                result[outcome] += 1;
              } catch (error) {
                result.failed += 1;
                logger?.error('automation_failed', { error });
              }
            }
          }
        } finally {
          await cursor.close();
        }
      }
    } finally {
      await policies.close();
    }
    result.stopped = stopping;
    return result;
  }

  function processDue({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new TypeError('Reminder batch size must be between 1 and 500.');
    if (stopping)
      return Promise.resolve({ scanned: 0, queued: 0, duplicates: 0, skipped: 0, failed: 0, stopped: true });
    if (activeRun) return activeRun;
    activeRun = runDue(limit).finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  async function stop() {
    stopping = true;
    await activeRun;
  }

  return { list, history, getPolicy, updatePolicy, preview, enqueueManual, processDue, stop };
}
