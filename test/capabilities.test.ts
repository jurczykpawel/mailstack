import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { KyselyStore } from '../src/core/store';
import { loadExtensions } from '../src/runtime/extensions';
import { parseConfig, type Config } from '../src/core/config/schema';
import { tokenSha256, type Client, type KeyProvider } from '../src/clients';
import { createApp } from '../src/index';
import { createAccessVerifier } from '../src/core/access';
import { capabilities } from '../src/core/capabilities';
import { panelEnv, panelClaims, signPanel } from './fixtures/panel';
import { testKeys } from './fixtures/keys';
import { accessEnv, accessKeyPair, certsFetch, publicJwk, signAccessJwt } from './fixtures/access';
import type { Env, SendDeps } from '../src/types';
import example from '../config/mailstack.example.json';

vi.setConfig({ testTimeout: 30000 });
const panelToken = 'msk_panel_' + 'a'.repeat(43), sendToken = 'msk_send_' + 'b'.repeat(43), hookToken = 'msk_hook_' + 'c'.repeat(43);
const transit = { keys: [{ ...generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' }), kid: 't1' }] };
const env = { ...panelEnv, TRANSIT_KEYS: JSON.stringify(transit), BUILD_COMMIT: 'abc123', API_KEY: 'full-key' };
type Caps = { license: { state: string }; principal: { role: string; brands: unknown; templates: unknown }; features: Record<string, { state: string; reason?: string }>;
  api: Record<string, unknown>; protocol: unknown; limits: unknown; backupWindowDays: number; jobs: Record<string, number>; transitKeys: Record<string, string>[] };

// Stand-in for Pro: the test toggles the license; `widen` makes a denial carry a broader principal than configured.
let licensed = true, widen = false;
function licenseKeys(config: Pick<Config, 'clients'>): KeyProvider {
  const base = testKeys(config);
  return { client: base.client, async authenticate(token, e) {
    const client = await base.authenticate(token, e);
    if (!client || licensed || 'denied' in client) return client;
    return { denied: 'license', client: widen ? { ...client, scopes: [...client.scopes, 'send'], brands: '*', templates: '*' } as Client : client };
  } };
}
const sent: unknown[] = [];
const delivery = { provider: 'ses', sendEmail: async (message: unknown) => { sent.push(message); return { ok: true, status: 200, messageId: 'ses-1' }; } } as unknown as Pick<SendDeps, 'sendEmail' | 'provider'>;

describe('capabilities', () => {
  let store: KyselyStore, cfg: Config, runtime: Awaited<ReturnType<typeof loadExtensions>>;
  const configure = async (over: Record<string, unknown> = {}, pro = true) => {
    cfg = parseConfig({ ...example, events: { ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:t'], accountIds: ['123456789012'] } },
      logging: { ...example.logging, brands: { acme: { templates: { notice: { level: 'full', resend: 'replay' } } } } },
      extensions: [{ module: pro ? 'mailstack-pro' : 'keys', options: { webhooks: {}, aws: {} } }],
      clients: [
        { id: 'panel', tokenSha256: await tokenSha256(panelToken), scopes: ['panel', 'webhooks:write'], brands: ['acme'], templates: '*' },
        { id: 'send', tokenSha256: await tokenSha256(sendToken), scopes: ['send'], brands: ['acme'], templates: ['notice'] },
        { id: 'hook', tokenSha256: await tokenSha256(hookToken), scopes: ['hook:sellf'], brands: ['acme'], templates: '*' },
      ], ...over });
    runtime = await loadExtensions(cfg, store, async module => ({ default: module === 'mailstack-pro'
      ? { name: 'pro', capabilities: ['resend'], keys: licenseKeys } : { name: 'keys', keys: licenseKeys } }), delivery);
  };
  const call = async (path = '/capabilities', role: 'viewer' | 'admin' = 'admin', token = panelToken, method = 'GET') =>
    runtime.fetch(await signPanel(new Request('http://localhost' + path, { method, body: method === 'GET' ? undefined : '{}' }), token, panelClaims(role)), env);
  const caps = async (role: 'viewer' | 'admin' = 'admin') => { const r = await call('/internal/v2/capabilities', role); expect(r.status).toBe(200); return await r.json() as Caps; };
  const app = () => createApp({ store, keys: runtime.keys, sendEmail: delivery.sendEmail, provider: 'ses' });
  const send = (token: string) => app().fetch(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Hi' }) }), env as unknown as Env, { waitUntil() {} } as unknown as ExecutionContext);

  beforeAll(async () => { store = createSqliteStore(':memory:'); await store.migrate(); });
  beforeEach(async () => { licensed = true; widen = false; sent.length = 0; await configure(); });
  afterAll(async () => { await store.db.destroy(); });

  it('reports protocol, platform, principal, limits, jobs and public transit keys on Node', async () => {
    const body = await caps();
    expect(body.protocol).toEqual({ min: 2, max: 2 });
    expect(body.api).toMatchObject({ commit: 'abc123', platform: 'node', audience: 'api.test' });
    expect(body.license).toEqual({ state: 'valid' });
    expect(body.principal).toEqual({ role: 'admin', brands: ['acme'], templates: '*' });
    expect(body.limits).toEqual({ listPage: 100, exportPageMessages: 50, exportPageBytes: 1048576 });
    expect(body.backupWindowDays).toBe(7);
    expect(body.jobs).toEqual({ pending: 0, oldest_pending_age_s: 0, dead_24h: 0 });
    expect(body.transitKeys).toEqual([{ kid: 't1', x: transit.keys[0].x }]);
    expect(JSON.stringify(body)).not.toContain(String(transit.keys[0].d));
    expect(body.features).toEqual({ panel: { state: 'enabled' }, webhooks: { state: 'enabled' }, 'resend.replay': { state: 'enabled' },
      'resend.source': { state: 'disabled', reason: 'not_configured' }, 'aws.status': { state: 'disabled', reason: 'role' }, 'aws.test': { state: 'disabled', reason: 'role' } });
    expect((await caps('viewer')).features).toMatchObject({ webhooks: { reason: 'role' }, 'resend.replay': { reason: 'role' } });
  });

  it('N: a scoped key without a license does not send; the full key still does', async () => {
    licensed = false;
    for (const response of [await send(sendToken), await app().fetch(new Request('https://mail.example/v1/hooks/sellf?brand=acme', { method: 'POST',
      headers: { authorization: `Bearer ${hookToken}` }, body: '{}' }), env as unknown as Env, {} as ExecutionContext)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ success: false, code: 'license_required' });
    }
    expect(sent).toHaveLength(0);
    expect((await send('full-key')).status).toBe(200);
    expect(sent).toHaveLength(1);
    licensed = true;
    expect((await send(sendToken)).status).toBe(200);
  });

  it('N: a denied panel token reaches only capabilities, with every Pro feature disabled by license', async () => {
    licensed = false;
    const body = await caps();
    expect(body.license).toEqual({ state: 'invalid' });
    expect(Object.values(body.features)).toEqual(Array(6).fill({ state: 'disabled', reason: 'license' }));
    for (const [path, method] of [['/internal/v2/messages', 'GET'], ['/internal/v2/audit/head', 'GET'], ['/internal/ext/pro/webhooks', 'GET'],
      ['/internal/v2/capabilities', 'POST'], ['/internal/v2/subjects/export', 'POST']]) {
      const response = await call(path, 'admin', panelToken, method);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'license_required' });
    }
  });

  it('N: a wrong token is 401 and a denial never widens the configured principal', async () => {
    licensed = false;
    expect((await call('/internal/v2/capabilities', 'admin', 'msk_panel_' + 'z'.repeat(43))).status).toBe(401);
    expect((await call('/internal/v2/capabilities', 'admin', 'msk_ghost_' + 'z'.repeat(43))).status).toBe(401);
    widen = true;
    expect((await caps()).principal).toEqual({ role: 'admin', brands: ['acme'], templates: '*' });
    expect((await send(sendToken)).status).toBe(403);
  });

  it('N: the Free plan disables Pro features the platform cannot carry', async () => {
    await configure({ cloudflare: { plan: 'free' } });
    const { features } = await caps();
    for (const name of ['panel', 'webhooks', 'resend.source', 'aws.test']) expect(features[name]).toEqual({ state: 'disabled', reason: 'platform:free_plan' });
    expect(features['resend.replay']).toEqual({ state: 'enabled' });
    expect(() => parseConfig({ ...example, cloudflare: { plan: 'enterprise' } })).toThrow('$.cloudflare.plan');
  });

  it('reports a missing or failed Pro extension instead of enabling its features', async () => {
    await configure({}, false);
    expect((await caps()).features).toMatchObject({ panel: { state: 'enabled' }, webhooks: { state: 'disabled', reason: 'not_configured' } });
    runtime = await loadExtensions({ ...cfg, extensions: [{ module: 'keys' }, { module: 'broken' }] }, store,
      async module => { if (module === 'broken') throw new Error('boom'); return { default: { name: 'keys', keys: licenseKeys } }; });
    expect((await caps()).features.webhooks).toEqual({ state: 'unavailable', reason: 'initialization' });
  });

  it('serves capabilities on the Worker internal host', async () => {
    const pair = await accessKeyPair(), certs = certsFetch(async () => ({ keys: [await publicJwk(pair, 'k1')] }));
    const worker = createApp({ store, keys: runtime.keys, access: createAccessVerifier(certs.fetcher) });
    const workerEnv = { ...env, ...accessEnv, INTERNAL_HOST: 'internal.example', BUILD_PRO_COMMIT: 'pro9' } as unknown as Env;
    const request = async () => worker.fetch(await signPanel(new Request('https://internal.example/internal/v2/capabilities',
      { headers: { 'cf-access-jwt-assertion': await signAccessJwt(pair.privateKey, Date.now()) } }), panelToken, panelClaims(), { aud: 'internal.example' }),
      workerEnv, { waitUntil() {} } as unknown as ExecutionContext);
    const body = await (await request()).json() as Caps;
    expect(body.api).toMatchObject({ platform: 'worker', audience: 'internal.example', proCommit: 'pro9' });
    expect(body.backupWindowDays).toBe(30);
    licensed = false;
    expect((await (await request()).json() as Caps).license).toEqual({ state: 'invalid' });
  });

  it('N: on the Worker, outbound features need the egress container and resend needs a delivery host', async () => {
    const principal = { ...panelClaims(), scopes: ['panel', 'webhooks:write'], brands: '*' as const, templates: '*' as const };
    const worker = (features: ReturnType<typeof runtime.features>, c = cfg) => capabilities(env, store, c, principal,
      { platform: 'worker', extensions: async () => ({ features: () => features, resendSource: undefined }) });
    const ready = [{ module: 'mailstack-pro', state: 'ready' as const, name: 'pro', capabilities: ['resend'] }];
    const body = await worker(ready);
    expect(body.features).toMatchObject({ webhooks: { state: 'disabled', reason: 'platform:secure_egress_unavailable' },
      'resend.source': { reason: 'platform:secure_egress_unavailable' }, 'resend.replay': { state: 'unavailable', reason: 'host' },
      'aws.status': { state: 'enabled' }, 'aws.test': { state: 'enabled' } });
    expect(body.backupWindowDays).toBe(30);
    expect((await worker(ready, { ...cfg, cloudflare: { plan: 'free' } })).backupWindowDays).toBe(7);
  });
});
