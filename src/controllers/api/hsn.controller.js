/**
 * GST for an HSN/SAC code (GET /api/hsn-gst?organizationId=&hsn=&description=), for the invoice editor.
 * In order: the business's own saved item with that code, the code on its latest issued invoice,
 * then the AI assistant when an administrator has set it up. Returns { rate, source, note } or
 * { rate: null } when nothing is known.
 */

import { z } from 'zod';

const querySchema = z.object({
  organizationId: z.string().min(1).max(100),
  hsn: z.string().regex(/^\d{4}(\d{2}){0,2}$/, 'HSN / SAC has 4, 6 or 8 digits.'),
  description: z.string().max(200).default(''),
});

export function createController({ db, ai }) {
  return {
    // GET /api/hsn-gst
    lookup: async (req, res) => {
      const { organizationId, hsn, description } = querySchema.parse(req.query);
      const saved = await db
        .collection('catalog')
        .findOne(
          { organizationId, hsn, active: true },
          { ...db.options(), projection: { _id: 0, name: 1, gstRate: 1 } },
        );
      if (saved)
        return res.json({
          rate: saved.gstRate,
          source: 'catalog',
          note: `from your saved item “${saved.name}”`,
        });
      const [issued] = await db
        .collection('documents')
        .find(
          { organizationId, kind: 'invoice', status: { $nin: ['draft', 'cancelled'] }, 'items.hsn': hsn },
          { ...db.options(), projection: { _id: 0, number: 1, items: 1 } },
        )
        .sort({ issueDate: -1, _id: -1 })
        .limit(1)
        .toArray();
      const used = issued?.items.find((item) => item.hsn === hsn);
      if (used)
        return res.json({
          rate: used.gstRate,
          source: 'history',
          note: `as on your invoice ${issued.number}`,
        });
      const suggested = ai ? await ai.suggestGst({ hsn, description }).catch(() => null) : null;
      if (suggested)
        return res.json({
          rate: suggested.rate,
          source: 'ai',
          note: `AI suggestion for ${hsn}${suggested.covers ? ` (${suggested.covers})` : ''}; please check before issuing`,
        });
      res.json({ rate: null });
    },
  };
}
