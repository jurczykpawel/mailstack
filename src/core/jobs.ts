import { sql, type CompiledQuery, type RawBuilder } from 'kysely';
import type { KyselyStore } from './store';
import type { Notifier } from './ports';
import { createBudget, type Budget, type Trigger } from './budget';
import { JOB_KINDS } from './job-kinds';
import type { BeforeMessageDelete } from './extensions';
import { scheduleFanout, type EventConsumer } from './events';

export const LEASE_MS = 30000;
const DELAYS = [60000, 600000, 3600000, 21600000], MAX_ATTEMPTS = DELAYS.length + 1;
// Platform operations of a claim (peek, readiness, claim), of the final release and of a step by default.
const CLAIM_OPS = 3, RELEASE_OPS = 1, STEP_OPS = 6;

/** `attempt`: claims since the last saved progress (1 on the first claim). */
export interface Job { id: string; kind: string; cursor: string | null; payload: unknown; attempt: number }
/** One portion of work; `writes` commit atomically with the new cursor or the result, and only under a valid token. */
export type Step = ({ cursor: string } | { result: unknown } | { retry: true }) & { writes?: CompiledQuery[] };
/** `reserveMs`: the longest a single step may take; no step starts with less budget left (default 3 s). */
export interface JobContext { store: KyselyStore; now: number; beforeDelete?: BeforeMessageDelete; consumers?: Map<string, EventConsumer> }
/** `retry` commits its writes and reschedules like a failure; `ready` is asked before a job of the kind is claimed (false
 * leaves it pending without an attempt); `dead` writes commit whenever the job ends dead (failures or lost claims); `ops`
 * bounds the D1 calls and subrequests of one step, commit included, and is its minimum charge. */
export interface JobKind { reserveMs?: number; ops?: number; ready?(): Promise<boolean>; dead?(job: Job): CompiledQuery[]; step(job: Job, ctx: JobContext): Promise<Step> }
/** What the extension host contributes to background work. */
export type JobHooks = Pick<JobContext, 'beforeDelete' | 'consumers'> & { kinds?: Record<string, JobKind> };
interface Options extends JobHooks { now?: () => number }
interface Claimed { id: string; kind: string; cursor: string | null; payload: string; attempts: number }

/** The insert to commit in the same batch as the work that requested the job; `when` makes it conditional on that work. */
export const newJobId = () => 'job_' + crypto.randomUUID().replaceAll('-', '');
export function enqueueJob(store: KyselyStore, kind: string, payload: unknown, now: number, when: RawBuilder<unknown> = sql`1`, id = newJobId()): { id: string; query: CompiledQuery } {
  return { id, query: sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at)
    select ${id},${kind},'pending',${JSON.stringify(payload)},${now},${now},${now} where ${when}`.compile(store.db) };
}

/** One live job per id: inserts it, or revives a finished one (`done`/`dead`); a pending or running job is left alone. */
export function ensureJob(store: Pick<KyselyStore, 'db'>, kind: string, id: string, payload: unknown, now: number): CompiledQuery {
  return sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at) values (${id},${kind},'pending',${JSON.stringify(payload)},${now},${now},${now})
    on conflict(id) do update set state = 'pending', cursor = null, payload = excluded.payload, attempts = 0, token = null, lease_until = null,
    run_after = excluded.run_after, updated_at = excluded.updated_at, done_at = null, result = null where jobs.state in ('done', 'dead')`.compile(store.db);
}

const due = (t: number) => sql`((state = 'pending' and run_after <= ${t}) or (state = 'running' and lease_until <= ${t}))`;

/** Claims due jobs, erasure first (its cleanup closes deliveries still queued, A 3.8.4), then oldest first, until the budget
 * or the queue runs out; returns the number claimed. */
export async function drain(store: KyselyStore, budget: Budget, { now = Date.now, kinds = JOB_KINDS, ...hooks }: Options = {}): Promise<number> {
  let claimed = 0;
  // Kinds not ready in this call, and extension kinds without a handler here (another isolate or a later start runs them).
  const held = new Set<string>(), kind = (name: string) => Object.hasOwn(kinds, name) ? kinds[name] : undefined;
  while (budget.take(CLAIM_OPS + STEP_OPS + RELEASE_OPS)) {
    const token = crypto.randomUUID(), t = now();
    const next = sql`select id, kind from jobs where ${due(t)} and kind not in (select value from json_each(${JSON.stringify([...held])}))
      order by kind = 'erase' desc, run_after, created_at, id limit 1`;
    const [peek] = (await sql<{ kind: string }>`${next}`.execute(store.db)).rows;
    if (!peek) break;
    const ready = kind(peek.kind)?.ready;
    if (!kind(peek.kind) && peek.kind.startsWith('ext:') || ready && !await ready().catch(() => false)) { held.add(peek.kind); continue; }
    const [row] = (await sql<Claimed>`update jobs
      set state = 'running', token = ${token}, lease_until = ${t + LEASE_MS}, attempts = attempts + 1, updated_at = ${t}
      where id = (select id from (${next})) and ${due(t)}
      returning id, kind, cursor, payload, attempts`.execute(store.db)).rows;
    if (!row) break;
    claimed++;
    if (await run(store, budget, row, token, kind(row.kind), now, hooks) === 'out_of_budget') break;
  }
  return claimed;
}

