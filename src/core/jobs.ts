import { sql, type CompiledQuery, type RawBuilder } from 'kysely';
import type { KyselyStore } from './store';
import type { Notifier } from './ports';
import { createBudget, type Budget, type Trigger } from './budget';
import { JOB_KINDS } from './job-kinds';

export const LEASE_MS = 30000;
const DELAYS = [60000, 600000, 3600000, 21600000], MAX_ATTEMPTS = DELAYS.length + 1;

export interface Job { id: string; kind: string; cursor: string | null; payload: unknown }
/** One portion of work; `writes` commit atomically with the new cursor or the result, and only under a valid token. */
export type Step = ({ cursor: string } | { result: unknown }) & { writes?: CompiledQuery[] };
/** `reserveMs`: the longest a single step may take; no step starts with less budget left (default 3 s). */
export interface JobKind { reserveMs?: number; step(job: Job, ctx: { store: KyselyStore; now: number }): Promise<Step> }
interface Options { now?: () => number; kinds?: Record<string, JobKind> }
interface Claimed { id: string; kind: string; cursor: string | null; payload: string; attempts: number }

/** The insert to commit in the same batch as the work that requested the job. */
export function enqueueJob(store: KyselyStore, kind: string, payload: unknown, now: number): { id: string; query: CompiledQuery } {
  const id = 'job_' + crypto.randomUUID().replaceAll('-', '');
  return { id, query: sql`insert into jobs(id,kind,state,payload,run_after,created_at,updated_at)
    values (${id},${kind},'pending',${JSON.stringify(payload)},${now},${now},${now})`.compile(store.db) };
}

const due = (t: number) => sql`((state = 'pending' and run_after <= ${t}) or (state = 'running' and lease_until <= ${t}))`;

/** Claims due jobs, oldest first, until the budget or the queue runs out; returns the number claimed. */
export async function drain(store: KyselyStore, budget: Budget, { now = Date.now, kinds = JOB_KINDS }: Options = {}): Promise<number> {
  let claimed = 0;
  while (budget.take()) {
    const token = crypto.randomUUID(), t = now();
    const [row] = (await sql<Claimed>`update jobs
      set state = 'running', token = ${token}, lease_until = ${t + LEASE_MS}, attempts = attempts + 1, updated_at = ${t}
      where id = (select id from jobs where ${due(t)} order by run_after, created_at, id limit 1) and ${due(t)}
      returning id, kind, cursor, payload, attempts`.execute(store.db)).rows;
    if (!row) break;
    claimed++;
    if (await run(store, budget, row, token, Object.hasOwn(kinds, row.kind) ? kinds[row.kind] : undefined, now) === 'out_of_budget') break;
  }
  return claimed;
}

async function run(store: KyselyStore, budget: Budget, row: Claimed, token: string, kind: JobKind | undefined, now: () => number) {
  // The only ownership check: once the token is gone the fence copies the row onto itself (duplicate key),
  // which aborts the whole batch, so a late executor writes neither its result nor its step writes.
  const fence = sql`insert into jobs select * from jobs where id = ${row.id} and token is not ${token}`;
  const owned = sql`id = ${row.id}`;
  const commit = (update: RawBuilder<unknown>, writes: CompiledQuery[] = []) =>
    store.batch([fence.compile(store.db), ...writes, update.compile(store.db)]);
  const finish = (state: 'done' | 'dead', result: unknown, writes?: CompiledQuery[]) => commit(sql`update jobs set state = ${state},
    token = null, lease_until = null, done_at = ${now()}, updated_at = ${now()}, result = ${JSON.stringify(result ?? null)} where ${owned}`, writes);
  const release = (extra: RawBuilder<unknown>) =>
    commit(sql`update jobs set state = 'pending', token = null, lease_until = null, updated_at = ${now()}, ${extra} where ${owned}`);
  if (!kind) return finish('dead', { error: 'unknown_kind' });
  if (row.attempts > MAX_ATTEMPTS) return finish('dead', { error: 'attempts' });
  // `attempts` counts claims since the last saved progress, so long jobs spread over many calls never run out.
  let { cursor, attempts } = row;
  try {
    const payload = JSON.parse(row.payload);
    while (budget.has(kind.reserveMs ?? 3000)) {
      const step = await kind.step({ id: row.id, kind: row.kind, cursor, payload }, { store, now: now() });
      if ('result' in step) return await finish('done', step.result, step.writes);
      await commit(sql`update jobs set cursor = ${step.cursor}, attempts = 1, lease_until = ${now() + LEASE_MS},
        updated_at = ${now()} where ${owned}`, step.writes);
      cursor = step.cursor; attempts = 1;
    }
    await release(sql`attempts = max(attempts - 1, 0)`);
    return 'out_of_budget';
  } catch {
    // A lost token makes these writes fail too; the lease then hands the job to whoever holds it now.
    await (attempts >= MAX_ATTEMPTS ? finish('dead', { error: 'handler_failed' })
      : release(sql`run_after = ${now() + DELAYS[attempts - 1]}`)).catch(() => {});
  }
}

export async function jobStats(store: KyselyStore, now: number) {
  const [row] = (await sql<{ pending: number | null; oldest: number | null; dead: number | null }>`select
    sum(case when state in ('pending','running') then 1 else 0 end) pending,
    min(case when state in ('pending','running') and run_after <= ${now} then run_after end) oldest,
    sum(case when state = 'dead' and done_at > ${now - 86400000} then 1 else 0 end) dead from jobs`.execute(store.db)).rows;
  return { pending: Number(row?.pending ?? 0), oldest_pending_age_s: row?.oldest == null ? 0 : Math.floor((now - row.oldest) / 1000),
    dead_24h: Number(row?.dead ?? 0) };
}

/** One trigger firing: drain within the trigger's budget; the minute cron also raises the only alarm, stalled work. */
export async function runJobs(store: KyselyStore, trigger: Trigger, { notifier, ...options }: Options & { notifier?: Notifier } = {}) {
  const now = options.now ?? Date.now;
  await drain(store, createBudget(trigger, now), options);
  if (trigger !== 'cron' || !notifier) return;
  const t = now(), { pending, oldest_pending_age_s: age } = await jobStats(store, t), key = 'alert:jobs:' + Math.floor(t / 3600000);
  if (age <= 900 || !await store.consume(key, t + 3600000)) return;
  try { await notifier.notify({ title: 'mailstack: jobs stalled', body: `${pending} pending, oldest ${age} s`, priority: 'high' }); }
  catch { await store.release(key); }
}
