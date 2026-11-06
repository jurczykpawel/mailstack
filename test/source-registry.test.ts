import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/core/config';
import { parseConfig } from '../src/core/config/schema';
import { authenticate } from '../src/clients';
import { createApp } from '../src/index';
import type { Env } from '../src/types';
const original = structuredClone(config);
const source = { signature: { scheme: 'sha256-prefix', header: 'X-Signature' }, envelope: { event: 'event', timestamp: 'timestamp', data: 'data' },
  events: { ping: { action: 'send', template: 'notice', to: 'data.email', fields: { heading: { format: 'Notice' }, paragraphs: 'data.text' } } } };
afterEach(() => { Object.keys(config).forEach(key => Reflect.deleteProperty(config, key)); Object.assign(config, structuredClone(original)); });
it.each(['alpha', 'beta'])('uses registry permissions, brand and signature for %s', async id => {
  Object.assign(config, parseConfig({ ...original, sources: { [id]: { ...source, legacyKey: true, defaultBrand: 'demo' }, other: source }, legacyApiKey: { signatureSecretEnv: 'SIGN' } }));
  const env = { API_KEY: 'local-full-key', SIGN: 'local-signature', SELLF_DEFAULT_BRAND: 'acme' } as unknown as Env;
  const client = await authenticate(new Request('https://local.example', { headers: { authorization: `Bearer ${env.API_KEY}` } }), env, config);
  expect(client).toMatchObject({ scopes: ['send', `hook:${id}`] });
  const sendEmail = vi.fn(async () => ({ ok: true, status: 200 }));
  const raw = JSON.stringify({ event: 'ping', timestamp: '2026-11-06T12:00:00Z', data: { email: 'reader@example.com', text: 'Hello' } });
  const app = createApp({ sendEmail, now: () => new Date('2026-11-06T12:00:00Z') });
  const call = (path: string, signed = true) => app.fetch(new Request(`https://local.example/v1/hooks/${path}`, { method: 'POST', body: raw,
    headers: { authorization: `Bearer ${env.API_KEY}`, ...(signed ? { 'X-Signature': `sha256=${createHmac('sha256', Reflect.get(env, 'SIGN') as string).update(raw).digest('hex')}` } : {}) } }), env, {} as ExecutionContext);
  expect((await call(id, false)).status).toBe(401);
  expect((await call('other')).status).toBe(403);
  expect((await call(id)).status).toBe(200);
  expect(sendEmail).toHaveBeenCalledOnce();
  expect(sendEmail.mock.calls[0]).toEqual([env, expect.objectContaining({ from: config.brands.demo.from })]);
});
it('validates registry brand and signing selections', () => {
  expect(() => parseConfig({ ...original, sources: { alpha: { ...source, defaultBrand: 'absent' } } })).toThrow('$.sources.alpha.defaultBrand');
  expect(() => parseConfig({ ...original, sources: { alpha: { ...source, legacyKey: true, signature: { scheme: 'bearer-only' } } }, legacyApiKey: { signatureSecretEnv: 'SIGN' } })).toThrow('requires a signing scheme');
  expect(() => parseConfig({ ...original, sources: { alpha: { ...source, signature: { scheme: 'bearer-only' } } }, legacyApiKey: { signatureSecretEnv: 'SIGN' } })).not.toThrow();
  expect(() => parseConfig({ ...original, legacyApiKey: { scopes: ['send', 'hook:sellf'] } })).toThrow('$.legacyApiKey.scopes');
});
it('migrates the prior full-key selection and aliases offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mailstack-config-'));
  const run = (input: unknown, deployment = {}) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(input)); writeFileSync(join(dir, 'deployment.json'), JSON.stringify(deployment));
    return spawnSync(process.execPath, ['scripts/migrate-sellf-config.ts', join(dir, 'config.json'), join(dir, 'deployment.json')], { encoding: 'utf8' });
  };
  try {
    const old = { ...original, sources: { sellf: source, other: source }, legacyApiKey: { scopes: ['send', 'hook:sellf'] }, clients: [{ id: 'sender', scopes: ['hook:sellf'], sellfSignatureSecretEnv: 'SIGN' }] };
    const result = run(old, { SELLF_DEFAULT_BRAND: 'demo' }); expect(result.status).toBe(0);
    const migrated = JSON.parse(result.stdout); expect(migrated.sources.sellf).toMatchObject({ legacyKey: true, defaultBrand: 'demo' });
    expect(migrated.sources.other.legacyKey).not.toBe(true); expect(migrated.legacyApiKey.scopes).toBeUndefined();
    expect(migrated.clients[0]).toEqual({ id: 'sender', scopes: ['hook:sellf'], signatureSecretEnv: 'SIGN' });
    const optedOut = run({ ...old, legacyApiKey: {}, clients: [], sources: { sellf: { ...source, legacyKey: false } } });
    expect(optedOut.status).toBe(0); expect(JSON.parse(optedOut.stdout).sources.sellf.legacyKey).toBe(false);
    for (const [change, deployment, path] of [
      [{ ...old, sources: { sellf: { ...source, legacyKey: false } } }, {}, '$.sources.sellf.legacyKey'],
      [{ ...old, sources: { sellf: { ...source, defaultBrand: 'acme' } } }, { SELLF_DEFAULT_BRAND: 'demo' }, '$.sources.sellf.defaultBrand'],
      [{ ...old, clients: [{ scopes: ['hook:sellf'], signatureSecretEnv: 'A', sellfSignatureSecretEnv: 'B' }] }, {}, '$.clients.0.signatureSecretEnv'],
      [old, { SELLF_DEFAULT_BRAND: 'absent' }, '$.sources.sellf.defaultBrand'],
      [{ ...old, legacyApiKey: { scopes: ['send', 'hook:*'] } }, {}, '$.legacyApiKey.scopes'],
      [{ ...old, clients: [{ scopes: ['hook:sellf', 'hook:other'], sellfSignatureSecretEnv: 'SIGN' }] }, {}, '$.clients.0.signatureSecretEnv'],
    ] as const) { const bad = run(change, deployment); expect(bad.status).toBe(1); expect(bad.stderr).toContain(path); expect(bad.stdout).toBe(''); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
