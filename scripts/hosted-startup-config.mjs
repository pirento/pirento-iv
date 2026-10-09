import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function assertHostedNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 5)) {
    throw new Error('IV deployment requires Node 24.5 or newer.');
  }
}

export function selectHostedMode(environment = process.env) {
  if (environment.IV_PREVIEW_MODE === undefined) return 'production';
  if (environment.IV_PREVIEW_MODE === 'disposable-synthetic') return 'disposable-synthetic';
  throw new Error('Unknown IV preview mode; startup refused.');
}

const within = (directory, candidate) => {
  const tail = relative(directory, candidate);
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
};

const privateOutsideApp = (root, filename) =>
  !within(root, filename) && !filename.split(sep).some((part) => ['public', 'dist', 'src'].includes(part));

/**
 * Fail before loading the application if hosted settings could open a fresh or
 * public database. Filesystem checks cannot prove that a hosting mount persists
 * across deployments; the operator must verify that separately.
 */
export function validateHostedProduction({ root, environment = process.env, nodeVersion } = {}) {
  assertHostedNodeVersion(nodeVersion);
  if (environment.NODE_ENV !== 'production') {
    throw new Error('The hosted production launcher requires NODE_ENV=production.');
  }
  let originReady = false;
  try {
    const origin = new URL(environment.PUBLIC_APP_URL ?? '');
    originReady = origin.protocol === 'https:' && environment.PUBLIC_APP_URL === origin.origin;
  } catch {
    // Fixed errors below never disclose credentials accidentally embedded in a URL.
  }
  if (!originReady) {
    throw new Error(
      'PUBLIC_APP_URL must be the exact HTTPS origin without a trailing slash, credentials, path, query or fragment.',
    );
  }
  const filename = environment.DATABASE_PATH;
  if (!filename || !isAbsolute(filename) || filename.includes('\0')) {
    throw new Error('Set an absolute DATABASE_PATH on verified private persistent storage.');
  }

  let lexicalRoot;
  let canonicalRoot;
  let canonicalParent;
  let database;
  let present;
  let metadata;
  try {
    lexicalRoot = resolve(root);
    canonicalRoot = realpathSync(lexicalRoot);
    canonicalParent = realpathSync(dirname(filename));
    if (!statSync(canonicalRoot).isDirectory() || !statSync(canonicalParent).isDirectory()) throw new Error();
    present = lstatSync(filename, { throwIfNoEntry: false }) !== undefined;
    database = present ? realpathSync(filename) : join(canonicalParent, basename(filename));
    if (present) metadata = statSync(database);
  } catch {
    throw new Error(
      'Provision and verify an accessible persistent database parent directory before startup.',
    );
  }
  if (
    !privateOutsideApp(lexicalRoot, filename) ||
    !privateOutsideApp(canonicalRoot, filename) ||
    !privateOutsideApp(canonicalRoot, database)
  ) {
    throw new Error('DATABASE_PATH must be private and outside the replaceable application directory.');
  }
  if (!present && environment.IV_ALLOW_NEW_DATABASE !== 'true') {
    throw new Error('Expected IV database is missing; startup refused to prevent a silent reset.');
  }
  if (present && (!metadata.isFile() || metadata.size === 0 || metadata.nlink !== 1)) {
    throw new Error('Expected IV database is not a nonempty regular file without hard links.');
  }
  return { root: canonicalRoot, databasePath: database, creatingDatabase: !present };
}
