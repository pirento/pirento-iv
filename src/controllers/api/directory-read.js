/**
 * Shared search + CSV export handlers for the two large directories: contacts and catalog.
 * Spread into customers.controller.js and catalog.controller.js.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDirectoryQueries } from '../../models/directory-queries.js';
import { directoryCsv, readDirectoryFilters } from '../../services/pages/directory-list.js';

/** Additive read endpoints keep the original array-shaped collection API compatible. */
/** Returns { lookup, export } handlers for kind 'customers' or 'catalog'. */
export function directoryReaders(context, kind) {
  const { db, scopedOrganization } = context;
  const queries = createDirectoryQueries(db);
  return {
    // GET /api/customers/lookup  and  GET /api/catalog/lookup  (paged search for the invoice editor)
    lookup: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      const filters = readDirectoryFilters(kind, req.query, { lookup: true });
      res.json(await queries.lookup(kind, organization.id, filters));
    },
    // GET /api/customers/export  and  GET /api/catalog/export  (CSV of every matching record)
    export: async (req, res) => {
      const organization = await scopedOrganization(req.query.organizationId);
      const filters = readDirectoryFilters(kind, req.query);
      const cursor = await queries.exportCursor(kind, organization.id, filters);
      const products = kind === 'catalog' ? await db.models.businessProducts.list(organization.id) : [];
      res.attachment(
        `${organization.name.replace(/[^a-z0-9]+/gi, '-')}-${kind === 'customers' ? 'contacts' : kind}.csv`,
      );
      res.type('text/csv; charset=utf-8');
      await pipeline(Readable.from(directoryCsv(kind, cursor, products)), res);
    },
  };
}
