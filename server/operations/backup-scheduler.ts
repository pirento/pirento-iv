import type { BackupMetadata } from './database-backup.ts';

interface BackupService {
  createBackup(): Promise<BackupMetadata>;
  listBackups(): Promise<BackupMetadata[]>;
  waitForIdle(): Promise<void>;
}

export function createBackupManager(options: {
  service: BackupService;
  enabled: boolean;
  intervalMinutes: number;
  retention: number;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  let lastSuccessfulAt: string | null = null;
  let lastFailure = false;
  let pending: Promise<BackupMetadata> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
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
        const existing = await options.service.listBackups();
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
      const run = () =>
        void tick().catch(() =>
          console.error(
            'Database backup failed. Check private storage and retry; business data was not changed.',
          ),
        );
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
