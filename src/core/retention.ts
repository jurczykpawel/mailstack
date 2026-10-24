import { sql } from 'kysely';
import { appendAudit } from './audit';
import { pruneAudit } from './store/audit';
import type { KyselyStore } from './store';
import type { Config } from './config/schema';

export function isContentReadable(row: { expires_at: number } | null | undefined, now: number): boolean {
  return !!row && row.expires_at > now;
}
export async function runRetention(store: KyselyStore, now: number, cfg: Config): Promise<void> {
  for (const table of ['contents', 'replays', 'guards'])
    await sql`delete from ${sql.table(table)} where expires_at <= ${now}`.execute(store.db);
  while (true) {
    const ids = sql`select id from messages where meta_expires_at < ${now}
      or created_at < ${now - cfg.logging.ceilings.metaDays * 86400000} order by id limit 500`;
    if (!(await ids.execute(store.db)).rows.length) break;
    await store.batch([
      ...['recipients', 'subjects', 'events', 'contents', 'replays'].map(table =>
        sql`delete from ${sql.table(table)} where message_id in (${ids})`),
      sql`delete from messages where id in (${ids})`,
    ]);
  }
  await sql`delete from contents where message_id in (select id from messages
    where created_at <= ${now - cfg.logging.ceilings.contentDays * 86400000})`.execute(store.db);
  await sql`delete from replays where message_id in (select id from messages
    where created_at <= ${now - cfg.logging.ceilings.contentDays * 86400000})`.execute(store.db);
  while (true) {
    const rows = (await sql<{ id: string }>`select id from messages
      where status = 'sending' and created_at < ${now - 900000} limit 500`.execute(store.db)).rows;
    if (!rows.length) break;
    await store.batch(rows.flatMap(({ id }) => [
      sql`insert into events(id,message_id,source,source_event_id,type,occurred_at,received_at,auth)
        select ${eventId(now)},id,'local',${'unknown:' + id},'unknown',${now},${now},'local'
        from messages where id = ${id} and status = 'sending' and created_at < ${now - 900000}
        on conflict(source,source_event_id) do nothing`,
      sql`update messages set status = 'unknown' where id = ${id} and status = 'sending' and created_at < ${now - 900000}`,
    ]));
  }
  await pruneAudit(store, now - cfg.logging.ceilings.auditDays * 86400000, row => appendAudit(store, {
    at: now, actor: 'system', action: 'audit.pruned', details: { upTo: row.seq, hashAtUpTo: row.hash },
  }));
}

function eventId(now: number): string {
  let value = BigInt(now);
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) value = (value << 8n) | BigInt(byte);
  let id = '';
  for (let i = 0; i < 26; i++) {
    id = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return 'evt_' + id;
}
