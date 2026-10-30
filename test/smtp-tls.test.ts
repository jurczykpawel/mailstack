import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type TLSSocket } from 'node:tls';
import { once } from 'node:events';

const directory = mkdtempSync(join(process.cwd(), 'node_modules/.mailstack-smtp-tls-'));
const certificate = join(directory, 'cert.pem');
const key = join(directory, 'key.pem');
const sockets = new Set<TLSSocket>();
const server = createServer();
let port: number;
beforeAll(async () => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=smtp.example.test', '-addext', 'subjectAltName=DNS:smtp.example.test',
    '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  await build({ entryPoints: ['src/adapters/sender/smtp.ts'], outfile: join(directory, 'sender.mjs'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  server.setSecureContext({ key: readFileSync(key), cert: readFileSync(certificate) });
  server.on('connection', socket => {
    sockets.add(socket as TLSSocket);
    socket.on('close', () => sockets.delete(socket as TLSSocket));
  });
  server.on('tlsClientError', () => {});
  server.on('secureConnection', socket => {
    socket.setEncoding('utf8');
    socket.write('220 smtp.example.test ESMTP\r\n');
    let buffer = '', data = false;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; socket.write('250 queued as local-1\r\n'); }
        } else if (line.startsWith('EHLO')) socket.write('250 smtp.example.test\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local TCP address');
  port = address.port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

async function send(url: boolean, servername: string, trusted: boolean) {
  const settings = { ...(url ? { SMTP_URL: `smtps://127.0.0.1:${port}` }
    : { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'true' }), SMTP_TLS_SERVERNAME: servername };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { smtpFromEnv } from ${JSON.stringify(join(directory, 'sender.mjs'))};
    try {
      const result = await smtpFromEnv(${JSON.stringify(settings)})({}, {
        from: 'sender@example.test', to: ['recipient@example.test'], subject: 'Local TLS check', html: '', text: 'Hello'
      });
      console.log(JSON.stringify(result));
    } catch (error) { console.log(JSON.stringify({error: error.code, message: error.message})); }
  `], { env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: trusted ? certificate : undefined,
    NODE_PATH: join(process.cwd(), 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

it.each([false, true])('sends over a direct address with a matching certificate, URL mode %s', async url => {
  expect(await send(url, 'smtp.example.test', true)).toMatchObject({ ok: true, messageId: 'local-1' });
});
it.each([false, true])('requires the configured certificate name, URL mode %s', async url => {
  expect(await send(url, 'other.example.test', true)).toMatchObject({ error: 'ESOCKET',
    message: expect.stringContaining('not in the cert') });
});
it.each([false, true])('requires a trusted certificate, URL mode %s', async url => {
  expect(await send(url, 'smtp.example.test', false)).toMatchObject({ error: 'ESOCKET',
    message: expect.stringContaining('self-signed certificate') });
});
