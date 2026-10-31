/**
 * Creates every API controller with the shared service context built in src/services/backend.js.
 * Controller files follow the pattern <resource>.controller.js and export createController(context).
 */

import { createController as webhooks } from './webhooks.controller.js';
import { createController as health } from './health.controller.js';
import { createController as backups } from './backups.controller.js';
import { createController as integrations } from './integrations.controller.js';
import { createController as documents } from './documents.controller.js';
import { createController as messages } from './messages.controller.js';
import { createController as workspaceSettings } from './workspace-settings.controller.js';
import { createController as organizations } from './organizations.controller.js';
import { createController as businessProducts } from './business-products.controller.js';
import { createController as catalog } from './catalog.controller.js';
import { createController as formats } from './formats.controller.js';
import { createController as customers } from './customers.controller.js';
import { createController as payments } from './payments.controller.js';
import { createController as gst } from './gst.controller.js';
import { createController as ledger } from './ledger.controller.js';
import { createController as reminders } from './reminders.controller.js';
import { createController as recurring } from './recurring-invoices.controller.js';
import { createController as expenses } from './expenses.controller.js';
import { createController as creditNotes } from './credit-notes.controller.js';
import { createController as debitNotes } from './debit-notes.controller.js';
import { createController as stockAdjustments } from './stock-adjustments.controller.js';
import { createController as einvoice } from './einvoice.controller.js';
import { createController as letterheads } from './letterheads.controller.js';
import { createController as ai } from './ai.controller.js';
import { createController as integrationSettings } from './integration-settings.controller.js';

/** One controller object per API resource; route paths live in src/routes/api.js. */
export function createApiControllers(context) {
  return {
    webhooks: webhooks(context),
    health: health(context),
    backups: backups(context),
    integrations: integrations(context),
    documents: documents(context),
    messages: messages(context),
    workspaceSettings: workspaceSettings(context),
    organizations: organizations(context),
    businessProducts: businessProducts(context),
    expenses: expenses(context),
    creditNotes: creditNotes(context),
    debitNotes: debitNotes(context),
    stockAdjustments: stockAdjustments(context),
    einvoice: einvoice(context),
    letterheads: letterheads(context),
    ai: ai(context),
    integrationSettings: integrationSettings(context),
    catalog: catalog(context),
    formats: formats(context),
    customers: customers(context),
    payments: payments(context),
    gst: gst(context),
    ledger: ledger(context),
    reminders: reminders(context),
    recurring: recurring(context),
  };
}
