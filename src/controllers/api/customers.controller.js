/**
 * Contacts API (/api/customers): customers, B2B buyers and vendors of one business.
 * Search and CSV export come from directory-read.js. A contact used by a saved document
 * cannot be deleted (archive it instead).
 */

import { randomUUID } from 'node:crypto';
import { customerSchema } from '../../services/validation/validation.js';
import { normalizeContact } from '../../services/validation/contacts.js';
import { HttpError } from '../../middleware/errors.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { directoryReaders } from './directory-read.js';
export function createController(context) {
  const { db, getOrganization, getCustomer, scopedOrganization } = context;
  return {
    ...directoryReaders(context, 'customers'),
    // GET /api/customers
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      res.json((await db.models.customers.list(organization.id)).map((row) => normalizeContact(row)));
    },
    // POST /api/customers
    create: async (req, res) => {
      const input = customerSchema.parse(req.body);
      const customer = await db.transaction(
        async () => {
          await getOrganization(input.organizationId);
          const saved = { ...input, id: randomUUID() };
          await db.models.customers.insert(saved);
          return saved;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(customer);
    },
    // PUT /api/customers/:id
    update: async (req, res) => {
      const input = customerSchema.parse(req.body);
      const customer = await transactionForRecord(
        db,
        () => getCustomer(req.params.id),
        async (current) => {
          if (input.organizationId !== current.organizationId)
            throw new HttpError(400, 'A customer cannot be moved between organizations.');
          const saved = { ...input, id: current.id };
          await db.models.customers.save(saved);
          return saved;
        },
      );
      res.json(customer);
    },
    // DELETE /api/customers/:id
    remove: async (req, res) => {
      await transactionForRecord(
        db,
        () => getCustomer(req.params.id),
        async () => {
          if (await db.models.documents.findByCustomer(req.params.id))
            throw new HttpError(409, 'This customer is used by a saved document and cannot be deleted.');
          await db.models.customers.remove(req.params.id);
        },
      );
      res.json({
        ok: true,
      });
    },
  };
}
