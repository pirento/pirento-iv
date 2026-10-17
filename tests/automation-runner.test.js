/** Unit tests: the automation runner (recurring invoices + reminders) coalesces passes and stops cleanly. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationRunner } from '../src/services/operations/automation-runner.js';
import { createLogger } from '../src/services/operations/logger.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('Automation passes coalesce and a feature failure does not starve the other scheduler', async () => {
  let clock = 0;
  let recurringCalls = 0;
  let reminderCalls = 0;
  const gate = deferred();
  const logs = [];
  const runner = createAutomationRunner({
    monotonicNow: () => clock,
    logger: createLogger({ write: (line) => logs.push(JSON.parse(line)) }),
    recurringInvoices: {
      processDue: async () => {
        recurringCalls++;
        await gate.promise;
        throw new Error('A private document value must never be logged');
      },
    },
    reminders: {
      processDue: async () => {
        reminderCalls++;
        return { queued: 1 };
      },
    },
  });
  const first = runner.processDue();
  assert.equal(runner.processDue(), first);
  gate.resolve();
  assert.deepEqual(await first, { recurring: { failed: true }, reminders: { queued: 1 } });
  assert.equal(recurringCalls, 1);
  assert.equal(reminderCalls, 1);
  assert.deepEqual(await runner.processDue(), { waiting: true });
  clock = 60_000;
  await runner.processDue();
  assert.equal(recurringCalls, 2);
  assert.equal(reminderCalls, 2);
  assert.equal(logs[0].event, 'automation_failed');
  assert.equal(logs[0].stage, 'recurring');
  assert.equal(JSON.stringify(logs).includes('private'), false);
  await runner.stop();
});

test('Stopping automation drains its active pass and never starts the next scheduler', async () => {
  const generation = deferred();
  const stopped = [];
  let reminderCalls = 0;
  const runner = createAutomationRunner({
    recurringInvoices: {
      processDue: () => generation.promise,
      stop: () => {
        stopped.push('recurring');
      },
    },
    reminders: {
      processDue: async () => {
        reminderCalls++;
      },
      stop: () => {
        stopped.push('reminders');
      },
    },
  });
  const active = runner.processDue();
  const stop = runner.stop();
  assert.equal(runner.stop(), stop);
  assert.deepEqual(stopped, ['recurring', 'reminders']);
  let drained = false;
  stop.then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  generation.resolve({ generated: 1 });
  await Promise.all([active, stop]);
  assert.equal(reminderCalls, 0);
  assert.deepEqual(await runner.processDue(), { stopped: true });
});

test('A failed feature stop still waits for the other cleanup and the accepted generation', async () => {
  const generation = deferred();
  const cleanup = deferred();
  const runner = createAutomationRunner({
    recurringInvoices: {
      processDue: () => generation.promise,
      stop: () => {
        throw new Error('stop failed');
      },
    },
    reminders: { processDue: async () => {}, stop: () => cleanup.promise },
  });
  runner.processDue();
  const result = assert.rejects(runner.stop(), AggregateError);
  let completed = false;
  result.then(() => {
    completed = true;
  });
  generation.resolve();
  await Promise.resolve();
  assert.equal(completed, false);
  cleanup.resolve();
  await result;
});
