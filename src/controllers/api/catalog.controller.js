import { randomUUID } from 'node:crypto';
import { transaction } from '../../config/database.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { catalogSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';
import { directoryReaders } from './directory-read.js';
export function createController(context) {
  const {
    db,
    now,
    getOrganization,
    getCatalogItem,
    selectBusinessProduct,
    assertSkuAvailable,
    scopedOrganization,
  } = context;
  return {
    ...directoryReaders(context, 'catalog'),
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      res.json(await db.models.catalog.list(organization.id));
    },
    create: async (req, res) => {
      const input = catalogSchema.parse(req.body);
      const item = await transaction(
        db,
        async () => {
          const organization = await getOrganization(input.organizationId);
          await selectBusinessProduct(organization, input.businessProductId, undefined, false);
          await assertSkuAvailable(input);
          const timestamp = now().toISOString();
          const result = {
            ...input,
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await db.models.catalog.insert(result);
          return result;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(item);
    },
    update: async (req, res) => {
      const input = catalogSchema.parse(req.body);
      const item = await transactionForRecord(
        db,
        () => getCatalogItem(req.params.id),
        async (current) => {
          if (input.organizationId !== current.organizationId)
            throw new HttpError(400, 'A product or service cannot be moved between organizations.');
          await selectBusinessProduct(
            await getOrganization(current.organizationId),
            input.businessProductId,
            current.businessProductId,
            false,
          );
          await assertSkuAvailable(input, current.id);
          const result = {
            ...current,
            ...input,
            updatedAt: now().toISOString(),
          };
          await db.models.catalog.save(result);
          return result;
        },
      );
      res.json(item);
    },
  };
}
