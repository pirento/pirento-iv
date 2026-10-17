/** Unit tests: scripts/with-test-database.js stops all child processes when verification is interrupted. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, leaderIgnoresTerm] of [
  ['interrupting verification stops descendants even when the command leader exits first', false],
  ['interrupting verification escalates when the command leader also ignores SIGTERM', true],
])
  test(
    name,
    {
      skip: process.platform === 'win32' && 'Windows supports direct-child shutdown only.',
    },
    async () => {
      // The grandchild deliberately ignores SIGTERM and keeps inherited stdout open.
      // The runner's close event cannot fire until that grandchild has also stopped.
      const descendant = `
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ ready: true, pid: process.pid, parent: process.ppid }));
    setInterval(() => {}, 1000);
  `;
      const command = `
    ${leaderIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''}
    console.log(JSON.stringify({ parent: process.pid }));
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `;
      const moduleUrl = pathToFileURL(resolve('scripts/with-test-database.js')).href;
      const runnerSource = `
    import { runVerificationCommand } from ${JSON.stringify(moduleUrl)};
    const [code, signal] = await runVerificationCommand(
      [process.execPath, '-e', ${JSON.stringify(command)}], process.env, { shutdownGraceMs: 100 }
    );
    console.log(JSON.stringify({ terminationSignal: signal }));
    process.exitCode = code ?? (signal ? 1 : 0);
  `;
      const runner = spawn(process.execPath, ['--input-type=module', '-e', runnerSource], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finished = once(runner, 'close');
      let processIds;
      let output = '';
      let diagnostics = '';
      let ready;
      const started = new Promise((resolve) => {
        ready = resolve;
      });
      runner.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const lines = output.split('\n');
        output = lines.pop();
        for (const line of lines) {
          const value = JSON.parse(line);
          processIds = { ...processIds, ...value };
          if (value.ready) {
            ready();
          }
        }
      });
      runner.stderr.on('data', (chunk) => {
        diagnostics += chunk.toString();
      });
      let completed = false;
      try {
        await within(
          Promise.race([
            started,
            finished.then(() => {
              throw new Error(`Verification exited before descendants started: ${diagnostics}`);
            }),
          ]),
          5_000,
          'Verification descendants did not start.',
        );
        runner.kill('SIGTERM');
        const [code, signal] = await within(
          finished,
          5_000,
          'Verification left a descendant running after interruption.',
        );
        assert.equal(code, 1, diagnostics);
        assert.equal(signal, null, 'The runner should finish its cleanup and exit itself.');
        assert.equal(processIds.terminationSignal, leaderIgnoresTerm ? 'SIGKILL' : 'SIGTERM');
        completed = true;
      } finally {
        if (!completed) {
          // Give the runner its normal cleanup path even if startup was too slow.
          runner.kill('SIGTERM');
          await within(finished, 1_000, 'Cleanup needs forced shutdown.').catch(() => {});
          // Only the process IDs reported by this test's own children may be stopped.
          for (const pid of [-processIds?.parent, processIds?.pid, processIds?.parent, runner.pid]) {
            if (!Number.isInteger(pid)) continue;
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              // eslint-disable-next-line no-unsafe-finally -- surface unexpected kill failures
              if (error.code !== 'ESRCH') throw error;
            }
          }
          await finished.catch(() => {});
        }
      }
    },
  );
