import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createD1Store } from '../src/core/store/d1';
import { createApp } from '../src/index';
import { config } from '../src/core/config';
import { tokenSha256 } from '../src/clients';
import { open } from '../src/core/crypto';
import { renderAndSend } from '../src/send';
import { getTemplate } from '../src/templates';
import type { Extension } from '../src/core/extensions';
import type { KyselyStore } from '../src/core/store';
import type { Env, SendDeps } from '../src/types';
import { testKeys } from './fixtures/keys';
import { panelClaims, panelEnv, signPanel } from './fixtures/panel';
import { seal, transitEnv } from './fixtures/transit';

// Resend on the Worker (E6): D1, the Worker host with SES delivery, replay only through a transit envelope (K2).
vi.setConfig({ testTimeout: 30000 });
const token = 'msk_panel_' + 'a'.repeat(43), apiKey = 'full-key-secret', host = 'internal.example';
const content = generateKeyPairSync('x25519'), contentKey = { ...content.privateKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' };
const env = { ...panelEnv, ...transitEnv, API_KEY: apiKey, SES_REGION: 'eu-west-1', INTERNAL_HOST: host,
  CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...content.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }),
  INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]) } as unknown as Env;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const pro = (capabilities: Extension['capabilities'] = ['resend']): Extension => ({ name: 'pro', capabilities, routes(app) {
  app.route('POST', '/resend', async (req, c) => {
    const result = await c.resend!.request({ messageId: new URL(req.url).searchParams.get('id')!, ...await req.json() as { reason: string; idempotencyKey: string; envelope: string } });
    return Response.json(result, { status: result.status });
  });
} });
let store: KyselyStore, mf: Miniflare, saved: Pick<typeof config, 'clients' | 'extensions' | 'logging'>;
let id: string, replay: unknown, sendEmail: ReturnType<typeof vi.fn<SendDeps['sendEmail']>>, app: ReturnType<typeof createApp>;
const envelope = (value: unknown, messageId = id, aud = host, op: 'resend.replay' | 'resend.source' = 'resend.replay') => seal({ replay: value }, op, aud, Date.now(), messageId);
const resend = async (body: Record<string, unknown>) => app.fetch(await signPanel(new Request(`https://${host}/internal/ext/pro/resend?id=${id}`, { method: 'POST',
  body: JSON.stringify({ reason: 'Requested by customer', idempotencyKey: 'worker-' + id, ...body }) }), token, panelClaims('operator'), { aud: host }), env, ctx);
const jobs = async () => (await sql`select * from resend_jobs`.execute(store.db)).rows.length;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
  store = createD1Store(await mf.getD1Database('DB')); await store.migrate();
  saved = structuredClone({ clients: config.clients, extensions: config.extensions, logging: config.logging });
  config.clients = [{ id: 'panel', tokenSha256: await tokenSha256(token), scopes: ['panel'], brands: '*', templates: '*', recipientOverride: false, attachments: false }];
  config.extensions = [{ module: 'mailstack-pro', options: {} }];
  config.logging.defaults.level = 'masked'; config.logging.brands.acme = { templates: { notice: { resend: 'replay' } } };
});
afterAll(async () => { Object.assign(config, saved); await store.db.destroy(); await mf.dispose(); });
beforeEach(async () => {
  await sql`delete from resend_jobs`.execute(store.db); await sql`delete from guards`.execute(store.db);
  sendEmail = vi.fn<SendDeps['sendEmail']>().mockResolvedValue({ ok: true, status: 200, messageId: 'provider-1' });
  const deps: SendDeps = { store, keys: testKeys(config), logging: config.logging, now: () => new Date(), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn(), sendEmail };
  const original = await renderAndSend(deps, env, config.brands.acme, getTemplate('notice')!, { paragraphs: 'Hello' }, { to: ['buyer@example.com'], clientId: 'sender' });
  id = original.id!; sendEmail.mockClear();
  const row = await store.db.selectFrom('replays').selectAll().where('message_id', '=', id).executeTakeFirstOrThrow();
  replay = await open(row.sealed, { brand: 'acme', messageId: id, purpose: 'replay' }, [contentKey]);
  app = createApp({ store, keys: testKeys(config), sendEmail, access: async () => true }, undefined, pro());
});

it('reports resend replay enabled on the Worker and source off without the egress service', async () => {
  const caps = await (await app.fetch(await signPanel(new Request(`https://${host}/internal/v2/capabilities`), token, panelClaims('operator'), { aud: host }), env, ctx)).json() as { features: Record<string, unknown> };
  expect(caps.features['resend.replay']).toEqual({ state: 'enabled' });
  expect(caps.features['resend.source']).toEqual({ state: 'disabled', reason: 'platform:secure_egress_unavailable' });
});
it('opens the envelope, checks the replay MAC on D1 and sends once per idempotency key', async () => {
  const first = await resend({ envelope: await envelope(replay) });
  expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ ok: true, resendId: expect.any(String), id: expect.any(String) });
  const again = await resend({ envelope: await envelope(replay) });
  expect(await again.json()).toMatchObject({ ok: true, idempotent: true });
  expect(sendEmail).toHaveBeenCalledTimes(1);
  expect(sendEmail.mock.calls[0][1].to).toEqual(['buyer@example.com']);
});
it.each([
  ['another message', async () => envelope(replay, 'msg_other'), 403, 'transit_invalid'],
  ['another audience', async () => envelope(replay, id, panelEnv.PANEL_AUDIENCE), 403, 'transit_invalid'],
  ['another operation', async () => envelope(replay, id, host, 'resend.source'), 403, 'transit_invalid'],
  ['no envelope', async () => undefined, 403, 'transit_invalid'],
  ['a changed replay', async () => envelope({ ...replay as object, data: { paragraphs: 'Changed' } }), 409, 'resend_mismatch'],
])('declines %s without a reservation or a send', async (_name, make, status, code) => {
  const response = await resend({ envelope: await make() });
  expect(response.status).toBe(status); expect(await response.json()).toMatchObject({ code });
  expect(await jobs()).toBe(0); expect(sendEmail).not.toHaveBeenCalled();
});
it('declines a replayed envelope', async () => {
  const value = await envelope(replay);
  expect((await resend({ envelope: value })).status).toBe(200);
  const second = await resend({ envelope: value, idempotencyKey: 'worker-2-' + id });
  expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ code: 'replayed' });
  expect(sendEmail).toHaveBeenCalledTimes(1);
});
it.each([[['resend'], 409, 'resend_mismatch'], [[], 400, 'not_supported']] as const)('routes a source resend on /v1/send through the host (capabilities %j)', async (capabilities, status, code) => {
  app = createApp({ store, keys: testKeys(config), sendEmail, access: async () => true }, undefined, pro([...capabilities]));
  const response = await app.fetch(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': 'unapproved' },
    body: JSON.stringify({ brand: 'acme', template: 'notice', to: 'buyer@example.com', paragraphs: 'Fresh', resendOf: id }) }), env, ctx);
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status, body: { code } });
  expect(sendEmail).not.toHaveBeenCalled();
});
