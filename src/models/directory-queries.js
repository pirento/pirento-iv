import { normalizeContact } from '../../shared/contact-types.js';

// This applies to every predicate, not only sorting: tenant and record identifiers must stay byte-exact.
export const DIRECTORY_COLLATION = { locale: 'simple' };
export const DIRECTORY_SORT = { name: 1, id: 1 };
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withoutId = (record) => {
  const { _id, ...value } = record;
  return value;
};

/** Tenant scope is unconditional, including explicit IDs used to restore a saved browser draft. */
export function directoryFilter(organizationId, kind, filters, matchingProducts = []) {
  const conditions = [{ organizationId }];
  if (filters.lookup && filters.ids.length) {
    conditions.push({ id: { $in: filters.ids } });
  } else {
    if (kind === 'customers') {
      conditions.push({ active: filters.role === 'archived' ? false : { $ne: false } });
      if (!['all', 'archived'].includes(filters.role))
        conditions.push(
          filters.role === 'customer'
            ? {
                $or: [{ roles: 'customer' }, { roles: null }],
              }
            : { roles: filters.role },
        );
    } else {
      conditions.push({ active: filters.type === 'archived' ? { $ne: true } : true });
      if (['service', 'product'].includes(filters.type)) conditions.push({ type: filters.type });
      const shared = { $or: [{ businessProductId: '' }, { businessProductId: null }] };
      if (filters.lookup) {
        conditions.push(
          ['all', 'shared'].includes(filters.product)
            ? shared
            : {
                $or: [shared, { businessProductId: filters.product }],
              },
        );
      } else if (filters.product === 'shared') conditions.push(shared);
      else if (filters.product !== 'all') conditions.push({ businessProductId: filters.product });
    }
    if (filters.search) {
      const regex = { $regex: literal(filters.search), $options: 'i' };
      const fields =
        kind === 'customers'
          ? [
              'name',
              'email',
              'phone',
              'gstin',
              'contactPerson',
              ...(filters.lookup ? ['pan', 'address'] : []),
            ]
          : ['name', 'sku', 'description', 'hsn'];
      const branches = fields.map((field) => ({ [field]: regex }));
      const orderedFields =
        kind === 'customers'
          ? filters.lookup
            ? ['name', 'contactPerson', 'phone', 'email', 'gstin', 'pan', 'address']
            : ['name', 'email', 'phone', 'gstin', 'contactPerson']
          : filters.lookup
            ? ['name', 'description', 'sku', 'hsn']
            : ['name', 'sku', 'description', 'hsn'];
      // Retain searches crossing adjacent displayed fields, as in the original browser filter.
      branches.push({
        $expr: {
          $regexMatch: {
            input: {
              $concat: orderedFields.flatMap((field, index) => [
                ...(index ? [' '] : []),
                { $ifNull: ['$' + field, ''] },
              ]),
            },
            regex: literal(filters.search),
            options: 'i',
          },
        },
      });
      if (kind === 'catalog' && !filters.lookup && matchingProducts.length)
        branches.push({ businessProductId: { $in: matchingProducts } });
      if (kind === 'catalog' && !filters.lookup && 'shared offering'.includes(filters.search.toLowerCase()))
        branches.push({ $or: [{ businessProductId: '' }, { businessProductId: null }] });
      conditions.push({ $or: branches });
    }
  }
  return { $and: conditions };
}

export function createDirectoryQueries(db) {
  const options = () => ({ ...db.options(), collation: DIRECTORY_COLLATION });
  const present = (kind, row) => (kind === 'customers' ? normalizeContact(withoutId(row)) : withoutId(row));
  async function filter(organizationId, kind, filters) {
    const matchingProducts =
      kind === 'catalog' && !filters.lookup && filters.search && !filters.ids.length
        ? await db
            .collection('business_products')
            .find(
              { organizationId, name: { $regex: literal(filters.search), $options: 'i' } },
              { ...db.options(), projection: { _id: 0, id: 1 } },
            )
            .toArray()
        : [];
    return directoryFilter(
      organizationId,
      kind,
      filters,
      matchingProducts.map((item) => item.id),
    );
  }
  const cursor = (kind, query) => db.collection(kind).find(query, options()).sort(DIRECTORY_SORT);

  async function counts(kind, organizationId) {
    const active = kind === 'customers' ? { $ne: ['$active', false] } : { $eq: ['$active', true] };
    const terms =
      kind === 'customers'
        ? Object.fromEntries(
            ['customer', 'vendor', 'b2b_buyer'].map((role) => [
              role,
              {
                $sum: {
                  $cond: [{ $and: [active, { $in: [role, { $ifNull: ['$roles', ['customer']] }] }] }, 1, 0],
                },
              },
            ]),
          )
        : Object.fromEntries(
            ['service', 'product'].map((type) => [
              type,
              {
                $sum: { $cond: [{ $and: [active, { $eq: ['$type', type] }] }, 1, 0] },
              },
            ]),
          );
    const [result] = await db
      .collection(kind)
      .aggregate(
        [
          { $match: { organizationId } },
          {
            $group: {
              _id: null,
              all: { $sum: { $cond: [active, 1, 0] } },
              archived: { $sum: { $cond: [active, 0, 1] } },
              ...terms,
            },
          },
          { $project: { _id: 0 } },
        ],
        db.options(),
      )
      .toArray();
    return { all: 0, archived: 0, customer: 0, vendor: 0, b2b_buyer: 0, service: 0, product: 0, ...result };
  }

  async function page(kind, organizationId, filters) {
    const query = await filter(organizationId, kind, filters);
    const [total, summary] = await Promise.all([
      db.collection(kind).countDocuments(query, options()),
      counts(kind, organizationId),
    ]);
    const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pageCount);
    const rows = await cursor(kind, query)
      .skip((page - 1) * filters.pageSize)
      .limit(filters.pageSize)
      .toArray();
    return {
      items: rows.map((row) => present(kind, row)),
      total,
      page,
      pageCount,
      pageSize: filters.pageSize,
      counts: summary,
      filters,
    };
  }

  async function lookup(kind, organizationId, filters) {
    const query = await filter(organizationId, kind, filters);
    const exact = filters.ids.length > 0;
    const limit = exact ? filters.ids.length : filters.pageSize;
    const rows = await cursor(kind, query)
      .skip(exact ? 0 : (filters.page - 1) * limit)
      .limit(limit + (exact ? 0 : 1))
      .toArray();
    return {
      items: rows.slice(0, limit).map((row) => present(kind, row)),
      page: exact ? 1 : filters.page,
      pageSize: limit,
      hasMore: !exact && rows.length > limit,
    };
  }

  async function exportCursor(kind, organizationId, filters) {
    return cursor(kind, await filter(organizationId, kind, filters)).batchSize(100);
  }
  return { page, lookup, exportCursor };
}
