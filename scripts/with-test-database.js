/**
 * `npm run verify:local` - starts a temporary local MongoDB replica set (needs `mongod` installed),
 * runs the given command against it (normally `npm run verify:release`) and removes it afterwards.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function signalChild(child, signal, processGroup = false) {
  if (!child?.pid) return;
  if (!processGroup) return child.kill(signal);
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stop(child, processGroup = false, shutdownGraceMs = 10_000) {
  if (!child) return;
  const exited = child.exitCode !== null || child.signalCode;
  if (exited && !processGroup) return;
  const finished = exited ? Promise.resolve() : once(child, 'exit').catch(() => {});
  signalChild(child, 'SIGTERM', processGroup);
  const timer = setTimeout(() => signalChild(child, 'SIGKILL', processGroup), shutdownGraceMs);
  try {
    await finished;
  } finally {
    clearTimeout(timer);
    // npm or a shell can exit before its descendants, including children ignoring SIGTERM.
    if (processGroup) signalChild(child, 'SIGKILL', true);
  }
}

/** POSIX commands own a new process group; Windows supports direct-child shutdown only. */
export async function runVerificationCommand(
  args,
  environment = process.env,
  { shutdownGraceMs = 10_000 } = {},
) {
  const processGroup = process.platform !== 'win32';
  const child = spawn(args[0], args.slice(1), {
    stdio: 'inherit',
    env: environment,
    shell: false,
    detached: processGroup,
  });
  let stopping;
  const beginShutdown = () => (stopping ??= stop(child, processGroup, shutdownGraceMs));
  const interrupt = () => {
    // Start escalation now: a command ignoring SIGTERM will not reach finally on its own.
    // The same promise is awaited below, including any shutdown error.
    beginShutdown().catch(() => {});
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    return await once(child, 'exit');
  } finally {
    try {
      await beginShutdown();
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
  }
}

/** Run a command against a fresh local replica set; never open an existing data directory. */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (!args.length) args.push('npm', 'run', 'verify:release');

  const directory = await mkdtemp(join(tmpdir(), 'venturecore-verification-'));
  let databaseProcess;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    databaseProcess?.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);

  try {
    const port = await unusedPort();
    const log = join(directory, 'mongod.log');
    const executable = process.env.MONGOD_BINARY || 'mongod';
    databaseProcess = spawn(
      executable,
      [
        '--replSet',
        'venturecore_test',
        '--bind_ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--dbpath',
        directory,
        '--logpath',
        log,
        '--oplogSize',
        '128',
        '--wiredTigerCacheSizeGB',
        '0.25',
        '--nounixsocket',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let launchError;
    databaseProcess.on('error', (error) => {
      launchError = error;
    });
    // Drain diagnostics; database logs stay inside this temporary test directory.
    databaseProcess.stderr.resume();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (launchError) throw new Error('mongod could not start. Install MongoDB or set MONGOD_BINARY.');

    const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
      serverSelectionTimeoutMS: 10_000,
    });
    try {
      await client.connect();
      await client.db('admin').command({
        replSetInitiate: { _id: 'venturecore_test', members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
      });
      const deadline = Date.now() + 30_000;
      let primary = false;
      while (!interrupted && Date.now() < deadline) {
        primary = Boolean((await client.db('admin').command({ hello: 1 })).isWritablePrimary);
        if (primary) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!primary) throw new Error('The isolated test replica set did not become ready.');
      const { version } = await client.db('admin').command({ buildInfo: 1 });
      console.log(`Isolated MongoDB ${version} replica set ready; running verification.`);
    } catch (error) {
      if (databaseProcess.exitCode !== null) {
        const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n');
        const failure = lines.findLast((line) => /"s":"[EF]"/.test(line));
        if (failure) console.error(failure);
      }
      throw error;
    } finally {
      await client.close();
    }

    if (interrupted) throw new Error('Verification was interrupted.');
    const [code, signal] = await runVerificationCommand(args, {
      ...process.env,
      MONGODB_TEST_URI: `mongodb://127.0.0.1:${port}/?replicaSet=venturecore_test`,
    });
    process.exitCode = code ?? (signal ? 1 : 0);
  } catch (error) {
    console.error(
      error.code === 'ENOENT' ? 'The requested verification command was not found.' : error.message,
    );
    process.exitCode = 1;
  } finally {
    await stop(databaseProcess);
    await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
