import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { sql } from 'kysely';
import { config } from '../src/core/config';
import { open } from '../src/core/crypto';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { handleSend } from '../src/send';
import type { Env, SendDeps } from '../src/types';

let privateKey: JsonWebKey & { kid: string };
let publicKeys: string;
beforeAll(async () => {
  const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  const pair = await suite.kem.generateKeyPair();
  const publicKey = { kid: 'c1', kty: 'OKP', crv: 'X25519', x: Buffer.from(await suite.kem.serializePublicKey(pair.publicKey)).toString('base64url') };
  privateKey = { ...publicKey, d: Buffer.from(await suite.kem.serializePrivateKey(pair.privateKey)).toString('base64url') };
  publicKeys = JSON.stringify({ keys: [publicKey] });
});

for (const driver of ['sqlite', 'd1'] as const) describe(`send outcomes: ${driver}`, () => {
  let store: KyselyStore;
  let mf: Miniflare | undefined;
  let env: Env;
  let deps: SendDeps;
  const response = { __type: 'AccessDeniedException', message: 'Configuration set not permitted for buyer@example.com' };
  const send = () => handleSend(new Request('https://mail.example/v1/send', {
    method: 'POST', headers: { authorization: 'Bearer test-key', 'Idempotency-Key': 'failure-1' },
    body: JSON.stringify({ brand: 'acme', template: 'notice', heading: 'Notice', paragraphs: 'Body' }),
  }), env, deps);
  const row = () => store.db.selectFrom('messages').selectAll().executeTakeFirstOrThrow();
  beforeAll(async () => {
    if (driver === 'sqlite') store = createSqliteStore(':memory:');
    else {
      mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
        compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
      store = createD1Store(await mf.getD1Database('DB'));
    }
    await store.migrate();
  });
  beforeEach(async () => {
    await store.db.deleteFrom('messages').execute();
    env = { API_KEY: 'test-key', SES_REGION: 'eu-west-1', SES_ACCESS_KEY_ID: '', SES_SECRET_ACCESS_KEY: '', TURNSTILE_SECRET: '', ALTCHA_HMAC_KEY: '',
      CONTENT_PUBLIC_KEYS: publicKeys, INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) };
    deps = { store, logging: structuredClone(config.logging), now: () => new Date('2026-10-24T12:00:00Z'),
      verifyAltcha: async () => false, verifyTurnstile: async () => false,
      sendEmail: vi.fn().mockResolvedValue({ ok: false, status: 403, response }) };
  });
  afterEach(async () => { vi.restoreAllMocks(); await sql`drop trigger if exists failure_update`.execute(store.db); });
  afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

  it('records the refusal status and sealed provider body in one update', async () => {
    await sql`create trigger failure_update before update on messages
      when (new.status = 'send_failed' and new.provider_response_sealed is null)
        or (new.provider_response_sealed is not null and new.status != 'send_failed')
      begin select raise(abort, 'paired update required'); end`.execute(store.db);
    const res = await send();
    const message = await row();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, message: 'send failed', code: 'send_failed', id: message.id });
    expect(message.status).toBe('send_failed');
    expect(message.provider_response_sealed).toMatch(/^ms1\./);
    expect(await open(message.provider_response_sealed!, { brand: 'acme', messageId: message.id, purpose: 'provider_response' }, [privateKey])).toEqual(response);
    expect(JSON.stringify(message)).not.toContain('buyer@example.com');
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps the refusal response when storing its sealed body fails', async () => {
    await sql`create trigger failure_update before update on messages when new.provider_response_sealed is not null
      begin select raise(abort, 'body unavailable'); end`.execute(store.db);
    const res = await send();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, message: 'send failed', code: 'send_failed' });
    expect(await row()).toMatchObject({ status: 'send_failed', provider_response_sealed: null });
  });

  it('keeps the refusal response when sealing its body fails', async () => {
    vi.mocked(deps.sendEmail).mockImplementation(async () => {
      env.CONTENT_PUBLIC_KEYS = '{}';
      return { ok: false, status: 403, response };
    });
    const res = await send();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, message: 'send failed', code: 'send_failed' });
    expect(await row()).toMatchObject({ status: 'send_failed', provider_response_sealed: null });
  });

  it('preserves the refusal response when its fallback status write also fails', async () => {
    vi.mocked(deps.sendEmail).mockImplementation(async () => {
      env.CONTENT_PUBLIC_KEYS = '{}';
      return { ok: false, status: 403, response };
    });
    const status = vi.spyOn(store, 'setStatus').mockRejectedValue(new Error('storage unavailable'));
    const res = await send();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: false, message: 'send failed', code: 'send_failed' });
    expect(status).toHaveBeenCalledExactlyOnceWith((await row()).id, 'send_failed');
  });

  it('retains an unknown network outcome and does not send it again', async () => {
    vi.mocked(deps.sendEmail).mockRejectedValue(new Error('network unavailable'));
    expect((await send()).status).toBe(502);
    expect(await row()).toMatchObject({ status: 'unknown', provider_response_sealed: null });
    const res = await send();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'outcome_unknown' });
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
  });
});
