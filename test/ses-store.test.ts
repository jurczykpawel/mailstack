import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sql } from 'kysely';
import { createD1Store } from '../src/core/store/d1';
import { createSqliteStore } from '../src/core/store/sqlite';
import type { KyselyStore } from '../src/core/store';
import { eventId, findMessage, recordEvents } from '../src/core/store/events';

for (const driver of ['sqlite', 'd1'] as const) describe(`event storage: ${driver}`, () => {
  let store: KyselyStore, mf: Miniflare | undefined;
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
  async function seed(id: string, status: string) {
    await sql`insert into messages(id,client_id,brand,template,level,policy_hash,status,created_at,meta_expires_at,provider_account,provider_message_id)
      values(${id},'demo','acme','notice','meta','hash',${status},0,9999999999999,'123456789012',${id})`.execute(store.db);
    await sql`insert into recipients values(${id},0,'to','index','i1','sealed','hint',${status},200)`.execute(store.db);
  }
  const row = (id: string, type = 'accepted') => ({ id: eventId(Date.now()), message_id: id, recipient_pos: 0, source: 'ses-sns', source_event_id: id + ':0', type,
    occurred_at: 100, received_at: 300, auth: 'sns-sig-v2', summary: '', evidence_sealed: 'sealed' });
  it.each(['unknown', 'accepted', 'delay', 'delivered', 'bounce_transient', 'bounce_undetermined', 'render_failure', 'reject', 'send_failed', 'bounce_permanent'])(
    'preserves the rank of %s for a late accepted event', async (status) => {
      const id = 'msg_' + status;
      await seed(id, status);
      expect(await recordEvents(store, [row(id)])).toBe(true);
      expect(await recordEvents(store, [row(id)])).toBe(false);
      const result = (await sql<{ status: string; last_event_at: number }>`select status,last_event_at from recipients where message_id=${id}`.execute(store.db)).rows[0];
      expect(result).toEqual({ status: status === 'unknown' ? 'accepted' : status, last_event_at: 200 });
    });
  it('rolls back an event when the message projection cannot be written', async () => {
    await seed('msg_atomic', 'sending');
    await sql`create trigger projection_error before update on messages when new.id='msg_atomic' begin select raise(abort,'projection error'); end`.execute(store.db);
    await expect(recordEvents(store, [row('msg_atomic')])).rejects.toThrow();
    expect((await sql`select * from events where message_id='msg_atomic'`.execute(store.db)).rows).toHaveLength(0);
    expect((await sql<{ status: string }>`select status from recipients where message_id='msg_atomic'`.execute(store.db)).rows[0].status).toBe('sending');
  });
  it('does not create events for a deleted message', async () => {
    expect(await recordEvents(store, [row('msg_deleted')])).toBe(false);
    expect((await sql`select * from events where message_id='msg_deleted'`.execute(store.db)).rows).toHaveLength(0);
  });
  it('resolves tags and scopes provider identifiers by account', async () => {
    expect((await findMessage(store, 'msg_delivered', 'other', 'different'))?.id).toBe('msg_delivered');
    expect(await findMessage(store, undefined, 'other', 'msg_delivered')).toBeUndefined();
    expect((await findMessage(store, undefined, '123456789012', 'msg_delivered'))?.id).toBe('msg_delivered');
  });
});
