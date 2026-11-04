import { sql, type CompiledQuery } from 'kysely';
import type { KyselyStore } from './store';
import type { DomainEvent, EventAck } from './extensions';

/** Delivers one durable event to one extension, resuming after endpoint `resume`; resolves with what `onEvent` returned,
 * its `writes` compiled for the core batch. */
export type EventConsumer = (event: DomainEvent, resume: string | null) => Promise<unknown>;
type Settled = EventAck & { writes?: CompiledQuery[] };
export const ACK_TIMEOUT_MS = 5000;
const DAY = 86400000;
interface Row { seq: number; id: string; type: DomainEvent['type']; message_id: string; brand: string; template: string; status: string; at: number; ref_digest: string | null }


async function settle(consumer: EventConsumer, event: DomainEvent, resume: string | null): Promise<Settled | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([consumer(event, resume), new Promise(resolve => { timer = setTimeout(resolve, ACK_TIMEOUT_MS); })]);
    const v = value as { ack?: unknown; partial?: unknown; writes?: unknown } | null;
    if (v && typeof v === 'object' && (v.ack === true || typeof v.partial === 'string') && (v.writes === undefined || Array.isArray(v.writes))) return v as Settled;
  } catch { /* A failed or unconfirmed event keeps the cursor where it is. */ } finally { clearTimeout(timer); }
}

/**
 * Hands the next event past the extension's cursor to its `onEvent`, without a job row (R11). One event per step: the deliveries
 * it returns as `writes` commit in one batch with the conditional cursor move, so a call stopped by its budget keeps every confirmed
 * event (A 3.3.2, N4) and a concurrent step stores the same rows and moves the cursor once; a failure waits for the next call.
 * `{partial}` stores the last finished endpoint and the next step resumes after it. Resolves false when nothing more waits.
 */
export const FANOUT = {
  reserveMs: ACK_TIMEOUT_MS + 2000,
  // Cursor and event reads, the consumer's reads (Pro: endpoints) and the commit.
  ops: 5,
  async step(store: KyselyStore, extension: string, consumer: EventConsumer): Promise<boolean> {
    const saved = (await sql<{ seq: number; partial: string | null }>`select seq, partial from ext_event_cursor
      where extension = ${extension}`.execute(store.db)).rows[0] ?? { seq: 0, partial: null };
    // The second row only tells whether more is waiting; without it the job finishes with this event's commit.
    const [row, more] = (await sql<Row>`select * from domain_events where seq > ${saved.seq} order by seq limit 2`.execute(store.db)).rows;
    if (!row) return false;
    const ack = await settle(consumer, { id: row.id, type: row.type, at: row.at, brand: row.brand, template: row.template, status: row.status,
      messageId: row.message_id, ...(row.ref_digest ? { refDigest: row.ref_digest } : {}) }, saved.partial);
    if (!ack) throw new Error('Event not confirmed');
    const [seq, partial] = 'partial' in ack ? [saved.seq, ack.partial] : [row.seq, null];
    // Conditional on the cursor read above: retention may have moved it past a gap meanwhile.
    await store.batch([...ack.writes ?? [], sql`insert into ext_event_cursor(extension, seq, partial) values(${extension}, ${seq}, ${partial})
      on conflict(extension) do update set seq = excluded.seq, partial = excluded.partial
      where ext_event_cursor.seq = ${saved.seq} and ext_event_cursor.partial is ${saved.partial}`.compile(store.db)]);
    return partial !== null || !!more;
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
