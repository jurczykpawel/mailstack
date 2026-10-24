export async function boundedText(input: Request | Response, limit: number): Promise<string> {
  if (Number(input.headers.get('content-length')) > limit) throw new RangeError();
  const reader = input.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError(); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}
