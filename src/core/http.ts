// Transit envelope bounds live here, without the crypto module, so Node strip-only setup can load them.
/** An opened value (replay, `ref`, address) holds what one accepted send (64 KiB body) can produce: a replay adds its recipient
 *  array, built markup blocks and keys (65 536 B body → 65 616 B replay, measured), within 4 KiB. The payload adds its one-key wrapper. */
export const MAX_OPENED = 64 * 1024 + 4096;
export const MAX_ENVELOPE = 2 * MAX_OPENED;
/** A request carrying one envelope (HPKE + base64url, under `MAX_ENVELOPE`) and its form fields, URL- or JSON-encoded:
 *  the bound for the panel body limit, the panel assertion and the API route parser alike. */
export const TRANSIT_REQUEST_BYTES = MAX_ENVELOPE + 16 * 1024;

export async function boundedBytes(input: Request | Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(input.headers.get('content-length')) > limit) throw new RangeError();
  const reader = input.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw new RangeError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function boundedText(input: Request | Response, limit: number): Promise<string> {
  return new TextDecoder().decode(await boundedBytes(input, limit));
}