async function run(store: KyselyStore, budget: Budget, row: Claimed, token: string, kind: JobKind | undefined, now: () => number, hooks: JobHooks) {
  // The only ownership check: once the token is gone the fence copies the row onto itself (duplicate key),
  // which aborts the whole batch, so a late executor writes neither its result nor its step writes.
  const fence = sql`insert into jobs select * from jobs where id = ${row.id} and token is not ${token}`;
  const owned = sql`id = ${row.id}`;
  const commit = (update: RawBuilder<unknown>, writes: CompiledQuery[] = []) =>
    store.batch([fence.compile(store.db), ...writes, update.compile(store.db)]);
  const job = (): Job => ({ id: row.id, kind: row.kind, cursor, payload: JSON.parse(row.payload), attempt: attempts });
  const finish = (state: 'done' | 'dead', result: unknown, writes: CompiledQuery[] = []) => commit(sql`update jobs set state = ${state},
    token = null, lease_until = null, done_at = ${now()}, updated_at = ${now()}, result = ${JSON.stringify(result ?? null)} where ${owned}`,
    state === 'dead' && kind?.dead ? [...writes, ...kind.dead(job())] : writes);
  const release = (extra: RawBuilder<unknown>, writes?: CompiledQuery[]) =>
    commit(sql`update jobs set state = 'pending', token = null, lease_until = null, updated_at = ${now()}, ${extra} where ${owned}`, writes);
  const failed = (writes?: CompiledQuery[]) => attempts >= MAX_ATTEMPTS ? finish('dead', { error: 'handler_failed' }, writes)
    : release(sql`run_after = ${now() + DELAYS[attempts - 1]}`, writes);
  // `attempts` counts claims since the last saved progress, so long jobs spread over many calls never run out.
  let { cursor, attempts } = row;
  if (!kind) return finish('dead', { error: 'unknown_kind' });
  if (attempts > MAX_ATTEMPTS) return finish('dead', { error: 'attempts' });
  try {
    const ops = kind.ops ?? STEP_OPS;
    while (budget.has(kind.reserveMs ?? 3000, ops + RELEASE_OPS)) {
      const from = budget.used();
      try {
        const step = await kind.step(job(), { store, now: now(), ...hooks });
        if ('result' in step) return await finish('done', step.result, step.writes);
        if ('retry' in step) return await failed(step.writes);
        await commit(sql`update jobs set cursor = ${step.cursor}, attempts = 1, lease_until = ${now() + LEASE_MS},
          updated_at = ${now()} where ${owned}`, step.writes);
        cursor = step.cursor; attempts = 1;
      } finally { budget.charge(from, ops); }
    }
    await release(sql`attempts = max(attempts - 1, 0)`);
    return 'out_of_budget';
  } catch {
    // A lost token makes these writes fail too; the lease then hands the job to whoever holds it now.
    await failed().catch(() => {});
  }
}

export async function jobStats(store: KyselyStore, now: number) {
  const [row] = (await sql<{ pending: number | null; oldest: number | null; dead: number | null; dropped: number | null }>`select
    (select sum(count) from ext_event_gaps) dropped,
    sum(case when state in ('pending','running') then 1 else 0 end) pending,
    min(case when state in ('pending','running') and run_after <= ${now} then run_after end) oldest,
    sum(case when state = 'dead' and done_at > ${now - 86400000} then 1 else 0 end) dead from jobs`.execute(store.db)).rows;
  return { pending: Number(row?.pending ?? 0), oldest_pending_age_s: row?.oldest == null ? 0 : Math.floor((now - row.oldest) / 1000),
    dead_24h: Number(row?.dead ?? 0), events_dropped: Number(row?.dropped ?? 0) };
}

/** One trigger firing: drain within the trigger's budget; the minute cron also raises the only alarm, stalled work. */
export async function runJobs(store: KyselyStore, trigger: Trigger, { notifier, ...options }: Options & { notifier?: Notifier } = {}) {
  const now = options.now ?? Date.now;
  if (options.consumers?.size) await scheduleFanout(store, [...options.consumers.keys()], now());
  await drain(store, createBudget(trigger, now), options);
  if (trigger !== 'cron' || !notifier) return;
  const t = now(), { pending, oldest_pending_age_s: age } = await jobStats(store, t), key = 'alert:jobs:' + Math.floor(t / 3600000);
  if (age <= 900 || !await store.consume(key, t + 3600000)) return;
  try { await notifier.notify({ title: 'mailstack: jobs stalled', body: `${pending} pending, oldest ${age} s`, priority: 'high' }); }
  catch { await store.release(key); }
}
