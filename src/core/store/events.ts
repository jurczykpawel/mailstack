import { sql } from 'kysely';
import type { KyselyStore } from './index';

export interface Message { id: string; brand: string; provider_account: string | null; provider_message_id: string | null }
export interface Recipient { pos: number; addr_idx: string; idx_kid: string; status: string }
export interface EventRow {
  id: string; message_id: string; recipient_pos: number | null; source: string; source_event_id: string;
  type: string; occurred_at: number; received_at: number; auth: string; summary: string; evidence_sealed: string;
}
const ranks: Record<string, number> = { sending: 0, unknown: 5, accepted: 10, delay: 20, delivered: 30,
  bounce_transient: 40, bounce_undetermined: 40, render_failure: 50, reject: 50, send_failed: 50, bounce_permanent: 50 };
const rank = (column: string) => sql.raw(`case ${column} ${Object.entries(ranks).map(([k, v]) => `when '${k}' then ${v}`).join(' ')} else -1 end`);
export function eventId(now: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '', random = '';
  for (let i = 0; i < 10; i++) { time = alphabet[now % 32] + time; now = Math.floor(now / 32); }
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) random += alphabet[byte & 31];
  return 'evt_' + time + random;
}
export async function findMessage(store: KyselyStore, id: string | undefined, account: string, providerId: string): Promise<Message | undefined> {
  const db = store.db;
  const result = id ? await sql<Message>`select id,brand,provider_account,provider_message_id from messages where id=${id}`.execute(db)
    : await sql<Message>`select id,brand,provider_account,provider_message_id from messages where provider_account=${account} and provider_message_id=${providerId}`.execute(db);
  return result.rows[0];
}
export async function recipients(store: KyselyStore, id: string): Promise<Recipient[]> {
  return (await sql<Recipient>`select pos,addr_idx,idx_kid,status from recipients where message_id=${id} order by pos`.execute(store.db)).rows;
}
export async function recordEvents(store: KyselyStore, rows: EventRow[]): Promise<boolean> {
  const id = rows[0].message_id;
  const statements = rows.map(row => sql`insert into events (${sql.join(Object.keys(row).map(k => sql.ref(k)))})
    select ${sql.join(Object.values(row))} where exists(select 1 from messages where id=${id})
    on conflict(source,source_event_id) do nothing`.compile(store.db));
  statements.push(sql`update recipients set
    status=coalesce((select type from events where message_id=${id} and recipient_pos=recipients.pos
      and ${rank('type')}>${rank('recipients.status')} order by ${rank('type')} desc, occurred_at desc, id desc limit 1),status),
    last_event_at=(select max(occurred_at) from (select occurred_at from events where message_id=${id} and recipient_pos=recipients.pos
      union all select recipients.last_event_at as occurred_at))
    where message_id=${id}`.compile(store.db));
  statements.push(sql`update messages set
    status=coalesce((select status from recipients where message_id=${id} order by ${rank('status')} desc,pos limit 1),status),
    complained=case when exists(select 1 from events where message_id=${id} and type='complaint') then 1 else complained end
    where id=${id}`.compile(store.db));
  const results = await store.atomic(statements);
  return results.slice(0, rows.length).some(r => r.numAffectedRows === 1n);
}
export async function auditConfirmation(store: KyselyStore, at: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = (await sql<{ seq: number; hash: string }>`select seq,hash from audit order by seq desc limit 1`.execute(store.db)).rows[0];
    const seq = (head?.seq ?? 0) + 1, prev = head?.hash ?? '';
    const input = `${prev}\n${seq}\n${at}\nsystem\nevents.subscription_confirmed\n\n{}`;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))), b => b.toString(16).padStart(2, '0')).join('');
    try {
      await sql`insert into audit(seq,at,actor,action,target,details,prev_hash,hash)
        values(${seq},${at},'system','events.subscription_confirmed',null,'{}',${prev},${hash})`.execute(store.db);
      return;
    } catch (error) { if (attempt === 2) throw error; }
  }
}
