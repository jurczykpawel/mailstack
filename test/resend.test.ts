import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createResendService } from '../src/core/resend';
import { config } from '../src/core/config';
import { open } from '../src/core/crypto';
import { renderAndSend, handleSend } from '../src/send';
import { getTemplate } from '../src/templates';
import type { Env, SendDeps } from '../src/types';
import type { PanelPrincipal } from '../src/core/panel';
import type { ResendPayload } from '../src/core/resend-contract';

let store: ReturnType<typeof createSqliteStore>, deps: SendDeps, cfg: typeof config, now: number;
let service: ReturnType<typeof createResendService>, id: string, payload: ResendPayload;
const pair = generateKeyPairSync('x25519');
const privateKey = { ...pair.privateKey.export({ format: 'jwk' }), kid: 'c1', kty: 'OKP', crv: 'X25519' };
const env = { API_KEY: 'test-key', CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'c1' }] }), INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 7).toString('base64url') }]) } as Env;
const principal = (): PanelPrincipal => ({ actor: 'user-1', role: 'operator', issuedAt: now, expiresAt: now + 60000, stepUpAt: now, scopes: ['panel'], brands: '*', templates: '*' });
const request = (key = 'request-1', value: unknown = payload, panel = principal(), messageId = id) => service.forPanel(panel).request({ messageId, reason: 'Requested by customer', idempotencyKey: key, replay: value });
async function original(template = 'notice', clientId = 'sender') {
  const result = await renderAndSend(deps, env, cfg.brands.acme, getTemplate(template)!, { paragraphs: 'Hello', licenseKey: 'synthetic-key' }, { to: ['buyer@example.com'], clientId, ref: 'ORDER-1' });
  return result.id!;
}
beforeEach(async () => {
  now = Date.now(); cfg = structuredClone(config);
  cfg.logging.defaults.level = 'masked';
  cfg.logging.brands.acme = { templates: { notice: { resend: 'replay' }, license: { resend: 'source' } } };
  cfg.clients = [{ id: 'sender', tokenSha256: 'a'.repeat(64), scopes: ['send'], brands: ['acme'], templates: ['notice', 'license'], recipientOverride: true, attachments: false, resendCallback: { url: 'https://source.example/resend', secretEnv: 'SOURCE_SECRET' } }];
  store = createSqliteStore(':memory:'); await store.migrate();
  deps = { store, logging: cfg.logging, now: () => new Date(now), verifyTurnstile: vi.fn(), verifyAltcha: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200, messageId: 'provider-1' }) };
  service = createResendService(cfg, store, env, deps);
  id = await original();
  const row = await store.db.selectFrom('replays').selectAll().where('message_id', '=', id).executeTakeFirstOrThrow();
  payload = await open(row.sealed, { brand: 'acme', messageId: id, purpose: 'replay' }, [privateKey]) as ResendPayload;
  vi.mocked(deps.sendEmail).mockClear();
});
afterEach(async () => { vi.restoreAllMocks(); await store.db.destroy(); });

