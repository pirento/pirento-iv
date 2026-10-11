import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentPackages } from './deployment-package.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
if (arguments_.length && (arguments_.length !== 1 || arguments_[0] !== '--synthetic'))
  throw new Error(
    'Use no arguments for persistent deployment, or --synthetic for a disposable test preview.',
  );
for (const archive of createDeploymentPackages({ root, synthetic: arguments_[0] === '--synthetic' }))
  console.log(`Created ${archive}`);
