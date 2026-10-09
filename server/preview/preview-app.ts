import express from 'express';
import { closeSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createApp } from '../app.ts';
import { initDb, transaction } from '../db/db.ts';
import { securityHeaders } from '../http/http-security.ts';
import type { Organization } from '../../shared/types.ts';

export const PREVIEW_DISABLED =
  'Disabled in this disposable synthetic preview. No GST, payment, email, broker or external service calls are permitted.';
export const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const blockedPreviewFetch: typeof fetch = async () => {
  throw new Error(PREVIEW_DISABLED);
};

const previewEnvironmentKeys = new Set([
  'IV_PREVIEW_MODE',
  'INITIAL_ADMIN_EMAIL',
  'INITIAL_ADMIN_PASSWORD',
  'INITIAL_ADMIN_NAME',
  'NODE_ENV',
  'PUBLIC_APP_URL',
  'HOST',
  'PORT',
  'DATABASE_PATH',
  'DATABASE_BACKUP_DIR',
  'BACKUP_ENABLED',
  'EMAIL_AUTOMATION',
  'SHRI_SARRAF_EMAIL_AUTOMATION',
]);

function requireRealDirectories(directory: string) {
  const base = parse(directory).root;
  let current = base;
  for (const component of directory.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Preview storage must use real directories without symlink ancestors.');
  }
}

