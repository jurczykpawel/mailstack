import { attachmentSummary } from '../../attachments';
import { alertMessage } from '../alerts';
import type { Brand, Env, SendDeps, SendParams, SendResult, TemplateData, TemplateDef } from '../../types';
import { config } from '../config';
import { seal, verifyMac } from '../crypto';
import { parseKeyring } from '../keyring';
import type { MessageRow } from '../store/messages';
import type { EventIntent } from '../store/events';
import type { DomainEvent } from '../extensions';
import { resolvePolicy } from './policy';
import { idempotencyHash, intentRequest, messageId, prepareRecord, recordIntent } from './writer';

export interface PreparedDelivery {
  params: SendParams; template: TemplateDef; data: TemplateData;
  prepared?: ReturnType<typeof prepareRecord>;
  record: Pick<import("./writer").RecordInput, "render" | "renderMetadata" | "budget">;
}
export interface DeliveryContext {
  explicitSubject?: string; localeInput?: string | null;
  legacyData?: () => TemplateData; legacySubject?: (data: TemplateData) => string;
  record?: Pick<import("./writer").RecordInput, "render" | "renderMetadata" | "budget">;
  clientId?: string;
  resendOf?: string;
  resendRoot?: string;
  ref?: string;
  idempotencyKey?: string;
  explicitJsonLd?: unknown[];
  /** Public contact submission: `form.submitted` is recorded with `message.sent`. */
  submitted?: boolean;
}
const failure = (status: number, code: string, message = code.replaceAll('_', ' ')): SendResult => ({ ok: false, status, code, message });

export function deliveryResponse(result: SendResult, trusted: boolean): Record<string, unknown> {
  return {
    success: result.ok,
    ...(!result.ok ? { message: result.message ?? 'send failed', code: result.code ?? 'send_failed' } : {}),
    ...(trusted && result.id ? { id: result.id } : {}),
    ...(trusted && result.idempotent ? { idempotent: true } : {}),
  };
}

