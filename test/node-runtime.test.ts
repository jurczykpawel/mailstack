import { mkdir, mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startScheduler, startServer } from '../src/runtime/node-api';
import { createSqliteStore } from '../src/core/store/sqlite';
import { config } from '../src/core/config';
import type { Env } from '../src/types';
import { createApp } from '../src/index';

let backupDir: string;
beforeEach(async () => {
  await mkdir('dist', { recursive: true });
  backupDir = await mkdtemp(join(process.cwd(), 'dist/scheduler-'));
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await rm(backupDir, { recursive: true }); });
it('runs hourly retention and a daily backup without overlap', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const retention = vi.fn().mockImplementationOnce(() => new Promise<void>(r => { finish = r; })).mockResolvedValue(undefined);
  const backup = vi.fn().mockResolvedValue(undefined);
  const stop = await startScheduler(retention, backup, backupDir);
  await vi.advanceTimersByTimeAsync(30000);
  expect(retention).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(23 * 3600000);
  expect(backup).toHaveBeenCalledTimes(2);
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

it.each(['readonly', 'busy'] as const)('keeps read health separate from required writes: %s', async fault => {
  const filename = join(backupDir, 'store.sqlite');
  let store = createSqliteStore(filename);
  await store.migrate(); await store.db.destroy();
  const connection = new Database(filename, { readonly: fault === 'readonly', timeout: 1 });
  store = createSqliteStore(connection);
  const lock = fault === 'busy' ? new Database(filename) : undefined;
  const logging = structuredClone(config.logging);
  logging.defaults.requireLog = true;
  logging.defaults.level = 'meta';
  const pair = generateKeyPairSync('x25519');
  const env = { API_KEY: 'test-token', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{
    ...pair.publicKey.export({ format: 'jwk' }), kty: 'OKP', crv: 'X25519', kid: 'c1',
  }] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]) } as Env;
  const sender = vi.fn().mockResolvedValue({ ok: true, status: 200,
    smtp: { accepted: ['A@acme.example'], rejected: [] } });
  const app = () => createApp({ store, logging, provider: 'smtp', sendEmail: sender });
  const call = (path: string, init?: RequestInit) => app().fetch(new Request(`http://localhost${path}`, init), env, {} as ExecutionContext);
  const send = () => call('/v1/send', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: 'Bearer test-token',
  }, body: JSON.stringify({ brand: 'acme', template: 'license', to: 'A@acme.example', licenseKey: 'TEST-END4' }) });
  try {
    lock?.exec('BEGIN IMMEDIATE');
    const health = await call('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, store: 'ok' });
    const failed = await send();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ success: false, code: 'log_unavailable' });
    expect(sender).not.toHaveBeenCalled();
    expect(await store.db.selectFrom('messages').select('id').execute()).toEqual([]);
    lock?.exec('ROLLBACK');
    await store.db.destroy();
    const closed = await call('/health');
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ ok: true, store: 'down' });
    expect((await send()).status).toBe(503);
    expect(sender).not.toHaveBeenCalled();
    store = createSqliteStore(filename);
    expect(await (await call('/health')).json()).toMatchObject({ ok: true, store: 'ok' });
    expect((await send()).status).toBe(200);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await store.db.selectFrom('messages').select(['status', 'provider']).execute()).toEqual([{ status: 'sent', provider: 'smtp' }]);
    expect(await store.db.selectFrom('recipients').select('status').execute()).toEqual([{ status: 'accepted' }]);
  } finally {
    if (lock?.inTransaction) lock.exec('ROLLBACK');
    lock?.close(); await store.db.destroy();
  }
});

