/**
 * Businesses API (/api/organizations). Staff see only their assigned businesses;
 * creating or editing a business is administrator-only. A new business gets the default
 * invoice formats (models/workspace-seed.js) and its document number prefixes must be unique.
 */

import { randomUUID } from 'node:crypto';
import { isIndependentBusiness, organizationGateway } from '../../../shared/business-identity.js';
import { billingProfileFor } from '../../../shared/billing-presets.js';
import { transaction } from '../../config/database.js';
import { seedDefaultFormat } from '../../models/workspace-seed.js';
import { organizationSchema } from '../../services/validation/validation.js';
export function createController(context) {
  const { db, auth, online, now, getOrganization, assertPrefixesAvailable } = context;
  return {
    // GET /api/organizations
    list: async (_req, res) => {
      const user = res.locals.user;
      const rows = await db.models.organizations.list();
      res.json(
        auth && user?.role !== 'admin' ? rows.filter((org) => user?.organizationIds.includes(org.id)) : rows,
      );
    },
    // POST /api/organizations
    create: async (req, res) => {
      const input = organizationSchema.parse(req.body);
      const organization = await transaction(db, async () => {
        await assertPrefixesAvailable(input);
        const base = {
          ...input,
          id: randomUUID(),
        };
        const profile = billingProfileFor(base);
        const result = {
          ...base,
          billingProfile: profile,
          enableProductSelection: input.enableProductSelection ?? profile === 'ecosystem',
        };
        await db.models.organizations.insert(result);
        await seedDefaultFormat(db, result, now().toISOString());
        return result;
      });
      res.status(201).json(organization);
    },
    // PUT /api/organizations/:id
    update: async (req, res) => {
      const input = organizationSchema.parse(req.body);
      const organization = await transaction(db, async () => {
        const current = await getOrganization(req.params.id);
        await assertPrefixesAvailable(input, current.id);
        const result = {
          ...current,
          ...input,
          id: current.id,
        };
        if (
          organizationGateway(result) !== organizationGateway(current) ||
          isIndependentBusiness(result) !== isIndependentBusiness(current)
        ) {
          const rows = await db.models.documents.list(current.id);
          for (const row of rows) await online.assertManualChangesAllowed(row.id);
        }
        if (current.id === 'shri-sarraf') result.businessType = 'independent';
        await db.models.organizations.save(result);
        return result;
      });
      res.json(organization);
    },
  };
}
