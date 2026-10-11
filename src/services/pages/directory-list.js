import { HttpError } from '../../middleware/errors.js';
import {
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  normalizeContact,
  contactRoles,
} from '../../../shared/contact-types.js';
import { calculateLineAmount, pricingDescription } from '../../../shared/types.js';

export const DIRECTORY_PAGE_SIZE = 50;
export const LOOKUP_PAGE_SIZE = 20;
export const LOOKUP_ID_LIMIT = 50;

/** Fixed scalar filters: request objects and regex operators never become MongoDB operators. */
export function readDirectoryFilters(kind, query = {}, { lookup = false } = {}) {
  const value = (key, fallback = '', maximum = 200) => {
    const result = query[key] ?? fallback;
    if (typeof result !== 'string' || result.length > maximum)
      throw new HttpError(400, 'The directory filters are invalid.');
    return result.trim();
  };
  const search = value('q');
  const page = value('page', '1');
  const role = value('role', 'all');
  const type = value('type', 'all');
  const product = value('product', 'all');
  if (
    !/^[1-9]\d{0,6}$/.test(page) ||
    !['all', ...(lookup ? [] : ['archived']), ...CONTACT_ROLES].includes(role) ||
    !['all', 'service', 'product', ...(lookup ? [] : ['archived'])].includes(type) ||
    (product !== 'all' && product !== 'shared' && !/^[a-zA-Z0-9_-]{1,100}$/.test(product))
  )
    throw new HttpError(400, 'The directory filters are invalid.');
  const rawIds = value('ids', '', LOOKUP_ID_LIMIT * 101);
  const ids = rawIds ? [...new Set(rawIds.split(','))] : [];
  if (ids.length > LOOKUP_ID_LIMIT || ids.some((id) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id)))
    throw new HttpError(400, 'Provide at most 50 valid record identifiers.');
  return {
    kind,
    search,
    page: Number(page),
    role,
    type,
    product,
    lookup,
    ids,
    pageSize: lookup ? LOOKUP_PAGE_SIZE : DIRECTORY_PAGE_SIZE,
  };
}

export function directoryParams(kind, filters, extra = {}) {
  const query = new URLSearchParams();
  if (filters.search) query.set('q', filters.search);
  if (kind === 'customers' && filters.role !== 'all') query.set('role', filters.role);
  if (kind === 'catalog' && filters.type !== 'all') query.set('type', filters.type);
  if (kind === 'catalog' && filters.product !== 'all') query.set('product', filters.product);
  for (const [key, value] of Object.entries(extra)) if (value) query.set(key, String(value));
  return query;
}

export function directoryPageLinks(organizationId, kind, page, returnTo = '') {
  const href = (extra) => {
    const query = directoryParams(kind, page.filters, extra);
    if (returnTo) query.set('returnTo', returnTo);
    return `/workspace/${encodeURIComponent(organizationId)}/${kind}${query.size ? '?' + query : ''}`;
  };
  const exportQuery = directoryParams(kind, page.filters, { organizationId });
  return {
    ...page,
    previousUrl: page.page > 1 ? href({ page: page.page - 1 }) : '',
    nextUrl: page.page < page.pageCount ? href({ page: page.page + 1 }) : '',
    exportUrl: `/api/${kind}/export?${exportQuery}`,
  };
}

const row = (values) =>
  values
    .map((value) => {
      let text = String(value ?? '');
      if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = "'" + text;
      return `"${text.replaceAll('"', '""')}"`;
    })
    .join(',') + '\r\n';

/** Stream every matching record; exports do not stop at the displayed directory page. */
export async function* directoryCsv(kind, cursor, products = []) {
  const productName = (id) =>
    products.find((product) => product.id === id)?.name ||
    (id ? 'Archived business product' : 'Shared offering');
  try {
    yield '\uFEFF' +
      row(
        kind === 'customers'
          ? [
              'Name',
              'Roles',
              'Contact person',
              'Email',
              'Phone',
              'GSTIN',
              'PAN',
              'Billing address',
              'State',
              'Shipping address',
              'Shipping state',
              'Payment terms (days)',
              'Credit limit',
              'Status',
              'Notes',
            ]
          : [
              'Name',
              'Business product',
              'Type',
              'SKU',
              'Description',
              'HSN/SAC',
              'Unit',
              'Base rate (INR)',
              'Rate basis',
              'Pricing mode',
              'Periods',
              'Period unit',
              'Gross weight (g)',
              'Stone weight (g)',
              'Purity',
              'Making basis',
              'Making charge',
              'Stone amount (INR)',
              'Other charges (INR)',
              'Wastage %',
              'Amount for one item (INR)',
              'Pricing details',
              'GST %',
              'Status',
            ],
      );
    for await (const record of cursor) {
      if (kind === 'customers') {
        const c = normalizeContact(record);
        yield row([
          c.name,
          contactRoles(c)
            .map((role) => CONTACT_ROLE_LABELS[role])
            .join(', '),
          c.contactPerson,
          c.email,
          c.phone,
          c.gstin,
          c.pan,
          c.address,
          c.stateCode,
          c.shippingAddress,
          c.shippingStateCode,
          c.paymentTermsDays,
          c.creditLimit,
          c.active ? 'Active' : 'Archived',
          c.notes,
        ]);
      } else {
        const item = record;
        const j = item.pricing?.jewellery;
        const basis =
          item.pricing?.mode === 'jewellery'
            ? 'per gram of net metal'
            : item.pricing?.mode === 'recurring'
              ? `per ${item.unit} / ${(item.pricing.periodUnit || 'Month').toLowerCase()}`
              : `per ${item.unit}`;
        yield row([
          item.name,
          productName(item.businessProductId),
          item.type,
          item.sku,
          item.description,
          item.hsn,
          item.unit,
          item.rate,
          basis,
          item.pricing?.mode || 'standard',
          item.pricing?.periods ?? '',
          item.pricing?.periodUnit ?? '',
          j?.grossWeight ?? '',
          j?.stoneWeight ?? '',
          j?.purity ?? '',
          j?.makingChargeType ?? '',
          j?.makingCharge ?? '',
          j?.stoneAmount ?? '',
          j?.otherCharges ?? '',
          j?.wastagePercent ?? '',
          calculateLineAmount({ quantity: 1, rate: item.rate, pricing: item.pricing }),
          pricingDescription({ ...item, quantity: 1, description: item.description || item.name }),
          item.gstRate,
          item.active ? 'Active' : 'Archived',
        ]);
      }
    }
  } finally {
    await cursor.close();
  }
}
