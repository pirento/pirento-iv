/**
 * E-invoice and e-way bill API for an issued invoice: download the files for the government's
 * offline tools, then save (or clear) the IRN, signed QR code and e-way bill number they return.
 */

import { transactionForRecord } from '../../services/transaction-ownership.js';
import { einvoiceSchema, ewayBillSchema, ewayTransportSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
import { einvoiceJson, einvoiceProblems, ewayBillJson } from '../../services/documents/einvoice.js';

export function createController(context) {
  const { db, now, getDocument, addEvent, saveDocument } = context;
  const filename = (doc, suffix) => `${doc.number.replace(/[^A-Za-z0-9-]+/g, '-')}-${suffix}.json`;
  // Saves one field ('einvoice' or 'ewayBill') on an issued invoice, or clears it with null.
  const setField = (req, field, value, message) =>
    transactionForRecord(
      db,
      () => getDocument(req.params.id),
      async (doc) => {
        if (doc.kind !== 'invoice' || ['draft', 'cancelled'].includes(doc.status))
          throw new HttpError(409, 'Only an issued invoice can carry an IRN or e-way bill.');
        const updated = { ...doc, [field]: value, updatedAt: now().toISOString() };
        await saveDocument(updated);
        await addEvent(doc.id, `${field}_${value ? 'saved' : 'cleared'}`, message);
        return updated;
      },
    );
  return {
    // GET /api/documents/:id/einvoice-file
    einvoiceFile: async (req, res) => {
      const doc = await getDocument(req.params.id);
      const problems = einvoiceProblems(doc);
      if (problems.length) throw new HttpError(409, problems.join(' '));
      res.attachment(filename(doc, 'einvoice')).json(einvoiceJson(doc));
    },
    // GET /api/documents/:id/eway-bill-file?mode=road&distanceKm=120&vehicleNo=...
    ewayBillFile: async (req, res) => {
      const transport = ewayTransportSchema.parse(req.query);
      const doc = await getDocument(req.params.id);
      const problems = einvoiceProblems(doc, { ewayBill: true });
      if (problems.length) throw new HttpError(409, problems.join(' '));
      res.attachment(filename(doc, 'eway-bill')).json(ewayBillJson(doc, transport));
    },
    // PUT /api/documents/:id/einvoice
    saveEinvoice: async (req, res) => {
      const input = einvoiceSchema.parse(req.body);
      res.json(await setField(req, 'einvoice', input, `E-invoice IRN ${input.irn} saved.`));
    },
    // DELETE /api/documents/:id/einvoice
    clearEinvoice: async (req, res) => {
      res.json(await setField(req, 'einvoice', null, 'E-invoice IRN removed.'));
    },
    // PUT /api/documents/:id/eway-bill
    saveEwayBill: async (req, res) => {
      const input = ewayBillSchema.parse(req.body);
      res.json(await setField(req, 'ewayBill', input, `E-way bill ${input.number} saved.`));
    },
    // DELETE /api/documents/:id/eway-bill
    clearEwayBill: async (req, res) => {
      res.json(await setField(req, 'ewayBill', null, 'E-way bill removed.'));
    },
  };
}
