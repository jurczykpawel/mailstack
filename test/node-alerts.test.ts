import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { startServer } from '../src/runtime/node-api';
import { config } from '../src/core/config';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { Env } from '../src/types';

it.each(['/v1/send', '/v1/hooks/sellf'])('drains the pending alert for %s before Node closes', async path => {
  const store = createSqliteStore(':memory:'); await store.migrate();
  const publicKey = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' });
  const env = { API_KEY: 'test-key', NTFY_URL: 'https://ntfy.example/demo', PANEL_URL: 'https://panel.example',
    CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...publicKey, kid: 'c1' }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]),
  } as Env;
  const logging = structuredClone(config.logging); logging.defaults.alertOn = ['send_failed'];
  const app = createApp({ store, logging, sendEmail: async () => ({ ok: false, status: 500 }) });
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const originalFetch = globalThis.fetch;
  const notify = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    entered(); return new Promise<Response>(resolve => { finish = () => resolve(new Response()); });
  });
  const runtime = await startServer((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext), env, 0);
  let closing: Promise<void> | undefined;
  try {
    const body = path === '/v1/send' ? { brand: 'acme', template: 'notice', to: 'buyer@example.com', paragraphs: 'Test' }
      : { event: 'purchase.completed', timestamp: new Date().toISOString(), data: { customer: { email: 'buyer@example.com' }, order: { sessionId: 'order-1', amount: 100 }, product: { name: 'Plan' } } };
    let status: number | undefined;
    const response = originalFetch(`http://127.0.0.1:${runtime.port}${path}?brand=acme`, { method: 'POST',
      headers: { authorization: 'Bearer test-key', connection: 'close' }, body: JSON.stringify(body) }).then(result => { status = result.status; return result; });
    await started;
    await expect.poll(() => status).toBe(502);
    await response;
    let closed = false; closing = runtime.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false);
    finish(); await closing;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1]?.headers).toMatchObject({ Click: expect.stringContaining(env.PANEL_URL!) });
  } finally { finish?.(); await (closing ?? runtime.close()); notify.mockRestore(); await store.db.destroy(); }
});
