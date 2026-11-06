import { z } from 'zod';
import { read, scalar as text, sourceField, mapSourceFields } from './source-fields.ts';
import { WorkBudget } from './templates/output.ts';
export { sourceField } from './source-fields.ts';
import { normalizeLocale, resolvePresentation } from './templates/locale.ts';
import { selectKind } from './templates/prepare.ts';
import { own } from './templates/config.ts';
import { config, compiledTemplates, getBrand } from './core/config';
import { SOURCE_LIMITS, requiredSourceFields } from './core/config/sources';
import type { Source } from './core/config/sources';
import { boundedBytes } from './core/http';
import { authenticate, licenseRequired, permits, tokenSha256 } from './clients';
import { getTemplate, missingRequiredFields } from './templates/index';
import { renderAndSend } from './send';
import { deliveryResponse } from './core/logging/delivery';
import type { Env, SendDeps, TemplateData } from './types';

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
  const client = await authenticate(req, env, config, deps.keys, deps.waitUntil);
  if (!client) return json({ success: false, message: 'unauthorized' }, 401);
  if ('denied' in client) return licenseRequired();
  const brandId = new URL(req.url).searchParams.get('brand') || source.defaultBrand || Object.keys(config.brands)[0];
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
  const secretEnv = client.signatureSecretEnv;
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
  const budget = new WorkBudget(1024 * 1024);
  let mapped: TemplateData, base: TemplateData, ref = '', identity = '';
  const locale = brand.mailTemplates?.languages && source.locale ? normalizeLocale(read(body, source.locale)) : null;
  try {
    base = mapSourceFields(body, action.fields, budget); mapped = base;
    if (brand.mailTemplates?.languages) {
      const selected = resolvePresentation(deps.templates ?? compiledTemplates, brand, template.id, selectKind(brand, template.id, base), locale).locale;
      const overlay = selected ? own(action.fieldsByLocale, selected) : undefined;
      if (overlay) mapped = { ...base, ...mapSourceFields(body, overlay, budget) };
    }
  }
  catch (error) { if (!(error instanceof RangeError)) throw error; return invalid([error.message]); }
  for (const [key, selection, limit] of [['ref', action.ref, 128], ['idempotencyKey', action.idempotencyKey, SOURCE_LIMITS.valueChars]] as const) {
    if (!selection) continue;
    try { const value = sourceField(body, selection, budget, limit, true); if (key === 'ref') ref = value; else identity = value; }
    catch (error) { if (!(error instanceof RangeError)) throw error; return invalid([key]); }
  }
  const to = text(read(body, action.to)).trim();
  const fields = [...missingRequiredFields(template, mapped), ...requiredSourceFields(action).filter(key => !mapped[key]?.trim())];
  if (!z.email().safeParse(to).success) fields.push(action.to);
  if (fields.length) return invalid([...new Set(fields)]);
  if (mapped.subject && /[\u0000-\u001f\u007f-\u009f]/.test(mapped.subject)) return invalid(['subject']);
  const urls = brand.licenseActivationUrls;
  if (template.id === 'license' && urls && Object.hasOwn(urls, mapped.productId)) mapped.activationUrl = urls[mapped.productId];
  const idempotencyKey = `source:${id}:${event}:${JSON.stringify([brandId, identity || (await tokenSha256(raw)).slice(0, 32)])}`;
  const result = await renderAndSend(deps, env, brand, template, mapped, {
    to: [to], replyTo: brand.to[0], clientId: client.id, ref: ref || undefined, idempotencyKey, locale, legacyData: () => base,
  });
  if (!result.ok && ['invalid_subject', 'template_empty_heading', 'template_sensitive_header', 'template_output_limit', 'replay_payload_limit'].includes(result.code ?? ''))
    return invalid([result.code === 'invalid_subject' ? 'subject' : result.code === 'template_empty_heading' ? 'heading' : result.code!]);
  return json(deliveryResponse(result, true), result.status);
}
