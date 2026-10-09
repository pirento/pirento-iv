import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../../server/app.ts';
import { initDb } from '../../server/db/db.ts';

test('CSV failure after headers interrupts the download and leaves the server available', async (t) => {
  const db = initDb(':memory:');
  const organization = 'pipeline2-legal';
  db.prepare('INSERT INTO customers (id, organization_id, data) VALUES (?, ?, ?)').run(
    'synthetic-stream-buyer',
    organization,
    '{}',
  );
  // An operator-corrupted record exercises a streaming read error; the API
  // cannot normally persist invalid JSON. No real database or records are used.
  db.prepare(
    'INSERT INTO documents (id, organization_id, customer_id, kind, number, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'synthetic-stream-document',
    organization,
    'synthetic-stream-buyer',
    'invoice',
    'STREAM/TEST/1',
    'invalid private fixture JSON',
  );
  const app = createApp({ db, auth: false, environment: {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });
  await assert.rejects(async () => {
    const response = await fetch(`${base}/api/documents/export.csv?organizationId=${organization}`);
    await response.text();
  });
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
