import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderJson } from '../../server/integrations/provider-http.ts';

test('provider JSON reader accepts bounded data and rejects oversized declared responses without reading them', async () => {
  assert.deepEqual(await readProviderJson(Response.json({ id: 'provider-id' }), 100), { id: 'provider-id' });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readProviderJson(new Response(body, { headers: { 'content-length': '1000' } }), 100),
    /allowed size/,
  );
  assert.equal(cancelled, true);
});

test('provider JSON reader enforces streamed bytes despite a missing or false content length and cancels the stream', async () => {
  for (const declared of [undefined, '1']) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"secret":"' + 'x'.repeat(1000)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: declared ? { 'content-length': declared } : {} },
    );
    await assert.rejects(
      readProviderJson(response, 100),
      (error) =>
        error instanceof Error && /allowed size/.test(error.message) && !error.message.includes('secret'),
    );
    assert.equal(cancelled, true);
  }
});
