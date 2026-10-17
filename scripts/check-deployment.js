/**
 * `npm run check:deployment` - read-only check of a production setup: Node version, settings,
 * HTTPS origin, proxy setting, database reachability/transactions, first-admin settings, backups
 * and which payment/email integrations are configured. Prints JSON; never prints secret values.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { z } from 'zod';
import { assertHttpsPublicOrigin, loadEnvironment } from '../src/config/environment.js';
import { parseTrustedProxy } from '../src/config/trusted-proxy.js';
import { parseDatabaseBackupConfig } from '../src/services/operations/database-backup.js';
import {
  assertHostedNodeVersion,
  hasValidBootstrapSettings,
  inspectHostedDatabase,
} from '../src/config/production.js';

const present = (value) => typeof value === 'string' && value.trim().length > 0;

/** Configuration plus read-only MongoDB inspection. Never logs input values. */
export async function checkDeployment({ environment = process.env, databaseState, nodeVersion } = {}) {
  const checks = [];
  const integrations = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  try {
    assertHostedNodeVersion(nodeVersion);
    add('node', 'pass', 'Node runtime is supported.');
  } catch {
    add('node', 'blocker', 'Use Node.js 24.5 or newer, below Node 27.');
  }
  add(
    'production',
    environment.NODE_ENV === 'production' ? 'pass' : 'blocker',
    'Hosted deployment requires NODE_ENV=production.',
  );
  let originValid = false;
  try {
    assertHttpsPublicOrigin(environment.PUBLIC_APP_URL);
    originValid = true;
  } catch {
    /* Only fixed messages are returned. */
  }
  add(
    'public-origin',
    originValid ? 'pass' : 'blocker',
    'PUBLIC_APP_URL must be the exact public HTTPS origin.',
  );
  try {
    const proxies = parseTrustedProxy(environment.TRUST_PROXY);
    add(
      'trusted-proxy',
      'pass',
      proxies.length
        ? 'Explicit proxy addresses are configured. Verify them against the actual hosting network.'
        : 'Forwarded client addresses are not trusted; account limits use the connected peer.',
    );
  } catch {
    add(
      'trusted-proxy',
      'blocker',
      'TRUST_PROXY must be empty or contain only explicit proxy IP addresses/CIDRs.',
    );
  }
  const host = environment.HOST || '127.0.0.1';
  const hostValid = isIP(host) > 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host);
  add(
    'host',
    hostValid ? 'pass' : 'blocker',
    'HOST must be an IP address or hostname without a URL scheme or port.',
  );
  if (hostValid && ['127.0.0.1', 'localhost', '::1'].includes(host))
    add('host-routing', 'warning', 'Loopback binding requires a reverse proxy on the same host.');
  const port = Number(environment.PORT || 3001);
  add(
    'port',
    Number.isInteger(port) && port > 0 && port < 65536 ? 'pass' : 'blocker',
    'PORT must be between 1 and 65535.',
  );

  let state = databaseState;
  try {
    state ??= await inspectHostedDatabase(environment);
    add('database', 'pass', 'MongoDB is reachable and supports transactions.');
    if (state.recoveryPending)
      add('recovery', 'blocker', 'The selected database is held for recovery review.');
    if (!state.existing)
      add(
        'new-database',
        environment.IV_ALLOW_NEW_DATABASE === 'true' ? 'warning' : 'blocker',
        'The selected workspace is empty. Confirm the database name and use IV_ALLOW_NEW_DATABASE=true for an intentional first hosted launch.',
      );
  } catch {
    add(
      'database',
      'blocker',
      'MongoDB read-only inspection failed. Check the URI, database permissions and replica-set configuration.',
    );
  }

  if (environment.IV_ALLOW_NEW_DATABASE && !['true', 'false'].includes(environment.IV_ALLOW_NEW_DATABASE))
    add('new-database-setting', 'blocker', 'IV_ALLOW_NEW_DATABASE accepts true or false.');
  let bootstrapValid = false;
  let bootstrapInvalid = false;
  try {
    bootstrapValid = hasValidBootstrapSettings(environment);
  } catch {
    bootstrapInvalid = true;
  }
  if (bootstrapInvalid)
    add(
      'administrator',
      'blocker',
      'Configure a valid INITIAL_ADMIN_EMAIL and 12–256 character INITIAL_ADMIN_PASSWORD together.',
    );
  else
    add(
      'administrator',
      state?.activeAdmins > 0 || bootstrapValid ? 'pass' : 'blocker',
      state?.activeAdmins > 0
        ? 'An active administrator exists.'
        : 'First-owner startup credentials are required before opening signup.',
    );

  try {
    const backup = parseDatabaseBackupConfig(environment);
    add('backup-settings', 'pass', 'Backup schedule and retention settings are valid.');
    add(
      'backup-storage',
      'warning',
      backup.enabled
        ? 'Verify the configured backup directory is private, writable and persistent on the actual host.'
        : 'Scheduled backups are disabled; manual snapshots remain available.',
    );
  } catch {
    add(
      'backup-settings',
      'blocker',
      'Backup settings are invalid. Check the directory, boolean, interval and retention values.',
    );
  }

  const scopes = new Set(['']);
  for (const name of Object.keys(environment)) {
    const match =
      /^([A-Z][A-Z0-9_]*)_(?:RAZORPAY_KEY_ID|CASHFREE_CLIENT_ID|RESEND_API_KEY|EMAIL_FROM|EMAIL_AUTOMATION)$/.exec(
        name,
      );
    if (match) scopes.add(`${match[1]}_`);
  }
  for (const prefix of [...scopes].sort()) {
    for (const [provider, names] of [
      ['razorpay', ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']],
      ['cashfree', ['CASHFREE_CLIENT_ID', 'CASHFREE_CLIENT_SECRET']],
      ['resend', ['EMAIL_FROM', 'RESEND_API_KEY']],
    ]) {
      const fields = Object.fromEntries(
        names.map((name) => [prefix + name, present(environment[prefix + name])]),
      );
      const complete = Object.values(fields).every(Boolean);
      const any = Object.values(fields).some(Boolean);
      const automated = provider === 'resend' && environment[`${prefix}EMAIL_AUTOMATION`] === 'true';
      integrations.push({
        scope: prefix.slice(0, -1) || 'workspace',
        provider,
        state: complete ? 'settings-present' : 'held',
        fields,
      });
      if ((any && !complete) || (automated && !complete))
        add(
          `${prefix}${provider}`,
          automated ? 'blocker' : 'warning',
          'This credential group is incomplete. Configure the complete group or keep the optional integration disabled.',
        );
    }
    const mode = environment[`${prefix}CASHFREE_ENVIRONMENT`] || 'sandbox';
    if (!['sandbox', 'production'].includes(mode))
      add(`${prefix}cashfree-mode`, 'blocker', 'Cashfree environment must be sandbox or production.');
    const automation = environment[`${prefix}EMAIL_AUTOMATION`];
    if (automation !== undefined && !['true', 'false'].includes(automation))
      add(`${prefix}email-automation`, 'blocker', 'EMAIL_AUTOMATION accepts true or false.');
    if (present(environment[`${prefix}EMAIL_FROM`])) {
      const sender = environment[`${prefix}EMAIL_FROM`];
      const address = sender.match(/<([^<>]+)>\s*$/)?.[1] || sender;
      if (/[\r\n]/.test(sender) || !z.string().email().safeParse(address.trim()).success)
        add(
          `${prefix}email-sender`,
          'blocker',
          'EMAIL_FROM must contain a valid sender address without line breaks.',
        );
    }
  }
  const gstProvider =
    environment.GST_PROVIDER?.trim().toLowerCase() ||
    (present(environment.GST_LOOKUP_URL) ? 'generic' : 'portal');
  if (!['portal', 'generic', 'sandbox'].includes(gstProvider))
    add('gst-provider', 'blocker', 'GST_PROVIDER accepts portal, generic or sandbox.');
  if (
    gstProvider === 'sandbox' &&
    (!['test', 'production'].includes(environment.SANDBOX_ENVIRONMENT || 'test') ||
      !present(environment.SANDBOX_API_KEY) ||
      !present(environment.SANDBOX_API_SECRET))
  )
    add('gst-sandbox', 'blocker', 'Sandbox GST requires a valid mode and a complete key/secret pair.');
  if (gstProvider === 'generic') {
    let valid = false;
    try {
      const template = environment.GST_LOOKUP_URL || '';
      const url = new URL(template.replaceAll('{gstin}', '27AAACR5055K1Z7'));
      valid =
        template.includes('{gstin}') &&
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.hash;
    } catch {
      /* Never disclose a configured provider URL. */
    }
    add(
      'gst-generic',
      valid ? 'pass' : 'blocker',
      'Generic GST requires an HTTPS URL containing {gstin} without embedded credentials.',
    );
  }
  integrations.push({ scope: 'gst', provider: gstProvider, state: 'selected' });
  return {
    ready: !checks.some((check) => check.status === 'blocker'),
    checks,
    integrations,
    limitations: [
      'This check does not validate provider credentials, HTTPS routing, DNS, sender verification, offsite backups or hosting persistence.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { environment } = loadEnvironment();
    const report = await checkDeployment({ environment });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    console.error('Deployment check could not run. Check the runtime and configuration inputs.');
    process.exitCode = 1;
  }
}
