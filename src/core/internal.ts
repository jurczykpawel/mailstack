import { sql, type RawBuilder } from 'kysely';
import { appendAudit, AUDIT_GENESIS, type AuditRow } from './audit';
import { auditHead } from './store/audit';
import { blindIndexes, refIndex } from './crypto';
import { parseIndexKeys } from './keyring';
import { boundedText } from './http';
import { panelAllows, type PanelPrincipal } from './panel';
import type { KyselyStore } from './store';
import type { Config } from './config/schema';
import type { MessageRow } from './store/messages';
import { enqueueJob, newJobId } from './jobs';
import { selection, type EraseScope } from './erase';
import { capabilities, LIMITS, type CapabilityHost } from './capabilities';

const PAGE_BYTES = LIMITS.exportPageBytes - 8192; // 1 MiB page including the manifest envelope
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status: number) => { throw status; };
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(+value) || +value > max) fail(400);
  return +value;
}
const narrow = (own: '*' | string[], other: '*' | string[]) => own === '*' ? other : other === '*' ? own : own.filter(v => other.includes(v));
const covers = (own: '*' | string[], other: '*' | string[]) => own === '*' || (other !== '*' && other.every(v => own.includes(v)));
const names = (v: unknown) => v === '*' || (Array.isArray(v) && v.length <= 100 && v.every(n => typeof n === 'string' && n.length <= 128));
export async function internalFetch(req: Request, env: object, store: KyselyStore, cfg: Config, panel: PanelPrincipal, host: CapabilityHost): Promise<Response> {
  const now = Date.now(), url = new URL(req.url), path = url.pathname.slice('/internal/v2'.length), q = url.searchParams;
  const run = async <T>(query: RawBuilder<T>) => (await query.execute(store.db)).rows;
  const scope = sql`(${selection('m.brand', panel.brands)}) and (${selection('m.template', panel.templates)})`;
  const live = sql`m.meta_expires_at > ${now} and m.created_at > ${now - cfg.logging.ceilings.metaDays * 86400000}`;
  const contentLive = sql`(m.content_expires_at is null or m.content_expires_at > ${now}) and m.created_at > ${now - cfg.logging.ceilings.contentDays * 86400000}`;
  const requireRole = (role: 'viewer' | 'operator' | 'admin', step = false) => { if (!panelAllows(panel, role, step, now)) fail(403); };
  const audit = async (action: string, target?: string, details?: unknown, writes?: Parameters<typeof appendAudit>[2]) => {
    try { return await appendAudit(store, { at: now, actor: 'panel:' + panel.actor, action, target, details }, writes); }
    catch { return fail(503); }
  };
  const body = async () => {
    try {
      const value = JSON.parse(await boundedText(req, 65536));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400);
      return value as Record<string, unknown>;
    } catch (e) { return fail(e instanceof RangeError ? 413 : 400); }
  };
  const blob = async (table: 'contents' | 'replays', id: string) => (await run(sql<{ sealed: string; expires_at: number }>`select b.sealed,b.expires_at from ${sql.table(table)} b
    join messages m on m.id=b.message_id where m.id=${id} and ${scope} and ${live} and ${contentLive} and b.expires_at > ${now}`))[0] ?? null;
  const describe = (m: MessageRow, recipients: unknown[], events: unknown[]) => ({ id: m.id, brand: m.brand, template: m.template, level: m.level, status: m.status,
    created_at: m.created_at, sent_at: m.sent_at, subject_sealed: m.subject_sealed, complained: m.complained,
    provider: m.provider, provider_message_id: m.provider_message_id, resend_of: m.resend_of, resend_root: m.resend_root, recipients, events });
  const detail = async (m: MessageRow) => describe(m,
    await run(sql`select pos,role,addr_sealed,addr_hint,status,last_event_at from recipients where message_id=${m.id} order by pos`),
    await run(sql`select id,recipient_pos,type,occurred_at,received_at,source,auth,summary from events where message_id=${m.id} order by occurred_at,id`));
  const evidence = async (id: string) => ({
    events: await run(sql`select e.id,e.evidence_sealed from events e join messages m on m.id=e.message_id
      where m.id=${id} and ${scope} and ${live} and e.evidence_sealed is not null order by e.occurred_at,e.id`),
    provider_response_sealed: (await run<{ provider_response_sealed: string | null }>(sql`select m.provider_response_sealed from messages m
      where m.id=${id} and ${scope} and ${live}`))[0]?.provider_response_sealed ?? null,
  });
  // One query per table for a whole page of messages: the ids travel as a single JSON parameter.
  const pageRows = async <T extends { message_id: string }>(query: (ids: RawBuilder<unknown>) => RawBuilder<T>, messages: MessageRow[]) => {
    const grouped = new Map<string, Omit<T, 'message_id'>[]>();
    if (!messages.length) return grouped;
    for (const { message_id, ...row } of await run(query(sql`select value from json_each(${JSON.stringify(messages.map(m => m.id))})`))) {
      const list = grouped.get(message_id); if (list) list.push(row); else grouped.set(message_id, [row]);
    }
    return grouped;
  };
  // The job row commits in the audit entry's batch and only if that entry was written.
  const erase = async (scope: EraseScope, details: Record<string, unknown>) => {
    const job = newJobId();
    await audit('privacy.erase', 'subject:' + scope.indices[0].index.slice(0, 8), { ...details, job }, row =>
      [enqueueJob(store, 'erase', scope, now, sql`exists(select 1 from audit where seq=${row.seq} and hash=${row.hash})`, job).query]);
    return response({ jobId: job }, 202);
  };
  try {
    requireRole('viewer');
    if (req.url.length > 8192) return fail(400);
    if (path === '/capabilities' && req.method === 'GET') return response(await capabilities(env, store, cfg, panel, host, now));
    if (path === '/messages' && req.method === 'GET') {
      const limit = integer(q.get('limit'), 50, LIMITS.listPage); if (!limit) fail(400);
      const from = integer(q.get('from'), 0, Number.MAX_SAFE_INTEGER), to = integer(q.get('to'), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      if (from > to) fail(400);
      const filters = [scope, live, sql`m.created_at >= ${from} and m.created_at <= ${to}`];
      for (const name of ['brand', 'template', 'status']) if (q.has(name)) {
        const value = q.get(name)!; if (!value || value.length > 128) fail(400);
        filters.push(sql`${sql.ref('m.' + name)}=${value}`);
      }
      if (q.has('cursor')) {
        try {
          const c = JSON.parse(atob(q.get('cursor')!));
          if (!Array.isArray(c) || c.length !== 2 || !Number.isSafeInteger(c[0]) || c[0] < 0 || typeof c[1] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c[1])) fail(400);
          filters.push(sql`(m.created_at < ${c[0]} or (m.created_at=${c[0]} and m.id < ${c[1]}))`);
        } catch { fail(400); }
      }
      if (q.has('rcpt') || q.has('ref')) {
        const keys = parseIndexKeys(Reflect.get(env, 'INDEX_KEYS'));
        for (const name of ['rcpt', 'ref'] as const) if (q.has(name)) {
          const value = q.get(name)!; if (!value || value.length > (name === 'ref' ? 128 : 320)) fail(400);
          if (name === 'rcpt') {
            let indices; try { indices = await blindIndexes(value, keys); } catch { return fail(400); }
            filters.push(sql`exists(select 1 from recipients r where r.message_id=m.id and (${sql.join(indices.map(i => sql`(r.idx_kid=${i.kid} and r.addr_idx=${i.index})`), sql` or `)}))`);
          } else filters.push(sql`m.ref_idx in (${sql.join((await Promise.all(keys.map(k => refIndex(value, k)))).map(i => i.index))})`);
        }
      }
      await audit(q.has('rcpt') || q.has('ref') ? 'log.search' : 'log.list');
      const rows = await run<MessageRow & { addr_hints: string }>(sql`select m.id,m.brand,m.template,m.level,m.status,m.created_at,m.sent_at,m.subject_sealed,
        (select json_group_array(addr_hint) from (select r.addr_hint from recipients r where r.message_id=m.id order by r.pos)) addr_hints from messages m
        where ${sql.join(filters, sql` and `)} order by m.created_at desc,m.id desc limit ${limit + 1}`);
      const more = rows.length > limit; rows.splice(limit);
      const messages = rows.map(m => ({ ...m, addr_hints: JSON.parse(m.addr_hints) as string[] }));
      const last = rows.at(-1);
      return response({ messages, cursor: more && last ? btoa(JSON.stringify([last.created_at, last.id])) : null });
    }
    const match = /^\/messages\/([A-Za-z0-9_-]{1,128})(?:\/(content|evidence|resend-source))?$/.exec(path);
    if (match && req.method === 'GET') {
      const [, id, kind] = match;
      requireRole(kind ? 'operator' : 'viewer', !!kind);
      const m = (await run<MessageRow>(sql`select m.* from messages m where m.id=${id} and ${scope} and ${live}`))[0];
      if (!m) return fail(404);
      if (kind === 'content') {
        const content = await blob('contents', id); if (!content) return fail(404);
        await audit('content.read', id); return response({ ...content, level: m.level });
      }
      if (kind === 'evidence') {
        await audit('evidence.export', id); return response(await evidence(id));
      }
      if (kind === 'resend-source') {
        await audit('resend.source', id);
        return response({ id, brand: m.brand, template: m.template, ref_sealed: m.ref_sealed, replay: await blob('replays', id) });
      }
      await audit('log.read', id); return response(await detail(m));
    }
    if (path === '/subjects/erase-index' && req.method === 'POST') {
      requireRole('admin', true);
      const { tombstone: t, ...rest } = await body();
      if (Object.keys(rest).length || !t || typeof t !== 'object' || Array.isArray(t)) return fail(400);
      const { kid, index, at, brands, templates, ...extra } = t as Record<string, unknown>;
      if (Object.keys(extra).length || typeof kid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(kid) || typeof index !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(index) ||
        !Number.isSafeInteger(at) || (at as number) < 0 || (at as number) > now || !names(brands) || !names(templates)) return fail(400);
      // A restored erasure keeps its time bound and never widens past the caller's own scope.
      return await erase({ indices: [{ kid, index }], brands: narrow(panel.brands, brands as '*' | string[]), templates: narrow(panel.templates, templates as '*' | string[]), at: at as number }, { source: 'tombstone' });
    }
    const job = /^\/jobs\/(job_[a-f0-9]{32})$/.exec(path)?.[1];
    if (job && req.method === 'GET') {
      requireRole('admin');
      const row = (await run<{ state: string; cursor: string | null; payload: string; result: string | null; created_at: number; done_at: number | null }>(sql`select state,cursor,payload,result,created_at,done_at
        from jobs where id=${job} and kind='erase'`))[0];
      const fixed = row && JSON.parse(row.payload) as EraseScope;
      if (!row || !covers(panel.brands, fixed.brands) || !covers(panel.templates, fixed.templates)) return fail(404);
      const { phase = 1, count = 0 } = row.cursor ? JSON.parse(row.cursor) : {};
      return response({ id: job, kind: 'erase', state: row.state, progress: { phase, count }, result: row.result === null ? null : JSON.parse(row.result), created_at: row.created_at, done_at: row.done_at });
    }
    if ((path === '/subjects/export' || path === '/subjects/erase') && req.method === 'POST') {
      requireRole('admin', true);
      const input = await body();
      if (typeof input.email !== 'string' || input.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return fail(400);
      const indices = await blindIndexes(input.email, parseIndexKeys(Reflect.get(env, 'INDEX_KEYS')));
      if (path.endsWith('erase')) {
        if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500) return fail(400);
        return await erase({ indices: indices.map(({ kid, index }) => ({ kid, index })), brands: panel.brands, templates: panel.templates, at: now }, {});
      }
      const limit = input.limit === undefined ? 25 : input.limit;
      let after = '';
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.exportPageMessages) return fail(400);
      if (input.cursor !== undefined && input.cursor !== null) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 256) return fail(400);
          after = atob(input.cursor);
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(after)) return fail(400);
        } catch { return fail(400); }
      }
      const subject = sql`exists(select 1 from subjects s where s.message_id=m.id and (${sql.join(indices.map(i => sql`(s.idx_kid=${i.kid} and s.addr_idx=${i.index})`), sql` or `)}))`;
      const matched = (await run<{ count: number }>(sql`select count(*) count from messages m where ${scope} and ${subject} and ${live}`))[0].count;
      await audit('privacy.export', 'subject:' + indices[0].index.slice(0, 8), { count: matched });
      const rows = await run<MessageRow>(sql`select m.* from messages m where ${scope} and ${live} and ${subject} and m.id > ${after} order by m.id limit ${Number(limit) + 1}`);
      const more = rows.length > Number(limit); rows.splice(Number(limit));
      const blobs = (table: 'contents' | 'replays') => pageRows<{ message_id: string; sealed: string; expires_at: number }>(ids => sql`select b.message_id,b.sealed,b.expires_at
        from ${sql.table(table)} b join messages m on m.id=b.message_id where b.message_id in (${ids}) and ${contentLive} and b.expires_at > ${now}`, rows);
      const recipients = await pageRows<{ message_id: string }>(ids => sql`select message_id,pos,role,addr_sealed,addr_hint,status,last_event_at from recipients
        where message_id in (${ids}) order by message_id,pos`, rows);
      const events = await pageRows<{ message_id: string; id: string; evidence_sealed: string | null }>(ids => sql`select message_id,id,recipient_pos,type,occurred_at,received_at,source,auth,summary,evidence_sealed
        from events where message_id in (${ids}) order by message_id,occurred_at,id`, rows);
      const contents = await blobs('contents'), replays = await blobs('replays');
      const messages = [], encoder = new TextEncoder();
      let bytes = 0, truncated = false;
      for (const m of rows) {
        const own = events.get(m.id) ?? [];
        const message = { ...describe(m, recipients.get(m.id) ?? [], own.map(({ evidence_sealed, ...event }) => event)),
          content: contents.get(m.id)?.[0] ?? null, replay: replays.get(m.id)?.[0] ?? null, ref_sealed: m.ref_sealed,
          evidence: { events: own.filter(e => e.evidence_sealed !== null).map(e => ({ id: e.id, evidence_sealed: e.evidence_sealed })), provider_response_sealed: m.provider_response_sealed ?? null } };
        const size = encoder.encode(JSON.stringify(message)).length;
        // A page stops before the byte budget is exceeded; the first message is always included so the cursor advances.
        if (messages.length && bytes + size > PAGE_BYTES) { truncated = true; break; }
        messages.push(message); bytes += size;
      }
      const cursor = more || truncated ? btoa(messages.at(-1)!.id) : null;
      return response({ messages, cursor, manifest: { range: { first: messages[0]?.id ?? null, last: messages.at(-1)?.id ?? null, count: messages.length }, bytes, cursor, complete: cursor === null } });
    }
    if (['/audit', '/audit/head'].includes(path)) {
      if (panel.brands !== '*' || panel.templates !== '*') return fail(403);
      if (req.method === 'GET' && path === '/audit/head') { const head = await auditHead(store); return response({ seq: head?.seq ?? 0, hash: head?.hash ?? AUDIT_GENESIS }); }
      if (req.method === 'GET' && path === '/audit') {
        const after = integer(q.get('after_seq'), 0, Number.MAX_SAFE_INTEGER), limit = integer(q.get('limit'), 100, 500); if (!limit) fail(400);
        return response({ rows: await run<AuditRow>(sql`select * from audit where seq > ${after} order by seq limit ${limit}`) });
      }
      if (req.method === 'POST' && path === '/audit') {
        const input = await body();
        if (typeof input.action !== 'string' || !['panel.login', 'panel.logout', 'panel.role.changed', 'panel.integrity.alarm', 'panel.user.invited', 'panel.user.removed'].includes(String(input.action)) ||
          Object.keys(input).some(k => !['action', 'target', 'details'].includes(k))) return fail(400);
        if (input.target !== undefined && (typeof input.target !== 'string' || !/^(?:msg_|user:)[A-Za-z0-9_-]{1,128}$/.test(input.target))) return fail(400);
        if (input.details !== undefined) {
          if (!input.details || typeof input.details !== 'object' || Array.isArray(input.details)) return fail(400);
          for (const [key, value] of Object.entries(input.details)) {
            const valid = ['count', 'seq'].includes(key) ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 :
              key === 'hash' ? typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) : key === 'role' && typeof value === 'string' && ['viewer', 'operator', 'admin'].includes(value);
            if (!valid) return fail(400);
          }
        }
        if (!['panel.login', 'panel.logout', 'panel.integrity.alarm'].includes(String(input.action))) requireRole('admin', true);
        return response(await audit(String(input.action), input.target as string | undefined, input.details));
      }
    }
    return response({ success: false }, 404);
  } catch (error) { return response({ success: false }, typeof error === 'number' ? error : 503); }
}
