/**
 * Letterhead API (/api/letterheads/:organizationId): each business's letterhead image and the blank
 * area where documents are written on it. Administrators only. Documents copy it when saved with
 * "Print on letterhead", so later changes never alter a saved document.
 */

import { letterheadSchema } from '../../services/validation/validation.js';
import { HttpError } from '../../middleware/errors.js';

export function createController(context) {
  const { db, now, getOrganization } = context;
  const adminOnly = (res) => {
    // Administrators, or a Business owner login for its own business (the access guard checks the id).
    const user = res.locals.user;
    if (user && user.role !== 'admin' && user.permission !== 'owner')
      throw new HttpError(403, 'Only an administrator or the business owner can change the letterhead.');
  };
  return {
    // PUT /api/letterheads/:organizationId
    save: async (req, res) => {
      adminOnly(res);
      const input = letterheadSchema.parse(req.body);
      const organization = await getOrganization(req.params.organizationId);
      await db.models.letterheads.save({
        id: organization.id,
        organizationId: organization.id,
        ...input,
        updatedAt: now().toISOString(),
      });
      res.json({ ok: true });
    },
    // DELETE /api/letterheads/:organizationId
    remove: async (req, res) => {
      adminOnly(res);
      const organization = await getOrganization(req.params.organizationId);
      await db.models.letterheads.remove(organization.id);
      res.json({ ok: true });
    },
  };
}
