import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// A bounded, sequential HTTP-to-SMTP profile. The sink runs outside the API process.
const remote = process.argv.includes('--mailpit');
const baseUrl = process.env.PROFILE_API_URL;
const sinkUrl = process.env.PROFILE_SINK_URL;
if (remote) for (const url of [baseUrl, sinkUrl]) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1'); assert.equal(parsed.protocol, 'http:');
}
const messages = [];
const inbox = async () => (await (await fetch(sinkUrl + '/api/v1/messages')).json()).messages;
const mailCount = async () => remote ? (await inbox()).length : messages.length;
const smtp = createServer(socket => {
  socket.setEncoding('utf8'); socket.write('220 smtp.acme.example\r\n');
  let input = '', data = false, mime = '';
  socket.on('data', chunk => {
    input += chunk;
    while (input.includes('\r\n')) {
      const end = input.indexOf('\r\n'), line = input.slice(0, end); input = input.slice(end + 2);
      if (data) {
        if (line !== '.') { mime += line + '\r\n'; continue; }
        messages.push(mime); mime = ''; data = false; socket.write('250 queued as local-1\r\n');
      } else if (line.startsWith('EHLO')) socket.write('250 smtp.acme.example\r\n');
      else if (line === 'DATA') { data = true; socket.write('354 continue\r\n'); }
      else if (line === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
});
let child, ready = { rss: null, peakRss: null }, base = baseUrl;
try {
if (!remote) {
  await mkdir('dist', { recursive: true });
  await build({ entryPoints: ['test/fixtures/attachment-runtime.ts'], outfile: 'dist/attachment-runtime.mjs', bundle: true,
    platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.url': '"file:///profile-library"' }, plugins: [{ name: 'config', setup(b) {
      b.onResolve({ filter: /\/bundled\.ts$/ }, () => ({ path: resolve('src/runtime/config.ts') }));
      b.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: resolve('src/assets/logo.example.ts') }));
    } }] });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  child = fork('dist/attachment-runtime.mjs', [], { env: { ...process.env,
    MAILSTACK_CONFIG: resolve('config/mailstack.example.json'), PROFILE_SMTP_PORT: String(smtp.address().port) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  ready = await new Promise((res, rej) => { child.once('message', res); child.once('error', rej); child.once('exit', code => rej(Error(`API exit ${code}`))); });
  base = `http://127.0.0.1:${ready.port}`;
}
const samples = [{ stage: 'baseline', ...ready }], checksums = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (size, i = 0) => ({ filename: `sample-${i}.txt`, contentType: 'text/plain', contentBase64: Buffer.alloc(size, 65 + i).toString('base64') });
const post = async (files, expected = 200, bodySize) => {
  let body = JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Profile', attachments: files });
  if (bodySize) body += ' '.repeat(bodySize - Buffer.byteLength(body));
  const before = await mailCount();
  const response = await fetch(base + '/v1/send', { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body });
  assert.equal(response.status, expected, await response.text());
  assert.equal(await mailCount(), before + (expected === 200 ? 1 : 0));
  if (expected === 200) {
    const mime = remote ? await (await fetch(sinkUrl + '/api/v1/message/' + (await inbox())[0].ID + '/raw')).text() : messages.at(-1);
    for (const f of files) {
      const part = mime.split(/\r\n--/).find(p => p.includes(`filename=${f.filename}`) || p.includes(`filename="${f.filename}"`));
      assert.ok(part, `MIME part ${f.filename}`);
      assert.match(part, /Content-Type: text\/plain/i); assert.match(part, /Content-Transfer-Encoding: base64/i);
      const actual = Buffer.from(part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\s/g, ''), 'base64');
      const expectedHash = hash(Buffer.from(f.contentBase64, 'base64'));
      assert.equal(hash(actual), expectedHash); checksums.push({ bytes: actual.length, sha256: expectedHash });
    }
  }
  const profile = remote ? { rss: null, peakRss: null } : await (await fetch(base + '/profile')).json();
  if (!remote) {
    const archive = JSON.stringify(profile.archives);
    for (const f of files) { assert.ok(!archive.includes(f.filename)); assert.ok(!archive.includes(f.contentBase64)); }
  }
  samples.push({ stage: `${files.map(f => Buffer.from(f.contentBase64, 'base64').length).join('+')}:${expected}:${bodySize ?? ''}`, rss: profile.rss, peakRss: profile.peakRss });
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).store, 'ok');
};
  if (process.argv.includes('--fresh')) await post([file(7 * 1024 * 1024)]);
  else {
    for (let i = 0; i < 8; i++) await post([file(44)]);
    await post([file(1024 * 1024)]);
    await post([file(7 * 1024 * 1024)]);
    const sizes = [1048576, 1048576, 1048576, 1048576, 3145728];
    await post(sizes.map((size, i) => file(size, i)));
    await post([file(7 * 1024 * 1024 + 1)], 422);
    await post([], 200, 10 * 1024 * 1024);
    await post([], 413, 10 * 1024 * 1024 + 1);
    for (let i = 0; i < 8; i++) await post([file(44)]);
  }
  const peak = remote ? null : Math.max(...samples.map(s => s.peakRss));
  console.log(JSON.stringify({ platform: process.platform, node: process.version, samples, checksums, peakRss: peak, archiveVerification: !remote, sink: remote ? 'Mailpit' : 'separate local SMTP fixture', cgroup: 'collected separately for container runs' }, null, 2));
  if (!remote) assert.ok(peak < 384 * 1024 * 1024, `API peak RSS ${peak} exceeds profile budget`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(r => child.once('exit', r));
    if (child.connected) child.send('close'); else child.kill();
    await exited;
  }
  if (smtp.listening) await new Promise(r => smtp.close(r));
}
