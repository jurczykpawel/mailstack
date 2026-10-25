import { loadExtensions } from './extensions';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../core/config';
import { effectivePolicies } from '../core/config/schema';
import { parseKeyring } from '../core/keyring';
import { createSqliteStore } from '../core/store/sqlite';
import { runRetention } from '../core/retention';
import { backupSqlite } from '../core/store/backup';
import { createApp } from '../index';
import { sendEmail } from '../ses';
import { smtpFromEnv } from '../adapters/sender/smtp';
import type { Env } from '../types';

type Fetch = (req: Request, env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) => Promise<Response>;
async function latestBackup(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const times = await Promise.all(entries.filter(entry => entry.isFile() && /^mailstack-.+\.db$/.test(entry.name))
      .map(async entry => (await stat(join(dir, entry.name))).mtimeMs));
    return Math.max(0, ...times);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
}
export async function startScheduler(retention: () => Promise<unknown>, backup: () => Promise<unknown>, dir = '/data/backups') {
  let backedUp = await latestBackup(dir), running: Promise<void> | undefined;
  const attempt = async (task: () => Promise<unknown>) => {
    try { await task(); } catch { console.error('Scheduled maintenance failed'); }
  };
  const run = (retain: boolean) => {
    if (running) return;
    running = (async () => {
      if (retain) await attempt(retention);
      if (Date.now() - backedUp >= 86400000) await attempt(async () => { await backup(); backedUp = Date.now(); });
    })().finally(() => { running = undefined; });
  };
  run(false);
  const initial = setTimeout(() => run(true), 30000);
  const timer = setInterval(() => run(true), 3600000);
  return async () => { clearTimeout(initial); clearInterval(timer); await running; };
}
export async function startServer(handler: Fetch, env: Env, port = 8080) {
  const proxy = env.TRUSTED_PROXY;
  if (proxy !== undefined && proxy !== 'cloudflare' && proxy !== 'proxy') throw new Error('Invalid TRUSTED_PROXY');
  const pending = new Set<Promise<unknown>>();
  const ctx = { waitUntil(task: Promise<unknown>) {
    const tracked = task.catch(() => {}).finally(() => pending.delete(tracked)); pending.add(tracked);
  } };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const forwarded = proxy === 'cloudflare' ? headers.get('cf-connecting-ip')
        : proxy === 'proxy' ? headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
      const ip = forwarded && isIP(forwarded) ? forwarded : incoming.socket.remoteAddress ?? '';
      headers.set('cf-connecting-ip', ip);
      headers.set('x-forwarded-for', ip);
      const init: RequestInit & { duplex?: 'half' } = { method: incoming.method, headers };
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>; init.duplex = 'half';
      }
      const response = await handler(new Request(new URL(incoming.url ?? '/', 'http://localhost:8080'), init), env, ctx);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Listener unavailable');
  return { port: address.port, async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    while (pending.size) await Promise.all([...pending]);
  } };
}
async function main() {
  process.umask(0o077);
  const env: Env = { ...process.env, SES_REGION: process.env.SES_REGION ?? 'eu-west-1',
    SES_ACCESS_KEY_ID: process.env.SES_ACCESS_KEY_ID ?? '', SES_SECRET_ACCESS_KEY: process.env.SES_SECRET_ACCESS_KEY ?? '',
    TURNSTILE_SECRET: process.env.TURNSTILE_SECRET ?? '', ALTCHA_HMAC_KEY: process.env.ALTCHA_HMAC_KEY ?? '', API_KEY: process.env.API_KEY ?? '' };
  if (env.CONTENT_PUBLIC_KEYS || env.INDEX_KEYS || effectivePolicies(config).some(p => p.policy.level !== 'none' && p.policy.requireLog)) parseKeyring(env);
  const provider = config.sender?.type ?? 'ses';
  if (provider === 'ses' && (!env.SES_ACCESS_KEY_ID || !env.SES_SECRET_ACCESS_KEY)) throw new Error('SES configuration required');
  const sender = provider === 'smtp' ? smtpFromEnv(process.env) : sendEmail;
  await mkdir('/data', { recursive: true, mode: 0o700 });
  const database = new Database('/data/mailstack.db');
  const store = createSqliteStore(database);
  try {
    await store.migrate();
    const extensions = await loadExtensions(config, store);
    const app = createApp({ store, sendEmail: sender, provider, emitEvent: extensions.emitEvent });
    const stop = await startScheduler(() => runRetention(store, Date.now(), config), () => backupSqlite(database, '/data/backups', Date.now()));
    const server = await startServer((req, env, ctx) => app.fetch(req, env, ctx as ExecutionContext), env)
      .catch(async error => { await stop(); throw error; });
    const internal = await startServer((req, env) => extensions.fetch(req, env), env, 8081)
      .catch(async error => { await Promise.all([server.close(), stop()]); throw error; });
    let closing = false;
    const shutdown = async () => {
      if (closing) return; closing = true;
      await Promise.all([server.close(), internal.close(), stop()]); await store.db.destroy();
    };
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  } catch (error) { await store.db.destroy(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error && /^\$\.extensions\.\d+\.module:/.test(error.message) ? error.message : 'Node API startup failed'); process.exitCode = 1; });
}
