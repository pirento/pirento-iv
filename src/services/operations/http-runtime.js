import { performance } from 'node:perf_hooks';

export const SHUTDOWN_GRACE_MS = 30_000;

const invoke = (operation) => {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Stop new work first, then finish accepted requests and owned worker deliveries. */
export function createHttpRuntime(
  application,
  {
    host,
    port,
    logger = application.logger,
    shutdownGraceMs = SHUTDOWN_GRACE_MS,
    onForcedShutdown,
    onServerError,
  } = {},
) {
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1)
    throw new RangeError('Shutdown grace must be a positive number of milliseconds.');
  const server = application.app.listen(port, host);
  let worker = Promise.resolve();
  let workerRunning = false;
  let stopping = false;
  let interval;
  let stopPromise;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function processMail() {
    if (workerRunning || stopping) return;
    workerRunning = true;
    worker = invoke(async () => {
      await application.automations?.processDue();
      if (!stopping) await application.mailer.processQueue();
    })
      .catch((error) => logger.error('email_worker_failed', { error }))
      .finally(() => {
        workerRunning = false;
      });
  }
  function stop(reason = 'manual') {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(interval);
    application.beginShutdown();
    const started = performance.now();
    logger.info('shutdown_started', { reason, state: 'draining' });

    // stop() is called synchronously so a mail worker cannot claim another row.
    const mailStopped = invoke(() =>
      application.mailer.stop?.({
        graceMs: Math.min(20_000, Math.max(0, shutdownGraceMs - 5_000)),
      }),
    );
    const backupsStopped = invoke(() => application.backups.stop());
    const automationsStopped = invoke(() => application.automations?.stop());
    const httpStopped = new Promise((resolve) => {
      server.close((error) => resolve(error?.code === 'ERR_SERVER_NOT_RUNNING' ? undefined : error));
      server.closeIdleConnections?.();
    });

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ forced: true, failed: true }), shutdownGraceMs);
    });
    const complete = (async () => {
      let failed = false;
      const jobs = await Promise.allSettled([
        httpStopped,
        mailStopped,
        worker,
        backupsStopped,
        automationsStopped,
      ]);
      for (const job of jobs) {
        const error =
          job.status === 'rejected' ? job.reason : job.value instanceof Error ? job.value : undefined;
        if (error) {
          failed = true;
          logger.error('shutdown_failed', { error });
        }
      }
      try {
        await application.close();
      } catch (error) {
        failed = true;
        logger.error('shutdown_failed', { error, stage: 'database' });
      }
      return { forced: false, failed };
    })();
    stopPromise = Promise.race([complete, deadline]).then((result) => {
      clearTimeout(timer);
      if (result.forced) {
        server.closeAllConnections?.();
        application.readiness.markStopped();
        logger.error('shutdown_timeout', {
          reason,
          forced: true,
          durationMs: performance.now() - started,
        });
        onForcedShutdown?.();
      } else {
        logger.info('shutdown_completed', {
          reason,
          state: 'stopped',
          forced: false,
          durationMs: performance.now() - started,
        });
      }
      return result;
    });
    return stopPromise;
  }
  server.once('listening', () => {
    logger.info('server_listening', { port: server.address()?.port });
    if (!stopping) {
      application.backups.start();
      processMail();
      interval = setInterval(processMail, 15_000);
      interval.unref();
    }
    resolveReady();
  });
  server.on('error', (error) => {
    logger.error('server_start_failed', { error, stage: 'http' });
    rejectReady(error);
    onServerError?.();
    void stop('server_error');
  });
  return { server, ready, stop };
}