it.each([undefined, 'cloudflare', 'proxy'])('uses the configured client address for rate limits: %s', async mode => {
  const { memoryStore } = await import('./store-fixture');
  const { checkRateLimit } = await import('../src/ratelimit');
  const store = memoryStore();
  const runtime = await startServer(async req => {
    const ip = req.headers.get('cf-connecting-ip')!;
    const allowed = await checkRateLimit(store, 'acme', ip, new Date('2026-10-25T12:00:00Z'));
    return Response.json({ ip, forwarded: req.headers.get('x-forwarded-for') }, { status: allowed ? 200 : 429 });
  }, { TRUSTED_PROXY: mode } as Env, 0);
  try {
    for (let i = 1; i <= 9; i++) {
      const cf = `192.0.2.${i}`, last = `198.51.100.${i}`;
      const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/send`, { headers: {
        connection: 'close', 'cf-connecting-ip': cf, 'x-forwarded-for': `203.0.113.1, ${last}`,
      } });
      const expected = mode === 'cloudflare' ? cf : mode === 'proxy' ? last : '127.0.0.1';
      expect(await response.json()).toEqual({ ip: expected, forwarded: expected });
      expect(response.status).toBe(!mode && i === 9 ? 429 : 200);
    }
  } finally { await runtime.close(); }
});
it.each(['other', 'forwarded'])('refuses an unknown proxy mode before listening: %s', async mode => {
  await expect(startServer(async () => new Response(), { TRUSTED_PROXY: mode } as Env, 0)).rejects.toThrow('TRUSTED_PROXY');
});

it.each([undefined, 25, 23])('checks backup age from disk at startup: %s hours', async age => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  if (age !== undefined) {
    for (const [name, hours] of [['mailstack-20260101.db', age], ['mailstack-20261025.db', 48]] as const) {
      const file = join(backupDir, name); await writeFile(file, 'snapshot');
      const modified = new Date(Date.now() - hours * 3600000); await utimes(file, modified, modified);
    }
  }
  await writeFile(join(backupDir, 'mailstack-20261025.db.tmp'), 'pending');
  const retention = vi.fn().mockResolvedValue(undefined), backup = vi.fn().mockResolvedValue(undefined);
  const stop = await startScheduler(retention, backup, backupDir);
  await vi.advanceTimersByTimeAsync(0);
  expect(backup).toHaveBeenCalledTimes(age === 23 ? 0 : 1);
  expect(retention).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30000);
  expect(retention).toHaveBeenCalledTimes(1);
  await stop();
});
it('continues maintenance after retention and backup errors', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const retention = vi.fn().mockRejectedValueOnce(new Error('retention unavailable')).mockResolvedValue(undefined);
  const backup = vi.fn().mockRejectedValueOnce(new Error('backup unavailable')).mockResolvedValue(undefined);
  const stop = await startScheduler(retention, backup, backupDir);
  await vi.advanceTimersByTimeAsync(30000);
  expect(retention).toHaveBeenCalledTimes(1);
  expect(backup).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).toHaveBeenCalledTimes(2);
  expect(backup).toHaveBeenCalledTimes(2);
  await stop();
});
it('drains startup backup and skips overlapping maintenance', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const backup = vi.fn().mockImplementation(() => new Promise<void>(r => { finish = r; }));
  const retention = vi.fn();
  const stop = await startScheduler(retention, backup, backupDir);
  await vi.advanceTimersByTimeAsync(3600000);
  expect(backup).toHaveBeenCalledTimes(1); expect(retention).not.toHaveBeenCalled();
  let stopped = false; const closing = stop().then(() => { stopped = true; });
  expect(stopped).toBe(false); finish(); await closing;
  await vi.advanceTimersByTimeAsync(3600000);
  expect(retention).not.toHaveBeenCalled();
});

it('backs up when the backup directory does not exist yet', async () => {
  vi.useFakeTimers(); const backup = vi.fn().mockResolvedValue(undefined);
  const stop = await startScheduler(vi.fn(), backup, join(backupDir, 'new'));
  await vi.advanceTimersByTimeAsync(0); expect(backup).toHaveBeenCalledTimes(1);
  await stop();
});
