export async function readProviderJson(response, maxBytes = 1024 * 1024) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    discardProviderResponse(response);
    throw new Error('Provider response exceeds the allowed size.');
  }
  if (!response.body) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error('Provider response exceeds the allowed size.');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}
export function discardProviderResponse(response) {
  void response.body?.cancel().catch(() => undefined);
}
