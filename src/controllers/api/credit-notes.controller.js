/**
 * Credit notes API: a credit note lowers what the buyer owes on an issued invoice (goods returned,
 * a discount after sale, a correction). It gets its own number (PREFIX/2627/C0001). The part up to
 * the balance due is applied to the invoice as a "credit_note" receipt, so balances, reminders,
 * ledgers and payment links see it like a payment; any part above that (an invoice already paid)
 * is a refund due to the buyer, recorded with POST /api/credit-notes/:id/refund. Cancelling the
 * credit note voids its receipt.
 */

import { randomUUID } from 'node:crypto';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import {
  creditNoteRefundSchema,
  creditNoteSchema,
  voidPaymentSchema,
} from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
import { gstAmounts } from '../../../shared/types.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';
import { creditNoteHsnLines } from '../../services/pages/gstr1.js';

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
          const previous = await db.models.creditNotes.forRequest(invoice.id, input.requestId.toLowerCase());
          if (previous) return previous;
          if (invoice.kind !== 'invoice' || ['draft', 'cancelled'].includes(invoice.status))
            throw new HttpError(409, 'Credit notes can be issued only against issued invoices.');
          if (input.noteDate < invoice.issueDate || input.noteDate > indiaBusinessDate(now()))
            throw new HttpError(400, 'The credit note date must be between the invoice date and today.');
          if (!invoice.items.some((item) => (Number(item.gstRate) || 0) === input.gstRate))
            throw new HttpError(400, 'Choose a GST rate used on this invoice.');
          await online.assertManualChangesAllowed(invoice.id);
          const interstate = invoice.placeOfSupply !== invoice.organizationSnapshot.stateCode;
          const amounts = gstAmounts({ ...input, interstate });
          const invoicePaise = Math.round(invoice.totals.total * 100);
          const notePaise = Math.round(amounts.total * 100);
          const credited = (await db.models.creditNotes.forInvoice(invoice.id))
            .filter((row) => row.status === 'issued')
            .reduce((sum, row) => sum + Math.round(row.total * 100), 0);
          if (notePaise > invoicePaise - credited)
            throw new HttpError(409, 'Credit notes on this invoice would be more than its total.');
          // Up to the balance due lowers the invoice; the rest is refunded to the buyer.
          const applied = Math.min(
            notePaise,
            Math.max(0, invoicePaise - (await activePaidPaise(invoice.id))),
          );
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
            hsnLines: creditNoteHsnLines(invoice, { gstRate: input.gstRate, ...amounts }),
            appliedAmount: applied / 100,
            refundDue: (notePaise - applied) / 100,
            refund: null,
            requestId: input.requestId.toLowerCase(),
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
          if (applied)
            await db.models.payments.insert({
              id: randomUUID(),
              documentId: invoice.id,
              organizationId: invoice.organizationId,
              amount: applied / 100,
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
            `Credit note ${record.number} of INR ${amounts.total.toFixed(2)} issued (${input.reason})${
              record.refundDue ? `; INR ${record.refundDue.toFixed(2)} to be refunded to the buyer` : ''
            }.`,
          );
          if (applied) await updatePaymentBalance(invoice);
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
          if (current.refund)
            throw new HttpError(409, 'A refund is recorded for this credit note, so it cannot be cancelled.');
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
          if (applied) await updatePaymentBalance(invoice, false, true);
          return cancelled;
        },
      );
      res.json(note);
    },
    // POST /api/credit-notes/:id/refund
    refund: async (req, res) => {
      const input = creditNoteRefundSchema.parse(req.body);
      const initial = await getCreditNote(req.params.id);
      const note = await transactionForRecord(
        db,
        () => getDocument(initial.invoiceId),
        async (invoice) => {
          const current = await getCreditNote(initial.id);
          if (current.refund) return current;
          if (current.status !== 'issued' || !(current.refundDue > 0))
            throw new HttpError(409, 'This credit note has no refund due.');
          if (input.paidOn < current.noteDate || input.paidOn > indiaBusinessDate(now()))
            throw new HttpError(400, 'The refund date must be between the credit note date and today.');
          const refunded = { ...current, refund: { ...input, recordedAt: now().toISOString() } };
          await db.models.creditNotes.save(refunded);
          await addEvent(
            invoice.id,
            'credit_note_refunded',
            `Refund of INR ${current.refundDue.toFixed(2)} for credit note ${current.number} paid by ${input.method.replaceAll('_', ' ')}.`,
          );
          return refunded;
        },
      );
      res.json(note);
    },
  };
}
