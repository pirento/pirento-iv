/**
 * Background automation loop: once a minute it runs due recurring-invoice schedules and
 * automatic payment reminders. Started with the HTTP server, stopped on shutdown.
 */

import { performance } from 'node:perf_hooks';

// How often due schedules and reminders are checked.
export const AUTOMATION_INTERVAL_MS = 60_000;

/** One bounded pass per minute; each feature keeps its durable cross-process guards. */
export function createAutomationRunner({
  recurringInvoices,
  reminders,
  logger,
  intervalMs = AUTOMATION_INTERVAL_MS,
  monotonicNow = () => performance.now(),
}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1)
    throw new RangeError('Automation interval must be a positive number of milliseconds.');
  const jobs = [
    ['recurring', recurringInvoices],
    ['reminders', reminders],
  ].filter(([, service]) => service);
  let lastStarted = -Infinity;
  let pending;
  let stopped = false;
  let stopping;

  function processDue() {
    if (stopped) return Promise.resolve({ stopped: true });
    if (pending) return pending;
    const started = monotonicNow();
    if (started - lastStarted < intervalMs) return Promise.resolve({ waiting: true });
    lastStarted = started;
    pending = (async () => {
      const result = {};
      for (const [stage, service] of jobs) {
        if (stopped) break;
        try {
          result[stage] = await service.processDue();
        } catch (error) {
          logger?.error('automation_failed', { stage, error });
          result[stage] = { failed: true };
        }
      }
      return result;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    // Call both stops now, before awaiting an active pass, so neither can take more work.
    const stops = jobs.map(([, service]) => {
      try {
        return Promise.resolve(service.stop?.());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    stopping = Promise.allSettled([...stops, pending]).then((results) => {
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Automation shutdown did not complete cleanly.');
    });
    return stopping;
  }

  return { processDue, stop };
}
