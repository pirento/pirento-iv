import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { validateHostedProduction } from './scripts/hosted-startup-config.mjs';

// Validate hosting settings before importing the application or opening its DB.
// Configure these settings in the hosting environment, not a bundled dotenv file.
const { root } = validateHostedProduction({ root: dirname(fileURLToPath(import.meta.url)) });
process.chdir(root);
register();
await import('./server/index.ts');
