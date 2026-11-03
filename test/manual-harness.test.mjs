import { afterEach, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import https from 'node:https';

const roots = [], children = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() { const root = mkdtempSync(join(tmpdir(), 'manual-harness-')); roots.push(root); return root; }
async function start(root) {
  if (!readdirSync(root).includes('tls.key')) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt'), '-days', '1', '-subj', '/CN=acme.example'], { stdio: 'ignore' });
    writeFileSync(join(root, 'credentials.json'), JSON.stringify({ webhookSecret: 'synthetic', callbackSecret: 'synthetic' }));
  }
  // Keep the executable handlers and storage code; substitute only paths and listen ports.
  const source = readFileSync(resolve('scripts/manual/fixture.mjs'), 'utf8')
    .replace("'/run/fixture'", JSON.stringify(root)).replace("'/data/records.jsonl'", JSON.stringify(join(root, 'records.jsonl')))
    .replaceAll(/\.listen\((?:8443|8082|port),/g, '.listen(0,');
  for (const file of ['records.mjs', 'activation-page.ts', 'purchase-fixture.json'])
    copyFileSync(resolve('scripts/manual', file), join(root, file));
  const script = join(root, 'fixture.mjs');
  writeFileSync(script, source + "\nserver.on('listening',()=>process.send(server.address().port));\n");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const port = await new Promise((ok, fail) => { child.once('message', ok); child.once('exit', () => fail(new Error(stderr))); });
  return { child, port };
}
function request(port, path, headers = {}, body) {
  return new Promise((ok, fail) => {
    const req = https.request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', rejectUnauthorized: false, headers }, res => {
      let raw = ''; res.on('data', b => { raw += b; });
      res.on('end', () => { try { ok({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }); } catch (e) { fail(e); } });
    });
    req.on('error', fail); req.end(body);
  });
}
const row = n => ({ at: n, path: '/hook', body: JSON.stringify({ n }), headers: { 'content-type': 'application/json' }, signatureValid: false });
const lines = rows => rows.map(r => JSON.stringify(r) + '\n').join('');

