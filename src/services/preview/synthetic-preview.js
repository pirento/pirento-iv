/**
 * Disposable test preview (`npm run start:synthetic-preview`), separate from normal production.
 *
 * Starts the app on a brand-new random database filled with clearly fake businesses, blocks
 * every external integration (payments, email, GST), shows a "TEST PREVIEW" notice and deletes
 * its database on exit. Real database and provider settings are never read.
 */

import express from 'express';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { connectDatabase } from '../../config/database.js';
import { attachPageRoutes } from '../../routes/pages.js';
import { securityHeaders } from '../../middleware/http-security.js';
import { createBackend } from '../backend.js';

// Values shown in the preview's notice, headers and disabled-feature responses.
export const PREVIEW_MODE = 'disposable-synthetic-preview';
export const PREVIEW_NOTICE =
  'TEMPORARY SYNTHETIC PREVIEW. Test data only. Data is disposable. External integrations are disabled.';
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

/** Thrown when the preview settings are incomplete or unsafe. */
export class PreviewConfigurationError extends Error {}

const bootstrapSchema = z.object({
  INITIAL_ADMIN_EMAIL: z.string().trim().toLowerCase().email().max(254),
  INITIAL_ADMIN_PASSWORD: z.string().min(12).max(256),
  INITIAL_ADMIN_NAME: z.string().trim().max(120).optional(),
});

function refuse(message) {
  throw new PreviewConfigurationError(`Disposable preview refused: ${message}`);
}

/** Read only preview inputs; persistent database and provider settings are never copied. */
export function prepareSyntheticPreviewEnvironment(environment = process.env) {
  if (environment.IV_PREVIEW_MODE !== 'disposable-synthetic') refuse('explicit preview mode is required.');
  if (environment.NODE_ENV !== 'production') refuse('NODE_ENV must be production.');
  const origin = environment.PUBLIC_APP_URL;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || origin !== url.origin || url.username || url.password) throw new Error();
  } catch {
    refuse('PUBLIC_APP_URL must be an exact HTTPS origin without a path or credentials.');
  }
  const uri = environment.IV_PREVIEW_MONGODB_URI?.trim();
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri))
    refuse('set IV_PREVIEW_MONGODB_URI to a dedicated test replica set.');
  const bootstrap = bootstrapSchema.safeParse({
    INITIAL_ADMIN_EMAIL: environment.IV_PREVIEW_ADMIN_EMAIL,
    INITIAL_ADMIN_PASSWORD: environment.IV_PREVIEW_ADMIN_PASSWORD,
    INITIAL_ADMIN_NAME: environment.IV_PREVIEW_ADMIN_NAME || undefined,
  });
  if (!bootstrap.success) refuse('valid preview administrator settings are required.');
  const host = environment.HOST || '0.0.0.0';
  if (
    typeof host !== 'string' ||
    host !== host.trim() ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
        host,
      ))
  )
    refuse('HOST must be a valid listening address.');
  const port = environment.PORT || '3001';
  if (typeof port !== 'string' || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    refuse('PORT must be a whole number between 1 and 65535.');
  return {
    ...bootstrap.data,
    IV_PREVIEW_MODE: 'disposable-synthetic',
    NODE_ENV: 'production',
    PUBLIC_APP_URL: origin,
    HOST: host,
    PORT: String(Number(port)),
    MONGODB_URI: uri,
    BACKUP_ENABLED: 'false',
    EMAIL_AUTOMATION: 'false',
    SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
  };
}

/** Replacement for fetch() inside the preview: every outgoing provider request is refused. */
export async function blockedPreviewFetch() {
  throw new Error(PREVIEW_DISABLED);
}

/**
 * A separately selected, temporary application. Every invocation reserves a new
 * random MongoDB namespace; neither a URI database name nor an environment value
 * can select its deletion target. The ownership marker must match before cleanup.
 */
