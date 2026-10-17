/**
 * Scheduled database backups. tick() is called periodically and starts a backup when the
 * configured interval (BACKUP_INTERVAL_MINUTES) has passed since the last successful one.
 * Only one backup runs at a time; status() feeds the Backups page.
 */

/** Returns { create, tick, status, initialize, start, stop } for the backup schedule. */
export function createBackupManager(options) {
  const now = options.now ?? (() => new Date());
  let lastSuccessfulAt = null;
  let lastFailure = false;
  let pending;
  let timer;
  let stopping = false;
  function create() {
    if (stopping) return Promise.reject(new Error('The backup service is stopping.'));
    if (pending) return pending;
    const job = options.service.createBackup().then(
      (metadata) => {
        lastSuccessfulAt = metadata.createdAt;
        lastFailure = Boolean(metadata.retentionWarning);
        return metadata;
      },
      (error) => {
        lastFailure = true;
        throw error;
      },
    );
    pending = job;
    void job
      .finally(() => {
        if (pending === job) pending = undefined;
      })
      .catch(() => {});
    return job;
  }
  async function tick() {
    if (stopping || !options.enabled || pending) return;
    const elapsed = lastSuccessfulAt ? now().getTime() - new Date(lastSuccessfulAt).getTime() : Infinity;
    if (elapsed >= options.intervalMinutes * 60_000) await create();
  }
  return {
    create,
    tick,
    status() {
      return {
        available: true,
        enabled: options.enabled,
        intervalMinutes: options.intervalMinutes,
        retention: options.retention,
        running: Boolean(pending),
        lastSuccessfulAt,
        lastFailure,
        location: 'private_server_storage',
        remoteConfigured: false,
      };
    },
    async initialize() {
      try {
        const existing = await (options.service.listBackupMetadata ?? options.service.listBackups)();
        lastSuccessfulAt =
          existing
            .map((item) => item.createdAt)
            .sort()
            .at(-1) ?? null;
      } catch {
        lastFailure = true;
      }
    },
    start() {
      if (timer || stopping || !options.enabled) return;
      const run = () => void tick().catch((error) => options.logger?.error('backup_failed', { error }));
      timer = setInterval(run, Math.min(options.intervalMinutes * 60_000, 60_000));
      timer.unref();
      run();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      await pending?.catch(() => {});
      await options.service.waitForIdle();
    },
  };
}
