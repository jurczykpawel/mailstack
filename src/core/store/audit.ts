import { sql } from 'kysely';
import type { KyselyStore } from './index';
import type { AuditRow } from '../audit';

const queues = new WeakMap<KyselyStore, Promise<unknown>>();
export function serializeAudit<T>(store: KyselyStore, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(store) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(store, next);
  return next;
}
export async function auditHead(store: KyselyStore): Promise<AuditRow | undefined> {
  return (await sql<AuditRow>`select * from audit order by seq desc limit 1`.execute(store.db)).rows[0];
}
export async function insertAudit(store: KyselyStore, row: AuditRow): Promise<boolean> {
  const changes = await store.batch([sql`insert into audit(seq,at,actor,action,target,details,prev_hash,hash)
    select coalesce(max(seq),0)+1,${row.at},${row.actor},${row.action},${row.target},${row.details},${row.prev_hash},${row.hash}
    from audit having coalesce(max(seq),0) = ${row.seq - 1}`]);
  return changes[0] === 1;
}
export async function pruneAudit(store: KyselyStore, cutoff: number, marker: (row: AuditRow) => Promise<unknown>): Promise<void> {
  const last = (await sql<AuditRow>`select * from audit where seq <
    (select coalesce(min(seq), (select coalesce(max(seq),0)+1 from audit)) from audit where at >= ${cutoff})
    order by seq desc limit 1`.execute(store.db)).rows[0];
  if (!last) return;
  await marker(last);
  await sql`delete from audit where seq <= ${last.seq}`.execute(store.db);
}
