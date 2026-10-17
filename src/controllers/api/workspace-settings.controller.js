/** Workspace settings API (/api/workspace-settings): company name and dashboard logo. */

import { workspaceSettingsSchema } from '../../services/validation/validation.js';
export function createController(context) {
  const { db } = context;
  return {
    // GET /api/workspace-settings
    get: async (_req, res) => {
      res.json(await db.models.settings.get());
    },
    // PUT /api/workspace-settings
    update: async (req, res) => {
      const settings = workspaceSettingsSchema.parse(req.body);
      await db.models.settings.save(settings);
      res.json(settings);
    },
  };
}
