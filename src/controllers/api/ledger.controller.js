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
    getLedger: async (req, res) =>
      res.json(await ledger.list(res.locals.user, req.query.organizationId, req.query)),
    getLedgerCustomer: async (req, res) =>
      res.json(
        await ledger.statement(res.locals.user, req.query.organizationId, req.params.customerId, req.query),
      ),
    exportLedger: async (req, res) =>
      download(await ledger.exportCustomers(res.locals.user, req.query.organizationId, req.query), res),
    exportLedgerCustomer: async (req, res) =>
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
