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
