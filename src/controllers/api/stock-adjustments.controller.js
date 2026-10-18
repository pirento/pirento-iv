/** Stock API (/api/stock-adjustments): stock added to or removed from a catalog product by hand. */

import { randomUUID } from 'node:crypto';
import { transaction } from '../../config/database.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { stockAdjustmentSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';

export function createController(context) {
  const { db, now, getCatalogItem } = context;
  return {
    // POST /api/stock-adjustments
    create: async (req, res) => {
      const input = stockAdjustmentSchema.parse(req.body);
      const adjustment = await transaction(
        db,
        async () => {
          const product = await getCatalogItem(input.catalogItemId);
          if (product.organizationId !== input.organizationId || product.type !== 'product')
            throw new HttpError(400, 'Choose a product from this business.');
          const record = { ...input, id: randomUUID(), createdAt: now().toISOString() };
          await db.models.stockAdjustments.insert(record);
          return record;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(adjustment);
    },
    // DELETE /api/stock-adjustments/:id
    remove: async (req, res) => {
      await transactionForRecord(
        db,
        async () => {
          const row = await db.models.stockAdjustments.findById(req.params.id);
          if (!row) throw new HttpError(404, 'Stock entry not found.');
          return row;
        },
        () => db.models.stockAdjustments.remove(req.params.id),
      );
      res.json({ ok: true });
    },
  };
}
