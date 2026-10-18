/**
 * Credit notes API: a credit note lowers what the buyer owes on an issued invoice (goods returned,
 * a discount after sale, a correction). It gets its own number (PREFIX/2627/C0001) and is applied
 * to the invoice as a "credit_note" receipt, so balances, reminders, ledgers and payment links
 * see it like a payment. Cancelling the credit note voids that receipt.
 */

import { randomUUID } from 'node:crypto';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { creditNoteSchema, voidPaymentSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
import { gstAmounts } from '../../../shared/types.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';

// What the printed credit note and GSTR-1 need from the invoice's saved copies (no images).
const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source?.[key] ?? '']));
const SELLER_FIELDS = ['name', 'legalName', 'gstin', 'stateCode', 'address', 'email', 'phone'];
const BUYER_FIELDS = ['name', 'gstin', 'stateCode', 'address', 'email', 'phone'];

export function createController(context) {
  const {
    db,
    online,
    now,
    getOrganization,
    getDocument,
    activePaidPaise,
    addEvent,
    updatePaymentBalance,
    nextNumber,
  } = context;
  async function getCreditNote(id) {
    const row = await db.models.creditNotes.findById(id);
    if (!row) throw new HttpError(404, 'Credit note not found.');
    return row;
  }
  return {
    // POST /api/documents/:id/credit-notes
    create: async (req, res) => {
      const input = creditNoteSchema.parse(req.body);
      const requestId = `credit-note:${input.requestId.toLowerCase()}`;
      let created = false;
      const note = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (invoice) => {
          // A retried save returns the credit note it already created.
          const previous = await db.models.payments.findByRequest(invoice.id, requestId);
          if (previous) return await getCreditNote(previous.creditNoteId);
          if (invoice.kind !== 'invoice' || ['draft', 'cancelled'].includes(invoice.status))
            throw new HttpError(409, 'Credit notes can be issued only against issued invoices.');
          if (input.noteDate < invoice.issueDate || input.noteDate > indiaBusinessDate(now()))
            throw new HttpError(400, 'The credit note date must be between the invoice date and today.');
          if (!invoice.items.some((item) => (Number(item.gstRate) || 0) === input.gstRate))
            throw new HttpError(400, 'Choose a GST rate used on this invoice.');
          await online.assertManualChangesAllowed(invoice.id);
          const interstate = invoice.placeOfSupply !== invoice.organizationSnapshot.stateCode;
          const amounts = gstAmounts({ ...input, interstate });
          const outstanding = Math.round(invoice.totals.total * 100) - (await activePaidPaise(invoice.id));
          if (Math.round(amounts.total * 100) > outstanding)
            throw new HttpError(409, 'The credit note is more than the balance due on this invoice.');
          const timestamp = now().toISOString();
          const record = {
            id: randomUUID(),
            organizationId: invoice.organizationId,
            number: await nextNumber(
              await getOrganization(invoice.organizationId),
              'credit_note',
              input.noteDate,
            ),
            noteDate: input.noteDate,
            reason: input.reason,
            notes: input.notes,
            gstRate: input.gstRate,
            interstate,
            ...amounts,
            invoiceId: invoice.id,
            invoiceNumber: invoice.number,
            invoiceDate: invoice.issueDate,
            invoiceTotal: invoice.totals.total,
            placeOfSupply: invoice.placeOfSupply,
            customerId: invoice.customerId,
            customerSnapshot: pick(invoice.customerSnapshot, BUYER_FIELDS),
            organizationSnapshot: pick(invoice.organizationSnapshot, SELLER_FIELDS),
            status: 'issued',
            cancelledAt: null,
            cancelReason: '',
            createdAt: timestamp,
          };
          await db.models.creditNotes.insert(record);
          await db.models.payments.insert({
            id: randomUUID(),
            documentId: invoice.id,
            organizationId: invoice.organizationId,
            amount: amounts.total,
            paidOn: input.noteDate,
            method: 'credit_note',
            reference: record.number,
            notes: input.reason,
            requestId,
            finalizeWhenPaid: false,
            creditNoteId: record.id,
            createdAt: timestamp,
            voidedAt: null,
            voidReason: '',
          });
          await addEvent(
            invoice.id,
            'credit_note_issued',
            `Credit note ${record.number} of INR ${amounts.total.toFixed(2)} issued (${input.reason}).`,
          );
          await updatePaymentBalance(invoice);
          created = true;
          return record;
        },
      );
      res.status(created ? 201 : 200).json(note);
    },
    // POST /api/credit-notes/:id/cancel
    cancel: async (req, res) => {
      const { reason } = voidPaymentSchema.parse(req.body);
      const initial = await getCreditNote(req.params.id);
      const note = await transactionForRecord(
        db,
        () => getDocument(initial.invoiceId),
        async (invoice) => {
          const current = await getCreditNote(initial.id);
          if (current.status === 'cancelled') return current;
          await online.assertManualChangesAllowed(invoice.id);
          const timestamp = now().toISOString();
          const cancelled = { ...current, status: 'cancelled', cancelledAt: timestamp, cancelReason: reason };
          await db.models.creditNotes.save(cancelled);
          const applied = await db.models.payments.forCreditNote(current.id);
          if (applied && !applied.voidedAt)
            await db.models.payments.save({ ...applied, voidedAt: timestamp, voidReason: reason });
          await addEvent(
            invoice.id,
            'credit_note_cancelled',
            `Credit note ${current.number} cancelled. Reason: ${reason}`,
          );
          await updatePaymentBalance(invoice, false, true);
          return cancelled;
        },
      );
      res.json(note);
    },
  };
}
