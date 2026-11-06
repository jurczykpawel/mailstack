import { sql } from 'kysely';
import type { KyselyStore } from './index';

export interface ResendJob {
  id: string; message_id: string; root: string; actor: string; token: string;
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  strategy: 'replay' | 'source'; payload_mac: string | null; error: string | null;
  created_at: number; expires_at: number; result_id: string | null;
}
export async function getResend(store: KyselyStore, id: string): Promise<ResendJob | undefined> {
  return (await sql<ResendJob>`select * from resend_jobs where id=${id}`.execute(store.db)).rows[0];
}
export const unsuppressed = (id: string | import('kysely').RawBuilder<unknown>) => sql`not exists(select 1 from messages m where m.id=${id}
  and (m.complained=1 or m.status in ('bounce_permanent','reject')))
  and not exists(select 1 from recipients original join recipients r on r.addr_idx=original.addr_idx and r.idx_kid=original.idx_kid
    join messages m on m.id=r.message_id where original.message_id=${id}
    and (r.status in ('bounce_permanent','reject') or m.complained=1))`;
export async function claimResend(store: KyselyStore, input: { id: string; messageId: string; root: string; actor: string; now: number; metaCutoff: number; strategy?: 'replay' | 'source' }): Promise<boolean> {
  const { id, messageId, root, actor, now, metaCutoff } = input;
  const token = crypto.randomUUID(), dayEnd = (Math.floor(now / 86400000) + 1) * 86400000;
  const scopes = [`resend:root:${root}:`, `resend:actor:${actor}:`, 'resend:instance:'];
  const count = (prefix: string, cutoff = now) => sql`(select count(*) from guards where substr(key,1,${prefix.length})=${prefix} and expires_at > ${cutoff})`;
  const insert = sql`insert into resend_jobs(id,message_id,root,actor,token,strategy,state,created_at,expires_at)
    select ${id},${messageId},${root},${actor},${token},${input.strategy ?? 'replay'},'pending',${now},${now + 86400000}
    where exists(select 1 from messages where id=${messageId} and meta_expires_at > ${now} and created_at > ${metaCutoff}
      and coalesce(resend_root,id)=${root} and status not in ('sending','unknown')) and ${unsuppressed(messageId)}
    and ${count(scopes[0])} < 3 and ${count(scopes[0], now + 85800000)}=0
    and ${count(scopes[1])} < 20 and ${count(scopes[2])} < 50
    on conflict(id) do update set token=excluded.token,state='pending',created_at=excluded.created_at,expires_at=excluded.expires_at,error=null
    where resend_jobs.state='failed' and resend_jobs.message_id=excluded.message_id and resend_jobs.actor=excluded.actor and resend_jobs.root=excluded.root and resend_jobs.strategy=excluded.strategy`;
  const guards = scopes.map((prefix, i) => sql`insert into guards(key,count,expires_at)
    select ${prefix + id},1,${i === 0 ? now + 86400000 : dayEnd} from resend_jobs where id=${id} and token=${token}
    on conflict(key) do update set expires_at=excluded.expires_at`);
  const changes = await store.batch([insert, ...guards].map(q => q.compile(store.db)));
  return changes[0] === 1;
}
export async function startResend(store: KyselyStore, id: string, now: number, payloadMac: string, token: string): Promise<boolean> {
  const result = await sql`update resend_jobs set state='sending',created_at=${now},payload_mac=${payloadMac} where id=${id} and token=${token} and state='pending' and expires_at > ${now}
    and exists(select 1 from messages m where m.id=resend_jobs.message_id and m.meta_expires_at > ${now} and m.status not in ('sending','unknown'))
    and ${unsuppressed(sql`resend_jobs.message_id`)}`.execute(store.db);
  return result.numAffectedRows === 1n;
}
export async function finishResend(store: KyselyStore, id: string, state: ResendJob['state'], resultId: string | undefined, token: string, error?: string): Promise<boolean> {
  const queries = [sql`update resend_jobs set state=${state},result_id=${resultId ?? null},error=${error ?? null} where id=${id} and token=${token} ${error ? sql`and state='pending' and strategy='source'` : sql``}`];
  if (state === 'failed') queries.push(sql`delete from guards where changes()=1 and key in (select 'resend:root:'||root||':'||id from resend_jobs where id=${id} and token=${token} and state='failed'
    union all select 'resend:actor:'||actor||':'||id from resend_jobs where id=${id} and token=${token} and state='failed' union all select 'resend:instance:'||id from resend_jobs where id=${id} and token=${token} and state='failed')`);
  const result = await store.batch(queries.map(q => q.compile(store.db)));
  return result[0] === 1;
}
