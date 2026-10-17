/** Expenses API (/api/expenses): purchase bills and other business expenses with their GST (input tax credit). */

import { randomUUID } from 'node:crypto';
import { transaction } from '../../config/database.js';
import { transactionForRecord } from '../../services/transaction-ownership.js';
import { expenseSchema } from '../../services/validation/validation.js';
import { expenseAmounts, expenseTotals, readExpenseMonth } from '../../services/expenses/expenses.js';
import { monthRange } from '../../services/pages/gstr1.js';
import { HttpError } from '../../middleware/errors.js';
import { indiaBusinessDate } from '../../../shared/business-date.js';

export function createController(context) {
  const { db, now, getOrganization, getCustomer, scopedOrganization } = context;
  async function getExpense(id) {
    const row = await db.models.expenses.findById(id);
    if (!row) throw new HttpError(404, 'Expense not found.');
    return row;
  }
  // A chosen vendor must be a contact of the same business; its saved name and GSTIN are used.
  async function build(input) {
    const vendor = input.vendorId ? await getCustomer(input.vendorId) : null;
    if (vendor && vendor.organizationId !== input.organizationId)
      throw new HttpError(400, 'Choose a vendor from this business.');
    return {
      ...input,
      ...(vendor ? { vendorName: vendor.name, vendorGstin: vendor.gstin ?? '' } : {}),
      ...expenseAmounts(input),
    };
  }
  return {
    // GET /api/expenses?organizationId=...&month=YYYY-MM
    list: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      const month = readExpenseMonth(req.query, indiaBusinessDate(now()));
      const expenses = await db.models.expenses.listBetween(organization.id, monthRange(month));
      res.json({ month, expenses, totals: expenseTotals(expenses) });
    },
    // POST /api/expenses
    create: async (req, res) => {
      const input = expenseSchema.parse(req.body);
      const expense = await transaction(
        db,
        async () => {
          await getOrganization(input.organizationId);
          const timestamp = now().toISOString();
          const record = {
            ...(await build(input)),
            id: randomUUID(),
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await db.models.expenses.insert(record);
          return record;
        },
        { organizationId: input.organizationId },
      );
      res.status(201).json(expense);
    },
    // PUT /api/expenses/:id
    update: async (req, res) => {
      const input = expenseSchema.parse(req.body);
      const expense = await transactionForRecord(
        db,
        () => getExpense(req.params.id),
        async (current) => {
          if (current.organizationId !== input.organizationId)
            throw new HttpError(400, 'An expense cannot be moved between organizations.');
          const record = { ...current, ...(await build(input)), updatedAt: now().toISOString() };
          await db.models.expenses.save(record);
          return record;
        },
      );
      res.json(expense);
    },
    // DELETE /api/expenses/:id
    remove: async (req, res) => {
      await transactionForRecord(
        db,
        () => getExpense(req.params.id),
        () => db.models.expenses.remove(req.params.id),
      );
      res.json({ ok: true });
    },
  };
}