it('reads an empty history', async () => {
  const root = directory(); writeFileSync(join(root, 'records.jsonl'), '');
  const { port } = await start(root);
  expect((await request(port, '/records')).body).toEqual([]);
});
it('recovers 27 records around 1498 NUL bytes and keeps the original', async () => {
  const root = directory(), rows = Array.from({ length: 27 }, (_, n) => row(n));
  const original = Buffer.concat([Buffer.from(lines(rows.slice(0, 14))), Buffer.alloc(1498), Buffer.from(lines(rows.slice(14)))]);
  writeFileSync(join(root, 'records.jsonl'), original);
  const { port } = await start(root);
  expect((await request(port, '/records')).body).toEqual(rows);
  const report = (await request(port, '/records/diagnostics')).body;
  expect(report).toMatchObject({ recovered: 27, discarded: [], nulBytes: 1498 });
  expect(report.nulRanges).toEqual([{ offset: Buffer.byteLength(lines(rows.slice(0, 14))), bytes: 1498 }]);
  expect(readFileSync(join(root, report.original))).toEqual(original);
  expect((await request(port, '/health')).status).toBe(200);
});
it('reports bad positions and separates a truncated tail before append across restarts', async () => {
  const root = directory(), file = join(root, 'records.jsonl');
  const prefix = lines([row(1)]), middle = 'bad\n', good = lines([row(2)]), tail = '{"at":';
  const original = prefix + middle + good + tail;
  writeFileSync(file, original);
  let fixture = await start(root);
  expect((await request(fixture.port, '/records')).body).toEqual([row(1), row(2)]);
  let report = (await request(fixture.port, '/records/diagnostics')).body;
  expect(report.discarded).toEqual([{ line: 2, offset: Buffer.byteLength(prefix), bytes: 3 }, { line: 4, offset: Buffer.byteLength(prefix + middle + good), bytes: tail.length }]);
  expect(readFileSync(join(root, report.original), 'utf8')).toBe(original);
  await request(fixture.port, '/hook', {}, '{}');
  fixture.child.kill(); await once(fixture.child, 'exit');
  fixture = await start(root);
  await request(fixture.port, '/hook', {}, '{"n":3}');
  const response = await request(fixture.port, '/records');
  expect(response.body).toHaveLength(4);
  expect(response.body.slice(0, 2)).toEqual([row(1), row(2)]);
  expect(response.body.at(-1).body).toBe('{"n":3}');
  expect(response.headers['x-fixture-discarded-records']).toBe('2');
  expect((await request(fixture.port, '/health')).status).toBe(200);
});
it('keeps a complete final record without a newline when appending', async () => {
  const root = directory(); writeFileSync(join(root, 'records.jsonl'), JSON.stringify(row(1)));
  const { port } = await start(root); await request(port, '/hook', {}, '{}');
  expect((await request(port, '/records')).body).toHaveLength(2);
});
it('stores and exports only selected request headers', async () => {
  const root = directory(), file = join(root, 'records.jsonl');
  const { port } = await start(root);
  await request(port, '/hook', { Authorization: 'Bearer synthetic-token', Cookie: 'session=synthetic-cookie', 'Proxy-Authorization': 'synthetic-proxy', 'x-extra': 'synthetic-extra', 'Idempotency-Key': 'test-1' }, '{}');
  const stored = readFileSync(file, 'utf8');
  for (const value of ['synthetic-token', 'synthetic-cookie', 'synthetic-proxy', 'synthetic-extra']) expect(stored).not.toContain(value);
  expect((await request(port, '/records')).body[0].headers['idempotency-key']).toBe('test-1');
  writeFileSync(file, lines([{ ...row(1), headers: { Authorization: 'old-token', COOKIE: 'old-cookie' } }]));
  expect(JSON.stringify((await request(port, '/records')).body)).not.toMatch(/old-token|old-cookie/);
});
it('generates a persistent non-root inbox with a separate memory budget', () => {
  const root = directory();
  execFileSync(process.execPath, ['scripts/manual/compose.mjs', root, '1234', '5678']);
  const config = JSON.parse(readFileSync(join(root, 'compose.yml'), 'utf8'));
  const mailpit = config.services.mailpit;
  expect(mailpit.volumes).toContain('mailpit-data:/data');
  expect(config.volumes).toHaveProperty('mailpit-data');
  expect(mailpit.environment.MP_DATABASE).toBe('/data/mailpit.db');
  expect(mailpit.user).toBe('1234:5678');
  expect(mailpit.mem_limit).toBe('512m');
  expect(config.services.api.mem_limit).toBe('512m');
  expect(config.services.api.environment.PANEL_AUDIENCE).toBe(config.services.panel.environment.PANEL_API_AUDIENCE);
  expect(config.services.panel.environment.PANEL_ASSERTION_KEYS_FILE).toBe('/run/panel/assertion');
  expect(config.services.init.volumes).toContain('mailpit-data:/mailpit');
  expect(config.services.init.command.at(-1)).toContain('/mailpit');
  expect(mailpit.depends_on.init.condition).toBe('service_completed_successfully');
});

it('reports a NUL-only entry and keeps later records', async () => {
  const root = directory();
  writeFileSync(join(root, 'records.jsonl'), '\0\0\n' + lines([row(1)]));
  const { port } = await start(root);
  expect((await request(port, '/records')).body).toEqual([row(1)]);
  expect((await request(port, '/records/diagnostics')).body.discarded).toEqual([{ line: 1, offset: 0, bytes: 2 }]);
});
it('creates history on first append when no file exists', async () => {
  const root = directory(), { port } = await start(root);
  expect((await request(port, '/records')).body).toEqual([]);
  await request(port, '/hook', {}, '{}');
  expect((await request(port, '/records')).body).toHaveLength(1);
});