// Convenience wrapper that returns only the Express app (no close()).
export async function createSyntheticPreviewApplication(options = {}) {
  const environment = prepareSyntheticPreviewEnvironment(options.environment);
  const databaseName = `venturecore_preview_${randomUUID().replaceAll('-', '')}`;
  const ownerToken = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'venturecore-preview-'));
  environment.MONGODB_DATABASE = databaseName;
  environment.DATABASE_BACKUP_DIR = directory;
  const client = new MongoClient(environment.MONGODB_URI, {
    appName: 'venturecore-synthetic-preview',
    ignoreUndefined: true,
  });
  const database = client.db(databaseName);
  let backend;
  let reserved = false;
  let closing;

  function close() {
    if (!closing)
      closing = (async () => {
        try {
          await backend?.close();
          if (reserved) {
            const ownership = await database.collection('preview_instance').findOne({ _id: 'instance' });
            if (
              database.databaseName !== databaseName ||
              !/^venturecore_preview_[a-f0-9]{32}$/.test(databaseName) ||
              ownership?.ownerToken !== ownerToken
            )
              throw new Error('Disposable preview ownership could not be verified; cleanup refused.');
            await database.dropDatabase();
          }
        } finally {
          await client.close();
          await rm(directory, { recursive: true, force: true });
        }
      })();
    return closing;
  }

  try {
    await client.connect();
    if (await database.listCollections({}, { nameOnly: true }).hasNext())
      throw new Error('Disposable preview namespace is not empty; startup refused.');
    await database.createCollection('preview_instance');
    await database.collection('preview_instance').insertOne({
      _id: 'instance',
      ownerToken,
      createdAt: new Date(),
      mode: PREVIEW_MODE,
    });
    reserved = true;
    const db = await connectDatabase({ client, environment });
    await db.transaction(async () => {
      let number = 0;
      for (const organization of await db.models.organizations.list()) {
        number++;
        await db.models.organizations.save({
          ...organization,
          name: `TEST ONLY — ${organization.name}`,
          legalName: `Synthetic preview seller ${number} — NOT A REAL BUSINESS`,
          supportEmail: `test-${number}@example.invalid`,
          invoicePrefix: `T${number}I`,
          quotationPrefix: `T${number}Q`,
          terms: 'SYNTHETIC PREVIEW — NOT A VALID INVOICE. No real goods, services or payment.',
        });
      }
      await db.models.settings.save({ companyName: 'TEMPORARY SYNTHETIC PREVIEW', dashboardLogoUrl: '' });
    });
    backend = await createBackend({
      db,
      environment,
      fetch: blockedPreviewFetch,
      paymentFetch: blockedPreviewFetch,
      emailFetch: blockedPreviewFetch,
    });
    const apiApp = backend.app;
    const app = express();
    app.disable('x-powered-by');
    for (const key of [
      'services',
      'initialize',
      'errorHandler',
      'getDocument',
      'paymentDetails',
      'documentExport',
      'ledgerExport',
      'reportError',
      'requestDiagnostics',
    ])
      app.locals[key] = apiApp.locals[key];
    Object.assign(app.locals, {
      syntheticPreview: true,
      deploymentMode: PREVIEW_MODE,
      previewNotice: PREVIEW_NOTICE,
      close,
    });
    app.locals.workspaceData = async (...args) => ({
      ...(await apiApp.locals.workspaceData(...args)),
      preview: true,
      integrationsDisabled: true,
      deploymentMode: PREVIEW_MODE,
    });
    app.use(securityHeaders(true));
    app.use((_req, res, next) => {
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) =>
        setHeader(name, name.toLowerCase() === 'content-security-policy' ? PREVIEW_CSP : value);
      res.set({
        'Content-Security-Policy': PREVIEW_CSP,
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-IV-Deployment-Mode': PREVIEW_MODE,
      });
      next();
    });
    if (apiApp.locals.requestDiagnostics) app.use(apiApp.locals.requestDiagnostics);
    app.get('/api/deployment-mode', (_req, res) =>
      res.json({ mode: PREVIEW_MODE, disposable: true, integrationsDisabled: true }),
    );
    app.get('/api/health', (_req, res) => res.json({ ok: true, preview: true, integrationsDisabled: true }));
    app.use((req, res, next) => {
      let path;
      try {
        path = decodeURIComponent(req.path);
      } catch {
        return res.status(400).json({ error: 'Invalid request path.' });
      }
      const publicDisabled =
        /^\/api\/webhooks(?:\/|$)/i.test(path) ||
        /^\/api\/auth\/(?:forgot-password|reset-password)(?:\/|$)/i.test(path);
      const protectedDisabled =
        /^\/api\/(?:gst|integrations)(?:\/|$)/i.test(path) ||
        /^\/api\/documents\/[^/]+\/(?:payment-link|email)(?:\/|$)/i.test(path) ||
        /^\/api\/messages\/[^/]+\/retry(?:\/|$)/i.test(path);
      const disabled = () => res.status(503).json({ error: PREVIEW_DISABLED, preview: true });
      if (publicDisabled) return disabled();
      if (protectedDisabled) return backend.auth.requireSession(req, res, disabled);
      next();
    });
    app.use((req, res, next) => {
      if (/^\/api(?:\/|$)/i.test(req.path)) return apiApp(req, res, next);
      next();
    });
    const application = { ...backend, app, environment, close };
    attachPageRoutes(application);
    await backend.initialize();
    return application;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

export async function createSyntheticPreviewApp(options) {
  return (await createSyntheticPreviewApplication(options)).app;
}
