/**
 * AI assistant API: the OpenAI settings (administrators: /api/ai-settings) and the finance helpers
 * (administrators and Finance logins: /api/finance/ai/statement, /api/finance/ai/matches).
 */

import { z } from 'zod';
import { HttpError } from '../../middleware/errors.js';

const settingsSchema = z.object({
  apiKey: z.string().trim().max(300).regex(/^\S*$/, 'The API key cannot contain spaces.').optional(),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9.:_-]{2,80}$/, 'Enter an OpenAI model name, for example gpt-4o-mini.'),
  removeKey: z.boolean().optional(),
});
const statementSchema = z
  .object({
    text: z.string().max(300_000).optional(),
    // A PDF statement as a data URL (about 8 MB file at most).
    file: z
      .object({
        name: z.string().trim().min(1).max(200),
        data: z
          .string()
          .max(11_500_000)
          .regex(/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/, 'Choose a PDF statement.'),
      })
      .optional(),
  })
  .refine(
    (input) => Boolean(input.text?.trim()) !== Boolean(input.file),
    'Send the statement text or a PDF.',
  );
const line = z.object({
  date: z.string().max(10),
  narration: z.string().max(500),
  reference: z.string().max(100),
  credit: z.number().min(0),
  debit: z.number().min(0),
});
const book = z.object({
  date: z.string().max(10),
  amount: z.number(),
  reference: z.string().max(200),
  label: z.string().max(300),
  business: z.string().max(200),
  direction: z.enum(['credit', 'debit']),
});
const matchSchema = z.object({ lines: z.array(line).min(1).max(300), books: z.array(book).min(1).max(1000) });

export function createController({ ai }) {
  const admin = (res) => {
    if (res.locals.user && res.locals.user.role !== 'admin')
      throw new HttpError(403, 'Only an administrator can change the AI settings.');
  };
  const finance = (res) => {
    const user = res.locals.user;
    if (user && user.role !== 'admin' && user.permission !== 'accounts')
      throw new HttpError(403, 'The AI finance tools are for administrators and Finance logins.');
  };
  return {
    // GET /api/ai-settings
    status: async (_req, res) => {
      admin(res);
      res.json(await ai.status());
    },
    // PUT /api/ai-settings
    save: async (req, res) => {
      admin(res);
      res.json(await ai.save(settingsSchema.parse(req.body)));
    },
    // POST /api/finance/ai/statement
    statement: async (req, res) => {
      finance(res);
      res.json({ lines: await ai.readStatement(statementSchema.parse(req.body)) });
    },
    // POST /api/finance/ai/matches
    matches: async (req, res) => {
      finance(res);
      res.json({ suggestions: await ai.suggestMatches(matchSchema.parse(req.body)) });
    },
  };
}
