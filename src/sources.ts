import { z } from 'zod';
import { config, getBrand } from './core/config';
import { SOURCE_LIMITS } from './core/config/sources';
import type { Source, SourceField } from './core/config/sources';
import { boundedBytes } from './core/http';
import { authenticate, permits, tokenSha256 } from './clients';
import { getTemplate, missingRequiredFields } from './templates/index';
import { renderAndSend } from './send';
import { deliveryResponse } from './core/logging/delivery';
import type { Env, SendDeps, TemplateData } from './types';

function read(value: unknown, path: string): unknown {
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = Reflect.get(value, part);
  }
  return value;
}
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}
export function sourceField(body: unknown, field: SourceField): string {
  if (typeof field === 'string') return text(read(body, field));
  if ('join' in field) return field.join.map(path => text(read(body, path))).filter(Boolean).join(' ');
  const value = read(body, field.path);
  switch (field.as) {
    case 'money-minor': return typeof value === 'number' && Number.isSafeInteger(value) ? (value / 100).toFixed(2).replace('.', ',') : '';
    case 'upper': return text(value).toUpperCase();
    case 'date-pl': {
      const date = typeof value === 'string' && value.trim() ? new Date(value) : new Date(NaN);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pl-PL', { timeZone: 'UTC' });
    }
    case 'map': return Object.hasOwn(field.map, text(value)) ? field.map[text(value)] : '';
  }
}
function bounded(value: unknown, depth = 0): boolean {
  if (depth > SOURCE_LIMITS.depth) return false;
  return !value || typeof value !== 'object' || Object.values(value).every(item => bounded(item, depth + 1));
}
async function signatureValid(req: Request, raw: Uint8Array<ArrayBuffer>, signature: Source['signature'], secret: unknown, now: Date) {
  if (signature.scheme === 'bearer-only' || typeof secret !== 'string' || !secret) return false;
  const header = req.headers.get(signature.header) ?? '';
  const match = signature.scheme === 't-v1' ? /^t=(\d{1,12}),v1=([a-f0-9]{64})$/i.exec(header)
    : /^sha256=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  if (signature.scheme === 't-v1' && Math.abs(now.getTime() / 1000 - Number(match[1])) > signature.toleranceSeconds) return false;
  const hex = match.at(-1)!;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const prefix = encoder.encode(signature.scheme === 't-v1' ? `${match[1]}.` : '');
    const message = new Uint8Array(prefix.length + raw.length);
    message.set(prefix); message.set(raw, prefix.length);
    return await crypto.subtle.verify('HMAC', key, Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16)),
      message);
  } catch { return false; }
}
const json = (body: object, status = 200) => Response.json(body, { status });
const invalid = (fields: string[]) => json({ success: false, code: 'invalid_event_data', message: 'invalid event data', fields }, 422);
export async function handleSourceHook(req: Request, env: Env, deps: SendDeps, id: string): Promise<Response> {
  const source = config.sources && Object.hasOwn(config.sources, id) ? config.sources[id] : undefined;
  if (!source) return json({ success: false, message: 'not found' }, 404);
  const client = await authenticate(req, env, config);
  if (!client) return json({ success: false, message: 'unauthorized' }, 401);
  const brandId = new URL(req.url).searchParams.get('brand') || (id === 'sellf' ? env.SELLF_DEFAULT_BRAND : undefined) || Object.keys(config.brands)[0];
  const forbidden = () => json({ success: false, message: 'forbidden', code: 'scope' }, 403);
  if (!permits(client, `hook:${id}`, brandId)) return forbidden();
  const brand = getBrand(brandId);
  if (!brand) return json({ success: false, message: 'unknown brand' }, 400);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await boundedBytes(req, SOURCE_LIMITS.bodyBytes); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return json({ success: false, message: 'payload too large' }, 413);
  }
  const secretEnv = client.signatureSecretEnv ?? (id === 'sellf' ? client.sellfSignatureSecretEnv : undefined);
  if (secretEnv && !await signatureValid(req, bytes, source.signature, Reflect.get(env, secretEnv), deps.now()))
    return json({ success: false, message: 'unauthorized' }, 401);
  let body: unknown, raw: string;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); body = JSON.parse(raw); } catch { return json({ success: false, message: 'invalid JSON' }, 400); }
  const event = read(body, source.envelope.event);
  const timestamp = read(body, source.envelope.timestamp);
  const data = read(body, source.envelope.data);
  if (!bounded(body) || typeof event !== 'string' || !event.trim() || event.length > 128 ||
    !z.iso.datetime({ offset: true }).safeParse(timestamp).success || !data || typeof data !== 'object' || Array.isArray(data))
    return json({ success: false, code: 'invalid_envelope', message: 'invalid envelope' }, 400);
  const action = Object.hasOwn(source.events, event) ? source.events[event] : undefined;
  if (!action || action.action === 'ignore') return json({ success: true, ignored: event });
  if (action.action === 'reject') return json({ success: false, code: 'unsupported_event', message: `Unsupported event: ${event}. Disable this event in the sender; retry will not help.` }, 422);
  if (!permits(client, `hook:${id}`, brandId, action.template)) return forbidden();
  const template = getTemplate(action.template);
  if (!template) return invalid(['template']);
  const mapped: TemplateData = Object.fromEntries(Object.entries(action.fields).map(([key, field]) => [key, sourceField(body, field)]));
  const to = text(read(body, action.to)).trim();
  const fields = missingRequiredFields(template, mapped);
  if (!z.email().safeParse(to).success) fields.push(action.to);
  for (const [key, value] of Object.entries(mapped)) if (value.length > SOURCE_LIMITS.valueChars) fields.push(key);
  const ref = action.ref ? text(read(body, action.ref)).trim() : '';
  if (ref.length > 128) fields.push('ref');
  if (fields.length) return invalid([...new Set(fields)]);
  const identity = action.idempotencyKey ? text(read(body, action.idempotencyKey)).trim() : '';
  const idempotencyKey = `source:${id}:${event}:${JSON.stringify([brandId, identity || (await tokenSha256(raw)).slice(0, 32)])}`;
  const result = await renderAndSend(deps, env, brand, template, mapped, {
    to: [to], replyTo: brand.to[0], clientId: client.id, ref: ref || undefined, idempotencyKey,
  });
  return json(deliveryResponse(result, true), result.status);
}
