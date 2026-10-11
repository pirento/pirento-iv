import { performance } from 'node:perf_hooks';

export const READINESS_TIMEOUT_MS = 1_500;

/** Liveness is separate; this probe checks whether this process can serve workspace data. */
export function createReadiness({ db, logger, timeoutMs = READINESS_TIMEOUT_MS }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new RangeError('Readiness timeout must be between 1 and 10000 milliseconds.');
  let lifecycle = 'starting';
  let lastReported;
  let pending;
  let controller;

  function result(state, checks) {
    if (lastReported !== state) {
      logger?.[state === 'ready' ? 'info' : 'warn']('readiness_changed', { state });
      lastReported = state;
    }
    return { ok: state === 'ready', ready: state === 'ready', state, ...(checks ? { checks } : {}) };
  }
  function localResult() {
    return lifecycle === 'ready' ? undefined : result(lifecycle);
  }
  async function probe() {
    const started = performance.now();
    const abort = new AbortController();
    controller = abort;
    const budget = () => Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
    let timer;
    let databaseReady = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({
          state: 'unavailable',
          checks: { database: databaseReady ? 'up' : 'unavailable', recovery: 'unknown' },
        });
      }, timeoutMs);
    });
    const inspect = (async () => {
      try {
        await db.database.command({ ping: 1 }, { timeoutMS: budget(), signal: abort.signal });
        databaseReady = true;
        const recovery = await db
          .collection('ops_recovery_state')
          .findOne(
            { id: 1 },
            { projection: { _id: 0, status: 1 }, timeoutMS: budget(), signal: abort.signal },
          );
        return recovery && recovery.status !== 'reviewed'
          ? { state: 'recovery_required', checks: { database: 'up', recovery: 'pending' } }
          : { state: 'ready', checks: { database: 'up', recovery: 'clear' } };
      } catch {
        return {
          state: 'unavailable',
          checks: { database: databaseReady ? 'up' : 'unavailable', recovery: 'unknown' },
        };
      }
    })();
    try {
      const inspected = await Promise.race([inspect, timeout]);
      return localResult() ?? result(inspected.state, inspected.checks);
    } finally {
      clearTimeout(timer);
      if (controller === abort) controller = undefined;
    }
  }
  return {
    check() {
      const local = localResult();
      if (local) return Promise.resolve(local);
      if (!pending) {
        pending = probe().finally(() => {
          pending = undefined;
        });
      }
      return pending;
    },
    markReady() {
      if (lifecycle === 'starting') lifecycle = 'ready';
    },
    beginDrain() {
      if (lifecycle !== 'stopped') lifecycle = 'draining';
      controller?.abort();
    },
    markStopped() {
      lifecycle = 'stopped';
      controller?.abort();
    },
    isDraining: () => lifecycle === 'draining' || lifecycle === 'stopped',
  };
}
