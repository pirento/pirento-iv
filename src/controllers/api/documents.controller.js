/**
 * Documents API (/api/documents): invoices, quotations, proformas and delivery challans.
 *
 * Covers create/update/delete, quotation->invoice conversion, delivery challans from an
 * invoice, manual receipts, installment plans, finalizing a paid invoice, and invoice email.
 *
 * Important rules enforced here:
 * - Updates must send the document `version` (stale browser tabs get a 409 conflict).
 * - New documents send a `requestId`, so a retried save never creates a duplicate.
 * - Issued/paid documents lock their financial fields; kind and business never change.
 * Shared write logic: src/services/workspace-service.js and services/documents/document-writes.js.
 */

import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';
import { blankShipping, calculateTotals, DOCUMENT_LABELS, getDocumentFormat } from '../../../shared/types.js';
import { isInvoiceRecipient } from '../../services/validation/contacts.js';
import {
  documentSchema,
  installmentPlanSchema,
  paymentSchema,
} from '../../services/validation/validation.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { assertDocumentVersion, createDocumentWriter } from '../../services/documents/document-writes.js';
import {
  businessSnapshot,
  customerSnapshot as snapshotOfCustomer,
} from '../../services/documents/snapshots.js';
export function createController(context) {
  const {
    db,
    mailer,
    online,
    now,
    getOrganization,
    getCustomer,
    getDocument,
    activePaidPaise,
    addEvent,
    paymentDetails,
    updatePaymentBalance,
    selectBusinessProduct,
    validateInstallmentTotal,
    recordPlanChange,
    selectFormat,
    validateCatalogReferences,
    scopedOrganization,
    validateTax,
    saveDocument,
    sellerRegistration,
    newDocument,
    letterheadFor,
    emailIssuedDocument,
    recordPayment,
    fiscalYear,
  } = context;
  const writer = createDocumentWriter({ db, now, newDocument, getOrganization, getCustomer });
  return {
    // GET /api/documents/:id/messages
    listMessages: async (req, res) => {
      await getDocument(req.params.id);
      res.json(await mailer.listMessages(req.params.id));
    },
    // POST /api/documents/:id/email
    sendEmail: async (req, res) => {
      const input = z
        .object({
          includePaymentLink: z.boolean().default(false),
          requestId: z.guid(),
        })
        .parse(req.body);
      let document = await getDocument(req.params.id);
      if (document.status === 'draft' || document.status === 'cancelled' || document.kind === 'delivery_note')
        throw new HttpError(409, 'Issue a financial document before emailing it.');
      if (!(await mailer.status(document.organizationId)).configured)
        throw new HttpError(503, (await mailer.status(document.organizationId)).reason);
      if (!z.string().email().safeParse(document.customerSnapshot.email).success)
        throw new HttpError(400, 'The saved invoice recipient needs a valid email address.');
      let paymentUrl;
      if (input.includePaymentLink) {
        const links = await online.createPaymentLink(document.id);
        paymentUrl = links.links.find((link) => ['created', 'partially_paid'].includes(link.state))?.url;
        if (!paymentUrl)
          throw new HttpError(409, 'No payable link is available. Review online payments before sending.');
        document = await getDocument(document.id);
      }
      const message = await transactionForRecord(
        db,
        () => getDocument(document.id),
        async (current) =>
          mailer.enqueueInvoice(current, {
            eventKey: `invoice-manual:${current.id}:${input.requestId}`,
            paymentUrl,
          }),
      );
      res.status(202).json({
        message,
      });
    },
    // GET /api/documents
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      const kind =
        req.query.kind === undefined
          ? undefined
          : z.enum(['invoice', 'quotation', 'proforma', 'delivery_note']).parse(req.query.kind);
      const rows = kind
        ? await db.models.documents.list(organization.id, kind)
        : await db.models.documents.list(organization.id);
      res.json(rows);
    },
    // POST /api/documents
    create: async (req, res) => {
      const input = documentSchema.parse(req.body);
      const { requestId } = z.object({ requestId: z.guid().optional() }).parse(req.body);
      const result = await writer.create(input, requestId?.toLowerCase());
      res.status(result.created ? 201 : 200).json(result.document);
    },
    // PUT /api/documents/:id
    update: async (req, res) => {
      const input = documentSchema.parse(req.body);
      const { version } = z
        .object({ version: z.number().int().nonnegative().safe().optional() })
        .parse(req.body);
      const result = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (current) => {
          assertDocumentVersion(version, current);
          if (input.organizationId !== current.organizationId || input.kind !== current.kind)
            throw new HttpError(400, 'Document kind and organization cannot be changed.');
          if (current.finalizedAt)
            throw new HttpError(
              409,
              'This invoice is finalized and locked. Void an incorrect payment with a reason to reopen its balance.',
            );
          if (current.convertedInvoiceId)
            throw new HttpError(
              409,
              'This document was converted to an invoice and can no longer be edited.',
            );
          const businessProductId =
            input.businessProductId === undefined ? current.businessProductId : input.businessProductId;
          const productChange = (businessProductId || '') !== (current.businessProductId || '');
          const gstRegistrationId =
            input.gstRegistrationId === undefined ? current.gstRegistrationId : input.gstRegistrationId;
          const registrationChange = (gstRegistrationId || '') !== (current.gstRegistrationId || '');
          const brandingChange =
            input.branding !== undefined &&
            JSON.stringify(input.branding) !== JSON.stringify(current.branding);
          if (brandingChange && current.status !== 'draft')
            throw new HttpError(
              409,
              'Document logos, signatures and stamps can be customized only while the document is a draft.',
            );
          const installmentPlan =
            input.installmentPlan === undefined ? current.installmentPlan : input.installmentPlan;
          const planChange =
            JSON.stringify(installmentPlan ?? null) !== JSON.stringify(current.installmentPlan ?? null);
          if (planChange && current.status !== 'draft')
            throw new HttpError(
              409,
              'Use the installment schedule action to change a plan on an issued invoice.',
            );
          const immutable = ['customerId', 'issueDate', 'items', 'discountPercent', 'placeOfSupply'];
          const financialChange =
            productChange ||
            registrationChange ||
            immutable.some((key) => JSON.stringify(input[key]) !== JSON.stringify(current[key]));
          const paid = current.kind === 'invoice' ? await activePaidPaise(current.id) : 0;
          if (paid > 0 && (financialChange || ['draft', 'cancelled'].includes(input.status)))
            throw new HttpError(
              409,
              'Invoices with active payments cannot change financial details, return to draft or be cancelled.',
            );
          if (
            current.kind === 'invoice' &&
            input.status !== current.status &&
            (['paid', 'partially_paid'].includes(input.status) ||
              ['paid', 'partially_paid'].includes(current.status))
          )
            throw new HttpError(
              409,
              'Payment status is calculated from recorded payments. Use Payments to record or void a payment.',
            );
          if (current.status !== 'draft') {
            if (input.status === 'draft')
              throw new HttpError(409, 'An issued document cannot be returned to draft.');
            if (financialChange)
              throw new HttpError(
                409,
                'Financial details of an issued document are locked. Only status, title, due date, notes and terms can be updated.',
              );
          }
          if (fiscalYear(input.issueDate) !== fiscalYear(current.issueDate))
            throw new HttpError(
              400,
              'The issue date must stay within the financial year of the assigned document number.',
            );
          if (
            input.customerId !== current.customerId &&
            !isInvoiceRecipient(await getCustomer(input.customerId))
          )
            throw new HttpError(400, 'Select an active customer, vendor or B2B buyer.');
          if (financialChange || input.status !== current.status)
            await online.assertManualChangesAllowed(current.id);
          const customerSnapshot = snapshotOfCustomer(
            financialChange ? await getCustomer(input.customerId) : current.customerSnapshot,
          );
          if (customerSnapshot.organizationId !== current.organizationId)
            throw new HttpError(400, 'The customer belongs to a different organization.');
          const organizationSnapshot = businessSnapshot(
            financialChange
              ? sellerRegistration(await getOrganization(current.organizationId), gstRegistrationId)
              : current.organizationSnapshot,
          );
          validateTax(input, organizationSnapshot);
          await validateCatalogReferences(
            {
              ...input,
              businessProductId,
            },
            current,
          );
          const selectedProduct = await selectBusinessProduct(
            await getOrganization(current.organizationId),
            businessProductId,
            current.businessProductId,
            financialChange,
          );
          const businessProductSnapshot =
            !productChange && current.businessProductSnapshot
              ? current.businessProductSnapshot
              : selectedProduct;
          const formatSnapshot =
            input.formatId && input.formatId !== current.formatId
              ? await selectFormat(current.organizationId, input.formatId)
              : (current.formatSnapshot ?? getDocumentFormat(current));
          const totals = financialChange
            ? calculateTotals(
                input.items,
                input.discountPercent,
                organizationSnapshot.stateCode !== input.placeOfSupply,
              )
            : current.totals;
          validateInstallmentTotal(installmentPlan, totals.total);
          // Printing on the letterhead keeps the copy taken when it was first chosen.
          const useLetterhead =
            input.useLetterhead === undefined ? Boolean(current.letterhead) : input.useLetterhead;
          const letterhead = useLetterhead
            ? (current.letterhead ?? (await letterheadFor(current.organizationId, true)))
            : null;
          const document = {
            ...current,
            ...input,
            customerSnapshot,
            organizationSnapshot,
            updatedAt: now().toISOString(),
            formatId: formatSnapshot.id,
            formatSnapshot,
            totals,
            amountPaid: paid / 100,
            balanceDue: input.kind === 'invoice' ? (Math.round(totals.total * 100) - paid) / 100 : 0,
            businessProductId,
            businessProductSnapshot,
            installmentPlan,
            gstRegistrationId,
            useLetterhead,
            letterhead,
          };
          await saveDocument(document);
          if (document.status === 'cancelled') await mailer.holdCancelledDocument(document);
          if (planChange) await recordPlanChange(document.id, current.installmentPlan, installmentPlan);
          if (current.status === 'draft' && document.status === 'sent') await emailIssuedDocument(document);
          return document;
        },
      );
      res.json(result);
    },
    // DELETE /api/documents/:id
    remove: async (req, res) => {
      await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (document) => {
          if (document.finalizedAt || (await db.models.payments.first(document.id)))
            throw new HttpError(409, 'Invoices with payment history or finalization cannot be deleted.');
          if (document.status !== 'draft') throw new HttpError(409, 'Only draft documents can be deleted.');
          if (
            document.sourceQuotationId ||
            document.convertedInvoiceId ||
            document.sourceDocumentId ||
            document.deliveryNoteId
          )
            throw new HttpError(409, 'Documents linked by conversion or delivery cannot be deleted.');
          await db.models.events.removeForDocument(document.id);
          await db.models.documents.remove(document.id);
        },
      );
      res.json({
        ok: true,
      });
    },
    // POST /api/documents/:id/convert
    convert: async (req, res) => {
      let created = false;
      const invoice = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (quotation) => {
          if (!['quotation', 'proforma'].includes(quotation.kind))
            throw new HttpError(400, 'Only a quotation or proforma can be converted to an invoice.');
          if (quotation.convertedInvoiceId) return await getDocument(quotation.convertedInvoiceId);
          if (['declined', 'cancelled'].includes(quotation.status))
            throw new HttpError(409, 'A declined or cancelled document cannot be converted.');
          const issueDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(now());
          const paymentTermMilliseconds = quotation.dueDate
            ? Date.parse(`${quotation.dueDate}T00:00:00Z`) - Date.parse(`${quotation.issueDate}T00:00:00Z`)
            : 0;
          const dueDate = quotation.dueDate
            ? new Date(Date.parse(`${issueDate}T00:00:00Z`) + Math.max(0, paymentTermMilliseconds))
                .toISOString()
                .slice(0, 10)
            : '';
          const input = {
            organizationId: quotation.organizationId,
            customerId: quotation.customerId,
            kind: 'invoice',
            status: 'draft',
            issueDate,
            dueDate,
            title: quotation.title === DOCUMENT_LABELS[quotation.kind] ? 'Invoice' : quotation.title,
            items: quotation.items,
            discountPercent: quotation.discountPercent,
            placeOfSupply: quotation.placeOfSupply,
            notes: quotation.notes,
            terms: quotation.terms,
            shipping: quotation.shipping,
            gstRegistrationId: quotation.gstRegistrationId,
            branding: quotation.branding,
            businessProductId: quotation.businessProductId,
            installmentPlan: quotation.installmentPlan,
            useLetterhead: Boolean(quotation.letterhead),
          };
          const result = await newDocument(
            input,
            quotation.organizationSnapshot,
            quotation.customerSnapshot,
            quotation,
          );
          await saveDocument({
            ...quotation,
            status: 'accepted',
            convertedInvoiceId: result.id,
            updatedAt: now().toISOString(),
          });
          created = true;
          return result;
        },
      );
      res.status(created ? 201 : 200).json(invoice);
    },
    // POST /api/documents/:id/delivery-note
    createDeliveryNote: async (req, res) => {
      let created = false;
      const document = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (invoice) => {
          if (invoice.kind !== 'invoice')
            throw new HttpError(400, 'Create a delivery challan from an invoice.');
          if (invoice.deliveryNoteId) return await getDocument(invoice.deliveryNoteId);
          if (invoice.status === 'cancelled')
            throw new HttpError(409, 'A cancelled invoice cannot create a delivery challan.');
          const issueDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(now());
          const shipping = invoice.shipping ?? {
            ...blankShipping(),
            recipientName: invoice.customerSnapshot.name,
            address: invoice.customerSnapshot.address,
            stateCode: invoice.customerSnapshot.stateCode,
            phone: invoice.customerSnapshot.phone,
            reference: invoice.number,
          };
          const input = {
            organizationId: invoice.organizationId,
            customerId: invoice.customerId,
            kind: 'delivery_note',
            status: 'draft',
            issueDate,
            dueDate: '',
            title: 'Delivery challan',
            items: invoice.items.map(({ pricing: _pricing, ...item }) => ({
              ...item,
              rate: 0,
              gstRate: 0,
            })),
            discountPercent: 0,
            placeOfSupply: invoice.placeOfSupply,
            notes: '',
            terms: '',
            shipping,
            gstRegistrationId: invoice.gstRegistrationId,
            branding: invoice.branding,
            businessProductId: invoice.businessProductId,
            useLetterhead: Boolean(invoice.letterhead),
          };
          const result = await newDocument(
            input,
            invoice.organizationSnapshot,
            invoice.customerSnapshot,
            invoice,
          );
          await saveDocument({
            ...invoice,
            deliveryNoteId: result.id,
            updatedAt: now().toISOString(),
          });
          await addEvent(
            invoice.id,
            'delivery_note_created',
            `Delivery challan ${result.number} created from this invoice.`,
          );
          created = true;
          return result;
        },
      );
      res.status(created ? 201 : 200).json(document);
    },
    // GET /api/documents/:id/payments
    listPayments: async (req, res) => {
      const document = await getDocument(req.params.id);
      if (document.kind !== 'invoice')
        throw new HttpError(400, 'Payments can be recorded only against invoices.');
      res.json(await paymentDetails(document.id));
    },
    // PUT /api/documents/:id/installments
    updateInstallments: async (req, res) => {
      const { plan, version } = z
        .object({
          plan: installmentPlanSchema.nullable(),
          version: z.number().int().nonnegative().safe().optional(),
        })
        .parse(req.body);
      const details = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (document) => {
          assertDocumentVersion(version, document);
          if (document.kind !== 'invoice')
            throw new HttpError(400, 'This installment schedule action is available for invoices only.');
          if (document.finalizedAt || document.status === 'cancelled')
            throw new HttpError(
              409,
              'Finalized or cancelled invoices cannot change their installment schedule.',
            );
          validateInstallmentTotal(plan, document.totals.total);
          if (JSON.stringify(document.installmentPlan ?? null) !== JSON.stringify(plan)) {
            await saveDocument({
              ...document,
              installmentPlan: plan,
              updatedAt: now().toISOString(),
            });
            await recordPlanChange(document.id, document.installmentPlan, plan);
          }
          return await paymentDetails(document.id);
        },
      );
      res.json(details);
    },
    // POST /api/documents/:id/payments
    recordPayment: async (req, res) => {
      const input = paymentSchema.parse(req.body);
      if (/^(razorpay|cashfree|credit-note):/.test(input.requestId))
        throw new HttpError(
          400,
          'This receipt identifier is reserved for gateway payments and credit notes.',
        );
      const result = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async () => {
          await online.assertManualChangesAllowed(req.params.id);
          const recorded = await recordPayment(req.params.id, input);
          if (recorded.created)
            await mailer.enqueuePayment(recorded.details.document, {
              eventKey: `receipt:${recorded.payment.id}`,
              outcome: recorded.details.document.balanceDue === 0 ? 'paid' : 'received',
              amount: recorded.payment.amount,
              reference: recorded.payment.reference,
              automatic: true,
            });
          return recorded;
        },
      );
      res.status(result.created ? 201 : 200).json(result.details);
    },
    // POST /api/documents/:id/finalize
    finalize: async (req, res) => {
      const details = await transactionForRecord(
        db,
        () => getDocument(req.params.id),
        async (document) => {
          if (document.kind !== 'invoice') throw new HttpError(400, 'Only invoices can be finalized.');
          if (document.finalizedAt) return await paymentDetails(document.id);
          if (document.status === 'cancelled')
            throw new HttpError(409, 'A cancelled invoice cannot be finalized.');
          if ((await activePaidPaise(document.id)) !== Math.round(document.totals.total * 100))
            throw new HttpError(409, 'Record the full outstanding payment before finalizing this invoice.');
          const finalized = await updatePaymentBalance(document, true);
          await mailer.enqueuePayment(finalized, {
            eventKey: `invoice-finalized:${document.id}:${finalized.finalizedAt}`,
            outcome: 'paid',
            automatic: true,
          });
          return await paymentDetails(document.id);
        },
      );
      res.json(details);
    },
  };
}
