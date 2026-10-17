/**
 * Production preflight, run before a hosted server starts (and by `npm run check:deployment`).
 * Checks the Node.js version, required settings, the first-admin settings, and that the
 * selected database is the expected one (an empty database needs IV_ALLOW_NEW_DATABASE=true).
 */

import { MongoClient } from 'mongodb';
import { z } from 'zod';
import { assertHttpsPublicOrigin, EnvironmentConfigurationError } from './environment.js';
import { parseTrustedProxy } from './trusted-proxy.js';

/** Throws unless Node.js is 24.5 or newer (and below 27). */
export function assertHostedNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!match || major < 24 || major > 26 || (major === 24 && minor < 5))
    throw new EnvironmentConfigurationError(
      'Use a supported Node.js runtime: Node 24.5 or newer, below Node 27.',
    );
}

/**
 * True when the first-administrator email + password are both set and valid, false when both
 * are absent. Throws when only one is set or a value is invalid.
 */
export function hasValidBootstrapSettings(environment) {
  const email = environment.INITIAL_ADMIN_EMAIL;
  const password = environment.INITIAL_ADMIN_PASSWORD;
  if (!email && !password) return false;
  if (
    !z.string().trim().email().max(254).safeParse(email).success ||
    !z.string().min(12).max(256).safeParse(password).success
  )
    throw new EnvironmentConfigurationError(
      'Configure a valid INITIAL_ADMIN_EMAIL and 12–256 character INITIAL_ADMIN_PASSWORD together.',
    );
  return true;
}

/** Read-only preflight. This client never creates collections or seeds a workspace. */
export async function inspectHostedDatabase(environment) {
  if (!environment.MONGODB_URI?.trim())
    throw new EnvironmentConfigurationError('Set MONGODB_URI before production startup.');
  const databaseName = environment.MONGODB_DATABASE || 'venturecore_workspace';
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(databaseName))
    throw new EnvironmentConfigurationError('MONGODB_DATABASE is invalid.');
  const client = new MongoClient(environment.MONGODB_URI, {
    appName: 'venturecore-deployment-check',
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const topology = await database.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid')
      throw new EnvironmentConfigurationError('Use a MongoDB replica set or sharded cluster.');
    const names = new Set(
      (await database.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name),
    );
    const existing =
      names.has('organizations') &&
      Boolean(await database.collection('organizations').findOne({}, { projection: { _id: 1 } }));
    const recovery = names.has('ops_recovery_state')
      ? await database.collection('ops_recovery_state').findOne({ id: 1 }, { projection: { status: 1 } })
      : null;
    const activeAdmins = names.has('auth_users')
      ? await database.collection('auth_users').countDocuments({ role: 'admin', status: 'active' })
      : 0;
    return { existing, activeAdmins, recoveryPending: Boolean(recovery && recovery.status !== 'reviewed') };
  } finally {
    await client.close();
  }
}

/** Shared by normal and Hostinger production startup before writable initialization. */
export async function validateHostedProduction(
  environment,
  { inspectDatabase = inspectHostedDatabase, nodeVersion = process.versions.node } = {},
) {
  assertHostedNodeVersion(nodeVersion);
  parseTrustedProxy(environment.TRUST_PROXY);
  if (environment.NODE_ENV !== 'production')
    throw new EnvironmentConfigurationError('Hosted startup requires NODE_ENV=production.');
  assertHttpsPublicOrigin(environment.PUBLIC_APP_URL);
  const bootstrap = hasValidBootstrapSettings(environment);
  if (environment.IV_ALLOW_NEW_DATABASE && !['true', 'false'].includes(environment.IV_ALLOW_NEW_DATABASE))
    throw new EnvironmentConfigurationError('IV_ALLOW_NEW_DATABASE accepts true or false.');
  let state;
  try {
    state = await inspectDatabase(environment);
  } catch {
    throw new EnvironmentConfigurationError(
      'Production MongoDB preflight failed. Check connection, database access and replica-set settings.',
    );
  }
  if (state.recoveryPending)
    throw new EnvironmentConfigurationError(
      'The selected database is held for recovery review. Complete db:resume first.',
    );
  if (!state.existing && environment.IV_ALLOW_NEW_DATABASE !== 'true')
    throw new EnvironmentConfigurationError(
      'Expected workspace database is empty. For the first launch only, explicitly set IV_ALLOW_NEW_DATABASE=true.',
    );
  if (!(state.activeAdmins > 0) && !bootstrap)
    throw new EnvironmentConfigurationError(
      'No active administrator exists. Configure first-owner startup credentials before opening signup.',
    );
  return state;
}
