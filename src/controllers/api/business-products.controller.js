import { randomUUID } from 'node:crypto';
import { transaction } from '../../config/database.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { businessProductSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
export function createController(context) {
  const { db, now, getOrganization, getBusinessProduct, assertProductCodeAvailable, scopedOrganization } =
    context;
  return {
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      res.json(await db.models.businessProducts.list(organization.id));
    },
    create: async (req, res) => {
      const input = businessProductSchema.parse(req.body);
      const product = await transaction(
        db,
        async () => {
          await getOrganization(input.organizationId);
          await assertProductCodeAvailable(input);
          const timestamp = now().toISOString();
          const result = {
            ...input,
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await db.models.businessProducts.insert(result);
          return result;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(product);
    },
    update: async (req, res) => {
      const input = businessProductSchema.parse(req.body);
      const product = await transactionForRecord(
        db,
        () => getBusinessProduct(req.params.id),
        async (current) => {
          if (current.organizationId !== input.organizationId)
            throw new HttpError(400, 'Business products cannot be moved between organizations.');
          await assertProductCodeAvailable(input, current.id);
          const result = {
            ...current,
            ...input,
            updatedAt: now().toISOString(),
          };
          await db.models.businessProducts.save(result);
          return result;
        },
      );
      res.json(product);
    },
  };
}
