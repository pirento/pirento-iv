import { assertHostedNodeVersion, selectHostedMode } from './scripts/hosted-startup-config.mjs';

// Disposable data requires an explicit mode. An unknown or empty value fails
// before either application is loaded, rather than selecting another database.
assertHostedNodeVersion();
if (selectHostedMode() === 'disposable-synthetic') {
  await import('./scripts/synthetic-preview-entry.mjs');
} else {
  await import('./production-entry.mjs');
}
