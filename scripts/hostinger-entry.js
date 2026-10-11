import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EnvironmentConfigurationError,
  loadEnvironment,
  loadEnvironmentValues,
} from '../src/config/environment.js';

// Retain the helper imports used by deployment tooling and existing tests.
export {
  assertHostedNodeVersion,
  inspectHostedDatabase,
  validateHostedProduction,
} from '../src/config/production.js';

export function selectHostedMode(environment) {
  if (!environment.IV_PREVIEW_MODE) return 'production';
  if (environment.IV_PREVIEW_MODE === 'disposable-synthetic') return 'disposable-synthetic';
  throw new EnvironmentConfigurationError('Unknown preview mode. Check IV_PREVIEW_MODE before startup.');
}

/** One loading path; server.js performs the production database preflight once. */
export async function runHostedEntry({
  cwd = process.cwd(),
  environment = process.env,
  launchProduction = () => import('../server.js'),
  launchSynthetic = () => import('./synthetic-preview.js'),
} = {}) {
  loadEnvironmentValues({ cwd, environment });
  if (selectHostedMode(environment) === 'disposable-synthetic') return launchSynthetic(environment);
  if (environment.NODE_ENV !== 'production')
    throw new EnvironmentConfigurationError('Hosted startup requires NODE_ENV=production.');
  loadEnvironment({ cwd, environment });
  return launchProduction(environment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runHostedEntry();
  } catch (error) {
    console.error(
      error instanceof EnvironmentConfigurationError
        ? error.message
        : 'Hosted startup could not complete. Check the runtime and environment configuration.',
    );
    process.exitCode = 1;
  }
}
