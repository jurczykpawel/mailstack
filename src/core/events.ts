import { sql, type CompiledQuery } from 'kysely';
import type { KyselyStore } from './store';
import type { JobKind } from './jobs';
import type { DomainEvent, EventAck } from './extensions';

/** Delivers one durable event to one extension, resuming after endpoint `resume`; resolves with what `onEvent` returned,
 * its `writes` compiled for the core batch. */
export type EventConsumer = (event: DomainEvent, resume: string | null) => Promise<unknown>;
type Settled = EventAck & { writes?: CompiledQuery[] };
export const ACK_TIMEOUT_MS = 5000;
const DAY = 86400000;
interface Row { seq: number; id: string; type: DomainEvent['type']; message_id: string; brand: string; template: string; status: string; at: number; ref_digest: string | null }

const fanoutId = (extension: string) => 'job_fanout_' + extension;
/** One pending `fanout` job per consumer with events past its cursor; a finished job is reopened instead of duplicated. */
export async function scheduleFanout(store: KyselyStore, extensions: string[], now: number) {
  for (const extension of extensions) await sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at)
    select ${fanoutId(extension)},'fanout','pending',${JSON.stringify({ extension })},${now},${now},${now}
    where exists(select 1 from domain_events where seq > coalesce((select seq from ext_event_cursor where extension = ${extension}), 0))
    on conflict(id) do update set state = 'pending', run_after = ${now}, attempts = 0, cursor = null, result = null, done_at = null,
      updated_at = ${now} where jobs.state in ('done','dead')`.execute(store.db);
}

async function settle(consumer: EventConsumer, event: DomainEvent, resume: string | null): Promise<Settled | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([consumer(event, resume), new Promise(resolve => { timer = setTimeout(resolve, ACK_TIMEOUT_MS); })]);
    const v = value as { ack?: unknown; partial?: unknown; writes?: unknown } | null;
    if (v && typeof v === 'object' && (v.ack === true || typeof v.partial === 'string') && (v.writes === undefined || Array.isArray(v.writes))) return v as Settled;
  } catch { /* A failed or unconfirmed event keeps the cursor where it is. */ } finally { clearTimeout(timer); }
}

/**
 * Hands the next event past the extension's cursor to its `onEvent`. One event per step: the deliveries it returns as
 * `writes` commit in one batch with the cursor, so a call stopped by its budget keeps every confirmed event (A 3.3.2, N4).
 * `{partial}` stores the last finished endpoint and the next step resumes after it.
 */
export const FANOUT_JOB: JobKind = {
  reserveMs: ACK_TIMEOUT_MS + 2000,
  // Cursor and event reads, the consumer's reads (Pro: endpoints) and the commit.
  ops: 5,
  async step(job, { store, consumers }) {
    const { extension } = job.payload as { extension: string }, consumer = consumers?.get(extension);
    if (!consumer) return { result: { skipped: 'no_consumer' } };
    const saved = (await sql<{ seq: number; partial: string | null }>`select seq, partial from ext_event_cursor
      where extension = ${extension}`.execute(store.db)).rows[0] ?? { seq: 0, partial: null };
    const [row] = (await sql<Row>`select * from domain_events where seq > ${saved.seq} order by seq limit 1`.execute(store.db)).rows;
    if (!row) return { result: { seq: saved.seq } };
    const ack = await settle(consumer, { id: row.id, type: row.type, at: row.at, brand: row.brand, template: row.template, status: row.status,
      messageId: row.message_id, ...(row.ref_digest ? { refDigest: row.ref_digest } : {}) }, saved.partial);
    if (!ack) throw new Error('Event not confirmed');
    const [seq, partial] = 'partial' in ack ? [saved.seq, ack.partial] : [row.seq, null];
    // Conditional on the cursor read above: retention may have moved it past a gap meanwhile.
    return { cursor: `${seq}:${partial ?? ''}`, writes: [...ack.writes ?? [], sql`insert into ext_event_cursor(extension, seq, partial) values(${extension}, ${seq}, ${partial})
      on conflict(extension) do update set seq = excluded.seq, partial = excluded.partial
      where ext_event_cursor.seq = ${saved.seq} and ext_event_cursor.partial is ${saved.partial}`.compile(store.db)] };
  },
};

/**
 * Retention for `domain_events` (N5): unconfirmed rows expire after 7 days with a recorded gap that moves every lagging
 * cursor past them; rows confirmed by every active consumer go after 24 hours.
 */
export async function eventRetention(store: KyselyStore, now: number, extensions: string[]) {
  const expired = sql`(select max(seq) from domain_events where at <= ${now - 7 * DAY})`;
  const cursor = (extension: string) => sql`coalesce((select seq from ext_event_cursor where extension = ${extension}), 0)`;
  await store.batch([
    ...extensions.flatMap(extension => [
      sql`insert into ext_event_gaps(extension, from_seq, to_seq, count, at)
        select ${extension}, min(seq), max(seq), count(*), ${now} from domain_events where seq > ${cursor(extension)} and seq <= ${expired}
        having count(*) > 0 on conflict do nothing`,
      sql`insert into ext_event_cursor(extension, seq) select ${extension}, ${expired} where ${expired} > ${cursor(extension)}
        on conflict(extension) do update set seq = excluded.seq, partial = null where ext_event_cursor.seq < excluded.seq`,
    ]),
    sql`delete from domain_events where at <= ${now - 7 * DAY}`,
    ...extensions.length ? [sql`delete from domain_events where at <= ${now - DAY} and seq <= (select min(coalesce(c.seq, 0))
      from json_each(${JSON.stringify(extensions)}) e left join ext_event_cursor c on c.extension = e.value)`] : [],
  ].map(query => query.compile(store.db)));
}
