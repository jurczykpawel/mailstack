import { sql, type RawBuilder } from 'kysely';
import { appendAudit } from './audit';
import type { JobKind } from './jobs';
import type { MessageDeletion } from './extensions';

/** Fixed when the job is written: subject indexes, the principal's brands/templates and the creation-time bound. */
export interface EraseScope { indices: { kid: string; index: string }[]; brands: '*' | string[]; templates: '*' | string[]; at: number }
interface Cursor { phase: 0 | 1 | 2 | 3; after: string; count: number }
const PORTION = 500;

export const selection = (column: string, values: '*' | string[]) => values === '*' ? sql`1=1` :
  values.length ? sql`${sql.ref(column)} in (${sql.join(values)})` : sql`0=1`;
export function eraseMatch(s: EraseScope): RawBuilder<unknown> {
  const subject = sql.join(s.indices.map(i => sql`(s.idx_kid=${i.kid} and s.addr_idx=${i.index})`), sql` or `);
  return sql`(${selection('m.brand', s.brands)}) and (${selection('m.template', s.templates)}) and m.created_at <= ${s.at}
    and exists(select 1 from subjects s where s.message_id=m.id and (${subject}))`;
}
export type Tombstone = ReturnType<typeof tombstones>[number];
export const tombstones = (s: EraseScope) => s.indices.map(({ kid, index }) => ({ kid, index, at: s.at, brands: s.brands, templates: s.templates }));

/**
 * Phase 0 writes the erasure register outside the API database (a failure retries the job before anything is deleted).
 * Phase 1 hides each portion at once (the panel's `live` filter drops it) and removes archives; phase 2 deletes the rows.
 * Each portion commits with the cursor in one batch, so an interrupted call loses and repeats nothing.
 */
export const ERASE_JOB: JobKind = {
  async step(job, { store, now, beforeDelete, registry }) {
    const scope = job.payload as EraseScope;
    const c: Cursor = job.cursor ? JSON.parse(job.cursor) : { phase: 0, after: '', count: 0 };
    const result = { count: c.count, tombstones: tombstones(scope) };
    if (c.phase === 3) return { result };
    if (c.phase === 0) { await registry?.()?.(job.id, result.tombstones); return { cursor: JSON.stringify({ phase: 1, after: '', count: 0 }) }; }
    const rows = (await sql<MessageDeletion['messages'][number]>`select m.id,m.brand,m.template from messages m
      where ${eraseMatch(scope)} and m.id > ${c.after} order by m.id limit ${PORTION}`.execute(store.db)).rows;
    if (!rows.length && c.phase === 1) return { cursor: JSON.stringify({ phase: 2, after: '', count: c.count }) };
    if (!rows.length) {
      // The outcome entry and the terminal cursor commit together, so a repeated final step does not audit twice.
      const done = JSON.stringify({ phase: 3, after: '', count: c.count });
      await appendAudit(store, { at: now, actor: 'system', action: 'privacy.erase.done', target: 'subject:' + scope.indices[0].index.slice(0, 8),
        details: { job: job.id, count: c.count } }, row => [sql`update jobs set cursor=${done} where id=${job.id}
        and exists(select 1 from audit where seq=${row.seq} and hash=${row.hash})`.compile(store.db)]);
      return { result };
    }
    const ids = sql`select value from json_each(${JSON.stringify(rows.map(m => m.id))})`;
    const remove = (tables: string[]) => tables.map(t => sql`delete from ${sql.table(t)} where message_id in (${ids})`);
    const cursor = JSON.stringify({ phase: c.phase, after: rows.at(-1)!.id, count: c.count + (c.phase === 1 ? rows.length : 0) });
    if (c.phase === 1) {
      await beforeDelete?.({ reason: 'erase', messages: rows });
      return { cursor, writes: [sql`update messages set meta_expires_at=0, content_expires_at=0 where id in (${ids})`,
        ...remove(['contents', 'replays', 'domain_events'])].map(q => q.compile(store.db)) };
    }
    return { cursor, writes: [...remove(['recipients', 'events', 'domain_events', 'contents', 'replays', 'subjects']),
      sql`delete from messages where id in (${ids})`].map(q => q.compile(store.db)) };
  },
};
