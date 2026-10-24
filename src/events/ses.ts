import { z } from 'zod';
import { blindIndexes, seal } from '../core/crypto';
import type { ContentKey, IndexKey } from '../core/crypto';
import type { KyselyStore } from '../core/store';
import { auditConfirmation, eventId, findMessage, recipients, recordEvents } from '../core/store/events';
import { boundedText, confirm, envelope } from './sns';
import type { createVerifier, SesOptions } from './sns';

const affected = z.union([z.string(), z.object({ emailAddress: z.string(), diagnosticCode: z.string().optional() })]);
const detail = z.object({ timestamp: z.iso.datetime().optional(), recipients: z.array(affected).optional(),
  bouncedRecipients: z.array(affected).optional(), complainedRecipients: z.array(affected).optional(), delayedRecipients: z.array(affected).optional(),
  bounceType: z.enum(['Permanent', 'Transient', 'Undetermined']).optional(), bounceSubType: z.string().optional(),
  smtpResponse: z.string().optional(), reason: z.string().optional(), errorMessage: z.string().optional() });
const sesSchema = z.object({ eventType: z.string(), mail: z.object({ messageId: z.string().min(1),
  tags: z.object({ ms_id: z.array(z.string()).optional() }).optional() }),
  delivery: detail.optional(), bounce: detail.optional(), complaint: detail.optional(), reject: detail.optional(),
  deliveryDelay: detail.optional(), failure: detail.optional(), send: detail.optional() });
const mapping: Record<string, [string, string, string?]> = {
  Send: ['accepted', 'send'], Delivery: ['delivered', 'delivery', 'recipients'], Bounce: ['bounce', 'bounce', 'bouncedRecipients'],
  Complaint: ['complaint', 'complaint', 'complainedRecipients'], Reject: ['reject', 'reject'],
  DeliveryDelay: ['delay', 'deliveryDelay', 'delayedRecipients'], 'Rendering Failure': ['render_failure', 'failure'],
};
export interface EventDeps {
  options?: SesOptions; store?: KyselyStore; contentKeys: ContentKey[]; indexKeys: IndexKey[];
  verify: ReturnType<typeof createVerifier>; now: () => number; fetcher?: typeof fetch;
}
const response = (status: number, result?: string) => Response.json(result ? { ok: true, result } : { ok: false }, { status });
export async function handleSesEvent(req: Request, deps: EventDeps): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(await boundedText(req, 256 * 1024)); }
  catch (error) { return response(error instanceof RangeError ? 413 : 400); }
  if (!envelope(body, req.headers.get('x-amz-sns-message-type'))) return response(400);
  if (!deps.options || !await deps.verify(body, body.Type, deps.options)) return response(403);
  if (!deps.store) return response(503);
  if (body.Type === 'UnsubscribeConfirmation') return response(200, 'ignored');
  if (body.Type === 'SubscriptionConfirmation') {
    try {
      await confirm(body, deps.fetcher ?? fetch);
      await auditConfirmation(deps.store, deps.now());
      return response(200, 'confirmed');
    } catch { return response(503); }
  }
  let event: z.infer<typeof sesSchema>;
  try { event = sesSchema.parse(JSON.parse(body.Message)); } catch { return response(400); }
  if (!deps.contentKeys.length || !deps.indexKeys.length) return response(503);
  const map = Object.hasOwn(mapping, event.eventType) ? mapping[event.eventType] : undefined;
  if (!map) return response(200, 'ignored');
  const data = event[map[1] as Exclude<keyof typeof event, 'mail' | 'eventType'>];
  if (map[2] && (!data || (map[0] !== 'complaint' && !data[map[2] as 'recipients']))) return response(400);
  const type = map[0] === 'bounce' ? `bounce_${(data?.bounceType ?? 'Undetermined').toLowerCase()}` : map[0];
  try {
    const account = body.TopicArn.split(':')[4];
    const message = await findMessage(deps.store, event.mail.tags?.ms_id?.[0], account, event.mail.messageId);
    if (!message) return response(200, 'ignored');
    const stored = await recipients(deps.store, message.id);
    const addresses = map[2] ? data?.[map[2] as 'recipients'] ?? [] : undefined;
    const indices = new Set<string>();
    for (const address of addresses ?? []) {
      for (const idx of await blindIndexes(typeof address === 'string' ? address : address.emailAddress, deps.indexKeys))
        indices.add(idx.kid + ':' + idx.index);
    }
    const matched = stored.filter(r => !addresses || indices.has(r.idx_kid + ':' + r.addr_idx));
    const positions: (number | null)[] = matched.map(r => r.pos);
    if (!positions.length && type === 'complaint') positions.push(null);
    if (!positions.length) return response(200, 'ignored');
    const summary = [data?.bounceType, data?.bounceSubType, data?.smtpResponse, data?.reason, data?.errorMessage,
      ...(addresses ?? []).map(a => typeof a === 'string' ? '' : a.diagnosticCode)].filter(Boolean).join(' ')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/[^\s<>"(),;:]+@[^\s<>"(),;:]+/g, '').slice(0, 200);
    const evidence = await seal(body, { brand: message.brand, messageId: message.id, purpose: 'evidence' }, deps.contentKeys);
    const now = deps.now();
    const rows = positions.map(pos => ({ id: eventId(now), message_id: message.id, recipient_pos: pos, source: 'ses-sns',
      source_event_id: `${body.MessageId}:${pos ?? 'msg'}`, type, occurred_at: Date.parse(data?.timestamp ?? body.Timestamp),
      received_at: now, auth: body.SignatureVersion === '2' ? 'sns-sig-v2' : 'sns-sig-v1', summary, evidence_sealed: evidence }));
    return response(200, await recordEvents(deps.store, rows) ? 'processed' : 'duplicate');
  } catch { return response(503); }
}
