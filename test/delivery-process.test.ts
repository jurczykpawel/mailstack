import { build } from 'esbuild';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { expect, it } from 'vitest';
import example from '../config/mailstack.example.json';
import { createSqliteStore } from '../src/core/store/sqlite';
import { runRetention } from '../src/core/retention';
import { loadConfig } from '../src/core/config/load';

it('retains delivery state across API restarts and an interrupted SMTP response', async () => {
  mkdirSync('dist', { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), 'dist/delivery-process-'));
  const sockets = new Set<Socket>();
  const mimes: string[] = [];
  let hold = false, received!: () => void;
  const smtp = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('220 smtp.example ESMTP\r\n');
    let buffer = '', data = false, mime = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            mimes.push(mime); mime = ''; data = false;
            if (hold) received(); else socket.write('250 OK queued as fixture\r\n');
          } else mime += line + '\r\n';
        } else if (line.startsWith('EHLO')) socket.write('250 smtp.example\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 Send message\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  };
  try {
    await build({ entryPoints: ['test/fixtures/delivery-process.ts'], outfile: join(directory, 'api.mjs'),
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
    smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening');
    const smtpAddress = smtp.address();
    if (!smtpAddress || typeof smtpAddress === 'string') throw new Error('No SMTP port');
    const kem = new DhkemX25519HkdfSha256(), pair = await kem.generateKeyPair();
    const env = { ...process.env, API_KEY: 'test-key', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpAddress.port), SMTP_SECURE: 'false', SMTP_URL: '', SMTP_USER: '', SMTP_PASS: '',
      CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ kid: 'c1', kty: 'OKP', crv: 'X25519',
        x: Buffer.from(await kem.serializePublicKey(pair.publicKey)).toString('base64url') }] }),
      INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) };
    const input = structuredClone(example);
    const cfgPath = join(directory, 'config.json'), dbPath = join(directory, 'db.sqlite');
    const start = async (level: 'masked' | 'none') => {
      await stop();
      input.logging.defaults.level = level;
      writeFileSync(cfgPath, JSON.stringify(input));
      child = fork(join(directory, 'api.mjs'), [cfgPath, dbPath], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const [message] = await once(child, 'message') as [{ port: number }];
      return message.port;
    };
    const send = (port: number, key: string) => fetch(`http://127.0.0.1:${port}/v1/send`, {
      method: 'POST', headers: { authorization: 'Bearer test-key', 'Idempotency-Key': key },
      body: JSON.stringify({ brand: 'acme', template: 'payment', to: 'buyer@acme.example', amount: '23.41', currency: 'PLN', ref: key }),
    });
    for (const first of ['masked', 'none'] as const) {
      const key = 'transition-' + first;
      expect((await send(await start(first), key)).status).toBe(200);
      const before = mimes.length;
      expect(await (await send(await start(first === 'masked' ? 'none' : 'masked'), key)).json()).toMatchObject({ success: true, idempotent: true });
      expect(mimes).toHaveLength(before);
    }
    expect(mimes).toHaveLength(2);
    for (const mime of mimes) expect(mime).toContain('23.41');
    const port = await start('masked');
    hold = true;
    const inSmtp = new Promise<void>(resolve => { received = resolve; });
    const interrupted = send(port, 'interrupted').catch(() => undefined);
    await inSmtp;
    const store = createSqliteStore(dbPath);
    try {
      const [row] = await store.db.selectFrom('messages').selectAll().where('status', '=', 'sending').execute();
      expect(row).toBeDefined();
      await stop(); await interrupted;
      const restartedPort = await start('masked');
      expect(await (await send(restartedPort, 'interrupted')).json()).toMatchObject({ code: 'in_progress' });
      await store.db.updateTable('messages').set({ created_at: Date.now() - 900001 }).where('id', '=', row.id).execute();
      await runRetention(store, Date.now(), loadConfig(JSON.stringify(input)));
      expect(await store.db.selectFrom('recipients').select('status').where('message_id', '=', row.id).execute()).toEqual([{ status: 'unknown' }]);
      expect(await (await send(restartedPort, 'interrupted')).json()).toMatchObject({ code: 'outcome_unknown' });
      expect(mimes).toHaveLength(3);
    } finally { await store.db.destroy(); }
  } finally {
    await stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => smtp.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
