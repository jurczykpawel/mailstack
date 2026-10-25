import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { config, getBrand } from '../src/core/config';
import { idempotencyHash } from '../src/core/logging/writer';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { handleSend, renderAndSend } from '../src/send';
import { handleSellfHook } from '../src/sellf';
import { getTemplate } from '../src/templates';
import type { Env, SendDeps } from '../src/types';

for (const driver of ['sqlite', 'd1'] as const) {
  describe(`none idempotency: ${driver}`, () => {
    let store: KyselyStore;
    let mf: Miniflare | undefined;
    let deps: SendDeps;
    let loggedEnv: Env;
    let now: number;
    const env = { API_KEY: 'test-key' } as Env;
    const body = { brand: 'acme', template: 'notice', heading: 'Hello' };
    const send = (data: object = body, key: string | null = 'request-1') => handleSend(new Request('https://mail.example/v1/send', {
      method: 'POST', headers: { authorization: 'Bearer test-key', ...(key === null ? {} : { 'Idempotency-Key': key }) },
      body: JSON.stringify(data),
    }), env, deps);
    const guards = () => store.db.selectFrom('guards').selectAll().execute();
    beforeAll(async () => {
      if (driver === 'sqlite') store = createSqliteStore(':memory:');
      else {
        mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
          compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
        store = createD1Store(await mf.getD1Database('DB'));
      }
      await store.migrate();
      const kem = new DhkemX25519HkdfSha256();
      const pair = await kem.generateKeyPair();
      const x = Buffer.from(await kem.serializePublicKey(pair.publicKey)).toString('base64url');
      loggedEnv = { ...env, CONTENT_PUBLIC_KEYS: JSON.stringify({ keys: [{ kid: 'c1', kty: 'OKP', crv: 'X25519', x }] }),
        INDEX_KEYS: JSON.stringify([{ kid: 'i1', key: Buffer.alloc(32, 11).toString('base64url') }]) };
    });
    beforeEach(async () => {
      await store.db.deleteFrom('guards').execute();
      now = Date.parse('2026-10-24T12:00:00Z');
      deps = { store, logging: structuredClone(config.logging), now: () => new Date(now),
        verifyAltcha: vi.fn(), verifyTurnstile: vi.fn(), sendEmail: vi.fn().mockResolvedValue({ ok: true, status: 200 }) };
      deps.logging!.defaults.level = 'none';
    });
    afterEach(() => { vi.restoreAllMocks(); });
    afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

    it('returns a duplicate acknowledgement without an id or message row', async () => {
      expect(await (await send()).json()).toEqual({ success: true });
      expect(await (await send()).json()).toEqual({ success: true, idempotent: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
      expect(await store.db.selectFrom('messages').selectAll().execute()).toEqual([]);
      expect(await guards()).toEqual([{ key: 'idem:legacy:' + await idempotencyHash('legacy', 'request-1'), count: 1, expires_at: now + 86400000 }]);
      expect(vi.mocked(deps.sendEmail).mock.calls[0][1]).not.toHaveProperty('messageId');
    });

    it('acknowledges a changed body using the same key', async () => {
      await send();
      expect(await (await send({ ...body, heading: 'Changed' })).json()).toEqual({ success: true, idempotent: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('releases a refused attempt and sends its retry', async () => {
      vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
      expect((await send()).status).toBe(502);
      expect(await guards()).toEqual([]);
      expect((await send()).status).toBe(200);
      expect(await (await send()).json()).toEqual({ success: true, idempotent: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('keeps an uncertain attempt reserved', async () => {
      vi.mocked(deps.sendEmail).mockRejectedValueOnce(new Error('provider timeout'));
      expect((await send()).status).toBe(502);
      expect(await (await send()).json()).toEqual({ success: true, idempotent: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
      expect(await guards()).toHaveLength(1);
    });

    it('sends once for twenty concurrent requests', async () => {
      const responses = await Promise.all(Array.from({ length: 20 }, () => send()));
      expect(responses.every(response => response.status === 200)).toBe(true);
      const bodies = await Promise.all(responses.map(response => response.json())) as { idempotent?: true }[];
      expect(bodies.filter(body => body.idempotent)).toHaveLength(19);
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('scopes the same key to each client', async () => {
      const call = (clientId: string) => renderAndSend(deps, env, getBrand('acme')!, getTemplate('notice')!, {}, {
        clientId, idempotencyKey: 'shared', to: ['buyer@example.com'],
      });
      expect((await call('client-a')).ok).toBe(true);
      expect((await call('client-b')).ok).toBe(true);
      expect(await call('client-a')).toMatchObject({ ok: true, idempotent: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
      expect(await guards()).toHaveLength(2);
    });

    it('sends without deduplication when no key is provided', async () => {
      await send(body, null); await send(body, null);
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
      expect(await guards()).toEqual([]);
    });

    it('keeps the original expiry and permits a new attempt after guard cleanup', async () => {
      await send();
      now += 86400000 - 1;
      await store.purgeGuards(now);
      expect(await (await send()).json()).toEqual({ success: true, idempotent: true });
      now++;
      await store.purgeGuards(now);
      expect(await (await send()).json()).toEqual({ success: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    });

    it.each([true, false])('continues on missing or unavailable storage with requireLog=%s', async required => {
      deps.logging!.defaults.requireLog = required;
      deps.store = undefined;
      expect((await send()).status).toBe(200);
      deps.store = store;
      vi.spyOn(store, 'consume').mockRejectedValue(new Error('unavailable'));
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect(deps.sendEmail).toHaveBeenCalledTimes(3);
    });

    it('keeps the provider response when releasing the key fails', async () => {
      vi.spyOn(store, 'release').mockRejectedValue(new Error('unavailable'));
      vi.mocked(deps.sendEmail).mockResolvedValueOnce({ ok: false, status: 400 });
      const response = await send();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ success: false, message: 'send failed', code: 'send_failed' });
    });

    it('leaves the key available after a preparation error', async () => {
      vi.spyOn(getTemplate('notice')!, 'render').mockImplementationOnce(() => { throw new Error('render failed'); });
      await expect(send()).rejects.toThrow('render failed');
      expect(deps.sendEmail).not.toHaveBeenCalled();
      expect(await guards()).toEqual([]);
      expect((await send()).status).toBe(200);
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('releases only the selected guard and permits consuming it again', async () => {
      await store.consume('first', now); await store.consume('second', now);
      await store.release('first'); await store.release('absent');
      expect(await store.consume('first', now)).toBe(true);
      expect(await store.consume('second', now)).toBe(false);
    });

    it('deduplicates automatic Sellf keys and preserves the hook response', async () => {
      const hook = () => handleSellfHook(new Request('https://mail.example/v1/hooks/sellf?brand=acme', {
        method: 'POST', headers: { authorization: 'Bearer test-key' }, body: JSON.stringify({
          event: 'purchase.completed', timestamp: new Date(now).toISOString(),
          data: { customer: { email: 'buyer@example.com' }, order: { sessionId: 'order-1', amount: 100 }, product: { name: 'Plan' } },
        }),
      }), env, deps);
      expect(await (await hook()).json()).toEqual({ success: true });
      expect(await (await hook()).json()).toEqual({ success: true });
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    });

    it.each(['meta', 'masked', 'full'] as const)('uses message rows without a none guard at level %s', async level => {
      deps.logging!.defaults.level = level;
      const consume = vi.spyOn(store, 'consume');
      const call = (data = {}) => renderAndSend(deps, loggedEnv, getBrand('acme')!, getTemplate('notice')!, data, {
        clientId: 'legacy', idempotencyKey: level, to: ['buyer@example.com'],
      });
      const first = await call();
      expect(first).toMatchObject({ ok: true, id: expect.stringMatching(/^msg_/) });
      expect(await call()).toMatchObject({ ok: true, id: first.id, idempotent: true });
      expect(await call({ heading: 'Changed' })).toMatchObject({ ok: false, status: 409, code: 'idempotency_conflict' });
      expect(await store.findByIdempotency('legacy', await idempotencyHash('legacy', level))).toMatchObject({ id: first.id, status: 'sent', level });
      expect(consume).not.toHaveBeenCalled();
      expect(await guards()).toEqual([]);
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    });
  });
}
