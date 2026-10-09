import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertHostedNodeVersion } from './hosted-startup-config.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const present = (value) => typeof value === 'string' && value.trim().length > 0;
const within = (directory, candidate) => {
  const tail = relative(directory, candidate);
  return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail));
};

// Resolve links before deciding whether a storage location is private. Existing
// directories are required: a preflight must never create a business database.
function privateLocation(candidate, root) {
  const absolute = resolve(candidate);
  const parent = realpathSync(dirname(absolute));
  const canonical = existsSync(absolute) ? realpathSync(absolute) : join(parent, absolute.split(sep).at(-1));
  const privatePath = (path) => {
    if (path.split(sep).some((part) => ['public', 'dist', 'src'].includes(part))) return false;
    return !within(root, path) || within(join(root, '.data'), path);
  };
  return { parent, canonical, safe: privatePath(absolute) && privatePath(canonical) };
}

function writableDirectory(directory) {
  let probe;
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
    probe = mkdtempSync(join(directory, '.venturecore-preflight-'));
    writeFileSync(join(probe, 'write-check'), 'storage-probe', { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

/** Offline checks only. Reports names/presence, never credentials or private records. */
export async function checkDeployment(options = {}) {
  const environment = options.environment ?? process.env;
  const root = realpathSync(options.root ?? defaultRoot);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks = [];
  const integrations = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  let nodeReady = false;
  try {
    assertHostedNodeVersion(nodeVersion);
    nodeReady = true;
  } catch {
    /* The startup flag --use-env-proxy requires at least Node 24.5. */
  }
  add('node', nodeReady ? 'pass' : 'blocker', 'Node.js 24.5 or newer is required.');
  add(
    'production',
    environment.NODE_ENV === 'production' ? 'pass' : 'blocker',
    'Set NODE_ENV=production for a hosted deployment.',
  );

  let originReady = false;
  try {
    const origin = new URL(environment.PUBLIC_APP_URL ?? '');
    originReady =
      origin.protocol === 'https:' &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === '/' &&
      environment.PUBLIC_APP_URL === origin.origin;
  } catch {
    /* Report a fixed message, not the potentially sensitive URL. */
  }
  add(
    'public-origin',
    originReady ? 'pass' : 'blocker',
    'PUBLIC_APP_URL must be the exact HTTPS website origin, without credentials, paths, query strings or a trailing slash.',
  );

  const host = environment.HOST ?? '127.0.0.1';
  const hostValid = isIP(host) > 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);
  add(
    'host',
    hostValid ? 'pass' : 'blocker',
    'HOST must be an IP address or hostname without a scheme, port or whitespace.',
  );
  if (hostValid && ['127.0.0.1', 'localhost', '::1'].includes(host))
    add(
      'host-exposure',
      'warning',
      'HOST is loopback-only. Verify a local reverse proxy, or set HOST=0.0.0.0 for the hosting platform.',
    );
  const portInput = environment.PORT ?? '3001';
  const port = Number(portInput);
  add(
    'port',
    /^\d+$/.test(portInput) && Number.isInteger(port) && port >= 1 && port <= 65535 ? 'pass' : 'blocker',
    'PORT must be an integer between 1 and 65535.',
  );

  let databaseReady = false;
  let databaseLocation;
  const databasePath = environment.DATABASE_PATH;
  if (!present(databasePath) || !isAbsolute(databasePath)) {
    add(
      'database-path',
      'blocker',
      'Set DATABASE_PATH to an absolute path on persistent private storage. The default relative .data path is for local development.',
    );
  } else {
    try {
      databaseLocation = privateLocation(databasePath, root);
      const exists = existsSync(databaseLocation.canonical);
      const regular = !exists || lstatSync(databaseLocation.canonical).isFile();
      if (exists && regular) accessSync(databaseLocation.canonical, constants.W_OK);
      databaseReady = databaseLocation.safe && regular && writableDirectory(databaseLocation.parent);
      add(
        'database-path',
        databaseReady ? 'pass' : 'blocker',
        'Database storage must be writable and private, outside public/dist/src and application source. Only the private .data directory is allowed inside the project.',
      );
      if (databaseReady)
        add(
          'persistent-storage',
          'warning',
          'The directory is writable. Confirm the hosting platform preserves this mount across restarts and deployments; an offline check cannot prove persistence.',
        );
    } catch {
      add(
        'database-path',
        'blocker',
        'Provision an accessible private database directory and a writable database file before deployment.',
      );
    }
  }

  let existingAdminCount = options.existingAdminCount;
  if (
    existingAdminCount === undefined &&
    nodeReady &&
    databaseReady &&
    existsSync(databaseLocation.canonical)
  ) {
    let db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(databaseLocation.canonical, { readOnly: true });
      const table = db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'auth_users'")
        .get();
      existingAdminCount =
        Number(table.count) > 0
          ? Number(
              db
                .prepare(
                  "SELECT COUNT(*) AS count FROM auth_users WHERE role = 'admin' AND status = 'active'",
                )
                .get().count,
            )
          : 0;
    } catch {
      add(
        'database-readable',
        'blocker',
        'The existing database could not be inspected read-only. Check its format and permissions before starting the app.',
      );
    } finally {
      db?.close();
    }
  }
  const adminPresent = Number.isInteger(existingAdminCount) && existingAdminCount > 0;
  const adminEmail = present(environment.INITIAL_ADMIN_EMAIL);
  const adminPassword = present(environment.INITIAL_ADMIN_PASSWORD);
  const bootstrapValid =
    z.string().trim().email().max(254).safeParse(environment.INITIAL_ADMIN_EMAIL).success &&
    z.string().min(12).max(256).safeParse(environment.INITIAL_ADMIN_PASSWORD).success;
  if (adminEmail !== adminPassword || ((adminEmail || adminPassword) && !bootstrapValid))
    add(
      'administrator',
      'blocker',
      'INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be configured together with a valid email and a password of 12–256 characters.',
    );
  else
    add(
      'administrator',
      adminPresent || bootstrapValid ? 'pass' : 'blocker',
      adminPresent
        ? 'An active administrator already exists. Bootstrap credentials are not required.'
        : bootstrapValid
          ? 'First-administrator settings are present. Startup must provision the account; remove bootstrap credentials after the first owner login.'
          : 'Provision the first administrator in secure server settings before enabling public signup.',
    );

  const backupMode = environment.BACKUP_ENABLED?.trim().toLowerCase() || 'false';
  const backupEnabled = backupMode === 'true';
  const backupSettingValid = ['true', 'false'].includes(backupMode);
  add(
    'backup-setting',
    backupSettingValid ? 'pass' : 'blocker',
    'BACKUP_ENABLED accepts only true or false.',
  );
  if (backupEnabled) {
    const backupDir = environment.DATABASE_BACKUP_DIR;
    let backupReady = false;
    if (present(backupDir) && isAbsolute(backupDir)) {
      try {
        const directory = realpathSync(backupDir);
        // Check a fictitious filename so the shared location policy examines this directory.
        const location = privateLocation(join(directory, 'backup.sqlite'), root);
        backupReady = location.safe && directory !== databaseLocation?.parent && writableDirectory(directory);
      } catch {
        /* Safe static error below. */
      }
    }
    add(
      'backup-directory',
      backupReady ? 'pass' : 'blocker',
      'DATABASE_BACKUP_DIR must be an absolute writable private directory separate from the database directory.',
    );
  } else {
    add(
      'backups',
      'warning',
      'Automatic backups are disabled. Enable private scheduled backups and verify off-server copies and a restore before production use.',
    );
  }
  const interval = environment.BACKUP_INTERVAL_MINUTES?.trim() || '1440';
  const retention = environment.BACKUP_RETENTION_COUNT?.trim() || '7';
  const validInterval =
    /^\d+$/.test(interval) &&
    Number.isSafeInteger(Number(interval)) &&
    Number(interval) >= 1 &&
    Number(interval) <= 10080;
  const validRetention =
    /^\d+$/.test(retention) &&
    Number.isSafeInteger(Number(retention)) &&
    Number(retention) >= 1 &&
    Number(retention) <= 365;
  add(
    'backup-schedule',
    validInterval && validRetention ? 'pass' : 'blocker',
    'Backup interval must be 1–10080 minutes; retention must be 1–365 backups.',
  );

  function group(scope, provider, names, extraValid = true, activated = false, mode) {
    const fields = Object.fromEntries(names.map((name) => [name, present(environment[name])]));
    const complete = Object.values(fields).every(Boolean);
    const partial = Object.values(fields).some(Boolean) && !complete;
    const state = complete && extraValid ? 'settings-present' : 'held';
    integrations.push({ scope, provider, state, fields, ...(mode ? { mode } : {}) });
    if (activated && (!complete || !extraValid))
      add(
        `${scope}-${provider}`,
        'blocker',
        'An activated integration has missing or invalid server settings. Configure its complete credential group, or disable it.',
      );
    else if (partial || (complete && !extraValid))
      add(
        `${scope}-${provider}`,
        'warning',
        'This optional integration is held because its credential group or mode is incomplete. It does not block manual invoicing.',
      );
  }
  const scopes = new Set(['']);
  for (const name of Object.keys(environment)) {
    const match =
      /^([A-Z][A-Z0-9_]*)_(?:RAZORPAY_KEY_ID|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|CASHFREE_CLIENT_ID|CASHFREE_CLIENT_SECRET|RESEND_API_KEY|EMAIL_FROM|EMAIL_AUTOMATION)$/.exec(
        name,
      );
    if (match) scopes.add(`${match[1]}_`);
  }
  for (const prefix of [...scopes].sort()) {
    const scope = prefix ? prefix.slice(0, -1).toLowerCase() : 'workspace';
    group(
      scope,
      'razorpay',
      ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'].map((name) => prefix + name),
      true,
      false,
      present(environment[`${prefix}RAZORPAY_KEY_ID`])
        ? environment[`${prefix}RAZORPAY_KEY_ID`].startsWith('rzp_test_')
          ? 'test'
          : 'live'
        : 'unconfigured',
    );
    group(
      scope,
      'cashfree',
      ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET'].map((name) => prefix + name),
      !present(environment[`${prefix}CASHFREE_ENVIRONMENT`]) ||
        ['sandbox', 'production'].includes(environment[`${prefix}CASHFREE_ENVIRONMENT`]),
      false,
      ['sandbox', 'production'].includes(environment[`${prefix}CASHFREE_ENVIRONMENT`] || 'sandbox')
        ? environment[`${prefix}CASHFREE_ENVIRONMENT`] === 'production'
          ? 'live'
          : 'test'
        : 'invalid',
    );
    const sender = environment[`${prefix}EMAIL_FROM`] ?? '';
    const senderAddress = sender.match(/<([^<>]+)>\s*$/)?.[1] ?? sender;
    const senderValid = !/[\r\n]/.test(sender) && z.string().email().safeParse(senderAddress.trim()).success;
    group(
      scope,
      'resend',
      ['EMAIL_FROM', 'RESEND_API_KEY'].map((name) => prefix + name),
      senderValid,
      environment[`${prefix}EMAIL_AUTOMATION`] === 'true',
    );
    if (
      environment[`${prefix}EMAIL_AUTOMATION`] !== undefined &&
      !['true', 'false'].includes(environment[`${prefix}EMAIL_AUTOMATION`])
    )
      add(`${scope}-email-automation`, 'blocker', 'EMAIL_AUTOMATION accepts only true or false.');
  }
  const gstProvider =
    environment.GST_PROVIDER?.trim().toLowerCase() ||
    (present(environment.GST_LOOKUP_URL) ? 'generic' : 'portal');
  if (!['portal', 'generic', 'sandbox'].includes(gstProvider))
    add('gst-provider', 'blocker', 'GST_PROVIDER accepts portal, generic or sandbox.');
  const sandboxMode = environment.SANDBOX_ENVIRONMENT?.trim().toLowerCase() || 'test';
  const sandboxCredentialsValid = ['SANDBOX_API_KEY', 'SANDBOX_API_SECRET'].every((name) => {
    const value = environment[name]?.trim() ?? '';
    return value.length <= 2048 && !/[\x00-\x20\x7f]/.test(value);
  });
  group(
    'gst',
    'sandbox',
    ['SANDBOX_API_KEY', 'SANDBOX_API_SECRET'],
    ['test', 'production'].includes(sandboxMode) && sandboxCredentialsValid,
    gstProvider === 'sandbox',
    ['test', 'production'].includes(sandboxMode) ? sandboxMode : 'invalid',
  );
  if (gstProvider === 'generic') {
    let urlValid = false;
    try {
      const template = environment.GST_LOOKUP_URL ?? '';
      const url = new URL(template.replaceAll('{gstin}', '27AAACR5055K1Z7'));
      urlValid =
        template.includes('{gstin}') &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash;
    } catch {
      /* Never print a configured provider URL or key. */
    }
    add(
      'gst-generic',
      urlValid ? 'pass' : 'blocker',
      'Generic GST lookup requires an HTTPS URL containing {gstin} and no embedded credentials or fragment.',
    );
  }
  integrations.push({
    scope: 'gst',
    provider: ['portal', 'generic', 'sandbox'].includes(gstProvider) ? gstProvider : 'invalid',
    state: 'selected',
  });
  return {
    ready: !checks.some((check) => check.status === 'blocker'),
    checks,
    integrations,
    limitations: [
      'Offline checks do not verify provider credentials, DNS, HTTPS reachability, hosting persistence, webhook delivery or email sender verification.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const envFile = resolve(process.cwd(), '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const report = await checkDeployment();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    console.error(
      JSON.stringify({
        ready: false,
        error: 'Deployment preflight could not run. Check runtime and filesystem permissions.',
      }),
    );
    process.exitCode = 1;
  }
}
