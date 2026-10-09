import type { RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser } from '../../shared/auth-types.ts';

/** Resolve access from the stored resource as well as submitted organization IDs. */
export function createAccessGuard(db: DatabaseSync): RequestHandler {
  return (req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user || user.status !== 'active') {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    if (user.role === 'admin') {
      next();
      return;
    }
    const allowed = new Set(user.organizationIds);
    const denied = () =>
      res.status(403).json({ error: 'Your account does not have access to this organization or action.' });
    const segments = req.path.split('/').filter(Boolean);
    let resource: string;
    let id: string | undefined;
    try {
      resource = decodeURIComponent(segments[0] || '').toLowerCase();
      id = segments[1] ? decodeURIComponent(segments[1]) : undefined;
    } catch {
      res.status(400).json({ error: 'Invalid resource identifier.' });
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
    const tables: Record<string, string> = {
      customers: 'customers',
      documents: 'documents',
      catalog: 'catalog',
      formats: 'formats',
      'business-products': 'business_products',
      payments: 'payments',
    };
    const table = Object.hasOwn(tables, resource) ? tables[resource] : undefined;
    if (table && id) {
      // Table identifiers come from this fixed map, never user input.
      const row = db.prepare(`SELECT organization_id FROM ${table} WHERE id = ?`).get(id) as
        { organization_id: string } | undefined;
      if (row && !allowed.has(row.organization_id)) {
        denied();
        return;
      }
    }
    if (resource === 'integrations' && typeof req.query.documentId === 'string') {
      const document = db
        .prepare('SELECT organization_id FROM documents WHERE id = ?')
        .get(req.query.documentId) as { organization_id: string } | undefined;
      if (document && !allowed.has(document.organization_id)) {
        denied();
        return;
      }
    }
    // Email retries are resolved by their document in the endpoint. Password-reset
    // and other messages without a business document remain admin-only there.
    next();
  };
}
