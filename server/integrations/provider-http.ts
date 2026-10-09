/** Bound third-party response memory; never include provider bodies in errors. */
export async function readProviderJson<T>(response: Response, maxBytes = 1024 * 1024): Promise<T> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    discardProviderResponse(response);
    throw new Error('Provider response exceeds the allowed size.');
  }
  if (!response.body) throw new Error('Provider returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as T;
  } finally {
    reader.releaseLock();
  }
}

/** Rejected upstream bodies must not retain a pooled network connection. */
export function discardProviderResponse(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}
