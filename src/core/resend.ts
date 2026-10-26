import { sql } from 'kysely';
import { permits } from '../clients';
import { renderAndSend } from '../send';
import { getTemplate } from '../templates';
import type { Env, SendDeps, SendResult, Attachment } from '../types';
import type { Config } from './config/schema';
import { blindIndex, canonicalJson, createMac, verifyMac } from './crypto';
import { parseKeyring } from './keyring';
import { appendAudit } from './audit';
import { panelAllows, type PanelPrincipal } from './panel';
import { resolvePolicy } from './logging/policy';
import { idempotencyHash } from './logging/writer';
import type { KyselyStore } from './store';
import { claimResend, finishResend, getResend, startResend, unsuppressed, type ResendJob } from './store/resend';
import { resendPayload, type ResendCapability, type ResendOutcome, type ResendPayload, type ResendSource } from './resend-contract';

const fail = (status: number, code: string): never => { throw { ok: false, status, code, message: code.replaceAll('_', ' ') }; };
async function attempt<T>(run: () => Promise<T>): Promise<T | SendResult> {
  try { return await run(); } catch (e) {
    return e && typeof e === 'object' && 'ok' in e && e.ok === false ? e as SendResult : { ok: false, status: 503, code: 'log_unavailable', message: 'log unavailable' };
  }
}
export function createResendService(cfg: Config, store: KyselyStore, env: Env, deps: SendDeps) {
  const at = () => deps.now().getTime();
  const jobId = async (key: string) => 'rs_' + await idempotencyHash('panel', key);
  const audit = (actor: string, action: string, target: string, details?: unknown) => appendAudit(store, { at: at(), actor: 'panel:' + actor, action, target, ...(details === undefined ? {} : { details }) });
  async function inspect(id: string, panel?: PanelPrincipal) {
    if (panel && (!panel.scopes.includes('panel') || !panelAllows(panel, 'operator', true, at()) || panel.expiresAt <= at())) fail(403, 'scope');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(404, 'not_found');
    const m = await store.db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirst();
    if (!m || m.meta_expires_at <= at() || m.created_at <= at() - cfg.logging.ceilings.metaDays * 86400000) return fail(404, 'not_found');
    if (panel && ((panel.brands !== '*' && !panel.brands.includes(m.brand)) || (panel.templates !== '*' && !panel.templates.includes(m.template)))) fail(403, 'scope');
    const template = getTemplate(m.template), brand = cfg.brands[m.brand];
    const { policy } = await resolvePolicy(cfg.logging, m.brand, m.template);
    if (!template || !Object.hasOwn(cfg.brands, m.brand) || policy.resend === 'off' || policy.level === 'none') return fail(409, 'resend_disabled');
    if (m.created_at <= at() - policy.metaDays * 86400000) fail(404, 'not_found');
    if (m.status === 'sending' || m.status === 'unknown') fail(409, 'original_unresolved');
    if (!(await sql<{ ok: number }>`select ${unsuppressed(id)} as ok`.execute(store.db)).rows[0].ok) fail(409, 'suppressed');
    const replay = await store.db.selectFrom('replays').select(['sealed', 'expires_at']).where('message_id', '=', id).executeTakeFirst();
    const owner = cfg.clients?.find(c => c.id === m.client_id && c.resendCallback && permits(c, 'send', m.brand, m.template));
    if (policy.resend === 'replay' && (template.secretFields?.length || !['masked', 'full'].includes(policy.level) || m.attachments_meta || !m.replay_mac ||
      !replay || replay.expires_at <= at() || !m.content_expires_at || m.content_expires_at <= at() ||
      m.created_at <= at() - Math.min(policy.contentDays, cfg.logging.ceilings.contentDays) * 86400000)) fail(409, 'resend_disabled');
    if (policy.resend === 'source' && !m.ref_sealed) fail(409, 'no_ref');
    if (policy.resend === 'source' && !owner) fail(409, 'resend_disabled');
    const source: ResendSource = { id, brand: m.brand, template: m.template, strategy: policy.resend,
      replay: policy.resend === 'replay' ? replay! : null, ref_sealed: m.ref_sealed,
      ...(owner ? { owner: { clientId: owner.id, callback: owner.resendCallback! } } : {}) };
    return { m, source, brand, template };
  }
  async function validate(id: string, value: unknown, mac?: string | null): Promise<ResendPayload> {
    const parsed = resendPayload.safeParse(value);
    if (!parsed.success || canonicalJson(value).length > 65536) return fail(409, 'resend_mismatch');
    const payload = parsed.data;
    const keys = parseKeyring(env).indexKeys;
    if (mac && !await verifyMac(value, JSON.parse(mac), keys)) fail(409, 'resend_mismatch');
    const recipients = await store.db.selectFrom('recipients').select(['addr_idx', 'idx_kid', 'role']).where('message_id', '=', id).execute();
    const supplied = new Set<string>();
    for (const r of recipients) {
      const key = keys.find(k => k.kid === r.idx_kid);
      if (!key || r.role !== 'to') fail(409, 'resend_mismatch');
      for (const address of payload.to) {
        if ((await blindIndex(address, key!)).index === r.addr_idx) supplied.add(r.idx_kid + ':' + r.addr_idx);
      }
    }
    if (supplied.size !== new Set(recipients.map(r => r.idx_kid + ':' + r.addr_idx)).size || !recipients.length) fail(409, 'resend_mismatch');
    for (const address of payload.to) {
      if (!(await Promise.all(recipients.map(async r => (await blindIndex(address, keys.find(k => k.kid === r.idx_kid)!)).index === r.addr_idx))).some(Boolean)) fail(409, 'resend_mismatch');
    }
    return payload;
  }
  async function outcome(job: ResendJob): Promise<ResendOutcome> {
    if (job.state === 'sending') {
      const original = await store.db.selectFrom('messages').select('client_id').where('id', '=', job.message_id).executeTakeFirst();
      const child = original ? await store.findByIdempotency(original.client_id, await idempotencyHash(original.client_id, job.id)) : undefined;
      if ((child && child.status !== 'sending') || at() - job.created_at > 900000) {
        const state = !child || child.status === 'sending' || child.status === 'unknown' ? 'unknown' : child.status === 'send_failed' ? 'failed' : 'sent';
        await finishResend(store, job.id, state, child?.id, job.token);
        return state === 'failed' ? { ok: false, status: 502, code: 'send_failed', resendId: job.id } : outcome({ ...job, state, result_id: child?.id ?? null });
      }
    }
    const base = { resendId: job.id, ...(job.result_id ? { id: job.result_id } : {}), idempotent: true as const };
    if (job.state === 'sent') return { ...base, ok: true, status: 200 };
    if (job.state === 'pending') return { ...base, ok: true, status: 202 };
    return { ...base, ok: false, status: 409, code: job.state === 'sending' ? 'in_progress' : 'outcome_unknown' };
  }
  async function execute(job: ResendJob, payload: ResendPayload, ref?: string, attachments?: Attachment[]): Promise<ResendOutcome> {
    const { m, brand, template } = await inspect(job.message_id);
    if (payload.template !== m.template) fail(409, 'resend_mismatch');
    const identity = { payload, ref: ref ?? null, attachments: attachments ?? null };
    const keys = parseKeyring(env).indexKeys;
    if (job.payload_mac && !await verifyMac(identity, JSON.parse(job.payload_mac), keys)) fail(409, 'idempotency_conflict');
    if (job.state !== 'pending') return outcome(job);
    const tag = canonicalJson(await createMac(identity, keys));
    if (!await startResend(store, job.id, at(), tag, job.token)) {
      const current = (await getResend(store, job.id))!;
      if (current.payload_mac && !await verifyMac(identity, JSON.parse(current.payload_mac), keys)) fail(409, 'idempotency_conflict');
      if (current.state === 'pending') { await inspect(job.message_id); return fail(409, 'resend_mismatch'); }
      return outcome(current);
    }
    let result: SendResult;
    try {
      result = await renderAndSend({ ...deps, store, logging: cfg.logging }, env, brand, template, payload.data, {
        to: payload.to, replyTo: payload.replyTo, subject: payload.subjectOverride, explicitJsonLd: payload.markup,
        clientId: m.client_id, idempotencyKey: job.id, ref, attachments, resendOf: m.id, resendRoot: job.root,
      });
    } catch {
      const child = await store.findByIdempotency(m.client_id, await idempotencyHash(m.client_id, job.id));
      await finishResend(store, job.id, child ? 'unknown' : 'failed', child?.id, job.token);
      return fail(503, 'log_unavailable');
    }
    const row = result.id ? await store.db.selectFrom('messages').select('status').where('id', '=', result.id).executeTakeFirst() : undefined;
    const state = result.ok ? 'sent' : row?.status === 'unknown' || row?.status === 'sending' ? 'unknown' : 'failed';
    await finishResend(store, job.id, state, result.id, job.token);
    return { ...result, resendId: job.id };
  }
  return {
    forPanel(panel: PanelPrincipal): ResendCapability {
      return {
        source: id => attempt(async () => { const { source } = await inspect(id, panel); await audit(panel.actor, 'resend.source', id); return source; }),
        request: async input => {
          const result = await attempt(async () => {
            if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500 ||
              typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) fail(400, 'invalid_request');
            const { m, source } = await inspect(input.messageId, panel);
            const payload = source.strategy === 'replay' ? await validate(m.id, input.replay, m.replay_mac) : undefined;
            if (payload && payload.template !== m.template) fail(409, 'resend_mismatch');
            const id = await jobId(input.idempotencyKey), existing = await getResend(store, id);
            if (existing && existing.expires_at <= at()) fail(409, 'resend_mismatch');
            if (existing && (existing.message_id !== m.id || existing.actor !== panel.actor || existing.strategy !== source.strategy)) fail(409, 'idempotency_conflict');
            if (existing && existing.state !== 'failed') return { ...await outcome(existing), ...(source.strategy === 'source' ? { source } : {}) };
            await audit(panel.actor, 'resend.request', m.id, { reason: input.reason });
            const claimed = await claimResend(store, { id, messageId: m.id, root: m.resend_root ?? m.id, actor: panel.actor, now: at(),
              metaCutoff: at() - cfg.logging.ceilings.metaDays * 86400000, strategy: source.strategy });
            const job = await getResend(store, id);
            if (!claimed) {
              await inspect(m.id, panel);
              if (job && job.state !== 'failed') return { ...await outcome(job), ...(source.strategy === 'source' ? { source } : {}) };
              return fail(429, 'rate_limited');
            }
            return payload ? execute(job!, payload) : { ok: true, status: 202, resendId: id, source };
          });
          if (!result.ok && result.code !== 'log_unavailable') return attempt(async () => {
            await audit(panel.actor, 'resend.denied', typeof input.messageId === 'string' ? input.messageId.slice(0, 128) : 'message', { code: result.code });
            return result;
          });
          return result;
        },
      };
    },
    sendSource: (clientId: string, messageId: string, key: string, value: unknown, ref?: string, attachments?: Attachment[], brandId?: string) => attempt(async () => {
      const job = await getResend(store, await jobId(key));
      if (!job || job.message_id !== messageId || job.strategy !== 'source' || job.expires_at <= at()) return fail(409, 'resend_mismatch');
      const owner = await store.db.selectFrom('messages').select(['client_id', 'brand']).where('id', '=', messageId).executeTakeFirst();
      if (!owner || owner.client_id !== clientId || (brandId !== undefined && owner.brand !== brandId)) return fail(409, 'resend_mismatch');
      const { m, source } = await inspect(messageId);
      if (source.strategy !== 'source' || source.owner?.clientId !== clientId || !job || job.strategy !== 'source' || job.message_id !== m.id || job.expires_at <= at()) fail(409, 'resend_mismatch');
      const payload = await validate(m.id, value);
      if (job!.state === 'failed') {
        const claimed = await claimResend(store, { id: job!.id, messageId: m.id, root: job!.root, actor: job!.actor, now: at(),
          metaCutoff: at() - cfg.logging.ceilings.metaDays * 86400000, strategy: 'source' });
        if (!claimed) { const current = (await getResend(store, job!.id))!; return current.state === 'failed' ? fail(429, 'rate_limited') : outcome(current); }
      }
      return execute((await getResend(store, job!.id))!, payload, ref, attachments);
    }),
  };
}
