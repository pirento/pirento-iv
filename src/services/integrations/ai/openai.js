/**
 * OpenAI assistant for the finance dashboard. The administrator saves the API key and model in
 * Payments & email → AI assistant; the key is stored encrypted with TWO_STEP_KEY (AES-256-GCM) and
 * is never sent back to the browser. Used to read bank statements in any layout (PDF, scanned or
 * unusual CSV/Excel) and to suggest matches the exact-amount matcher leaves open (TDS cuts,
 * bank charges, one transfer for several invoices).
 */

import { createTwoStepVault } from '../../auth/two-step.js';
import { readProviderJson } from '../provider-http.js';
import { statementDate } from '../../../../shared/bank-match.js';
import { HttpError } from '../../../middleware/errors.js';

export const DEFAULT_AI_MODEL = 'gpt-4o-mini';
const SETTINGS = { _id: 'openai-settings' };

const STATEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'narration', 'reference', 'credit', 'debit'],
        properties: {
          date: { type: 'string', description: 'Transaction date as YYYY-MM-DD' },
          narration: { type: 'string' },
          reference: { type: 'string', description: 'UTR, cheque or reference number, else empty' },
          credit: { type: 'number', description: 'Money in (deposit), else 0' },
          debit: { type: 'number', description: 'Money out (withdrawal), else 0' },
        },
      },
    },
  },
};
const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'books', 'reason'],
        properties: {
          line: { type: 'integer', description: 'Index of the bank line' },
          books: { type: 'array', items: { type: 'integer' }, description: 'Indexes of the book entries' },
          reason: { type: 'string', description: 'One short sentence' },
        },
      },
    },
  },
};

const money = (value) => Math.round(Math.max(0, Number(value) || 0) * 100) / 100;

export function createAiAssistant({ db, environment, production, fetcher = fetch }) {
  const vault = createTwoStepVault(environment, production);
  const store = () => db.collection('workspace_metadata');

  async function settings() {
    const saved = await store().findOne(SETTINGS, db.options());
    const apiKey = saved?.apiKey ? vault.open(saved.apiKey) : null;
    return { apiKey, model: saved?.model || DEFAULT_AI_MODEL, keyEnd: saved?.keyEnd ?? '' };
  }

  /** What the pages may show: never the key itself. */
  async function status() {
    const { apiKey, model, keyEnd } = await settings();
    return { configured: Boolean(apiKey), model, keyEnd: apiKey ? keyEnd : '' };
  }

  /** Saves the model, and the key when one is given; { removeKey: true } deletes the key. */
  async function save({ apiKey, model, removeKey }) {
    const update = { model: model || DEFAULT_AI_MODEL, updatedAt: new Date() };
    if (apiKey) Object.assign(update, { apiKey: vault.seal(apiKey), keyEnd: apiKey.slice(-4) });
    await store().updateOne(
      SETTINGS,
      removeKey ? { $set: update, $unset: { apiKey: '', keyEnd: '' } } : { $set: update },
      { upsert: true, ...db.options() },
    );
    return status();
  }

  // One structured (JSON schema) answer from the Responses API.
  async function ask(name, schema, instructions, content) {
    const { apiKey, model } = await settings();
    if (!apiKey)
      throw new HttpError(409, 'Ask an administrator to add the OpenAI API key in Payments & email.');
    let response;
    try {
      response = await fetcher('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          instructions,
          input: [{ role: 'user', content }],
          text: { format: { type: 'json_schema', name, schema, strict: true } },
        }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new HttpError(502, 'OpenAI could not be reached. Try again in a minute.');
    }
    const body = await readProviderJson(response, 4 * 1024 * 1024).catch(() => null);
    if (!response.ok)
      throw new HttpError(502, `OpenAI refused the request: ${body?.error?.message ?? response.status}`);
    const text = body?.output
      ?.flatMap((item) => item.content ?? [])
      .find((part) => part.type === 'output_text')?.text;
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, 'OpenAI returned an unreadable answer. Try again.');
    }
  }

  /** Statement lines { date, narration, reference, credit, debit } from a file or text. */
  async function readStatement({ text, file }) {
    const content = file
      ? [{ type: 'input_file', filename: file.name, file_data: file.data }]
      : [{ type: 'input_text', text }];
    content.push({
      type: 'input_text',
      text: 'List every transaction in this bank statement, oldest first. Skip opening/closing balance rows.',
    });
    const answer = await ask(
      'bank_statement',
      STATEMENT_SCHEMA,
      'You read Indian bank statements exactly. Never invent rows. Amounts are rupees without commas.',
      content,
    );
    return (answer.lines ?? [])
      .map((line) => ({
        date: statementDate(line.date),
        narration: String(line.narration ?? '').slice(0, 500),
        reference: String(line.reference ?? '').slice(0, 100),
        credit: money(line.credit),
        debit: money(line.debit),
      }))
      .filter((line) => line.date && (line.credit || line.debit));
  }

  /** Suggested matches for bank lines and book entries the exact matcher left open. */
  async function suggestMatches({ lines, books }) {
    const answer = await ask(
      'match_suggestions',
      MATCH_SCHEMA,
      'You reconcile Indian bank statements with accounting books. Suggest a match only when it is likely: ' +
        'a credit can be a receipt less TDS (1%, 2% or 10%) or bank charges, or one transfer for several receipts ' +
        'of the same party; a debit can pay one or more bills. Use the narration, party names and dates.',
      [{ type: 'input_text', text: JSON.stringify({ bankLines: lines, bookEntries: books }) }],
    );
    return (answer.suggestions ?? []).filter(
      (row) =>
        Number.isInteger(row.line) &&
        row.line >= 0 &&
        row.line < lines.length &&
        row.books.length &&
        row.books.every((index) => Number.isInteger(index) && index >= 0 && index < books.length),
    );
  }

  return { status, save, readStatement, suggestMatches };
}
