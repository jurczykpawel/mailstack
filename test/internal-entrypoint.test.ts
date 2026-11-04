import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { panelEnv } from './fixtures/panel';

vi.setConfig({ testTimeout: 60000 });
const root = process.cwd() + '/';
let mf: Miniflare;
// The deployed entry (`main = "src/worker.ts"`) in workerd: a second Worker reaches `Internal` only through its service binding.
beforeAll(async () => {
  const out = await build({ entryPoints: [root + 'src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
    plugins: [{ name: 'example-logo', setup(b) { b.onResolve({ filter: /\/assets\/logo$/ }, () => ({ path: root + 'src/assets/logo.example.ts' })); } }] });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'panel', modules: true, compatibilityDate: '2026-06-01', serviceBindings: { API: { name: 'api', entrypoint: 'Internal' } },
      script: 'export default { fetch(req, env) { const u = new URL(req.url); return env.API.fetch("https://api.internal" + u.pathname, { headers: req.headers }); } }' },
    { name: 'api', modules: true, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'], script: out.outputFiles[0].text, d1Databases: ['DB'],
      bindings: { ...panelEnv, API_KEY: 'full-key', INTERNAL_HOST: '' } },
  ] }));
});
afterAll(() => mf?.dispose());

it('N: the Internal entrypoint applies the panel gate to /internal/* and serves nothing else; the public entry has no internal API', async () => {
  const panel = await mf.getWorker('panel'), api = await mf.getWorker('api');
  expect((await panel.fetch('http://panel/internal/v2/capabilities')).status).toBe(401);
  // The full key is a valid token without the panel scope.
  expect((await panel.fetch('http://panel/internal/v2/capabilities', { headers: { authorization: 'Bearer full-key' } })).status).toBe(403);
  expect((await panel.fetch('http://panel/health')).status).toBe(404);
  expect((await api.fetch('https://api.internal/internal/v2/capabilities', { headers: { authorization: 'Bearer full-key' } })).status).toBe(404);
  expect((await api.fetch('https://api.internal/health')).status).toBe(200);
});
