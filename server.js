import { createApplication } from './src/app.js';
import { loadEnvironment } from './src/config/environment.js';
import { validateHostedProduction } from './src/config/production.js';
import { createLogger } from './src/services/operations/logger.js';
import { createHttpRuntime } from './src/services/operations/http-runtime.js';

const logger = createLogger();
let application;
let runtime;
let stage = 'environment';
logger.info('server_starting');
try {
  const { environment, host, port } = loadEnvironment();
  if (environment.NODE_ENV === 'production') await validateHostedProduction(environment);
  stage = 'application';
  application = await createApplication({ environment, logger });
  stage = 'http';
  runtime = createHttpRuntime(application, {
    host,
    port,
    logger,
    onServerError: () => {
      process.exitCode = 1;
    },
    onForcedShutdown: () => process.exit(1),
  });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void runtime.stop(signal).then((result) => {
        if (result.failed) process.exitCode = 1;
      });
    });
  for (const [event, reason] of [
    ['uncaughtException', 'uncaught_exception'],
    ['unhandledRejection', 'unhandled_rejection'],
  ])
    process.on(event, (error) => {
      logger.error(reason, { error });
      process.exitCode = 1;
      void runtime.stop(reason).finally(() => process.exit(1));
    });
  await runtime.ready;
} catch (error) {
  logger.error('server_start_failed', { error, stage });
  process.exitCode = 1;
  if (runtime) await runtime.stop('startup_error');
  else if (application)
    await application.close().catch((closeError) => {
      logger.error('shutdown_failed', { error: closeError });
    });
}
