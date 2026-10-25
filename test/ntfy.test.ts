import { afterEach, expect, it, vi } from 'vitest';
import { createNtfyNotifier } from '../src/adapters/notify/ntfy';
afterEach(() => vi.restoreAllMocks());
it('posts the notification with optional metadata', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
    return new Response();
  });
  await createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo', NTFY_TOKEN: 'token' }, fetcher).notify({
    title: 'mailstack: complaint acme/notice', body: 'b***@e***.com · complaint', priority: 'high', click: 'https://panel.example/m/msg_1',
  });
  expect(fetcher).toHaveBeenCalledWith('https://ntfy.example/demo', expect.objectContaining({
    method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
    headers: { Title: 'mailstack: complaint acme/notice', Priority: 'high', Click: 'https://panel.example/m/msg_1', Authorization: 'Bearer token' },
  }));
});
it('does nothing without a URL', async () => {
  const fetcher = vi.fn();
  await createNtfyNotifier({}, fetcher).notify({ title: 'title', body: 'body', priority: 'default' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('aborts after five seconds', async () => {
  vi.useFakeTimers();
  try {
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('timeout'))));
    const result = createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo' }, fetcher).notify({ title: 'title', body: 'body', priority: 'default' });
    const assertion = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  } finally { vi.useRealTimers(); }
});
it('omits optional headers and reports provider refusal', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  await expect(createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo' }, fetcher).notify({ title: 'title', body: 'body', priority: 'default' })).rejects.toThrow();
  expect(fetcher.mock.calls[0][1].headers).toEqual({ Title: 'title', Priority: 'default' });
});
