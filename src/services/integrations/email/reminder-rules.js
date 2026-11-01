/** Rules for payment reminders: which invoices/installments are due, on which days, and their email keys. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { balanceDue, installmentBalances } from '../../../../shared/types.js';

// Reminder days relative to the due date: 3 days before, on the due date, 3 and 7 days after.
export const DEFAULT_REMINDER_OFFSETS = [-3, 0, 3, 7];
// Validates a policy's offsets: 1-12 unique whole days between -30 and +90, returned sorted.
export const reminderOffsetsSchema = z
  .array(z.number().int().min(-30).max(90))
  .min(1)
  .max(12)
  .refine((offsets) => new Set(offsets).size === offsets.length, 'Reminder offsets must be unique.')
  .transform((offsets) => [...offsets].sort((a, b) => a - b));

/** True for a valid YYYY-MM-DD date. */
export function isReminderDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Date-only arithmetic never depends on the machine's local timezone or daylight saving. */
export function reminderDate(dueDate, offset) {
  if (!isReminderDate(dueDate) || !Number.isSafeInteger(offset)) return null;
  const date = new Date(`${dueDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** The policy used when a business has never saved one (automatic reminders disabled). */
export function defaultReminderPolicy(organizationId) {
  return {
    organizationId,
    enabled: false,
    offsets: [...DEFAULT_REMINDER_OFFSETS],
    version: 0,
    effectiveFrom: null,
    updatedAt: null,
  };
}

/** Loads a business's saved policy, falling back to the default when it is missing or invalid. */
export async function readReminderPolicy(db, organizationId) {
  const stored = await db
    .collection('payment_reminder_policies')
    .findOne({ _id: organizationId }, db.options());
  if (!stored) return defaultReminderPolicy(organizationId);
  const offsets = reminderOffsetsSchema.safeParse(stored.offsets);
  if (
    stored.organizationId !== organizationId ||
    typeof stored.enabled !== 'boolean' ||
    !Number.isSafeInteger(stored.version) ||
    stored.version < 0 ||
    !offsets.success ||
    (stored.enabled && !isReminderDate(stored.effectiveFrom))
  )
    throw new Error('The payment reminder policy is invalid.');
  return {
    organizationId,
    enabled: stored.enabled,
    offsets: offsets.data,
    version: stored.version,
    effectiveFrom: stored.effectiveFrom ?? null,
    updatedAt: stored.updatedAt ?? null,
  };
}

/** True when the address can receive a reminder. */
export function validReminderEmail(value) {
  return typeof value === 'string' && value.length <= 254 && z.string().email().safeParse(value).success;
}

// Why an invoice cannot get a payment reminder, or '' when it can (issued, unpaid balance).
export function reminderDocumentReason(document) {
  if (!document) return 'The invoice is unavailable.';
  if (document.kind !== 'invoice') return 'Payment reminders are available only for invoices.';
  if (!['sent', 'partially_paid'].includes(document.status))
    return document.status === 'cancelled'
      ? 'This invoice is cancelled. Its unattempted reminders cannot be sent.'
      : document.status === 'draft'
        ? 'Issue this invoice before sending payment reminders.'
        : 'This invoice is not awaiting payment.';
  if (!Number.isFinite(balanceDue(document)) || balanceDue(document) <= 0)
    return 'This invoice has no outstanding balance.';
  return '';
}

/** Use the same oldest-installment allocation as the invoice/payment views. */
export function reminderTargets(document, asOf) {
  if (reminderDocumentReason(document)) return [];
  const invoiceBalance = balanceDue(document);
  const installments = document.installmentPlan?.installments?.length
    ? installmentBalances(document, asOf)
    : [{ id: null, label: 'Invoice balance', dueDate: document.dueDate, balanceDue: invoiceBalance }];
  return installments
    .filter(
      (entry) => Number.isFinite(entry.balanceDue) && entry.balanceDue > 0 && isReminderDate(entry.dueDate),
    )
    .map((entry) => {
      const daysFromDue = Math.round(
        (new Date(`${asOf}T12:00:00.000Z`) - new Date(`${entry.dueDate}T12:00:00.000Z`)) / 86_400_000,
      );
      const canSend = validReminderEmail(document.customerSnapshot?.email);
      return {
        documentId: document.id,
        documentNumber: document.number,
        customerName: document.customerSnapshot?.name ?? '',
        customerEmail: document.customerSnapshot?.email ?? '',
        installmentId: entry.id,
        label: entry.label,
        dueDate: entry.dueDate,
        balanceDue: entry.balanceDue,
        invoiceBalance,
        status: daysFromDue > 0 ? 'overdue' : daysFromDue === 0 ? 'due_today' : 'upcoming',
        daysFromDue,
        canSend,
        unavailableReason: canSend ? '' : 'The saved invoice recipient needs a valid email address.',
      };
    });
}

/**
 * Re-checks a saved reminder just before sending. Returns { reason } when it must not be sent
 * (invoice changed, not due yet, automatic policy changed) or { reason: '', target } when it can.
 */
export function reminderEligibility(document, reminder, policy, asOf) {
  const reason = reminderDocumentReason(document);
  if (reason) return { reason };
  if (
    !reminder ||
    typeof reminder.automatic !== 'boolean' ||
    !(reminder.installmentId === null || typeof reminder.installmentId === 'string') ||
    !isReminderDate(reminder.dueDate) ||
    !isReminderDate(reminder.scheduledFor)
  )
    return { reason: 'The saved payment reminder is incomplete. Prepare a new reminder.' };
  const target = reminderTargets(document, asOf).find(
    (entry) => entry.installmentId === reminder.installmentId,
  );
  if (!target || target.dueDate !== reminder.dueDate)
    return {
      reason: 'This installment or due date changed, or its balance was paid. Prepare a current reminder.',
    };
  if (!target.canSend) return { reason: target.unavailableReason };
  if (reminder.scheduledFor > asOf) return { reason: 'This payment reminder is not scheduled to send yet.' };
  if (
    reminder.automatic &&
    (!policy?.enabled ||
      policy.version !== reminder.policyVersion ||
      !policy.offsets.includes(reminder.offset) ||
      reminderDate(target.dueDate, reminder.offset) !== reminder.scheduledFor ||
      reminder.scheduledFor < policy.effectiveFrom)
  )
    return {
      reason: 'The automatic reminder policy changed or is disabled. This unattempted reminder is on hold.',
    };
  return { reason: '', target };
}

// Stable outbox key for one reminder, so the same reminder is never queued twice.
export function reminderEventKey(organizationId, documentId, installmentId, dueDate, automatic, occurrence) {
  const key = JSON.stringify([organizationId, documentId, installmentId, dueDate, automatic, occurrence]);
  return `payment-reminder:${automatic ? 'automatic' : 'manual'}:${createHash('sha256').update(key).digest('hex')}`;
}

// Hash of the whole saved invoice; used to detect changes after a reminder was prepared.
export function reminderDocumentFingerprint(document) {
  // The complete saved document also catches unversioned legacy/import changes.
  return createHash('sha256').update(JSON.stringify(document)).digest('hex');
}

// Email subject line for a payment reminder.
export function reminderSubject(document) {
  const business = document.organizationSnapshot;
  return `Payment reminder · Invoice ${document.number} · ${business.tradeName || business.name}`;
}
