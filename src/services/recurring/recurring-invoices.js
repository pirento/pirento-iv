/**
 * Recurring invoice schedules.
 *
 * A schedule copies a source invoice's items and settings once (the "template") and, on each
 * scheduled date (weekly / monthly / quarterly / yearly), creates a new DRAFT invoice for review.
 * Drafts are never issued, emailed or charged automatically. Schedules start paused unless the
 * admin activates them; processDue() is called once a minute by the automation runner.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';
import { documentSchema } from '../validation/validation.js';
import { isInvoiceRecipient } from '../validation/contacts.js';
import { billingProfileFor } from '../../../shared/billing-presets.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';
import {
  RECURRENCE_LABELS,
  addCalendarDays,
  dueOccurrenceCount,
  scheduledDate,
  validRecurrenceDate,
} from '../../../shared/recurrence-dates.js';

// Error codes the browser uses to show "changed elsewhere" / "request already used" messages.
export const RECURRING_VERSION_CONFLICT = 'RECURRING_VERSION_CONFLICT';
export const RECURRING_REQUEST_CONFLICT = 'RECURRING_REQUEST_CONFLICT';
// dueDays: max payment term in days; maxOccurrences: max drafts per schedule;
// pageSize: history rows per page; batchSize: schedules processed per automation pass.
export const RECURRING_LIMITS = Object.freeze({
  dueDays: 365,
  maxOccurrences: 1200,
  pageSize: 25,
  batchSize: 20,
});
// Shown in the UI: exactly what a schedule copies from its source invoice and what it re-checks.
export const RECURRING_SNAPSHOT_POLICY =
  'Items, quantities, rates, discounts, place of supply, notes, terms, branding and selected reference IDs are copied when this schedule is created. Later edits to the source invoice do not change this template. Each occurrence revalidates the current business, contact, catalog, product and format, uses their current identity and format snapshots, and creates a new draft with the scheduled issue date and a fresh financial-year number. Receipts, payment links, installments, delivery links and finalization are never copied. Review each draft before issuing it.';

// Request body schemas for create / update / status / generate.
const identifier = z.string().trim().min(1).max(100);
const date = z.string().refine(validRecurrenceDate, 'Use a valid calendar date between 2000 and 2199.');
const version = z.number().int().nonnegative().safe();
const editableFields = {
  name: z.string().trim().min(1).max(120),
  dueDays: z.number().int().min(0).max(RECURRING_LIMITS.dueDays),
  endDate: z.union([z.literal(''), date]).default(''),
  maxOccurrences: z.number().int().min(1).max(RECURRING_LIMITS.maxOccurrences).nullable().default(null),
};
const createSchema = z
  .object({
    organizationId: identifier,
    sourceDocumentId: identifier,
    sourceVersion: version,
    requestId: z.guid().transform((value) => value.toLowerCase()),
    ...editableFields,
    frequency: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
    startDate: date,
    active: z.boolean().default(false),
  })
  .strict();
const updateSchema = z.object({ ...editableFields, version }).strict();
const statusSchema = z.object({ action: z.enum(['pause', 'resume']), version }).strict();
const generateSchema = z.object({ version, occurrenceDate: date }).strict();
const summaryProjection = { _id: 0, template: 0, requestId: 0, requestFingerprint: 0 };
const sourceProjection = {
  _id: 0,
  id: 1,
  number: 1,
  title: 1,
  version: 1,
  status: 1,
  issueDate: 1,
  'customerSnapshot.name': 1,
  createdAt: 1,
};
const clean = ({ _id, requestId, requestFingerprint, ...value }) => value;

function conflict() {
  return new HttpError(
    409,
    'This schedule has changed. Open the latest saved version before applying your changes.',
    RECURRING_VERSION_CONFLICT,
  );
}
function assertVersion(expected, schedule) {
  if (expected !== schedule.version) throw conflict();
}
function pageNumber(value = '1') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,6}$/.test(value))
    throw new HttpError(400, 'Choose a valid page number.');
  return Number(value);
}
function fingerprint(value) {
  // createSchema emits a stable field order and accepts only the documented fields.
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function publicFailure(error) {
  if (error instanceof HttpError && error.status < 500) return error.message;
  if (error instanceof z.ZodError)
    return error.issues
      .slice(0, 3)
      .map((issue) => issue.message)
      .join(' ');
  return 'The draft could not be created. Review this schedule and retry the same occurrence.';
}

/**
 * Schedules are explicit, durable user records; startup never creates or activates one.
 * The core workspace transaction locks concurrent writers and owns document numbering.
 * A committed occurrence is retained after a generated draft is deleted.
 */
