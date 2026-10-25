import { alertMessage } from '../alerts';
import { createNtfyNotifier } from '../../adapters/notify/ntfy';
import type { Brand, Env, SendDeps, SendParams, SendResult, TemplateData, TemplateDef } from '../../types';
import { config } from '../config';
import { seal, verifyMac } from '../crypto';
import { parseKeyring } from '../keyring';
import type { MessageRow } from '../store/messages';
import { resolvePolicy } from './policy';
import { idempotencyHash, intentRequest, recordIntent } from './writer';

export interface DeliveryContext {
  clientId?: string;
  ref?: string;
  idempotencyKey?: string;
  explicitJsonLd?: unknown[];
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
  params: SendParams, context: DeliveryContext,
): Promise<SendResult> {
  const logging = deps.logging ?? config.logging;
  const { policy } = await resolvePolicy(logging, brand.id, template.id);
  const clientId = context.clientId ?? 'public';
  const input = {
    clientId, brand, template, data, recipients: params.to.map(address => ({ role: 'to' as const, address })),
    subject: params.subject, replyTo: params.replyTo, ref: context.ref,
    idempotencyKey: context.idempotencyKey, markup: context.explicitJsonLd, provider: 'ses',
  };
  const request = intentRequest(input);
  let id: string | undefined;
  let keyHash: string | undefined;
  const previous = async (): Promise<SendResult | 'retry' | undefined> => {
    if (!keyHash || !deps.store) return;
    const row: MessageRow | undefined = await deps.store.findByIdempotency(clientId, keyHash);
    if (!row) return;
    const keys = parseKeyring(env).indexKeys;
    if (!row.request_mac || !await verifyMac(request, JSON.parse(row.request_mac), keys)) return { ...failure(409, 'idempotency_conflict'), id: row.id };
    if (row.status === 'send_failed') {
      await deps.store.clearIdempotency(row.id, keyHash);
      return 'retry';
    }
    if (row.status === 'sending') return { ...failure(409, 'in_progress'), id: row.id };
    if (row.status === 'unknown') return { ...failure(409, 'outcome_unknown'), id: row.id };
    return { ok: true, status: 200, id: row.id, idempotent: true };
  };
  while (policy.level !== 'none') {
    try {
      if (context.idempotencyKey !== undefined) {
        keyHash = await idempotencyHash(clientId, context.idempotencyKey);
        const existing = await previous();
        if (existing && existing !== 'retry') return existing;
      }
      ({ id } = await recordIntent({ store: deps.store, logging, env, now: deps.now }, input));
      break;
    } catch {
      try {
        const existing = await previous();
        if (existing === 'retry') continue;
        if (existing) return existing;
      } catch { /* Storage may be unavailable for both reads and writes. */ }
      if (policy.requireLog) return failure(503, 'log_unavailable');
      break;
    }
  }
  const alert = (type: string) => {
    if (!id) return;
    const task = alertMessage(deps.store, deps.notifier ?? (env.NTFY_URL ? createNtfyNotifier(env) : undefined),
      id, type, deps.now().getTime(), logging, env.PANEL_URL);
    if (deps.waitUntil) deps.waitUntil(task);
    else return task;
  };
  let result: SendResult;
  try {
    result = await deps.sendEmail(env, { ...params, ...(id ? { messageId: id, brand: brand.id } : {}) });
  } catch {
    if (id) await deps.store!.setStatus(id, 'unknown').catch(() => {});
    await alert('unknown');
    return { ...failure(502, 'send_failed'), id };
  }
  if (id) {
    try {
      const sealed = await seal(result.response ?? {}, { brand: brand.id, messageId: id, purpose: 'provider_response' }, parseKeyring(env).contentKeys);
      if (result.ok) {
        await deps.store!.markSent(id, { providerMessageId: result.messageId ?? '', providerResponseSealed: sealed, sentAt: deps.now().getTime() });
      } else await deps.store!.markFailed(id, sealed);
    } catch {
      await deps.store!.setStatus(id, result.ok ? 'unknown' : 'send_failed').catch(() => {});
      if (result.ok) { await alert('unknown'); return { ...failure(502, 'send_failed'), id }; }
    }
  }
  if (!result.ok) await alert('send_failed');
  return result.ok ? { ok: true, status: 200, id } : { ...failure(502, 'send_failed'), id };
}
