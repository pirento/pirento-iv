import { createController as webhooks } from './webhooks.controller.js';
import { createController as health } from './health.controller.js';
import { createController as backups } from './backups.controller.js';
import { createController as integrations } from './integrations.controller.js';
import { createController as documents } from './documents.controller.js';
import { createController as messages } from './messages.controller.js';
import { createController as workspace_settings } from './workspace-settings.controller.js';
import { createController as organizations } from './organizations.controller.js';
import { createController as business_products } from './business-products.controller.js';
import { createController as catalog } from './catalog.controller.js';
import { createController as formats } from './formats.controller.js';
import { createController as customers } from './customers.controller.js';
import { createController as payments } from './payments.controller.js';
import { createController as gst } from './gst.controller.js';
import { createController as ledger } from './ledger.controller.js';
import { createController as reminders } from './reminders.controller.js';
import { createController as recurring } from './recurring-invoices.controller.js';
export function createApiControllers(context) {
  return {
    webhooks: webhooks(context),
    health: health(context),
    backups: backups(context),
    integrations: integrations(context),
    documents: documents(context),
    messages: messages(context),
    'workspace-settings': workspace_settings(context),
    organizations: organizations(context),
    'business-products': business_products(context),
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