it('uses the shared pipeline and links children to their original root', async () => {
  const first = await request(); expect(first).toMatchObject({ ok: true, resendId: expect.any(String), id: expect.any(String) });
  const child = await store.db.selectFrom('messages').selectAll().where('id', '=', first.id!).executeTakeFirstOrThrow();
  expect(child).toMatchObject({ resend_of: id, resend_root: id, status: 'sent', level: 'masked' });
  now += 600000;
  const next = await request('request-2', payload, principal(), first.id!);
  expect(next.ok).toBe(true);
  expect(await store.db.selectFrom('messages').select(['resend_of', 'resend_root']).where('id', '=', next.id!).executeTakeFirst()).toEqual({ resend_of: first.id, resend_root: id });
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
});
it('returns the same outcome for twenty concurrent identical requests', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => request()));
  expect(new Set(results.map(r => r.resendId)).size).toBe(1);
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  expect(await request()).toMatchObject({ ok: true, idempotent: true, resendId: results[0].resendId });
});
it.each(['data', 'to', 'template'] as const)('requires the stored %s value', async field => {
  const value = { ...payload, [field]: field === 'data' ? { ...payload.data, paragraphs: 'hello' } : field === 'to' ? ['other@example.com'] : 'welcome' };
  expect(await request('request-1', value)).toMatchObject({ ok: false, status: 409, code: 'resend_mismatch' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it.each(['sending', 'unknown'] as const)('refuses an original with status %s', async status => {
  await store.setStatus(id, status);
  expect(await request()).toMatchObject({ code: 'original_unresolved' });
});
it.each(['bounce_permanent', 'reject', 'complaint'])('refuses original recipient outcome %s', async status => {
  if (status === 'complaint') await store.db.updateTable('messages').set({ complained: 1 }).where('id', '=', id).execute();
  else await store.db.updateTable('recipients').set({ status: status as 'reject' }).where('message_id', '=', id).execute();
  expect(await request()).toMatchObject({ code: 'suppressed' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it('requires current policy, registered classification and retained content', async () => {
  cfg.logging.brands.acme.templates!.notice.resend = 'off'; expect(await request()).toMatchObject({ code: 'resend_disabled' });
  cfg.logging.brands.acme.templates!.notice.resend = 'replay';
  const template = getTemplate('notice')!;
  const previous = template.secretFields; template.secretFields = ['paragraphs'];
  try { expect(await request()).toMatchObject({ code: 'resend_disabled' }); } finally { template.secretFields = previous; }
  await store.db.updateTable('replays').set({ expires_at: now }).where('message_id', '=', id).execute();
  expect(await request()).toMatchObject({ code: 'resend_disabled' });
});
it('refuses missing, erased and expired sources', async () => {
  expect(await request('request-1', payload, principal(), 'msg_missing')).toMatchObject({ status: 404, code: 'not_found' });
  await store.db.updateTable('messages').set({ meta_expires_at: now }).where('id', '=', id).execute();
  expect(await request()).toMatchObject({ status: 404 });
  await store.db.deleteFrom('messages').where('id', '=', id).execute(); expect(await request()).toMatchObject({ status: 404 });
});
it.each([{ role: 'viewer' }, { stepUpAt: null }, { stepUpAt: 0 }, { brands: [] }, { templates: [] }, { scopes: [] }])('requires panel permission %j', async change => {
  expect(await request('request-1', payload, { ...principal(), ...change } as PanelPrincipal)).toMatchObject({ status: 403 });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it('requires a reason, valid key and an available audit writer', async () => {
  for (const input of [{ reason: 'short', idempotencyKey: 'key' }, { reason: 'Long enough reason', idempotencyKey: 'bad key' }]) {
    expect(await service.forPanel(principal()).request({ messageId: id, ...input, replay: payload })).toMatchObject({ status: 400 });
  }
  await sql`drop table audit`.execute(store.db);
  expect(await request()).toMatchObject({ status: 503 });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it('keeps uncertain outcomes and post-send write failures from sending again', async () => {
  vi.spyOn(store, 'markSent').mockRejectedValue(new Error('unavailable'));
  expect(await request()).toMatchObject({ code: 'send_failed' });
  expect(await request()).toMatchObject({ code: 'outcome_unknown' });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});
it('releases explicit refusal reservations for the same key', async () => {
  vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
  const first = await request(); expect(first).toMatchObject({ code: 'send_failed' });
  expect(await request()).toMatchObject({ ok: true, resendId: first.resendId });
  expect(deps.sendEmail).toHaveBeenCalledTimes(2);
});
it('reserves source sends for the owning client and approved key only', async () => {
  id = await original('license'); vi.mocked(deps.sendEmail).mockClear();
  const approved = await request('source-key', undefined);
  expect(approved).toMatchObject({ ok: true, status: 202, source: { owner: { clientId: 'sender' } } });
  const sourcePayload = { to: ['buyer@example.com'], template: 'license', data: { licenseKey: 'new-synthetic-key' } };
  expect(await service.sendSource('other', id, 'source-key', sourcePayload)).toMatchObject({ code: 'resend_mismatch' });
  expect(await service.sendSource('sender', id, 'wrong-key', sourcePayload)).toMatchObject({ code: 'resend_mismatch' });
  expect(await service.sendSource('sender', id, 'source-key', { ...sourcePayload, to: ['other@example.com'] })).toMatchObject({ code: 'resend_mismatch' });
  expect(await service.sendSource('sender', id, 'source-key', sourcePayload)).toMatchObject({ ok: true });
  expect(await service.sendSource('sender', id, 'source-key', sourcePayload)).toMatchObject({ ok: true, idempotent: true });
  expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});
it('requires a source reference and a current owning callback client', async () => {
  id = await original('license');
  const clients = cfg.clients; cfg.clients = []; expect(await request()).toMatchObject({ code: 'resend_disabled' });
  cfg.clients = clients;
  await store.db.updateTable('messages').set({ ref_sealed: null }).where('id', '=', id).execute();
  expect(await request()).toMatchObject({ code: 'no_ref' });
});
it('fails closed if child logging is unavailable even when requireLog is false', async () => {
  vi.spyOn(store, 'insertMessage').mockRejectedValue(new Error('unavailable'));
  expect(await request()).toMatchObject({ status: 503, code: 'log_unavailable' });
  expect(deps.sendEmail).not.toHaveBeenCalled();
});
it('does not expose history from the public send endpoint', async () => {
  const response = await handleSend(new Request('https://mail.example/v1/send', { method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify({ brand: 'acme', template: 'notice', resendOf: id }) }), env, deps);
  expect(await response.json()).toMatchObject({ code: 'not_supported' });
});

it('accepts approved source calls through the send handler', async () => {
  const { tokenSha256 } = await import('../src/clients');
  const token = 'msk_sender_' + 'a'.repeat(43);
  cfg.clients![0].tokenSha256 = await tokenSha256(token);
  const previous = config.clients; config.clients = cfg.clients;
  id = await original('license'); vi.mocked(deps.sendEmail).mockClear();
  const call = (key = 'source-key', address = 'buyer@example.com') => handleSend(new Request('https://mail.example/v1/send', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': key },
    body: JSON.stringify({ brand: 'acme', template: 'license', to: address, licenseKey: 'fresh-key', resendOf: id }),
  }), env, { ...deps, resendSource: (_env, client, messageId, key, payload, ref, attachments) => service.sendSource(client, messageId, key, payload, ref, attachments) });
  try {
    expect(await (await call()).json()).toMatchObject({ code: 'resend_mismatch' });
    expect(await request('source-key', undefined)).toMatchObject({ status: 202 });
    expect(await (await call('other-key')).json()).toMatchObject({ code: 'resend_mismatch' });
    expect(await (await call('source-key', 'other@example.com')).json()).toMatchObject({ code: 'resend_mismatch' });
    expect(await (await call()).json()).toMatchObject({ success: true, id: expect.any(String) });
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  } finally { config.clients = previous; }
});
