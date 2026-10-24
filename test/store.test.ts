import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { createSqliteStore } from '../src/core/store/sqlite';
import { createD1Store } from '../src/core/store/d1';
import type { KyselyStore } from '../src/core/store';
import { createChallenge, verifyAltcha } from '../src/altcha';
import { handleSend } from '../src/send';
import { checkRateLimit } from '../src/ratelimit';
import type { Env, SendDeps } from '../src/types';

for (const driver of ['sqlite', 'd1'] as const) {
  describe(`store: ${driver}`, () => {
    let store: KyselyStore;
    let mf: Miniflare | undefined;
    beforeAll(async () => {
      if (driver === 'sqlite') store = createSqliteStore(':memory:');
      else {
        mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("ok") } }',
          compatibilityDate: '2026-06-01', d1Databases: ['DB'] }));
        store = createD1Store(await mf.getD1Database('DB'));
      }
      await store.migrate();
    });
    afterAll(async () => { await store?.db.destroy(); await mf?.dispose(); });

    it('applies the full schema repeatedly without changing rows', async () => {
      await store.consume('migration-check', 1000);
      await store.migrate();
      await store.migrate();
      expect(await store.consume('migration-check', 1000)).toBe(false);
      const tables = await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(store.db);
      expect(tables.rows.map(r => r.name)).toEqual(expect.arrayContaining([
        'messages', 'recipients', 'subjects', 'contents', 'replays', 'events', 'guards', 'audit',
      ]));
      await expect(sql`insert into messages(id) values ('m')`.execute(store.db)).rejects.toThrow();
      await expect(sql`insert into recipients values ('m',0,'other','i','k','s','h','sent',null)`.execute(store.db)).rejects.toThrow();
    });

    it('accepts one of twenty simultaneous single-use operations', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => store.consume('once', 5000)));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('counts every concurrent attempt and keeps its original expiry', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => store.increment('count', 5000)));
      expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      await store.increment('count', 9000);
      const result = await sql<{ expires_at: number }>`select expires_at from guards where key = 'count'`.execute(store.db);
      expect(result.rows[0].expires_at).toBe(5000);
    });

    it('uses separate brand, IP and hourly windows', async () => {
      const now = new Date('2026-10-24T12:59:59Z');
      const results = await Promise.all(Array.from({ length: 20 }, () => checkRateLimit(store, 'demo', 'ip', now)));
      expect(results.filter(Boolean)).toHaveLength(8);
      expect(await checkRateLimit(store, 'acme', 'ip', now)).toBe(true);
      expect(await checkRateLimit(store, 'demo', 'other', now)).toBe(true);
      expect(await checkRateLimit(store, 'demo', 'ip', new Date('2026-10-24T13:00:00Z'))).toBe(true);
    });

    it('removes only expired guards including the boundary', async () => {
      await store.consume('expired', 10000);
      await store.consume('active', 10001);
      await store.purgeGuards(10000);
      expect(await store.consume('expired', 20000)).toBe(true);
      expect(await store.consume('active', 20000)).toBe(false);
    });

    it('returns one 200 for twenty submissions of the same ALTCHA solution', async () => {
      const key = 'test-altcha-store-key';
      const challenge = await createChallenge(key, { maxnumber: 0 });
      const payload = btoa(JSON.stringify({ ...challenge, number: 0 }));
      let sent = 0;
      const deps: SendDeps = { store, verifyAltcha, verifyTurnstile: async () => false,
        sendEmail: async () => { sent++; return { ok: true, status: 200 }; }, now: () => new Date() };
      const responses = await Promise.all(Array.from({ length: 20 }, () => handleSend(new Request('https://mail.example/v1/send', {
        method: 'POST', headers: { origin: 'https://demo.example' },
        body: JSON.stringify({ brand: 'demo', altcha: payload, autoreply: false }),
      }), { ALTCHA_HMAC_KEY: key } as Env, deps)));
      expect(responses.filter(r => r.status === 200)).toHaveLength(1);
      expect(responses.filter(r => r.status === 403)).toHaveLength(19);
      expect(sent).toBe(1);
    });
  });
}
