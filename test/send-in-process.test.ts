import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSqliteStore } from '../src/core/store/sqlite';
import { parseConfig } from '../src/core/config/schema';
import { config } from '../src/core/config';
import { createApp } from '../src/index';
import { tokenSha256 } from '../src/clients';
import { testKeys } from './fixtures/keys';
import { panelEnv, signPanel, panelClaims } from './fixtures/panel';
import example from '../config/mailstack.example.json';
import type { Extension, ExtensionRouteContext } from '../src/core/extensions';
import type { Env, SendDeps } from '../src/types';

import { generateKeyPairSync } from 'node:crypto';
const pair = generateKeyPairSync('x25519');
const token = 'msk_panel_' + 'a'.repeat(43), apiKey = 'full-key-secret', host = 'internal.example';
const env = { CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]), ...panelEnv, API_KEY: apiKey, SES_REGION: 'eu-west-1', INTERNAL_HOST: host } as unknown as Env;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
let contexts: unknown[] = [];
const loop: Extension = { name: 'demo', routes(app) {
  app.route('POST', '/loop', async (req: Request, c: ExtensionRouteContext) => { contexts.push(c); return Response.json(await c.sendInProcess!(await req.json() as never)); });
} };
const call = (app: ReturnType<typeof createApp>, body: Record<string, unknown>, role: 'viewer' | 'operator' | 'admin' = 'admin') =>
  signPanel(new Request(`https://${host}/internal/ext/demo/loop`, { method: 'POST', body: JSON.stringify(body) }), token, panelClaims(role), { aud: host })
    .then(r => app.fetch(r, env, ctx)).then(r => r.json() as Promise<{ id?: string; error?: string }>);

describe('sendInProcess (R8)', () => {
  let app: ReturnType<typeof createApp>, sendEmail: ReturnType<typeof vi.fn> & SendDeps['sendEmail'], fetchSpy: ReturnType<typeof vi.spyOn>;
  const brand = Object.keys(example.brands)[0];
  beforeAll(() => { config.extensions.push({ module: 'mailstack-pro' }); return () => { config.extensions.pop(); }; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); contexts = []; });
  async function setup(brands?: string[], templates: string[] | '*' = '*') {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const store = createSqliteStore(':memory:'); await store.migrate();
    const cfg = parseConfig({ ...example, clients: [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: brands ?? '*', templates }], logging: { ...example.logging, defaults: { ...example.logging.defaults, level: 'meta', requireLog: true } }, extensions: [{ module: 'demo-extension' }] });
    sendEmail = vi.fn(async () => ({ ok: true, status: 200, messageId: 'provider-1' }));
    app = createApp({ store, sendEmail, keys: testKeys(cfg), logging: cfg.logging, access: async () => true }, undefined, loop);
  }
  const next = () => vi.setSystemTime(Date.now() + 1200);

  it('sends exactly the three simulator scenarios without any network request and repeats idempotently', async () => {
    await setup();
    for (const scenario of ['success', 'bounce', 'complaint']) {
      const r = await call(app, { brand, scenario, key: 'k1' });
      expect(r.error).toBeUndefined();
      next();
    }
    expect(sendEmail.mock.calls.map(c => JSON.stringify(c[1]).match(/(success|bounce|complaint)@simulator\.amazonses\.com/)?.[0]))
      .toEqual(['success@simulator.amazonses.com', 'bounce@simulator.amazonses.com', 'complaint@simulator.amazonses.com']);
    await call(app, { brand, scenario: 'success', key: 'k1' });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('N: refuses a scenario outside the list and ignores a caller-supplied recipient', async () => {
    await setup();
    for (const scenario of ['delivered', 'success@evil.example', '', 1]) expect((await call(app, { brand, scenario, key: 'k' })).error).toBe('invalid');
    expect(sendEmail).not.toHaveBeenCalled();
    next();
    await call(app, { brand, scenario: 'success', key: 'k', to: 'victim@evil.example', template: 'welcome' });
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain('evil.example');
    expect(JSON.stringify(sendEmail.mock.calls)).toContain('success@simulator.amazonses.com');
  });

  it('N: refuses a repeat within 1.1 s', async () => {
    await setup();
    expect((await call(app, { brand, scenario: 'success', key: 'a' })).error).toBeUndefined();
    vi.setSystemTime(Date.now() + 1099);
    expect((await call(app, { brand, scenario: 'bounce', key: 'a' })).error).toBe('rate_limited');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect((await call(app, { brand, scenario: 'bounce', key: 'a' })).error).toBeUndefined();
  });

  it('N: refuses non-admin roles, unknown brands and invalid keys', async () => {
    await setup();
    expect((await call(app, { brand, scenario: 'success', key: 'a' }, 'operator')).error).toBe('invalid');
    expect((await call(app, { brand: 'nope', scenario: 'success', key: 'a' })).error).toBe('invalid');
    expect((await call(app, { brand, scenario: 'success', key: 'a b' })).error).toBe('invalid');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('N: refuses a brand outside the panel principal scope', async () => {
    await setup(['no-such-brand']);
    expect((await call(app, { brand, scenario: 'success', key: 'a' })).error).toBe('invalid');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('N: refuses a principal that may not use the notice template', async () => {
    await setup(undefined, ['contact']);
    expect((await call(app, { brand, scenario: 'success', key: 'a' })).error).toBe('invalid');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('contract: the extension context carries no general send and no key', async () => {
    await setup();
    await call(app, { brand, scenario: 'success', key: 'a' });
    const c = contexts[0] as Record<string, unknown>;
    expect(Object.keys(c).filter(k => /send|fetch|deliver/i.test(k))).toEqual(['sendInProcess']);
    expect(Object.keys(c).some(k => /send/i.test(k) && k !== 'sendInProcess' && k !== 'sesStatus')).toBe(false);
    expect(JSON.stringify(c, (_: string, v: unknown) => typeof v === 'function' ? undefined : v)).not.toContain(apiKey);
    expect((c.sendInProcess as (...a: unknown[]) => unknown).length).toBe(1);
  });
});
