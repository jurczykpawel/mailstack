import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt-in isolated TEST only. No existing Compose project may be running.
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
assert.equal(docker(['ps', '--filter', 'label=com.docker.compose.project', '-q']), '', 'Another Compose project is running');
for (const image of ['node:24-alpine', 'axllent/mailpit:v1.29.7']) docker(['image', 'inspect', image]);
process.umask(0o077);
const dir = mkdtempSync(join(tmpdir(), 'mailstack-budget-'));
const project = 'mailstack-budget-' + process.pid;
const compose = args => docker(['compose', '-p', project, '-f', join(dir, 'compose.json'), ...args]);
const pair = generateKeyPairSync('x25519');
const cfg = JSON.parse(readFileSync('config/mailstack.example.json'));
cfg.sender = { type: 'smtp' };
cfg.legacyApiKey = { enabled: true, env: 'API_KEY', scopes: ['send'], brands: '*', templates: '*', recipientOverride: true, attachments: true };
cfg.logging.defaults.level = 'full'; cfg.logging.defaults.requireLog = true;
writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
chmodSync(join(dir, 'config.json'), 0o644);
writeFileSync(join(dir, 'compose.json'), JSON.stringify({ services: {
  api: { build: { context: process.cwd() }, mem_limit: '512m', environment: { MAILSTACK_CONFIG: '/config/mailstack.json',
    API_KEY: 'test-key', SMTP_HOST: 'mailpit', SMTP_PORT: '1025', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }),
    INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) },
    volumes: [join(dir, 'config.json') + ':/config/mailstack.json:ro', 'api-data:/data'], ports: ['127.0.0.1::8080'], networks: ['test'] },
  mailpit: { image: 'axllent/mailpit:v1.29.7', mem_limit: '512m', environment: { MP_DATABASE: '/data/mailpit.db' },
    volumes: ['mailpit-data:/data'], ports: ['127.0.0.1::8025'], networks: ['test'] },
}, volumes: { 'api-data': {}, 'mailpit-data': {} }, networks: { test: { internal: true } } }));
const metrics = service => {
  const id = compose(['ps', '-aq', service]);
  const state = JSON.parse(docker(['inspect', id]))[0];
  let memory;
  if (state.State.Running) memory = docker(['exec', id, 'sh', '-c', 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events; cat /proc/1/status | sed -n "/VmRSS/p; /VmHWM/p"']);
  return { service, limit: state.HostConfig.Memory, OOMKilled: state.State.OOMKilled, exitCode: state.State.ExitCode, memory };
};
const wait = async url => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Startup is polled within a bounded deadline. */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw Error('TEST service did not become ready');
};
try {
  compose(['build', '--pull=false', 'api']);
  compose(['up', '-d', '--pull', 'never']);
  const api = 'http://' + compose(['port', 'api', '8080']);
  const sink = 'http://' + compose(['port', 'mailpit', '8025']);
  await wait(api + '/health'); await wait(sink + '/api/v1/messages');
  const fresh = spawn(process.execPath, ['scripts/attachment-profile.mjs', '--mailpit', '--fresh'], { stdio: 'inherit', env: { ...process.env, PROFILE_API_URL: api, PROFILE_SINK_URL: sink } });
  assert.equal(await new Promise(r => fresh.once('exit', r)), 0);
  console.log(JSON.stringify({ stage: 'fresh', services: ['api', 'mailpit'].map(metrics) }));
  compose(['restart', 'api']); await wait(api + '/health');
  console.log(JSON.stringify({ stage: 'baseline', services: ['api', 'mailpit'].map(metrics) }));
  const child = spawn(process.execPath, ['scripts/attachment-profile.mjs', '--mailpit'], { stdio: 'inherit', env: { ...process.env, PROFILE_API_URL: api, PROFILE_SINK_URL: sink } });
  const samples = [];
  const timer = setInterval(() => { samples.push(['api', 'mailpit'].map(metrics)); }, 1000);
  let code;
  try { code = await new Promise(r => child.once('exit', r)); } finally { clearInterval(timer); }
  const final = ['api', 'mailpit'].map(metrics);
  console.log(JSON.stringify({ stage: 'final', services: final, samples }));
  const healthy = states => states.every(s => !s.OOMKilled && s.exitCode === 0 && !/oom_kill [1-9]/.test(s.memory ?? ''));
  assert.equal(code, 0); assert.ok(final.every(s => s.memory)); assert.ok(healthy(final));
  const inbox = async () => (await (await fetch(sink + '/api/v1/messages')).json()).messages.map(m => m.ID).sort();
  const before = await inbox(); assert.equal(before.length, 21);
  const rawHashes = async ids => {
    const hashes = [];
    for (const id of ids) {
      const raw = await fetch(sink + '/api/v1/message/' + id + '/raw');
      assert.equal(raw.status, 200);
      hashes.push(createHash('sha256').update(Buffer.from(await raw.arrayBuffer())).digest('hex'));
    }
    return hashes;
  };
  const hashes = await rawHashes(before);
  compose(['restart', 'mailpit']); await wait(sink + '/api/v1/messages');
  assert.deepEqual(await inbox(), before);
  assert.deepEqual(await rawHashes(before), hashes);
  assert.equal((await fetch(api + '/health')).status, 200);
  const restored = ['api', 'mailpit'].map(metrics); assert.ok(healthy(restored));
  console.log(JSON.stringify({ inboxPreserved: before.length, rawHashes: hashes, services: restored }));
} finally {
  try { compose(['down', '-v', '--rmi', 'local']); } finally { rmSync(dir, { recursive: true, force: true }); }
}
