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

const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status: number) => { throw status; };
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(+value) || +value > max) fail(400);
  return +value;
}
export async function internalFetch(req: Request, env: object, store: KyselyStore, cfg: Config, panel: PanelPrincipal): Promise<Response> {
  const now = Date.now(), url = new URL(req.url), path = url.pathname.slice('/internal/v1'.length), q = url.searchParams;
  const run = async <T>(query: RawBuilder<T>) => (await query.execute(store.db)).rows;
  const selection = (column: string, values: '*' | string[]) => values === '*' ? sql`1=1` :
    values.length ? sql`${sql.ref(column)} in (${sql.join(values)})` : sql`0=1`;
  const scope = sql`(${selection('m.brand', panel.brands)}) and (${selection('m.template', panel.templates)})`;
  const live = sql`m.meta_expires_at > ${now} and m.created_at > ${now - cfg.logging.ceilings.metaDays * 86400000}`;
  const contentLive = sql`(m.content_expires_at is null or m.content_expires_at > ${now}) and m.created_at > ${now - cfg.logging.ceilings.contentDays * 86400000}`;
  const requireRole = (role: 'viewer' | 'operator' | 'admin', step = false) => { if (!panelAllows(panel, role, step, now)) fail(403); };
  const audit = async (action: string, target?: string, details?: unknown) => {
    try { return await appendAudit(store, { at: now, actor: 'panel:' + panel.actor, action, target, details }); }
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
  const detail = async (m: MessageRow) => ({ id: m.id, brand: m.brand, template: m.template, level: m.level, status: m.status,
    created_at: m.created_at, sent_at: m.sent_at, subject_sealed: m.subject_sealed, complained: m.complained,
    provider: m.provider, provider_message_id: m.provider_message_id, resend_of: m.resend_of, resend_root: m.resend_root,
    recipients: await run(sql`select pos,role,addr_sealed,addr_hint,status,last_event_at from recipients where message_id=${m.id} order by pos`),
    events: await run(sql`select id,recipient_pos,type,occurred_at,received_at,source,auth,summary from events where message_id=${m.id} order by occurred_at,id`) });
  const evidence = async (id: string) => ({
    events: await run(sql`select e.id,e.evidence_sealed from events e join messages m on m.id=e.message_id
      where m.id=${id} and ${scope} and ${live} and ${contentLive} and e.evidence_sealed is not null order by e.occurred_at,e.id`),
    provider_response_sealed: (await run<{ provider_response_sealed: string | null }>(sql`select m.provider_response_sealed from messages m
      where m.id=${id} and ${scope} and ${live} and ${contentLive}`))[0]?.provider_response_sealed ?? null,
  });
  try {
    requireRole('viewer');
    if (req.url.length > 8192) return fail(400);
    if (path === '/messages' && req.method === 'GET') {
      const limit = integer(q.get('limit'), 50, 100); if (!limit) fail(400);
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
      const rows = await run<MessageRow>(sql`select m.id,m.brand,m.template,m.level,m.status,m.created_at,m.sent_at,m.subject_sealed from messages m
        where ${sql.join(filters, sql` and `)} order by m.created_at desc,m.id desc limit ${limit + 1}`);
      const more = rows.length > limit; rows.splice(limit);
      const messages = await Promise.all(rows.map(async m => ({ ...m, addr_hints: (await run<{ addr_hint: string }>(sql`select addr_hint from recipients where message_id=${m.id} order by pos`)).map(r => r.addr_hint) })));
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
        if (!(await run(sql`select id from messages m where m.id=${id} and ${contentLive}`)).length) return fail(404);
        await audit('evidence.export', id); return response(await evidence(id));
      }
      if (kind === 'resend-source') {
        await audit('resend.source', id);
        return response({ id, brand: m.brand, template: m.template, ref_sealed: m.ref_sealed, replay: await blob('replays', id) });
      }
      await audit('log.read', id); return response(await detail(m));
    }
    if ((path === '/subjects/export' || path === '/subjects/erase') && req.method === 'POST') {
      requireRole('admin', true);
      const input = await body();
      if (typeof input.email !== 'string' || input.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) return fail(400);
      if (path.endsWith('erase') && (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500)) return fail(400);
      const indices = await blindIndexes(input.email, parseIndexKeys(Reflect.get(env, 'INDEX_KEYS')));
      const subject = sql`exists(select 1 from subjects s where s.message_id=m.id and (${sql.join(indices.map(i => sql`(s.idx_kid=${i.kid} and s.addr_idx=${i.index})`), sql` or `)}))`;
      const matched = (await run<{ count: number }>(sql`select count(*) count from messages m where ${scope} and ${subject} ${path.endsWith('export') ? sql`and ${live}` : sql``}`))[0].count;
      await audit(path.endsWith('erase') ? 'privacy.erase' : 'privacy.export', 'subject:' + indices[0].index.slice(0, 8), { count: matched });
      if (path.endsWith('export')) {
        const rows = await run<MessageRow>(sql`select m.* from messages m where ${scope} and ${live} and ${subject} order by m.id`);
        return response({ messages: await Promise.all(rows.map(async m => ({ ...await detail(m), content: await blob('contents', m.id),
          replay: await blob('replays', m.id), ref_sealed: m.ref_sealed, evidence: await evidence(m.id) }))) });
      }
      let count = 0;
      while (true) {
        const selected = (await run<{ id: string }>(sql`select m.id from messages m where ${scope} and ${subject} order by m.id limit 50`)).map(r => r.id);
        if (!selected.length) break;
        const ids = sql`select m.id from messages m where m.id in (${sql.join(selected)}) and ${scope}`;
        const queries = ['recipients', 'events', 'contents', 'replays', 'subjects'].map(t => sql`delete from ${sql.table(t)} where message_id in (${ids})`);
        queries.push(sql`delete from messages where id in (${ids})`);
        const changes = await store.batch(queries.map(query => query.compile(store.db)));
        count += changes.at(-1)!;
      }
      return response({ count });
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
