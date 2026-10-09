import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';

const bootstrapKeys = new Set([
  'IV_PREVIEW_ADMIN_EMAIL',
  'IV_PREVIEW_ADMIN_PASSWORD',
  'IV_PREVIEW_ADMIN_NAME',
]);
const integrationSetting =
  /RAZORPAY|CASHFREE|RESEND|EMAIL|GST|SANDBOX|API_?KEY|SECRET|BROKER|TOKEN|PASSWORD|CREDENTIAL|SMTP|MAILGUN|SENDGRID|WEBHOOK|PAYMENT|STRIPE|PAYPAL|DATABASE|POSTGRES|MYSQL|MARIADB|SUPABASE|MONGO|REDIS|AMQP|KAFKA|(?:^|_)DB(?:_|$)|(?:^|_)(?:AWS|AZURE|GOOGLE|SES)(?:_|$)/i;
const bootstrapSchema = z.object({
  INITIAL_ADMIN_EMAIL: z.string().trim().toLowerCase().email().max(254),
  INITIAL_ADMIN_PASSWORD: z.string().min(12).max(256),
  INITIAL_ADMIN_NAME: z.string().trim().max(120).optional(),
});

function fail(message) {
  throw new Error(`Disposable preview refused: ${message}`);
}

function directoryWithoutLinks(directory) {
  const base = parse(directory).root;
  let current = base;
  for (const component of directory.slice(base.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('storage paths must be real directories.');
  }
}

/** Prepare only new synthetic storage. Never load dotenv or change process.env. */
export function prepareSyntheticPreview({ root, environment = process.env }) {
  if (environment.IV_PREVIEW_MODE !== 'disposable-synthetic') fail('explicit preview mode is required.');
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))
    fail('an absolute application root is required.');
  const applicationRoot = resolve(root);
  try {
    directoryWithoutLinks(applicationRoot);
    if (readdirSync(applicationRoot).some((name) => name.startsWith('.env') && name !== '.env.example'))
      fail('remove private environment files from the preview package.');
  } catch {
    fail('the application root must be accessible, without symlinks or private environment files.');
  }

  for (const [key, value] of Object.entries(environment)) {
    if (bootstrapKeys.has(key) || value === undefined || value === '') continue;
    if (key.toUpperCase().startsWith('INITIAL_ADMIN_')) fail('use preview-only administrator settings.');
    if (key === 'IV_ALLOW_NEW_DATABASE' || integrationSetting.test(key))
      fail('existing database and integration settings must be absent.');
  }
  if (environment.NODE_ENV !== 'production') fail('NODE_ENV must be production.');
  const origin = environment.PUBLIC_APP_URL;
  try {
    const url = new URL(origin);
    if (
      typeof origin !== 'string' ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      origin !== url.origin
    )
      fail('PUBLIC_APP_URL must be an exact HTTPS origin.');
  } catch {
    fail('PUBLIC_APP_URL must be an exact HTTPS origin without a path or credentials.');
  }
  const bootstrap = bootstrapSchema.safeParse({
    INITIAL_ADMIN_EMAIL: environment.IV_PREVIEW_ADMIN_EMAIL,
    INITIAL_ADMIN_PASSWORD: environment.IV_PREVIEW_ADMIN_PASSWORD,
    ...(environment.IV_PREVIEW_ADMIN_NAME === undefined
      ? {}
      : { INITIAL_ADMIN_NAME: environment.IV_PREVIEW_ADMIN_NAME }),
  });
  if (!bootstrap.success) fail('valid initial administrator settings are required.');

  const host = environment.HOST || '0.0.0.0';
  if (
    typeof host !== 'string' ||
    host.trim() !== host ||
    (!isIP(host) &&
      !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
        host,
      ))
  )
    fail('HOST must be a valid listening address.');
  const port = environment.PORT || '3001';
  if (
    typeof port !== 'string' ||
    port.trim() !== port ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  )
    fail('PORT must be a whole number between 1 and 65535.');

  const container = join(applicationRoot, '.preview-data');
  let directory;
  try {
    try {
      mkdirSync(container, { mode: 0o700 });
      chmodSync(container, 0o700);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(container);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0)
      fail('the preview container must be a private real directory.');
    directoryWithoutLinks(container);
    directory = mkdtempSync(join(container, 'run-'));
    chmodSync(directory, 0o700);
    const instance = lstatSync(directory);
    if (instance.isSymbolicLink() || !instance.isDirectory() || (instance.mode & 0o077) !== 0)
      fail('the new preview directory must be private.');
  } catch {
    fail('private disposable storage could not be prepared safely.');
  }

  const databasePath = join(directory, 'workspace.sqlite');
  return {
    directory,
    databasePath,
    environment: {
      ...bootstrap.data,
      IV_PREVIEW_MODE: 'disposable-synthetic',
      NODE_ENV: 'production',
      PUBLIC_APP_URL: origin,
      HOST: host,
      PORT: String(Number(port)),
      DATABASE_PATH: databasePath,
      DATABASE_BACKUP_DIR: join(directory, 'backups'),
      BACKUP_ENABLED: 'false',
      EMAIL_AUTOMATION: 'false',
      SHRI_SARRAF_EMAIL_AUTOMATION: 'false',
    },
  };
}
