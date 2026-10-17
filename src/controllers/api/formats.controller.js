/**
 * Invoice formats API (/api/formats): layout, colours, columns and paper settings per business.
 * A business always keeps at least one format and exactly one default format.
 */

import { randomUUID } from 'node:crypto';
import { transaction } from '../../config/database.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { formatSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  const { db, now, getOrganization, getFormat, saveFormat, scopedOrganization } = context;
  return {
    // GET /api/formats
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      res.json(await db.models.formats.list(organization.id));
    },
    // POST /api/formats
    create: async (req, res) => {
      const input = formatSchema.parse(req.body);
      const format = await transaction(
        db,
        async () => {
          await getOrganization(input.organizationId);
          const timestamp = now().toISOString();
          const result = {
            ...input,
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await saveFormat(result);
          return result;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(format);
    },
    // PUT /api/formats/:id
    update: async (req, res) => {
      const input = formatSchema.parse(req.body);
      const format = await transactionForRecord(
        db,
        () => getFormat(req.params.id),
        async (current) => {
          if (input.organizationId !== current.organizationId)
            throw new HttpError(400, 'An invoice format cannot be moved between organizations.');
          if (current.isDefault && !input.isDefault)
            throw new HttpError(409, 'Set another format as default before removing this default.');
          const result = {
            ...current,
            ...input,
            updatedAt: now().toISOString(),
          };
          await saveFormat(result);
          return result;
        },
      );
      res.json(format);
    },
    // DELETE /api/formats/:id
    remove: async (req, res) => {
      await transactionForRecord(
        db,
        () => getFormat(req.params.id),
        async (current) => {
          const count = await db.models.formats.count(current.organizationId);
          if (count.count <= 1)
            throw new HttpError(409, 'Keep at least one invoice format for this organization.');
          if (current.isDefault)
            throw new HttpError(409, 'Set another format as default before deleting this format.');
          await db.models.formats.remove(current.id);
        },
      );
      res.json({
        ok: true,
      });
    },
  };
}
