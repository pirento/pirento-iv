import { workspaceSettingsSchema } from '../../services/validation/validation.js';
export function createController(context) {
  const { db } = context;
  return {
    get: async (_req, res) => {
      res.json(await db.models.settings.get());
    },
    update: async (req, res) => {
      const settings = workspaceSettingsSchema.parse(req.body);
      await db.models.settings.save(settings);
      res.json(settings);
    },
  };
}
