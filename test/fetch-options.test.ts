import { beforeAll, expect, it, vi } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createNtfyNotifier } from '../src/adapters/notify/ntfy';
import { confirm, createVerifier } from '../src/events/sns';
import { certificates, options, signed, topic } from './sns-fixture';

let cert: string, key: string;
beforeAll(() => { ({ cert, key } = certificates()); });

it('confirms subscriptions with supported fetch options', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.redirect === 'error') throw new TypeError('Invalid redirect value');
    return new Response();
  });
  await expect(confirm({ TopicArn: topic, SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(topic)}` }, fetcher)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.objectContaining({ method: 'GET', redirect: 'manual' }));
});

it.each([300, 301, 302, 303, 304, 305, 306, 307, 308, 399, 'opaqueredirect'] as const)('declines fetch response %s', async status => {
  const body = signed(key);
  const fetcher = vi.fn<typeof fetch>(async () => {
    const response = status === 'opaqueredirect' ? Response.error() : new Response(null, { status, headers: { location: 'https://other.example/' } });
    if (status === 'opaqueredirect') Object.defineProperty(response, 'type', { value: status });
    return response;
  });
  const verify = createVerifier(fetcher);
  expect(await verify(body, body.Type, options)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValueOnce(new Response(cert));
  expect(await verify(body, body.Type, options)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await expect(confirm({ TopicArn: topic, SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(topic)}` }, fetcher)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
  await expect(createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo' }, fetcher).notify({ title: 'title', body: 'body', priority: 'default' })).rejects.toThrow('Notification failed');
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it('uses native worker fetch for notification and SNS requests', async () => {
  const script = buildSync({ stdin: { contents: `
    import { createNtfyNotifier } from './src/adapters/notify/ntfy';
    import { confirm, createVerifier } from './src/events/sns';
    export default { async fetch(req, env) {
      const { body, options, status } = await req.json();
      const fetcher = (url, init) => fetch(url, { ...init, headers: { 'test-status': String(status) } });
      const verified = await createVerifier(fetcher)(body, body.Type, options);
      let notified = false, confirmed = false;
      try { await createNtfyNotifier({ NTFY_URL: 'https://ntfy.example/demo' }, fetcher).notify({ title: 'title', body: 'body', priority: 'default' }); notified = true; } catch {}
      try { await confirm(body, fetcher); confirmed = true; } catch {}
      return Response.json({ verified, notified, confirmed });
    } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'browser' }).outputFiles[0].text;
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'client', modules: true, script, compatibilityDate: '2026-06-01', outboundService: 'upstream' },
    { name: 'upstream', modules: true, compatibilityDate: '2026-06-01', bindings: { CERT: cert }, script: `
      export default { fetch(req, env) {
        if (new URL(req.url).hostname === 'other.example') return new Response(env.CERT);
        return new Response(env.CERT, { status: Number(req.headers.get('test-status')), headers: { location: 'https://other.example/' } });
      } };` },
  ] }));
  try {
    const body = signed(key, undefined, { Type: 'SubscriptionConfirmation', Token: 'token',
      SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?TopicArn=${encodeURIComponent(topic)}` });
    for (const status of [200, 302]) {
      const response = await mf.dispatchFetch('https://mail.example/', { method: 'POST', body: JSON.stringify({ body, options, status }) });
      expect(await response.json()).toEqual({ verified: status === 200, notified: status === 200, confirmed: status === 200 });
    }
  } finally { await mf.dispose(); }
});