export async function deliver(
  deps: SendDeps, env: Env, brand: Brand, template: TemplateDef, data: TemplateData,
  envelope: Omit<SendParams, "subject" | "html" | "text">, context: DeliveryContext, prepare: (policy: import("../config/schema").Policy) => PreparedDelivery,
): Promise<SendResult> {
  const logging = deps.logging ?? config.logging;
  const { policy } = await resolvePolicy(logging, brand.id, template.id, template);
  const clientId = context.clientId ?? 'public';
  const input: import("./writer").RecordInput = {
    ...(envelope.attachments?.length ? { attachments: await attachmentSummary(envelope.attachments) } : {}),
    ...context.record, resendOf: context.resendOf, resendRoot: context.resendRoot, clientId, brand, template, data, recipients: envelope.to.map(address => ({ role: 'to' as const, address })),
    explicitSubject: context.explicitSubject, localeInput: context.localeInput, replyTo: envelope.replyTo, ref: context.ref,
    idempotencyKey: context.idempotencyKey, markup: context.explicitJsonLd, provider: deps.provider ?? 'ses',
  };
  const request = intentRequest(input);
  let id: string | undefined;
  let keyHash: string | undefined;
  let guardKey: string | undefined;
  let retry: MessageRow | undefined;
  const previous = async (): Promise<SendResult | 'retry' | undefined> => {
    if (!keyHash || !deps.store) return;
    const row: MessageRow | undefined = await deps.store.findByIdempotency(clientId, keyHash!);
    if (!row || row.created_at <= deps.now().getTime() - 86400000) return;
    let matches = false;
    try {
      const tag = JSON.parse(row.request_mac!);
      const legacyData = !Object.hasOwn(tag, 'version') ? context.legacyData?.() ?? data : undefined;
      const payload = tag.version === 2 ? request : legacyData ? intentRequest({ ...input, data: legacyData, subject: context.legacySubject?.(legacyData) }, true) : undefined;
      matches = payload !== undefined && await verifyMac(payload, tag, parseKeyring(env).indexKeys);
    } catch {}
    if (!matches) return { ...failure(409, 'idempotency_conflict'), id: row.id };
    if (row.status === 'send_failed') {
      retry = row;
      return 'retry';
    }
    if (row.status === 'sending') return { ...failure(409, 'in_progress'), id: row.id };
    if (row.status === 'unknown') return { ...failure(409, 'outcome_unknown'), id: row.id };
    return { ok: true, status: 200, id: row.id, idempotent: true };
  };
  if (context.idempotencyKey !== undefined) {
    keyHash = await idempotencyHash(clientId, context.idempotencyKey);
    try { const existing = await previous(); if (existing && existing !== 'retry') return existing; }
    catch { if (policy.level !== 'none' && policy.requireLog) return failure(503, 'log_unavailable'); }
  }
  let params: SendParams, prepared: ReturnType<typeof prepareRecord>;
  try {
    const result = prepare(policy); params = result.params;
    Object.assign(input, result.record, { template: result.template, data: result.data, subject: params.subject });
    prepared = result.prepared ?? prepareRecord(input, policy, logging.patterns);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (!['invalid_subject', 'template_empty_heading', 'template_sensitive_header', 'template_output_limit', 'replay_payload_limit'].includes(code)) throw error;
    return failure(code === 'invalid_subject' ? 400 : 422, code);
  }
  while (true) {
    try {
      if (context.idempotencyKey !== undefined) {
        if (retry) { await deps.store!.clearIdempotency(retry.id, keyHash!); retry = undefined; }
        if (deps.store) {
          if (!await deps.store.claimIdempotency(clientId, keyHash!, deps.now().getTime(), policy.level !== 'none')) {
            const pending: SendResult = policy.level === 'none'
              ? { ok: true, status: 200, idempotent: true } : failure(409, 'in_progress');
            let winner;
            try {
              winner = await previous();
              if (policy.level !== 'none') {
                for (let attempt = 0; !winner && attempt < 3; attempt++) {
                  await new Promise<void>(resolve => setTimeout(resolve, 10));
                  winner = await previous();
                }
              }
            } catch {
              return pending;
            }
            if (winner === 'retry') continue;
            return winner ?? pending;
          }
          guardKey = 'idem:' + clientId + ':' + keyHash;
        }
      }
      if (policy.level === 'none') break;
      ({ id } = await recordIntent({ store: deps.store, logging, env, now: deps.now }, { ...input, prepared }));
      break;
    } catch {
      try {
        const existing = await previous();
        if (existing === 'retry') continue;
        if (existing) return existing;
      } catch { /* Storage may be unavailable for both reads and writes. */ }
      if (policy.level !== 'none' && (policy.requireLog || context.resendOf)) {
        if (guardKey) await deps.store!.release(guardKey).catch(() => {});
        return failure(503, 'log_unavailable');
      }
      break;
    }
  }
  const correlationId = id ?? messageId(deps.now().getTime());
  const emit = (status: 'sent' | 'send_failed' | 'unknown') => deps.emitEvent?.({
    type: `message.${status}`, at: deps.now().getTime(), brand: brand.id, template: template.id, status,
    messageId: correlationId, ...(context.ref === undefined ? {} : { ref: context.ref }), durable: recorded,
  }, deps.waitUntil);
  const alert = (type: string) => {
    if (!id) return;
    const task = alertMessage(deps.store, deps.notifier,
      id, type, deps.now().getTime(), logging, env.PANEL_URL);
    if (deps.waitUntil) deps.waitUntil(task);
    else return task;
  };
  // Durable events only with a consumer and a message row (level none has none); asked before contacting the provider.
  const consumer = id ? await deps.durableEvents?.().catch(() => undefined) : undefined;
  const refDigest = consumer?.ref && context.ref !== undefined ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(context.ref))), b => b.toString(16).padStart(2, '0')).join('') : null;
  const events = (...types: DomainEvent['type'][]): EventIntent | undefined => consumer && { at: deps.now().getTime(), refDigest, types };
  // Set once a status write carrying the events committed; memory delivery then skips them (no double onEvent).
  let recorded = false;
  const stored = () => { recorded = !!consumer; };
  let result: SendResult;
  try {
    result = await deps.sendEmail(env, { ...params, ...(id ? { messageId: id, brand: brand.id } : {}) });
  } catch {
    if (id) await deps.store!.setStatus(id, 'unknown', events('message.unknown')).then(stored, () => {});
    emit('unknown');
    await alert('unknown');
    return { ...failure(502, 'send_failed'), id, correlationId };
  }
  if (!result.ok && guardKey && !id) await deps.store!.release(guardKey).catch(() => {});
  if (id) {
    try {
      const sealed = await seal(result.response ?? {}, { brand: brand.id, messageId: id, purpose: 'provider_response' }, parseKeyring(env).contentKeys);
      if (result.ok) {
        await deps.store!.markSent(id, { providerMessageId: result.messageId ?? '', providerResponseSealed: sealed, sentAt: deps.now().getTime(),
          ...(result.smtp ? { smtp: {
            accepted: params.to.flatMap((address, pos) => result.smtp!.accepted.includes(address) ? [pos] : []),
            rejected: params.to.flatMap((address, pos) => result.smtp!.rejected.includes(address) ? [pos] : []),
            evidence: await seal(result.response ?? {}, { brand: brand.id, messageId: id, purpose: 'evidence' }, parseKeyring(env).contentKeys),
          } } : {}),
        }, events('message.sent', ...context.submitted ? ['form.submitted' as const] : []));
      } else await deps.store!.markFailed(id, sealed, events('message.send_failed'));
      stored();
    } catch {
      await deps.store!.setStatus(id, result.ok ? 'unknown' : 'send_failed', events(result.ok ? 'message.unknown' : 'message.send_failed')).then(stored, () => {});
      if (result.ok) { emit('unknown'); await alert('unknown'); return { ...failure(502, 'send_failed'), id, correlationId }; }
    }
  }
  emit(result.ok ? 'sent' : 'send_failed');
  if (!result.ok) await alert('send_failed');
  return result.ok ? { ok: true, status: 200, id, correlationId, ...(recorded ? { durable: true as const } : {}) } : { ...failure(502, 'send_failed'), id, correlationId };
}
