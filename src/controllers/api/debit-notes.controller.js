/**
 * Debit notes API: a debit note charges the buyer more than an issued invoice did (a price increase,
 * short billing, a correction). It is saved as its own invoice-kind document with `debitNoteFor`
 * (the original invoice), its own number (PREFIX/2627/DN0001) and the heading DEBIT NOTE, so
 * receipts, reminders, ledgers, PDF and email work as for any invoice. GSTR-1 reports it in
 * CDNR / CDNUR with note type D.
 */

import { randomUUID } from 'node:crypto';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { debitNoteSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
import { calculateTotals, getDocumentFormat } from '../../../shared/types.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';

export function createController(context) {
  const { db, now, getOrganization, getDocument, addEvent, nextNumber } = context;
  return {
    // POST /api/documents/:id/debit-notes
    create: async (req, res) => {
      const input = debitNoteSchema.parse(req.body);
      const requestId = input.requestId.toLowerCase();
      let created = false;
      const note = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (invoice) => {
          // A retried save returns the debit note it already created.
          const previous = await db.models.documents.findDebitNote(invoice.id, requestId);
          if (previous) return previous;
          if (
            invoice.kind !== 'invoice' ||
            invoice.debitNoteFor ||
            ['draft', 'cancelled'].includes(invoice.status)
          )
            throw new HttpError(409, 'Debit notes can be issued only against issued invoices.');
          if (input.noteDate < invoice.issueDate || input.noteDate > indiaBusinessDate(now()))
            throw new HttpError(400, 'The debit note date must be between the invoice date and today.');
          if (input.dueDate && input.dueDate < input.noteDate)
            throw new HttpError(400, 'The due date cannot be before the debit note date.');
          const line = invoice.items.find((item) => (Number(item.gstRate) || 0) === input.gstRate);
          if (!line) throw new HttpError(400, 'Choose a GST rate used on this invoice.');
          const items = [
            {
              description: `${input.reason}: against invoice ${invoice.number}`,
              hsn: line.hsn ?? '',
              ...(line.unit ? { unit: line.unit } : {}),
              ...(line.itemType ? { itemType: line.itemType } : {}),
              quantity: 1,
              rate: input.taxable,
              gstRate: input.gstRate,
            },
          ];
          const totals = calculateTotals(
            items,
            0,
            invoice.placeOfSupply !== invoice.organizationSnapshot.stateCode,
          );
          const timestamp = now().toISOString();
          const record = {
            id: randomUUID(),
            organizationId: invoice.organizationId,
            customerId: invoice.customerId,
            gstRegistrationId: invoice.gstRegistrationId,
            kind: 'invoice',
            status: 'sent',
            number: await nextNumber(
              await getOrganization(invoice.organizationId),
              'debit_note',
              input.noteDate,
            ),
            issueDate: input.noteDate,
            dueDate: input.dueDate || input.noteDate,
            title: 'Debit note',
            items,
            discountPercent: 0,
            placeOfSupply: invoice.placeOfSupply,
            notes: [
              `Debit note against invoice ${invoice.number} dated ${invoice.issueDate}. Reason: ${input.reason}.`,
              input.notes,
            ]
              .filter(Boolean)
              .join(' '),
            terms: invoice.terms ?? '',
            branding: invoice.branding,
            businessProductId: invoice.businessProductId,
            businessProductSnapshot: invoice.businessProductSnapshot ?? null,
            customerSnapshot: invoice.customerSnapshot,
            organizationSnapshot: invoice.organizationSnapshot,
            formatId: invoice.formatId,
            formatSnapshot: invoice.formatSnapshot ?? getDocumentFormat(invoice),
            totals,
            installmentPlan: null,
            amountPaid: 0,
            balanceDue: totals.total,
            finalizedAt: null,
            sourceQuotationId: null,
            convertedInvoiceId: null,
            sourceDocumentId: null,
            deliveryNoteId: null,
            debitNoteFor: {
              id: invoice.id,
              number: invoice.number,
              issueDate: invoice.issueDate,
              total: invoice.totals.total,
              reason: input.reason,
              requestId,
            },
            createdAt: timestamp,
            updatedAt: timestamp,
            version: 1,
          };
          await db.models.documents.insert(record);
          await addEvent(
            invoice.id,
            'debit_note_issued',
            `Debit note ${record.number} of INR ${totals.total.toFixed(2)} issued (${input.reason}).`,
          );
          created = true;
          return record;
        },
      );
      res.status(created ? 201 : 200).json(note);
    },
  };
}
