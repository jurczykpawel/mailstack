import { canonicalJson, decode, encode, suite } from './crypto/index.ts';
import type { ContentKey } from './crypto/index.ts';

export const TRANSIT_OPS = ['resend.replay', 'resend.source', 'log.search', 'subjects.export', 'subjects.erase'] as const;
export type TransitOp = typeof TRANSIT_OPS[number];
export interface TransitBinding { aud: string; op: TransitOp; messageId?: string | null }
export interface TransitPublicKey { kid: string; x: string }
interface NonceGuard { consume(key: string, expiresAt: number): Promise<boolean> }

export const TRANSIT_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const MAX_PAYLOAD = 64 * 1024;
const MAX_ENVELOPE = 2 * MAX_PAYLOAD;
const utf8 = new TextEncoder();
const info = utf8.encode('mailstack/v1/transit');

export class TransitError extends Error {
  constructor(readonly code: 'transit_invalid' | 'transit_expired' | 'replayed', readonly status: 400 | 409 = code === 'replayed' ? 409 : 400) {
    super(code);
  }
}

function aad({ aud, op, messageId }: TransitBinding, nonce: string): Uint8Array {
  const parts = [aud, messageId ?? '-', nonce];
  if (!TRANSIT_OPS.includes(op) || parts.some((v) => typeof v !== 'string' || !v || v.includes('|'))) throw new TransitError('transit_invalid');
  return utf8.encode(`ms-transit|${aud}|${op}|${parts[1]}|${nonce}`);
}

export async function sealTransit(payload: unknown, binding: TransitBinding, key: TransitPublicKey, now = Date.now(), ttlMs = TRANSIT_TTL_MS): Promise<string> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > TRANSIT_TTL_MS || utf8.encode(canonicalJson(payload)).byteLength > MAX_PAYLOAD) throw new TransitError('transit_invalid');
  const nonce = encode(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const body = { op: binding.op, messageId: binding.messageId ?? null, nonce, exp: now + ttlMs, payload };
  const additional = aad(binding, nonce);
  const recipientPublicKey = await suite.kem.importKey('jwk', { kty: 'OKP', crv: 'X25519', x: key.x });
  const { enc, ct } = await suite.seal({ recipientPublicKey, info }, utf8.encode(canonicalJson(body)), additional);
  return `mt1.${key.kid}.${nonce}.${encode(enc)}.${encode(ct)}`;
}

export async function openTransit(value: string, binding: TransitBinding, keys: readonly ContentKey[], guard: NonceGuard, now = Date.now()): Promise<unknown> {
  const body = await decrypt(value, binding, keys);
  if (body.exp <= now) throw new TransitError('transit_expired');
  if (body.exp > now + TRANSIT_TTL_MS + CLOCK_SKEW_MS) throw new TransitError('transit_invalid');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(body.nonce))), (b) => b.toString(16).padStart(2, '0')).join('');
  if (!await guard.consume(`transit-nonce:${digest}`, body.exp)) throw new TransitError('replayed');
  return body.payload;
}

async function decrypt(value: string, binding: TransitBinding, keys: readonly ContentKey[]): Promise<{ nonce: string; exp: number; payload: unknown }> {
  try {
    const [version, kid, nonce, enc, ct, extra] = typeof value === 'string' && value.length <= MAX_ENVELOPE ? value.split('.') : [];
    const key = keys.find((k) => k.kid === kid);
    if (version !== 'mt1' || extra !== undefined || !key?.d || decode(nonce).byteLength !== 16) throw new Error();
    const recipientKey = await suite.kem.importKey('jwk', key, false);
    const plain = await suite.open({ recipientKey, enc: decode(enc), info }, decode(ct), aad(binding, nonce));
    const body = JSON.parse(new TextDecoder().decode(plain));
    if (body?.op !== binding.op || body.messageId !== (binding.messageId ?? null) || body.nonce !== nonce || !Number.isSafeInteger(body.exp) ||
        !('payload' in body) || utf8.encode(canonicalJson(body.payload)).byteLength > MAX_PAYLOAD) throw new Error();
    return body;
  } catch {
    throw new TransitError('transit_invalid');
  }
}
