import { afterEach, expect, it, vi } from 'vitest';
import { startScheduler, startServer } from '../src/runtime/node-api';
import { createSqliteStore } from '../src/core/store/sqlite';
import { config } from '../src/core/config';
import type { Env } from '../src/types';
import { createApp } from '../src/index';

afterEach(() => vi.useRealTimers());
it('runs hourly retention and a daily backup without overlap', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const retention = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { finish = r; })).mockResolvedValue(undefined);
  const backup = vi.fn().mockResolvedValue(undefined);
  const stop = startScheduler(retention, backup);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(22 * 3600000);
  expect(backup).toHaveBeenCalledTimes(1);
  await stop();
  const calls = retention.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).toHaveBeenCalledTimes(calls);
});
it('adapts HTTP and drains requests and background work before closing', async () => {
  let finish!: () => void;
  let entered!: () => void;
  let backgroundDone = false;
  const enteredPromise = new Promise<void>(r => { entered = r; });
  const runtime = await startServer(async (req, _env, ctx) => {
    ctx.waitUntil(new Promise<void>(r => { finish = () => { backgroundDone = true; r(); }; }));
    entered();
    return Response.json({ text: await req.text(), ip: req.headers.get('cf-connecting-ip') });
  }, {} as Env, 0);
  const result = fetch(`http://127.0.0.1:${runtime.port}/v1/send`, { method: 'POST', headers: { 'cf-connecting-ip': 'supplied' }, body: 'hello' });
  await enteredPromise;
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  expect(await (await result).json()).toMatchObject({ text: 'hello', ip: '127.0.0.1' });
  expect(closed).toBe(false); finish(); await closing;
  expect(backgroundDone).toBe(true);
});
it('checks the actual store and retains liveness after storage closes', async () => {
  const store = createSqliteStore(':memory:'); await store.migrate();
  const app = createApp({ store, logging: config.logging });
  const call = () => app.fetch(new Request('http://localhost/health'), {} as Env, {} as ExecutionContext);
  expect(await (await call()).json()).toMatchObject({ ok: true, store: 'ok' });
  await store.db.destroy();
  expect(await (await call()).json()).toMatchObject({ ok: true, store: 'down' });
});