/** Isolated wrapper around the ordinary API, used only by explicit synthetic startup. */
export function createSyntheticPreviewApp(options: { root: string; environment: NodeJS.ProcessEnv }) {
  if (typeof options.root !== 'string' || !isAbsolute(options.root) || options.root.includes('\0'))
    throw new Error('An absolute preview application root is required.');
  const root = resolve(options.root);
  const environment = options.environment;
  if (environment.IV_PREVIEW_MODE !== 'disposable-synthetic')
    throw new Error('Explicit preview mode required.');
  if (
    environment.NODE_ENV !== 'production' ||
    environment.BACKUP_ENABLED !== 'false' ||
    environment.EMAIL_AUTOMATION !== 'false' ||
    environment.SHRI_SARRAF_EMAIL_AUTOMATION !== 'false' ||
    Object.entries(environment).some(
      ([key, value]) => value !== undefined && value !== '' && !previewEnvironmentKeys.has(key),
    )
  )
    throw new Error('Only sanitized preview settings with external workers disabled are permitted.');
  requireRealDirectories(root);
  if (readdirSync(root).some((name) => name.startsWith('.env') && name !== '.env.example'))
    throw new Error('Private environment files are forbidden in a disposable preview.');
  const filename = environment.DATABASE_PATH;
  const container = join(root, '.preview-data');
  const parts = filename ? relative(container, filename).split(sep) : [];
  if (
    !filename ||
    !isAbsolute(filename) ||
    filename.includes('\0') ||
    filename !== resolve(filename) ||
    parts.length !== 2 ||
    !/^run-[A-Za-z0-9]+$/.test(parts[0]) ||
    parts[1] !== 'workspace.sqlite' ||
    environment.DATABASE_BACKUP_DIR !== join(dirname(filename), 'backups')
  )
    throw new Error('Only a new isolated preview database is permitted.');
  requireRealDirectories(dirname(filename));
  for (const directory of [container, dirname(filename)]) {
    if ((lstatSync(directory).mode & 0o077) !== 0)
      throw new Error('Preview storage directories must be private.');
  }
  const originalHtml = readFileSync(join(root, 'dist/index.html'), 'utf8');
  if (!originalHtml.includes('</head>')) throw new Error('Build the preview frontend before starting.');
  const html = originalHtml
    .replace(
      '</head>',
      '<meta name="iv-deployment-mode" content="disposable-synthetic-preview" /><meta name="robots" content="noindex,nofollow,noarchive" /></head>',
    )
    .replace(
      '</body>',
      '<noscript>TEMPORARY SYNTHETIC PREVIEW. Test data only. Data is disposable. External integrations are disabled.</noscript></body>',
    );
  // Exclusive creation is intentional: never open an existing workspace, even
  // if a caller passes a plausible preview directory directly to this factory.
  closeSync(openSync(filename, 'wx', 0o600));
  const db = initDb(filename);
  try {
    transaction(db, () => {
      let number = 0;
      for (const row of db.prepare('SELECT id,data FROM organizations ORDER BY rowid').all()) {
        const organization = JSON.parse(String(row.data)) as Organization;
        number++;
        const synthetic = {
          ...organization,
          name: `TEST ONLY — ${organization.name}`,
          legalName: `Synthetic preview seller ${number} — NOT A REAL BUSINESS`,
          supportEmail: `test-${number}@example.invalid`,
          invoicePrefix: `T${number}I`,
          quotationPrefix: `T${number}Q`,
          terms: 'SYNTHETIC PREVIEW — NOT A VALID INVOICE. No real goods, services or payment.',
        };
        db.prepare('UPDATE organizations SET data=? WHERE id=?').run(JSON.stringify(synthetic), row.id);
      }
      db.prepare('UPDATE workspace_settings SET data=? WHERE id=1').run(
        JSON.stringify({ companyName: 'TEMPORARY SYNTHETIC PREVIEW', dashboardLogoUrl: '' }),
      );
    });
    const inner = createApp({
      db,
      environment,
      distPath: join(root, '.preview-no-static'),
      fetch: blockedPreviewFetch,
      paymentFetch: blockedPreviewFetch,
      emailFetch: blockedPreviewFetch,
    });
    const auth = inner.locals.services.auth;
    if (!auth) throw new Error('Preview authentication is required.');
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders(true));
    app.use((_req, res, next) => {
      const setHeader = res.setHeader.bind(res);
      // The embedded ordinary app also sets CSP; keep the stricter preview
      // policy for every response rather than allowing its HTTPS image policy.
      res.setHeader = (name, value) =>
        setHeader(name, name.toLowerCase() === 'content-security-policy' ? PREVIEW_CSP : value);
      res.setHeader('Content-Security-Policy', PREVIEW_CSP);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('X-IV-Deployment-Mode', 'disposable-synthetic-preview');
      next();
    });
    app.get('/api/deployment-mode', (_req, res) =>
      res.json({ mode: 'disposable-synthetic-preview', disposable: true, integrationsDisabled: true }),
    );
    app.get('/api/health', (_req, res) => res.json({ ok: true, preview: true, integrationsDisabled: true }));
    app.use((req, res, next) => {
      let path: string;
      try {
        path = decodeURIComponent(req.path);
      } catch {
        res.status(400).json({ error: 'Invalid request path.' });
        return;
      }
      const publicDisabled =
        /^\/api\/webhooks(?:\/|$)/i.test(path) ||
        /^\/api\/auth\/(?:forgot-password|reset-password)(?:\/|$)/i.test(path);
      const protectedDisabled =
        /^\/api\/(?:gst|integrations)(?:\/|$)/i.test(path) ||
        /^\/api\/documents\/[^/]+\/(?:payment-link|email)(?:\/|$)/i.test(path) ||
        /^\/api\/messages\/[^/]+\/retry(?:\/|$)/i.test(path);
      const disabled = () => {
        res.status(503).json({ error: PREVIEW_DISABLED, preview: true });
      };
      if (publicDisabled) {
        disabled();
        return;
      }
      if (protectedDisabled) {
        auth.requireSession(req, res, disabled);
        return;
      }
      next();
    });
    // Forward API requests only. Even an unexpectedly populated distPath must
    // never activate the ordinary app's static file server inside this wrapper.
    app.use((req, res, next) => {
      if (/^\/api(?:\/|$)/i.test(req.path)) inner(req, res, next);
      else next();
    });
    // Only built public assets are served. No source, .env or preview storage.
    app.use('/assets', express.static(join(root, 'dist/assets'), { dotfiles: 'deny', index: false }));
    app.get('/{*path}', (_req, res) => res.type('html').send(html));
    app.locals.services = inner.locals.services;
    app.locals.initialize = inner.locals.initialize;
    return app;
  } catch (error) {
    db.close();
    throw error;
  }
}
