export function createAccessGuard(db) {
  return async (req, res, next) => {
    const user = res.locals.user;
    if (!user || user.status !== 'active') {
      res.status(401).json({
        error: 'Sign in to continue.',
      });
      return;
    }
    if (user.role === 'admin') {
      next();
      return;
    }
    const allowed = new Set(user.organizationIds);
    const denied = () =>
      res.status(403).json({
        error: 'Your account does not have access to this organization or action.',
      });
    const segments = req.path.split('/').filter(Boolean);
    let resource;
    let id;
    try {
      resource = decodeURIComponent(segments[0] || '').toLowerCase();
      id = segments[1] ? decodeURIComponent(segments[1]) : undefined;
    } catch {
      res.status(400).json({
        error: 'Invalid resource identifier.',
      });
      return;
    }
    if (['organizations', 'workspace-settings'].includes(resource) && !['GET', 'HEAD'].includes(req.method)) {
      denied();
      return;
    }
    for (const organizationId of [req.query.organizationId, req.body?.organizationId]) {
      if (typeof organizationId === 'string' && !allowed.has(organizationId)) {
        denied();
        return;
      }
    }
    if (resource === 'organizations' && id && !allowed.has(id)) {
      denied();
      return;
    }
    const tables = {
      customers: 'customers',
      documents: 'documents',
      catalog: 'catalog',
      formats: 'formats',
      'business-products': 'business_products',
      payments: 'payments',
    };
    const table = Object.hasOwn(tables, resource) ? tables[resource] : undefined;
    const directoryRead =
      ['customers', 'catalog'].includes(resource) &&
      ['lookup', 'export'].includes(id) &&
      ['GET', 'HEAD'].includes(req.method) &&
      segments.length === 2;
    if (table && id && !directoryRead) {
      const paymentVoid =
        resource === 'payments' &&
        req.method === 'POST' &&
        segments.length === 3 &&
        segments[2].toLowerCase() === 'void';
      if (paymentVoid) {
        const payment = await db.models.payments.findById(id);
        if (payment) {
          // Older receipts can omit organizationId. Their existing parent invoice
          // establishes ownership; a malformed ID must never become a broad query.
          if (typeof payment.documentId !== 'string' || !payment.documentId) {
            denied();
            return;
          }
          const invoice = await db.models.ownership.document(payment.documentId);
          if (
            !invoice ||
            !allowed.has(invoice.organization_id) ||
            (payment.organizationId != null && payment.organizationId !== invoice.organization_id)
          ) {
            denied();
            return;
          }
        }
      } else {
        const row = await db.models.ownership.resource(table, id);
        if (row && !allowed.has(row.organization_id)) {
          denied();
          return;
        }
      }
    }
    if (resource === 'integrations' && typeof req.query.documentId === 'string') {
      const document = await db.models.ownership.document(req.query.documentId);
      if (document && !allowed.has(document.organization_id)) {
        denied();
        return;
      }
    }
    next();
  };
}
