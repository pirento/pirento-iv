import { loadEnvironmentValues } from '../src/config/environment.js';
import {
  createSyntheticPreviewApplication,
  PreviewConfigurationError,
} from '../src/services/preview/synthetic-preview.js';

// Unlike normal startup this launcher selects only explicitly named preview
// credentials. Persistent database, administrator and merchant inputs are ignored.
let application;
try {
  const environment = loadEnvironmentValues({ environment: { ...process.env } });
  application = await createSyntheticPreviewApplication({ environment });
  const server = application.app.listen(Number(application.environment.PORT), application.environment.HOST);
  let stopping = false;
  const close = async () => {
    try {
      await application.close();
    } catch {
      console.error('Disposable preview cleanup failed. Check its isolated MongoDB namespace.');
      process.exitCode = 1;
    }
  };
  server.on('listening', () =>
    console.log('DISPOSABLE SYNTHETIC PREVIEW started. Test data only; external integrations disabled.'),
  );
  server.on('error', async () => {
    console.error('Disposable preview could not listen. Check the host port setting.');
    await close();
    process.exitCode = 1;
  });
  // Deliberately no mail worker or automatic backup scheduler in this mode.
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      server.close(close);
    });
} catch (error) {
  console.error(
    error instanceof PreviewConfigurationError
      ? error.message
      : 'Disposable preview could not start. Check its dedicated MongoDB connection and preview settings.',
  );
  await application?.close().catch(() => {});
  process.exitCode = 1;
}
