import { createApp } from './app.ts';
import { existsSync } from 'node:fs';

// Native Node 24 env parsing keeps provider credentials exclusively on the server.
if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
// Account sessions protect business APIs. Public pages and signature-verified
// gateway webhooks remain reachable without a browser session.
const app = createApp();
await app.locals.initialize();
const server = app.listen(port, host);
let worker: Promise<unknown> = Promise.resolve();
let workerRunning = false;
const processMail = () => {
  if (workerRunning) return;
  workerRunning = true;
  worker = app.locals.services.mailer
    .processQueue()
    .catch(() =>
      console.error('Email worker could not complete this batch; pending deliveries remain in the queue.'),
    )
    .finally(() => {
      workerRunning = false;
    });
};
const interval = setInterval(processMail, 15_000);
interval.unref();
server.on('listening', () => {
  console.log(`Venturecore workspace API listening on http://${host}:${port}`);
  processMail();
});
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`Unable to start the workspace at ${host}:${port}: ${error.code || error.message}`);
  process.exitCode = 1;
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    server.close(async () => {
      await worker;
      app.locals.services.db.close();
    });
  });