export function createRecurringInvoices({ db, now = () => new Date(), workspace, logger }) {
  const schedules = db.collection('recurring_invoice_schedules');
  const occurrences = db.collection('recurring_invoice_occurrences');
  const events = db.collection('recurring_invoice_events');
  let stopped = false;
  let processing = null;
  const generations = new Set();

  // --- Reading and saving schedules ---
  async function rawSchedule(organizationId, id) {
    const schedule = await schedules.findOne({ id, organizationId }, db.options());
    if (!schedule) throw new HttpError(404, 'Recurring schedule not found in this business.');
    return schedule;
  }
  function summarize(schedule) {
    const { template, ...value } = clean(schedule);
    return { ...value, dueCount: dueOccurrenceCount(schedule, indiaBusinessDate(now())) };
  }
  async function event(schedule, type, description, actorId, extra = {}) {
    await events.insertOne(
      {
        id: randomUUID(),
        organizationId: schedule.organizationId,
        scheduleId: schedule.id,
        at: now().toISOString(),
        type,
        description,
        actorId,
        ...extra,
      },
      db.options(),
    );
  }
  async function replaceSchedule(current, changes) {
    if (!Number.isSafeInteger(current.version) || current.version >= Number.MAX_SAFE_INTEGER)
      throw new HttpError(409, 'This schedule has an invalid revision and needs review.');
    const updated = { ...changes, updatedAt: now().toISOString(), version: current.version + 1 };
    const saved = await schedules.updateOne(
      { id: current.id, organizationId: current.organizationId, version: current.version },
      { $set: updated },
      db.options(),
    );
    if (saved.matchedCount !== 1) throw conflict();
    return { ...current, ...updated };
  }
  function validateBounds(schedule) {
    if (schedule.endDate && schedule.endDate < schedule.startDate)
      throw new HttpError(400, 'The end date cannot be before the start date.');
    if (!scheduledDate(schedule, schedule.nextIndex))
      throw new HttpError(
        400,
        'The limits must include the next pending occurrence. Pause the schedule to stop generating drafts.',
      );
    if (!addCalendarDays(scheduledDate(schedule, schedule.nextIndex), schedule.dueDays))
      throw new HttpError(400, 'The resulting due date is outside the supported 2000–2199 range.');
  }

  // --- Building a draft from the schedule template ---
  function frozenTemplate(source) {
    const input = documentSchema.parse({
      organizationId: source.organizationId,
      customerId: source.customerId,
      kind: 'invoice',
      status: 'draft',
      issueDate: source.issueDate,
      dueDate: source.issueDate,
      title: source.title,
      items: structuredClone(source.items),
      discountPercent: source.discountPercent,
      placeOfSupply: source.placeOfSupply,
      notes: source.notes || '',
      terms: source.terms || '',
      ...(source.formatId ? { formatId: source.formatId } : {}),
      ...(source.businessProductId ? { businessProductId: source.businessProductId } : {}),
      ...(source.gstRegistrationId ? { gstRegistrationId: source.gstRegistrationId } : {}),
      ...(source.branding ? { branding: structuredClone(source.branding) } : {}),
    });
    const { issueDate, dueDate, ...template } = input;
    return template;
  }
  async function sourceDocument(organizationId, documentId) {
    const source = await workspace.getDocument(documentId);
    if (source.organizationId !== organizationId || source.kind !== 'invoice')
      throw new HttpError(404, 'Choose a source invoice from this business.');
    if (source.status === 'cancelled')
      throw new HttpError(400, 'A cancelled invoice cannot start a recurring schedule.');
    return source;
  }
  function sourceSnapshot(source, organization) {
    return {
      documentId: source.id,
      number: source.number,
      version: source.version ?? 0,
      title: source.title,
      status: source.status,
      issueDate: source.issueDate,
      customer: {
        id: source.customerId,
        name: source.customerSnapshot.name,
        email: source.customerSnapshot.email,
        address: source.customerSnapshot.address,
        gstin: source.customerSnapshot.gstin,
      },
      seller: {
        name: source.organizationSnapshot.legalName || source.organizationSnapshot.name,
        gstin: source.organizationSnapshot.gstin,
      },
      businessProduct: source.businessProductSnapshot
        ? { id: source.businessProductId, name: source.businessProductSnapshot.name }
        : null,
      format: source.formatSnapshot ? { id: source.formatId, name: source.formatSnapshot.name } : null,
      billingProfile: billingProfileFor(organization),
      totals: structuredClone(source.totals),
    };
  }

  async function readyInput(schedule, occurrenceDate) {
    const dueDate = addCalendarDays(occurrenceDate, schedule.dueDays);
    if (!dueDate)
      throw new HttpError(400, 'The occurrence due date is outside the supported calendar range.');
    const input = documentSchema.parse({
      ...structuredClone(schedule.template),
      kind: 'invoice',
      status: 'draft',
      issueDate: occurrenceDate,
      dueDate,
      installmentPlan: null,
    });
    const organization = await workspace.getOrganization(schedule.organizationId);
    if (billingProfileFor(organization) !== schedule.sourceSnapshot.billingProfile)
      throw new HttpError(
        400,
        'The business billing profile has changed. Review the source and create a replacement schedule.',
      );
    const customer = await workspace.getCustomer(input.customerId);
    if (customer.organizationId !== organization.id || !isInvoiceRecipient(customer))
      throw new HttpError(
        400,
        'The scheduled contact is unavailable or no longer an active invoice recipient.',
      );
    const seller = workspace.sellerRegistration(organization, input.gstRegistrationId);
    workspace.validateTax(input, seller);
    await workspace.validateCatalogReferences(input);
    await workspace.selectBusinessProduct(organization, input.businessProductId);
    await workspace.selectFormat(organization.id, input.formatId);
    return { input, organization, customer };
  }

  // --- API operations (called by recurring-invoices.controller.js) ---
  async function create(rawInput, actorId) {
    const input = createSchema.parse(rawInput);
    const hash = fingerprint(input);
    return db.transaction(
      async () => {
        const previous = await schedules.findOne(
          { organizationId: input.organizationId, requestId: input.requestId },
          db.options(),
        );
        if (previous) {
          if (previous.requestFingerprint !== hash)
            throw new HttpError(
              409,
              'This request already created a different schedule. Review recurring schedules before creating another.',
              RECURRING_REQUEST_CONFLICT,
            );
          return { created: false, schedule: summarize(previous) };
        }
        const source = await sourceDocument(input.organizationId, input.sourceDocumentId);
        if ((source.version ?? 0) !== input.sourceVersion)
          throw new HttpError(
            409,
            'The source invoice has changed. Reopen it and review the latest details before creating the schedule.',
            RECURRING_VERSION_CONFLICT,
          );
        const organization = await workspace.getOrganization(input.organizationId);
        if (billingProfileFor(source.organizationSnapshot) !== billingProfileFor(organization))
          throw new HttpError(
            400,
            'The source invoice uses a different billing profile. Prepare a current invoice before scheduling it.',
          );
        const timestamp = now().toISOString();
        const schedule = {
          id: randomUUID(),
          organizationId: input.organizationId,
          requestId: input.requestId,
          requestFingerprint: hash,
          name: input.name,
          frequency: input.frequency,
          startDate: input.startDate,
          nextIndex: 0,
          nextDate: input.startDate,
          dueDays: input.dueDays,
          endDate: input.endDate,
          maxOccurrences: input.maxOccurrences,
          status: input.active ? 'active' : 'paused',
          version: 1,
          generatedCount: 0,
          template: frozenTemplate(source),
          sourceSnapshot: sourceSnapshot(source, organization),
          nextEligibleAt: timestamp,
          lastError: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        };
        validateBounds(schedule);
        await readyInput(schedule, schedule.nextDate);
        await schedules.insertOne(schedule, db.options());
        await event(
          schedule,
          'created',
          `Schedule created ${schedule.status}; every occurrence will create a draft for review.`,
          actorId,
        );
        return { created: true, schedule: summarize(schedule) };
      },
      { organizationId: input.organizationId },
    );
  }

  async function update(organizationId, id, rawInput, actorId) {
    const input = updateSchema.parse(rawInput);
    return db.transaction(
      async () => {
        const current = await rawSchedule(organizationId, id);
        assertVersion(input.version, current);
        if (!['paused', 'error'].includes(current.status))
          throw new HttpError(
            409,
            'Pause the schedule before changing its settings. Completed schedules are kept as history.',
          );
        const { version: expectedVersion, ...changes } = input;
        validateBounds({ ...current, ...changes });
        const updated = await replaceSchedule(current, { ...changes, updatedBy: actorId });
        await event(
          updated,
          'updated',
          'Schedule settings updated. The source template, anchor and next occurrence are unchanged.',
          actorId,
          {
            previous: {
              name: current.name,
              dueDays: current.dueDays,
              endDate: current.endDate,
              maxOccurrences: current.maxOccurrences,
            },
            changes,
          },
        );
        return summarize(updated);
      },
      { organizationId },
    );
  }

  async function setStatus(organizationId, id, rawInput, actorId) {
    const input = statusSchema.parse(rawInput);
    return db.transaction(
      async () => {
        const current = await rawSchedule(organizationId, id);
        assertVersion(input.version, current);
        if (current.status === 'completed')
          throw new HttpError(
            409,
            'This schedule is complete. Create an explicit replacement if more drafts are needed.',
          );
        if (input.action === 'resume') {
          validateBounds(current);
          await readyInput(current, current.nextDate);
        }
        const status = input.action === 'pause' ? 'paused' : 'active';
        if (status === current.status) return summarize(current);
        const updated = await replaceSchedule(current, {
          status,
          updatedBy: actorId,
          ...(status === 'active'
            ? {
                nextEligibleAt: now().toISOString(),
                lastError: null,
                ...(current.recoveryPausedAt ? { recoveryReviewedAt: now().toISOString() } : {}),
              }
            : {}),
        });
        await event(
          updated,
          input.action === 'pause' ? 'paused' : 'resumed',
          input.action === 'pause'
            ? 'Automatic generation paused; the next occurrence and history are retained.'
            : 'Schedule reviewed and resumed from its unchanged next occurrence.',
          actorId,
        );
        return summarize(updated);
      },
      { organizationId },
    );
  }

  // --- Generating occurrences (manual "Generate now" and the automatic pass) ---
  async function occurrenceResult(schedule, occurrence, created = false) {
    const document = await db.models.documents.findById(occurrence.documentId);
    return {
      created,
      schedule: summarize(schedule),
      occurrence: { ...clean(occurrence), documentAvailable: Boolean(document) },
      document: document
        ? {
            id: document.id,
            organizationId: document.organizationId,
            kind: document.kind,
            number: document.number,
            status: document.status,
          }
        : null,
    };
  }

  async function recordFailure(organizationId, id, attempt, error, actorId) {
    const message = publicFailure(error);
    return db.transaction(
      async () => {
        const current = await rawSchedule(organizationId, id);
        const previous = await occurrences.findOne(
          { scheduleId: id, scheduledDate: attempt.date },
          db.options(),
        );
        // A network/commit error can arrive after success. Recover the committed receipt first.
        if (previous?.status === 'generated') return occurrenceResult(current, previous);
        if (current.version !== attempt.version || current.nextDate !== attempt.date) throw error;
        const failure = { at: now().toISOString(), message };
        const occurrence = {
          id: previous?.id || randomUUID(),
          organizationId,
          scheduleId: id,
          scheduledDate: attempt.date,
          occurrenceIndex: current.nextIndex,
          status: 'failed',
          attempts: (previous?.attempts || 0) + 1,
          lastFailure: failure,
          lastAttemptAt: failure.at,
          createdAt: previous?.createdAt || failure.at,
        };
        await occurrences.updateOne(
          { scheduleId: id, scheduledDate: attempt.date },
          { $set: occurrence },
          { ...db.options(), upsert: true },
        );
        const updated = await replaceSchedule(current, {
          status: 'error',
          lastError: { ...failure, scheduledDate: attempt.date },
        });
        await event(updated, 'generation_failed', message, actorId, { scheduledDate: attempt.date });
        return {
          created: false,
          failed: true,
          message,
          schedule: summarize(updated),
          occurrence: clean(occurrence),
          document: null,
        };
      },
      { organizationId },
    );
  }

  async function generateOne(organizationId, id, input, actorId, automatic = false) {
    let attempt;
    try {
      return await db.transaction(
        async () => {
          const current = await rawSchedule(organizationId, id);
          const previous = await occurrences.findOne(
            { scheduleId: id, scheduledDate: input.occurrenceDate },
            db.options(),
          );
          if (previous?.status === 'generated') return occurrenceResult(current, previous);
          if (automatic && (current.version !== input.version || current.nextDate !== input.occurrenceDate))
            return { skipped: true };
          assertVersion(input.version, current);
          if (current.nextDate !== input.occurrenceDate) throw conflict();
          if (current.status !== 'active')
            throw new HttpError(409, 'Resume this schedule before generating its next draft.');
          const timestamp = now().toISOString();
          if (current.nextDate > indiaBusinessDate(now()))
            throw new HttpError(409, 'The next occurrence is not due yet (India time).');
          if (automatic && (current.status !== 'active' || current.nextEligibleAt > timestamp))
            return { skipped: true };
          attempt = { version: current.version, date: current.nextDate };
          const {
            input: documentInput,
            organization,
            customer,
          } = await readyInput(current, current.nextDate);
          const document = await workspace.newDocument(
            { ...documentInput, recurringScheduleId: id, recurringScheduledDate: current.nextDate },
            organization,
            customer,
          );
          const occurrence = {
            id: previous?.id || randomUUID(),
            organizationId,
            scheduleId: id,
            scheduledDate: current.nextDate,
            occurrenceIndex: current.nextIndex,
            status: 'generated',
            attempts: (previous?.attempts || 0) + 1,
            lastFailure: previous?.lastFailure || null,
            lastAttemptAt: timestamp,
            createdAt: previous?.createdAt || timestamp,
            generatedAt: timestamp,
            documentId: document.id,
            documentNumber: document.number,
            dueDate: document.dueDate,
          };
          await occurrences.updateOne(
            { scheduleId: id, scheduledDate: current.nextDate },
            { $set: occurrence },
            { ...db.options(), upsert: true },
          );
          const nextIndex = current.nextIndex + 1;
          const nextDate = scheduledDate(current, nextIndex);
          const updated = await replaceSchedule(current, {
            nextIndex,
            nextDate: nextDate || '',
            generatedCount: current.generatedCount + 1,
            status: nextDate ? 'active' : 'completed',
            lastError: null,
            nextEligibleAt: new Date(now().getTime() + 60_000).toISOString(),
          });
          await event(
            updated,
            'generated',
            `Draft ${document.number} created for ${current.nextDate}.`,
            actorId,
            { scheduledDate: current.nextDate, documentId: document.id, documentNumber: document.number },
          );
          if (!nextDate)
            await event(updated, 'completed', 'The schedule reached its date or occurrence limit.', actorId);
          return occurrenceResult(updated, occurrence, true);
        },
        { organizationId },
      );
    } catch (error) {
      if (!attempt) throw error;
      logger?.error('recurring_generation_failed', { error, scheduleId: id, organizationId });
      return recordFailure(organizationId, id, attempt, error, actorId);
    }
  }
  function trackGeneration(action) {
    const promise = action();
    generations.add(promise);
    promise.finally(() => generations.delete(promise)).catch(() => {});
    return promise;
  }
  function generate(organizationId, id, rawInput, actorId) {
    const input = generateSchema.parse(rawInput);
    return trackGeneration(() => generateOne(organizationId, id, input, actorId));
  }
  function processDue() {
    if (stopped) return Promise.resolve({ processed: 0, created: 0, failed: 0, stopped: true });
    if (processing) return processing;
    processing = (async () => {
      const rows = await schedules
        .find(
          {
            status: 'active',
            nextDate: { $lte: indiaBusinessDate(now()) },
            nextEligibleAt: { $lte: now().toISOString() },
          },
          { projection: { _id: 0, id: 1, organizationId: 1, version: 1, nextDate: 1 } },
        )
        .sort({ nextDate: 1, id: 1 })
        .limit(RECURRING_LIMITS.batchSize)
        .toArray();
      const result = { processed: 0, created: 0, failed: 0 };
      for (const schedule of rows) {
        if (stopped) break;
        try {
          const outcome = await trackGeneration(() =>
            generateOne(
              schedule.organizationId,
              schedule.id,
              { version: schedule.version, occurrenceDate: schedule.nextDate },
              'automation',
              true,
            ),
          );
          if (!outcome.skipped) result.processed += 1;
          if (outcome.created) result.created += 1;
          if (outcome.failed) result.failed += 1;
        } catch (error) {
          result.failed += 1;
          logger?.error('recurring_schedule_failed', {
            error,
            scheduleId: schedule.id,
            organizationId: schedule.organizationId,
          });
        }
      }
      return result;
    })().finally(() => {
      processing = null;
    });
    return processing;
  }
  async function stop() {
    stopped = true;
    await Promise.allSettled([...(processing ? [processing] : []), ...generations]);
  }

  // --- Pages and lists ---
  async function list(organizationId, query = {}) {
    const requestedPage = pageNumber(query.page);
    const total = await schedules.countDocuments({ organizationId });
    const pageCount = Math.max(1, Math.ceil(total / RECURRING_LIMITS.pageSize));
    const page = Math.min(requestedPage, pageCount);
    const values = await schedules
      .find({ organizationId }, { projection: summaryProjection })
      .sort({ createdAt: -1, id: -1 })
      .skip((page - 1) * RECURRING_LIMITS.pageSize)
      .limit(RECURRING_LIMITS.pageSize)
      .toArray();
    return { schedules: values.map(summarize), total, page, pageCount, pageSize: RECURRING_LIMITS.pageSize };
  }
  async function sourceCandidates(organizationId, query = '') {
    const search = z.string().trim().max(200).parse(query);
    const filter = { organizationId, kind: 'invoice', status: { $ne: 'cancelled' } };
    if (search) {
      const literal = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = ['number', 'title', 'customerSnapshot.name'].map((field) => ({
        [field]: { $regex: literal, $options: 'i' },
      }));
    }
    const values = await db
      .collection('documents')
      .find(filter, { projection: sourceProjection })
      .sort({ createdAt: -1, _id: -1 })
      .limit(25)
      .toArray();
    return { sources: values.map((value) => ({ ...value, version: value.version ?? 0 })), search, limit: 25 };
  }
  async function get(organizationId, id, query = {}) {
    const schedule = await rawSchedule(organizationId, id);
    const where = { organizationId, scheduleId: id };
    const [historyTotal, eventTotal] = await Promise.all([
      occurrences.countDocuments(where),
      events.countDocuments(where),
    ]);
    const historyPageCount = Math.max(1, Math.ceil(historyTotal / RECURRING_LIMITS.pageSize));
    const eventPageCount = Math.max(1, Math.ceil(eventTotal / RECURRING_LIMITS.pageSize));
    const historyPage = Math.min(pageNumber(query.historyPage), historyPageCount);
    const eventPage = Math.min(pageNumber(query.eventPage), eventPageCount);
    const [history, activity] = await Promise.all([
      occurrences
        .find(where, { projection: { _id: 0 } })
        .sort({ scheduledDate: -1 })
        .skip((historyPage - 1) * RECURRING_LIMITS.pageSize)
        .limit(RECURRING_LIMITS.pageSize)
        .toArray(),
      events
        .find(where, { projection: { _id: 0 } })
        .sort({ at: -1, id: -1 })
        .skip((eventPage - 1) * RECURRING_LIMITS.pageSize)
        .limit(RECURRING_LIMITS.pageSize)
        .toArray(),
    ]);
    const documentIds = history.map((row) => row.documentId).filter(Boolean);
    const currentDocuments = documentIds.length
      ? await db
          .collection('documents')
          .find({ organizationId, id: { $in: documentIds } }, { projection: { _id: 0, id: 1, status: 1 } })
          .toArray()
      : [];
    const documents = new Map(currentDocuments.map((document) => [document.id, document]));
    return {
      schedule: { ...clean(schedule), dueCount: dueOccurrenceCount(schedule, indiaBusinessDate(now())) },
      history: history.map((row) => ({
        ...row,
        documentAvailable: documents.has(row.documentId),
        documentStatus: documents.get(row.documentId)?.status || '',
      })),
      historyTotal,
      historyPage,
      historyPageCount,
      activity,
      eventTotal,
      eventPage,
      eventPageCount,
    };
  }
  async function page(organizationId, route = {}) {
    const shared = {
      policy: RECURRING_SNAPSHOT_POLICY,
      labels: RECURRENCE_LABELS,
      limits: RECURRING_LIMITS,
      businessDate: indiaBusinessDate(now()),
    };
    if (route.action === 'edit')
      return { ...shared, mode: 'edit', ...(await get(organizationId, route.id, route.query)) };
    if (route.action === 'new') {
      const documentId = route.query?.documentId;
      if (documentId !== undefined) {
        identifier.parse(documentId);
        const source = await sourceDocument(organizationId, documentId);
        return {
          ...shared,
          mode: 'new',
          source: {
            id: source.id,
            version: source.version ?? 0,
            snapshot: sourceSnapshot(source, await workspace.getOrganization(organizationId)),
            template: frozenTemplate(source),
          },
        };
      }
      return {
        ...shared,
        mode: 'new',
        source: null,
        ...(await sourceCandidates(organizationId, route.query?.q || '')),
      };
    }
    return { ...shared, mode: 'list', ...(await list(organizationId, route.query)) };
  }

  return { create, update, setStatus, generate, processDue, stop, list, get, sourceCandidates, page };
}
