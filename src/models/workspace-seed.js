/**
 * First-run data: the starting businesses, their default invoice formats (15 presets),
 * workspace settings and the default business products. Never overwrites later user edits.
 */

import { COMPANY_NAME } from '../../shared/types.js';
import { presetFormatsFor } from '../../shared/template-presets.js';
import { billingProfileFor, ECOSYSTEM_PRODUCT_NAMES } from '../../shared/billing-presets.js';

/** Adds any missing preset invoice formats for a business and makes sure one is the default. */
export async function seedDefaultFormat(database, organization, timestamp = new Date().toISOString()) {
  const formats = await database.models.formats.list(organization.id);
  let defaultFormat = formats.find((format) => format.isDefault);
  for (const preset of presetFormatsFor(organization, timestamp)) {
    if (formats.some((format) => format.presetKey === preset.presetKey)) continue;
    const original =
      preset.presetKey === 'standard' &&
      formats.find((format) => format.id === `${organization.id}-standard` && !format.presetKey);
    if (original) {
      await database.models.formats.save({ ...original, presetKey: 'standard' });
      continue;
    }
    let id = preset.id,
      suffix = 1;
    while (await database.models.formats.findById(id)) id = `${preset.id}-${++suffix}`;
    const format = { ...preset, id, isDefault: !defaultFormat };
    await database.models.formats.save(format);
    formats.push(format);
    if (format.isDefault) defaultFormat = format;
  }
  if (!defaultFormat && formats.length) {
    defaultFormat = formats.find((format) => format.presetKey === 'standard') ?? formats[0];
    defaultFormat = { ...defaultFormat, isDefault: true };
    await database.models.formats.save(defaultFormat);
  }
  return defaultFormat;
}

/** Install the starting businesses once; never replace subsequent user edits. */
export async function initializeWorkspace(database) {
  await database.transaction(async () => {
    if (await database.collection('workspace_metadata').findOne({ _id: 'schema' }, database.options()))
      return;
    const brands = [
      ['pipeline2-legal', 'Pirento legal', 'P2LI', 'P2LQ', '#587bcb'],
      ['pipeline2-ecosystem', 'Pirento ecosystem', 'P2EI', 'P2EQ', '#8265e5'],
      ['at-facilities', 'AT Facility', 'ATFI', 'ATFQ', '#17816e'],
      ['at-elevators', 'A T Elevator', 'ATEI', 'ATEQ', '#d39347'],
      ['ingenio-space', 'INZARIO SPACE', 'INSI', 'INSQ', '#a261ae'],
      ['shri-sarraf', 'Shri Sarraf', 'SSRI', 'SSRQ', '#ad852b'],
    ];
    if ((await database.models.organizations.list()).length === 0) {
      for (const [id, name, invoicePrefix, quotationPrefix, accentColor] of brands) {
        const organization = {
          id,
          name,
          legalName: id === 'shri-sarraf' ? 'Shri Sarraf' : COMPANY_NAME,
          businessType: id === 'shri-sarraf' ? 'independent' : 'division',
          paymentGateway: id === 'shri-sarraf' ? 'cashfree' : 'razorpay',
          supportEmail: id === 'shri-sarraf' ? 'support@shrisarraf.com' : 'support@pirento.com',
          gstRegistrations: [],
          invoicePrefix,
          quotationPrefix,
          accentColor,
          gstin: '',
          email: '',
          phone: '',
          address: '',
          stateCode: '',
          logoUrl: '',
          bankName: '',
          accountName: '',
          accountNumber: '',
          ifsc: '',
          terms: '',
          signature: '',
          template: 'modern',
        };
        organization.billingProfile = billingProfileFor(organization);
        organization.enableProductSelection = organization.billingProfile === 'ecosystem';
        await database.models.organizations.insert(organization);
      }
    }
    for (const organization of await database.models.organizations.list())
      await seedDefaultFormat(database, organization);
    if (!(await database.models.settings.get()))
      await database.models.settings.save({ companyName: COMPANY_NAME, dashboardLogoUrl: '' });
    const organizationId = 'pipeline2-ecosystem';
    if (await database.models.organizations.findById(organizationId)) {
      const products = await database.models.businessProducts.list(organizationId);
      const timestamp = new Date().toISOString();
      for (const [index, name] of ECOSYSTEM_PRODUCT_NAMES.entries()) {
        if (products.some((product) => product.name.trim().toLowerCase() === name.trim().toLowerCase()))
          continue;
        await database.models.businessProducts.insert({
          id: `ecosystem-product-${index + 1}`,
          organizationId,
          name,
          code: '',
          description: '',
          logoUrl: '',
          active: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
    }
    await database
      .collection('workspace_metadata')
      .insertOne({ _id: 'schema', version: 1, initializedAt: new Date() }, database.options());
  });
}

/**
 * Once per database: every saved document format takes the workspace teal (#0e4d64). Issued
 * documents keep the format snapshot they were saved with; colours chosen later are kept.
 */
export async function migrateFormatsToTeal(context) {
  const marker = { _id: 'formats-teal-v1' };
  const metadata = context.collection('workspace_metadata');
  if (await metadata.findOne(marker)) return 0;
  const result = await context
    .collection('formats')
    .updateMany({ accentColor: { $ne: '#0e4d64' } }, { $set: { accentColor: '#0e4d64' } });
  await metadata.updateOne(
    marker,
    { $setOnInsert: { completedAt: new Date(), formats: result.modifiedCount } },
    { upsert: true },
  );
  return result.modifiedCount;
}
