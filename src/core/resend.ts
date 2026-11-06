import { config, compiledTemplates } from "./config";
import { effectiveTemplate } from "../templates/privacy.ts";
import { resolvePresentation } from "../templates/locale.ts";
import { templatePlans } from "../templates/config.ts";
import { sql } from 'kysely';
import { permits } from '../clients';
import { renderAndSend, prepareSend } from '../send';
import { getTemplate } from '../templates';
import type { Env, SendDeps, SendResult, Attachment } from '../types';
import type { Config } from './config/schema';
import { blindIndex, canonicalJson, createMac, refIndex, verifyMac } from './crypto';
import { parseKeyring, parseTransitKeys } from './keyring';
import { MAX_OPENED, openTransit, TransitError } from './transit';
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
    if (e instanceof Error && ['template_output_limit', 'replay_payload_limit', 'invalid_subject', 'template_empty_heading', 'template_sensitive_header'].includes(e.message)) return { ok: false, status: e.message === 'invalid_subject' ? 400 : 422, code: e.message, message: e.message.replaceAll('_', ' ') };
    return e && typeof e === 'object' && 'ok' in e && typeof e.ok === 'boolean' ? e as SendResult : { ok: false, status: 503, code: 'log_unavailable', message: 'log unavailable' };
  }
}
export function createResendService(cfg: Config, store: KyselyStore, env: Env, deps: SendDeps) {
  const plans = cfg === config ? compiledTemplates : cfg.mailTemplates ? templatePlans(cfg) : undefined;
  const at = () => deps.now().getTime();
  const jobId = async (key: string) => 'rs_' + await idempotencyHash('panel', key);
  const audit = (actor: string, action: string, target: string, details?: unknown) => appendAudit(store, { at: at(), actor: 'panel:' + actor, action, target, ...(details === undefined ? {} : { details }) });
  async function loadJob(id: string, expected: Pick<ResendJob, 'message_id' | 'root' | 'actor' | 'strategy'>) {
    const job = await getResend(store, id);
    if (job && job.expires_at <= at()) fail(409, 'resend_mismatch');
    if (job && (job.message_id !== expected.message_id || job.root !== expected.root || job.actor !== expected.actor || job.strategy !== expected.strategy)) fail(409, 'idempotency_conflict');
    return job;
  }
  async function inspect(id: string, panel?: PanelPrincipal) {
    if (panel && (!panel.scopes.includes('panel') || !panelAllows(panel, 'operator', true, at()) || panel.expiresAt <= at())) fail(403, 'scope');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(404, 'not_found');
    const m = await store.db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirst();
    if (!m || m.meta_expires_at <= at() || m.created_at <= at() - cfg.logging.ceilings.metaDays * 86400000) return fail(404, 'not_found');
    if (panel && ((panel.brands !== '*' && !panel.brands.includes(m.brand)) || (panel.templates !== '*' && !panel.templates.includes(m.template)))) fail(403, 'scope');
    const rawTemplate = getTemplate(m.template), brand = cfg.brands[m.brand];
    const template = rawTemplate && brand ? effectiveTemplate(rawTemplate, plans ? resolvePresentation(plans, brand, m.template).definition.secretFields : []) : undefined;
    const { policy } = await resolvePolicy(cfg.logging, m.brand, m.template, template);
    if (!template || !Object.hasOwn(cfg.brands, m.brand) || policy.resend === 'off' || policy.level === 'none') return fail(409, 'resend_disabled');
    if (m.created_at <= at() - policy.metaDays * 86400000) fail(404, 'not_found');
    if (m.status === 'sending' || m.status === 'unknown') fail(409, 'original_unresolved');
    if (!(await sql<{ ok: number }>`select ${unsuppressed(id)} as ok`.execute(store.db)).rows[0].ok) fail(409, 'suppressed');
    const replay = await store.db.selectFrom('replays').select(['sealed', 'expires_at']).where('message_id', '=', id).executeTakeFirst();
    const candidate = m.client_id ? deps.keys?.client(m.client_id) : undefined;
    const owner = candidate?.resendCallback && permits(candidate, 'send', m.brand, m.template) ? candidate : undefined;
    if (policy.resend === 'replay' && (template.secretFields?.length || !['masked', 'full'].includes(policy.level) || m.attachments_meta || !m.replay_mac ||
      !replay || replay.expires_at <= at() || !m.content_expires_at || m.content_expires_at <= at() ||
      m.created_at <= at() - Math.min(policy.contentDays, cfg.logging.ceilings.contentDays) * 86400000)) fail(409, 'resend_disabled');
    if (policy.resend === 'source' && !m.ref_sealed) fail(409, 'no_ref');
    if (policy.resend === 'source' && !owner) fail(409, 'resend_disabled');
    const source: ResendSource = { id, brand: m.brand, template: m.template, strategy: policy.resend,
      replay: policy.resend === 'replay' ? replay! : null, ref_sealed: m.ref_sealed,
      ...(owner ? { owner: { clientId: owner.id, callback: { ...owner.resendCallback! } } } : {}) };
    return { m, source, brand, template, policy };
  }
  async function validate(id: string, value: unknown, mac?: string | null, onPreparationFailure?: () => Promise<void>): Promise<ResendPayload> {
    const parsed = resendPayload.safeParse(value);
    const envelope = resendPayload.pick({ to: true, template: true, replyTo: true, subjectOverride: true }).passthrough().safeParse(value);
    if (!envelope.success || !parsed.success && !onPreparationFailure) return fail(409, 'resend_mismatch');
    const payload = parsed.success ? parsed.data : { ...envelope.data, data: {} } as ResendPayload;
    const keys = parseKeyring(env).indexKeys;
    if (mac) { let valid = false; try { valid = await verifyMac(value, JSON.parse(mac), keys); } catch {} if (!valid) fail(409, 'resend_mismatch'); }
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
    if (!parsed.success || new TextEncoder().encode(canonicalJson(value)).length > MAX_OPENED) {
      await onPreparationFailure?.(); return fail(409, 'resend_mismatch');
    }
    return payload;
  }
  // Replay and `ref` reach the API only sealed in the browser for this API, operation and message; the panel server forwards them unopened (K2).
  async function unwrap(value: string, strategy: ResendSource['strategy'], messageId: string, audience = '') {
    let keys; try { keys = (await parseTransitKeys(Reflect.get(env, 'TRANSIT_KEYS'))).privateKeys; } catch { return fail(503, 'transit_unavailable'); }
    let payload;
    try { payload = await openTransit(value, { aud: audience, op: `resend.${strategy}`, messageId }, keys, store, at()); }
    catch (e) { if (!(e instanceof TransitError)) throw e; return e.code === 'replayed' ? fail(409, 'replayed') : fail(403, 'transit_invalid'); }
    // A missing value fails later as `resend_mismatch` (replay) or `no_ref` (source).
    return payload && typeof payload === 'object' ? Reflect.get(payload, strategy === 'replay' ? 'replay' : 'ref') as unknown : undefined;
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
    if (job.state === 'failed' && job.error) return { ...base, ok: false, status: 503, code: job.error };
    if (job.state === 'sent') return { ...base, ok: true, status: 200 };
    if (job.state === 'pending') return { ...base, ok: true, status: 202 };
    return { ...base, ok: false, status: 409, code: job.state === 'sending' ? 'in_progress' : 'outcome_unknown' };
  }
  const identityOf = (payload: unknown, ref?: string, attachments?: Attachment[]) => ({ payload, ref: ref ?? null, attachments: attachments ?? null });
  async function verifyIdentity(job: ResendJob, payload: unknown, ref?: string, attachments?: Attachment[]) {
    if (!job.payload_mac) return;
    let valid = false; try { valid = await verifyMac(identityOf(payload, ref, attachments), JSON.parse(job.payload_mac), parseKeyring(env).indexKeys); } catch {}
    if (!valid) fail(409, 'idempotency_conflict');
  }
  function prepare(info: Awaited<ReturnType<typeof inspect>>, payload: ResendPayload, ref?: string, attachments?: Attachment[]) {
    return prepareSend({ ...deps, logging: cfg.logging, templates: plans }, info.brand, info.template, payload.data, {
      to: payload.to, replyTo: payload.replyTo, subject: payload.subjectOverride, explicitJsonLd: payload.markup, locale: payload.locale,
      clientId: info.m.client_id, ref, attachments,
    }, info.policy);
  }
  async function preparationFailure(job: ResendJob, error: unknown) {
    const code = error instanceof Error ? error.message : '';
    if (!['template_output_limit', 'replay_payload_limit', 'invalid_subject', 'template_empty_heading', 'template_sensitive_header'].includes(code)) throw error;
    if (job.strategy === 'source' && job.state === 'pending') {
      if (!await finishResend(store, job.id, 'failed', undefined, job.token, code)) {
        const current = await loadJob(job.id, job); if (current) return outcome(current);
      }
    }
    return fail(code === 'invalid_subject' ? 400 : 422, code);
  }
  async function execute(job: ResendJob, payload: ResendPayload, ref?: string, attachments?: Attachment[], ready?: import("./logging/delivery").PreparedDelivery, info?: Awaited<ReturnType<typeof inspect>>): Promise<ResendOutcome> {
    info ??= await inspect(job.message_id);
    const { m, source, brand, template } = info;
    if (payload.template !== m.template || source.strategy !== job.strategy || job.root !== (m.resend_root ?? m.id)) fail(409, 'resend_mismatch');
    payload = await validate(m.id, payload, job.strategy === 'replay' ? m.replay_mac : undefined);
    const identity = identityOf(payload, ref, attachments);
    const keys = parseKeyring(env).indexKeys;
    await verifyIdentity(job, payload, ref, attachments);
    if (job.state !== 'pending') return outcome(job);
    try { ready ??= prepare(info, payload, ref, attachments); } catch (error) { return preparationFailure(job, error); }
    const tag = canonicalJson(await createMac(identity, keys));
    if (!await startResend(store, job.id, at(), tag, job.token)) {
      const current = await loadJob(job.id, job);
      if (!current) return fail(409, 'resend_mismatch');
      await verifyIdentity(current, payload, ref, attachments);
      if (current.state === 'pending') { await inspect(job.message_id); return fail(409, 'resend_mismatch'); }
      return outcome(current);
    }
    let result: SendResult;
    try {
      result = await renderAndSend({ ...deps, store, logging: cfg.logging, templates: plans }, env, brand, template, payload.data, {
        to: payload.to, replyTo: payload.replyTo, subject: payload.subjectOverride, explicitJsonLd: payload.markup, locale: payload.locale, prepared: ready,
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
    /** `audience`: the API installation id the panel's envelopes are bound to. */
    forPanel(principal: PanelPrincipal, audience?: string): ResendCapability {
      const panel = structuredClone(principal), sourceClaims = new Map<string, string>();
      return {
        callbackFailed: async input => {
          const job = await getResend(store, await jobId(input.idempotencyKey));
          if (!job || job.message_id !== input.messageId || job.actor !== panel.actor || job.strategy !== 'source' || job.state !== 'pending' || sourceClaims.get(job.id) !== job.token) return;
          if (!await finishResend(store, job.id, 'failed', undefined, job.token, 'callback_unavailable')) return;
          await audit(panel.actor, 'resend.failed', job.message_id, { code: 'callback_unavailable' });
        },
        source: id => attempt(async () => { const { source } = await inspect(id, panel); await audit(panel.actor, 'resend.source', id); return source; }),
        request: async input => {
          const result = await attempt(async () => {
            if (typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 500 ||
              typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)) fail(400, 'invalid_request');
            const info = await inspect(input.messageId, panel);
            const { m, source } = info;
            const opened = await unwrap(input.envelope, source.strategy, m.id, audience);
            if (source.strategy === 'source') {
              const ref = opened;
              if (typeof ref !== 'string') return fail(409, 'no_ref');
              if (!ref.length || ref.length > 128 || !m.ref_idx) return fail(409, 'resend_mismatch');
              const indexes = await Promise.all(parseKeyring(env).indexKeys.map(key => refIndex(ref, key)));
              if (!indexes.some(value => value.index === m.ref_idx)) fail(409, 'resend_mismatch');
            }
            const payload = source.strategy === 'replay' ? await validate(m.id, opened, m.replay_mac) : undefined;
            if (payload && payload.template !== m.template) fail(409, 'resend_mismatch');
            const identity = { message_id: m.id, root: m.resend_root ?? m.id, actor: panel.actor, strategy: source.strategy };
            const id = await jobId(input.idempotencyKey), existing = await loadJob(id, identity);
            if (existing && payload) await verifyIdentity(existing, payload);
            if (existing && existing.state !== 'failed') {
              if (source.strategy === 'source') sourceClaims.set(id, existing.token);
              await audit(panel.actor, 'resend.request', m.id, { reason: input.reason });
              if (existing.state === 'pending' && payload) {
                return execute(existing, payload, undefined, undefined, undefined, info);
              }
              return { ...await outcome(existing), ...(source.strategy === 'source' ? { source, ref: opened as string } : {}) };
            }
            const ready = payload ? prepare(info, payload) : undefined;
            await audit(panel.actor, 'resend.request', m.id, { reason: input.reason });
            const claimed = await claimResend(store, { id, messageId: m.id, root: m.resend_root ?? m.id, actor: panel.actor, now: at(),
              metaCutoff: at() - cfg.logging.ceilings.metaDays * 86400000, strategy: source.strategy });
            const job = await loadJob(id, identity);
            if (!claimed) {
              await inspect(m.id, panel);
              if (job && job.state !== 'failed') {
                if (source.strategy === 'source') sourceClaims.set(id, job.token);
                await audit(panel.actor, 'resend.request', m.id, { reason: input.reason });
                return job.state === 'pending' && payload ? execute(job, payload, undefined, undefined, ready, info) :
                  { ...await outcome(job), ...(source.strategy === 'source' ? { source, ref: opened as string } : {}) };
              }
              return fail(429, 'rate_limited');
            }
            if (source.strategy === 'source') sourceClaims.set(id, job!.token);
            return payload ? execute(job!, payload, undefined, undefined, ready, info) : { ok: true, status: 202, resendId: id, source, ref: opened as string };
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
      const info = await inspect(messageId);
      const { m, source } = info;
      if (source.strategy !== 'source' || source.owner?.clientId !== clientId || !job || job.strategy !== 'source' || job.message_id !== m.id || job.expires_at <= at()) fail(409, 'resend_mismatch');
      if (job.root !== (m.resend_root ?? m.id) || typeof ref !== 'string' || !ref.length || ref.length > 128 || !m.ref_idx ||
        !(await Promise.all(parseKeyring(env).indexKeys.map(key => refIndex(ref, key)))).some(index => index.index === m.ref_idx)) fail(409, 'resend_mismatch');
      if (!value || typeof value !== 'object' || Reflect.get(value, 'template') !== m.template) fail(409, 'resend_mismatch');
      await verifyIdentity(job, value, ref, attachments);
      const payload = await validate(m.id, value, undefined, async () => {
        if (job.state === 'pending' && !await finishResend(store, job.id, 'failed', undefined, job.token, 'resend_mismatch')) {
          const current = await loadJob(job.id, job); if (current) throw await outcome(current);
        }
      });
      if (!['pending', 'failed'].includes(job.state)) return outcome(job);
      let ready;
      try { ready = prepare(info, payload, ref, attachments); } catch (error) { return preparationFailure(job, error); }
      if (job!.state === 'failed') {
        const claimed = await claimResend(store, { id: job!.id, messageId: m.id, root: job!.root, actor: job!.actor, now: at(),
          metaCutoff: at() - cfg.logging.ceilings.metaDays * 86400000, strategy: 'source' });
        if (!claimed) {
          const current = await loadJob(job.id, job);
          if (!current) return fail(409, 'resend_mismatch');
          return current.state === 'failed' ? fail(429, 'rate_limited') : execute(current, payload, ref, attachments, ready, info);
        }
      }
      const current = await loadJob(job.id, job);
      if (!current) return fail(409, 'resend_mismatch');
      return execute(current, payload, ref, attachments, ready, info);
    }),
  };
}
