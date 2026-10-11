import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

export class EnvironmentConfigurationError extends Error {}

/**
 * Host values win. A private .env, when present, replaces the legacy file as the
 * configuration source; otherwise .example.env can still be populated directly.
 * Do not preload either file before calling this function: dotenv would then
 * mistake those file values for host settings.
 */
export function loadEnvironmentValues({ cwd = process.cwd(), environment = process.env } = {}) {
  const primary = resolve(cwd, '.env');
  const legacy = resolve(cwd, '.example.env');
  const filename = existsSync(primary) ? primary : existsSync(legacy) ? legacy : undefined;
  if (filename) {
    const result = dotenv.config({ path: filename, processEnv: environment, override: false, quiet: true });
    if (result.error)
      throw new EnvironmentConfigurationError('The selected environment file could not be read.');
  }
  return environment;
}

export function assertHttpsPublicOrigin(value) {
  let valid = false;
  try {
    const url = new URL(value);
    valid = url.protocol === 'https:' && value === url.origin;
  } catch {
    // Configured addresses and credentials must never appear in error output.
  }
  if (!valid)
    throw new EnvironmentConfigurationError(
      'PUBLIC_APP_URL must be the exact HTTPS origin without a path, credentials or trailing slash.',
    );
}

/** Validate persistent application settings after selecting one environment file. */
export function loadEnvironment(options = {}) {
  const environment = loadEnvironmentValues(options);
  if (environment.NODE_ENV && !['development', 'test', 'production'].includes(environment.NODE_ENV))
    throw new EnvironmentConfigurationError('NODE_ENV must be development, test or production.');
  const port = Number(environment.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new EnvironmentConfigurationError('PORT must be between 1 and 65535.');
  if (!environment.MONGODB_URI?.trim())
    throw new EnvironmentConfigurationError(
      'Set MONGODB_URI in .example.env, an existing private .env, or the hosting environment.',
    );
  if (environment.NODE_ENV === 'production') {
    assertHttpsPublicOrigin(environment.PUBLIC_APP_URL);
    if (
      environment.INITIAL_ADMIN_PASSWORD &&
      (environment.INITIAL_ADMIN_PASSWORD.length < 12 || environment.INITIAL_ADMIN_PASSWORD.length > 256)
    )
      throw new EnvironmentConfigurationError('INITIAL_ADMIN_PASSWORD must contain 12–256 characters.');
  }
  return { environment, port, host: environment.HOST || '127.0.0.1' };
}
