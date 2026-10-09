import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
import { prepareSyntheticPreview } from './synthetic-preview-config.mjs';
import { installPreviewNetworkLock } from './preview-network-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const prepared = prepareSyntheticPreview({ root });
register();
// Load the TS module graph before disabling client sockets used by the loader.
const { createSyntheticPreviewApp } = await import('../server/preview/preview-app.ts');
installPreviewNetworkLock();
const app = createSyntheticPreviewApp({ root, environment: prepared.environment });
await app.locals.initialize();
const server = app.listen(Number(prepared.environment.PORT), prepared.environment.HOST);
// Deliberately no mail worker and no automatic backup scheduler in this mode.
server.on('listening', () =>
  console.log('DISPOSABLE SYNTHETIC PREVIEW started. Test data only; external integrations disabled.'),
);
server.on('error', () => {
  console.error('Disposable preview could not listen. Check the host port setting.');
  process.exitCode = 1;
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(async () => {
      await app.locals.services.backups.stop();
      app.locals.services.db.close();
    });
  });
