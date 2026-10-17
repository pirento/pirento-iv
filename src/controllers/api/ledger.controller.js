/**
 * Customer ledger API (/api/ledger): balances per customer, one customer's statement,
 * and CSV exports of both. Calculations live in src/services/ledger/.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function createController({ ledger }) {
  async function download(result, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(result.filename);
    res.type('text/csv; charset=utf-8');
    await pipeline(Readable.from(result.lines), res);
  }
  return {
    // GET /api/ledger
    list: async (req, res) =>
      res.json(await ledger.list(res.locals.user, req.query.organizationId, req.query)),
    // GET /api/ledger/:customerId
    statement: async (req, res) =>
      res.json(
        await ledger.statement(res.locals.user, req.query.organizationId, req.params.customerId, req.query),
      ),
    // GET /api/ledger/export
    exportBalances: async (req, res) =>
      download(await ledger.exportCustomers(res.locals.user, req.query.organizationId, req.query), res),
    // GET /api/ledger/:customerId/export
    exportStatement: async (req, res) =>
      download(
        await ledger.exportStatement(
          res.locals.user,
          req.query.organizationId,
          req.params.customerId,
          req.query,
        ),
        res,
      ),
  };
}
