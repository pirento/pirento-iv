/**
 * Core business service shared by the API controllers (passed to them as the controller context).
 *
 * Holds the rules that several screens need: loading records (404 when missing), receipts and
 * invoice balance/status, catalog and format checks, GST checks, document numbering
 * (PREFIX/2627/0001 per financial year) and creating a new document from validated input.
 */

import { randomUUID } from 'node:crypto';
import { normalizeContact, isInvoiceRecipient } from './validation/contacts.js';
import { organizationForRegistration } from '../../shared/business-identity.js';
import { calculateTotals, getDocumentFormat } from '../../shared/types.js';
import { paymentSchema } from './validation/validation.js';
import { indiaBusinessDate } from '../../shared/business-date.js';
import { wholePaise } from '../../shared/money.js';
import { HttpError } from '../middleware/errors.js';
import { DOCUMENT_VERSION_CONFLICT } from './documents/document-writes.js';

/** Builds the service. `context` provides { db, now, mailer, online }. */
export function createWorkspaceService(context) {
  const { db, now } = context;
  // Indian financial year (April-March) as 4 digits: an issue date in Oct 2026 -> "2627".
  function fiscalYear(issueDate) {
    const year = Number(issueDate.slice(0, 4));
    const start = Number(issueDate.slice(5, 7)) >= 4 ? year : year - 1;
    return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`;
  }
  // --- Record lookups: each throws HttpError 404 when the record does not exist. ---
  async function getOrganization(id) {
    const row = await db.models.organizations.findById(id);
    if (!row) throw new HttpError(404, 'Organization not found.');
    return row;
  }
  async function getCustomer(id) {
    const row = await db.models.customers.findById(id);
    if (!row) throw new HttpError(404, 'Customer not found.');
    return normalizeContact(row);
  }
  async function getDocument(id) {
    const row = await db.models.documents.findById(id);
    if (!row) throw new HttpError(404, 'Document not found.');
    return row;
  }
  async function getPayment(id) {
    const row = await db.models.payments.findById(id);
    if (!row) throw new HttpError(404, 'Payment not found.');
    return row;
  }
  // --- Receipts and invoice balance ---
  // Total of non-voided receipts for a document, in paise.
  async function activePaidPaise(documentId) {
    const row = await db.models.payments.activeTotal(documentId);
    return row.paid;
  }
  // Appends a line to the document's history (shown on the Payments page).
  async function addEvent(documentId, type, description) {
    const event = {
      id: randomUUID(),
      documentId,
      at: now().toISOString(),
      type,
      description,
    };
    await db.models.events.insert(event);
  }
  // Document + its receipts + its history, as returned by the payments API.
  async function paymentDetails(documentId) {
    return {
      document: await getDocument(documentId),
      payments: await db.models.payments.list(documentId),
      events: await db.models.events.list(documentId),
    };
  }
  /**
   * Recalculates amountPaid/balanceDue/status from the receipts and saves the invoice.
   * finalize=true marks a fully paid invoice as final (locked); reopening=true undoes that.
   */
  async function updatePaymentBalance(document, finalize = false, reopening = false) {
    const paid = await activePaidPaise(document.id);
    const total = Math.round(document.totals.total * 100);
    const fullyPaid = paid === total;
    const previousPaymentState = ['paid', 'partially_paid'].includes(document.status);
    const status =
      fullyPaid && (paid > 0 || finalize)
        ? 'paid'
        : paid > 0
          ? 'partially_paid'
          : previousPaymentState || reopening
            ? 'sent'
            : document.status;
    const timestamp = now().toISOString();
    const finalizing = fullyPaid && finalize && !document.finalizedAt;
    const updated = {
      ...document,
      amountPaid: paid / 100,
      balanceDue: (total - paid) / 100,
      status,
      finalizedAt: reopening ? null : finalizing ? timestamp : (document.finalizedAt ?? null),
      updatedAt: timestamp,
    };
    await saveDocument(updated);
    if (finalizing)
      await addEvent(
        document.id,
        'invoice_finalized',
        `Invoice ${document.number} finalized after full payment. The invoice number is unchanged.`,
      );
    return updated;
  }
  // --- Catalog, business products and formats ---
  async function getCatalogItem(id) {
    const row = await db.models.catalog.findById(id);
    if (!row) throw new HttpError(404, 'Product or service not found.');
    return row;
  }
  async function getBusinessProduct(id) {
    const row = await db.models.businessProducts.findById(id);
    if (!row) throw new HttpError(404, 'Business product not found.');
    return row;
  }
  // Validates the business product chosen for a document (same business, not archived unless already used).
  async function selectBusinessProduct(organization, productId, previousId, requireSelection = true) {
    if (!productId) {
      if (
        requireSelection &&
        organization.enableProductSelection &&
        (await db.models.businessProducts.firstActive(organization.id))
      )
        throw new HttpError(400, 'Choose a business product for this document.');
      return null;
    }
    const product = await getBusinessProduct(productId);
    if (product.organizationId !== organization.id)
      throw new HttpError(400, 'The business product belongs to a different organization.');
    if (!product.active && product.id !== previousId)
      throw new HttpError(400, 'Archived business products cannot be selected for new records.');
    return product;
  }
  // Product codes are unique within a business, including archived products.
  async function assertProductCodeAvailable(input, excludedId = '') {
    if (
      input.code &&
      (await db.models.businessProducts.findCodeConflict(input.organizationId, input.code, excludedId))
    )
      throw new HttpError(
        409,
        'This business product code is already used in this organization, including archived products.',
      );
  }
  // An installment plan must add up exactly (to the paisa) to the document total.
  function validateInstallmentTotal(plan, total) {
    if (
      plan &&
      plan.installments.reduce((sum, entry) => sum + Math.round(entry.amount * 100), 0) !==
        Math.round(total * 100)
    )
      throw new HttpError(
        400,
        'Installments must add up exactly to the full document total. Update or remove the plan when changing financial details.',
      );
  }
  // Records an installment plan change in the document history.
  async function recordPlanChange(documentId, previous, next) {
    await addEvent(
      documentId,
      'installment_plan_changed',
      `Installment schedule changed. Previous: ${JSON.stringify(previous ?? null)}. New: ${JSON.stringify(next ?? null)}. Existing payment receipts are unchanged.`,
    );
  }
  async function getFormat(id) {
    const row = await db.models.formats.findById(id);
    if (!row) throw new HttpError(404, 'Invoice format not found.');
    return row;
  }
  // The chosen format, or the business's default format when none is chosen.
  async function selectFormat(organizationId, formatId) {
    let format;
    if (formatId) format = await getFormat(formatId);
    else {
      const row = await db.models.formats.findDefault(organizationId);
      if (!row)
        throw new HttpError(409, 'Choose a default invoice format in Formats before saving a document.');
      format = row;
    }
    if (format.organizationId !== organizationId)
      throw new HttpError(400, 'The format belongs to a different organization.');
    return format;
  }
  // SKUs are unique within a business, including archived items.
  async function assertSkuAvailable(input, excludedId = '') {
    if (!input.sku) return;
    const row = await db.models.catalog.findSkuConflict(input.organizationId, input.sku, excludedId);
    if (row)
      throw new HttpError(409, 'This SKU is already used in this organization, including archived items.');
  }
  // Every catalog item on a document must belong to this business, be active (unless it was
  // already on the document) and match the document's business product.
  async function validateCatalogReferences(input, current) {
    const previous = new Set(current?.items.map((item) => item.catalogItemId).filter(Boolean));
    for (const item of input.items) {
      if (!item.catalogItemId) continue;
      const catalog = await getCatalogItem(item.catalogItemId);
      if (catalog.organizationId !== input.organizationId)
        throw new HttpError(400, 'Products and services must belong to this organization.');
      if (!catalog.active && !previous.has(catalog.id))
        throw new HttpError(400, 'Archived products and services cannot be added to new documents.');
      const retained =
        previous.has(catalog.id) && (current?.businessProductId || '') === (input.businessProductId || '');
      if (catalog.businessProductId && catalog.businessProductId !== input.businessProductId && !retained)
        throw new HttpError(
          400,
          'This catalog item belongs to a different business product. Select its matching product.',
        );
    }
  }
  // Saves a format; making it the default removes the default flag from the previous one.
  async function saveFormat(format) {
    if (format.isDefault) {
      const previous = await db.models.formats.findOtherDefault(format.organizationId, format.id);
      if (previous) {
        const previousFormat = {
          ...previous,
          isDefault: false,
          updatedAt: format.updatedAt,
        };
        await db.models.formats.save(previousFormat);
      }
    }
    await db.models.formats.save(format);
  }
  // --- Business checks ---
  // Loads the business named by a request's organizationId (400 when missing).
  async function scopedOrganization(value) {
    if (typeof value !== 'string' || !value) throw new HttpError(400, 'organizationId is required.');
    return await getOrganization(value);
  }
  // Invoice/quotation number prefixes must be unique across all businesses, including ones used in the past.
  async function assertPrefixesAvailable(organization, excludedId) {
    const organizations = await db.models.organizations.list();
    const incoming = new Set([organization.invoicePrefix, organization.quotationPrefix]);
    for (const other of organizations) {
      if (
        other.id !== excludedId &&
        (incoming.has(other.invoicePrefix) || incoming.has(other.quotationPrefix))
      ) {
        throw new HttpError(409, 'Document prefixes must be unique across all divisions.');
      }
    }
    const previous = await db.models.documents.listAll();
    if (previous.some((row) => row.organizationId !== excludedId && incoming.has(row.number.split('/')[0]))) {
      throw new HttpError(409, 'This prefix was already used by another division. Choose a new prefix.');
    }
  }
  // GST can only be charged when the business has a GSTIN and state, and a place of supply is selected.
  function validateTax(input, organization) {
    if (
      input.items.some((item) => item.gstRate > 0) &&
      (!organization.gstin || !organization.stateCode || !input.placeOfSupply)
    ) {
      throw new HttpError(
        400,
        'To charge GST, save the organization GSTIN and state in Settings, then select the place of supply.',
      );
    }
  }
  // --- Document numbering and creation ---
  // Next free document number, e.g. ATEI/2627/0001 (proformas add "P", delivery challans add "D").
  async function nextNumber(organization, kind, issueDate) {
    const year = fiscalYear(issueDate);
    const prefix = kind === 'quotation' ? organization.quotationPrefix : organization.invoicePrefix;
    const marker = kind === 'proforma' ? 'P' : kind === 'delivery_note' ? 'D' : '';
    for (;;) {
      const row = await db.models.sequences.next(organization.id, kind, year);
      if (row.value > (marker ? 99999 : 999999))
        throw new HttpError(409, 'The document sequence for this financial year is exhausted.');
      const number = `${prefix}/${year}/${marker}${String(row.value).padStart(4, '0')}`;
      if (!(await db.models.documents.findByNumber(number))) return number;
    }
  }
  // Saves a document only if nobody else saved it meanwhile (optimistic locking on `version`).
  async function saveDocument(document) {
    const version = document.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER)
      throw new HttpError(409, 'This document has an invalid revision. Review it before editing.');
    const updated = { ...document, version: version + 1 };
    const result = await db.models.documents.save(updated, version);
    if (!result.changes)
      throw new HttpError(
        409,
        'This document has changed. Open the latest saved version before applying your changes.',
        DOCUMENT_VERSION_CONFLICT,
      );
    document.version = updated.version;
  }
  // The business details as they apply to the chosen GST registration (seller identity on the document).
  function sellerRegistration(organization, registrationId) {
    try {
      return organizationForRegistration(organization, registrationId);
    } catch {
      throw new HttpError(400, 'Choose a GST registration saved in this organization.');
    }
  }
  /**
   * Creates and stores a new document: validates tax, customer, catalog and product, assigns
   * the next number, takes snapshots of the customer/business/format (so later edits to them
   * never change an issued document) and queues the invoice email when it is issued.
   * `source` is set when converting a quotation or creating a delivery challan from an invoice.
   */
  async function newDocument(input, organization, customer, source = null) {
    if (!source) organization = sellerRegistration(organization, input.gstRegistrationId);
    validateTax(input, organization);
    if (customer.organizationId !== organization.id)
      throw new HttpError(400, 'The customer belongs to a different organization.');
    if (['paid', 'partially_paid'].includes(input.status))
      throw new HttpError(
        400,
        'Record invoice payments in Payments; paid status is calculated from the payment ledger.',
      );
    if (!source && !isInvoiceRecipient(customer))
      throw new HttpError(400, 'Select an active customer, vendor or B2B buyer from this organization.');
    if (!source) await validateCatalogReferences(input);
    const businessProductSnapshot = source
      ? (source.businessProductSnapshot ?? null)
      : await selectBusinessProduct(organization, input.businessProductId);
    const formatSnapshot = source
      ? (source.formatSnapshot ?? getDocumentFormat(source))
      : await selectFormat(organization.id, input.formatId);
    const timestamp = now().toISOString();
    const totals =
      source && input.kind === 'invoice'
        ? source.totals
        : calculateTotals(input.items, input.discountPercent, organization.stateCode !== input.placeOfSupply);
    validateInstallmentTotal(input.installmentPlan, totals.total);
    const document = {
      ...input,
      id: randomUUID(),
      number: await nextNumber(await getOrganization(organization.id), input.kind, input.issueDate),
      createdAt: timestamp,
      updatedAt: timestamp,
      version: 1,
      customerSnapshot: customer,
      organizationSnapshot: organization,
      totals,
      sourceQuotationId: source?.kind === 'quotation' ? source.id : null,
      convertedInvoiceId: null,
      formatId: formatSnapshot.id,
      formatSnapshot,
      sourceDocumentId: source?.id ?? null,
      deliveryNoteId: null,
      amountPaid: 0,
      balanceDue: input.kind === 'invoice' ? totals.total : 0,
      finalizedAt: null,
      businessProductId: source?.businessProductId ?? input.businessProductId,
      businessProductSnapshot,
    };
    await db.models.documents.insert(document);
    await emailIssuedDocument(document);
    if (document.installmentPlan) await recordPlanChange(document.id, null, document.installmentPlan);
    return document;
  }
  // Queues the automatic email for an issued (status "sent") invoice/quotation/proforma.
  async function emailIssuedDocument(document) {
    if (document.status !== 'sent' || document.kind === 'delivery_note') return;
    await context.mailer.enqueueInvoice(document, {
      eventKey: `invoice-issued:${document.id}`,
      automatic: true,
      resolvePaymentLink:
        document.kind === 'invoice' &&
        (await context.online.getStatus(document.organizationId, document.id)).configured,
    });
  }
  /**
   * Records a receipt against an invoice. The same requestId with the same details returns the
   * existing receipt (safe retry); different details -> 409. Overpayment is rejected.
   * `providerPaidAt` is set only for payments verified by Razorpay/Cashfree.
   */
  async function recordPayment(documentId, rawInput, { providerPaidAt } = {}) {
    // Normalize both sides of a retry comparison, including harmless JS decimal noise.
    const input = paymentSchema.parse(rawInput);
    const document = await getDocument(documentId);
    if (document.kind !== 'invoice')
      throw new HttpError(400, 'Payments can be recorded only against invoices.');
    const previous = await db.models.payments.findByRequest(document.id, input.requestId);
    if (previous) {
      const saved = previous;
      const comparable = paymentSchema.parse(saved);
      if (JSON.stringify(comparable) !== JSON.stringify(input))
        throw new HttpError(
          409,
          'This payment request ID was already used with different details. Review the existing payment before retrying.',
        );
      return {
        created: false,
        payment: saved,
        details: await paymentDetails(document.id),
      };
    }
    // Verified gateways supply a trusted instant; manual receipts use today's
    // Indian date. An already saved request above remains retryable unchanged.
    if (!providerPaidAt && input.paidOn > indiaBusinessDate(now()))
      throw new HttpError(400, 'Choose the date you received this payment, up to today (India time).');
    if (document.status === 'cancelled')
      throw new HttpError(409, 'Payments cannot be recorded against a cancelled invoice.');
    if (document.finalizedAt) throw new HttpError(409, 'This invoice is already finalized and fully paid.');
    const paise = wholePaise(input.amount);
    const outstanding = Math.round(document.totals.total * 100) - (await activePaidPaise(document.id));
    if (paise > outstanding) throw new HttpError(409, 'Payment exceeds the outstanding balance.');
    const payment = {
      ...input,
      amount: paise / 100,
      id: randomUUID(),
      documentId: document.id,
      organizationId: document.organizationId,
      ...(providerPaidAt ? { providerPaidAt } : {}),
      createdAt: now().toISOString(),
      voidedAt: null,
      voidReason: '',
    };
    await db.models.payments.insert(payment);
    await addEvent(
      document.id,
      'payment_recorded',
      `Payment of INR ${payment.amount.toFixed(2)} recorded by ${payment.method.replaceAll('_', ' ')}${payment.reference ? `; reference ${payment.reference}` : ''}.`,
    );
    await updatePaymentBalance(document, input.finalizeWhenPaid);
    return {
      created: true,
      payment,
      details: await paymentDetails(document.id),
    };
  }
  return {
    getOrganization,
    getCustomer,
    getDocument,
    getPayment,
    activePaidPaise,
    addEvent,
    paymentDetails,
    updatePaymentBalance,
    getCatalogItem,
    getBusinessProduct,
    selectBusinessProduct,
    assertProductCodeAvailable,
    validateInstallmentTotal,
    recordPlanChange,
    getFormat,
    selectFormat,
    assertSkuAvailable,
    validateCatalogReferences,
    saveFormat,
    scopedOrganization,
    assertPrefixesAvailable,
    validateTax,
    nextNumber,
    saveDocument,
    sellerRegistration,
    newDocument,
    emailIssuedDocument,
    recordPayment,
    fiscalYear,
  };
}
