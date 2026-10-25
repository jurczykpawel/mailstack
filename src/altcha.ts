import type { Store } from './core/ports';
import type { Brand } from './types';

export interface AltchaChallenge {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
}

const CHALLENGE_LIFETIME_SECONDS = 10 * 60;
const MAX_NUMBER = 100_000;
const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

const NONCE_DOMAIN = 'mailstack/v1/nonce\n';
interface FormNonce { brand: string; product: string; random: string; exp: number }

export async function createNonce(key: string, brand: string, product: string, now: Date): Promise<string> {
  const payload: FormNonce = { brand, product, random: crypto.randomUUID(),
    exp: Math.floor(now.getTime() / 1000) + CHALLENGE_LIFETIME_SECONDS };
  const encoded = btoa(String.fromCharCode(...enc.encode(JSON.stringify(payload))));
  return `${encoded}.${await hmacHex(key, NONCE_DOMAIN + encoded)}`;
}

export async function verifyNonce(key: string, token: unknown, brand: Brand, product: unknown, now: Date): Promise<FormNonce | null> {
  try {
    if (!key || typeof token !== 'string' || token.length > 5000) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) return null;
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(parts[1].match(/../g)!, byte => parseInt(byte, 16));
    if (!await crypto.subtle.verify('HMAC', k, signature, enc.encode(NONCE_DOMAIN + parts[0]))) return null;
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(parts[0]), c => c.charCodeAt(0))));
    const remaining = p?.exp - Math.floor(now.getTime() / 1000);
    if (!p || p.brand !== brand.id || typeof p.product !== 'string' || !brand.products?.includes(p.product) ||
        (product !== undefined && product !== p.product) ||
        typeof p.random !== 'string' || !/^[a-f0-9-]{36}$/.test(p.random) ||
        !Number.isSafeInteger(p.exp) || remaining <= 0 || remaining > CHALLENGE_LIFETIME_SECONDS) return null;
    return p;
  } catch { return null; }
}

/** Build an Altcha challenge: number is the secret PoW answer; signature binds it to our key. */
export async function createChallenge(hmacKey: string, opts?: { maxnumber?: number }): Promise<AltchaChallenge> {
  const maxnumber = opts?.maxnumber ?? MAX_NUMBER;
  if (!Number.isInteger(maxnumber) || maxnumber < 0 || maxnumber > MAX_NUMBER) {
    throw new RangeError('invalid maxnumber');
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(12));
  const salt = `${toHex(saltBytes.buffer)}?expires=${Math.floor(Date.now() / 1000) + CHALLENGE_LIFETIME_SECONDS}`;
  const number = crypto.getRandomValues(new Uint32Array(1))[0] % (maxnumber + 1);
  const challenge = await sha256Hex(salt + number);
  const signature = await hmacHex(hmacKey, challenge);
  return { algorithm: 'SHA-256', challenge, salt, signature, maxnumber };
}

interface AltchaPayload {
  algorithm: 'SHA-256';
  challenge: string;
  salt: string;
  number: number;
  signature: string;
}

function parsePayload(payloadB64: string): AltchaPayload | null {
  try {
    if (typeof payloadB64 !== 'string' || payloadB64.length > 5000) return null;
    const p = JSON.parse(atob(payloadB64));
    if (!p || typeof p !== 'object' || Array.isArray(p) ||
        p.algorithm !== 'SHA-256' ||
        typeof p.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(p.challenge) ||
        typeof p.signature !== 'string' || !/^[a-f0-9]{64}$/.test(p.signature) ||
        typeof p.salt !== 'string' || p.salt.length > 256 ||
        !Number.isInteger(p.number) || p.number < 0 || p.number > MAX_NUMBER) return null;
    return p;
  } catch {
    return null;
  }
}

function remainingSeconds(salt: string, now: Date): number {
  const match = /^[a-f0-9]+\?expires=([1-9][0-9]{0,9})$/.exec(salt);
  if (!match) return 0;
  const remaining = Number(match[1]) - Math.floor(now.getTime() / 1000);
  return Number.isFinite(remaining) && remaining > 0 && remaining <= CHALLENGE_LIFETIME_SECONDS
    ? remaining : 0;
}

/** Verify the widget's solution and signed expiry. */
export async function verifyAltcha(hmacKey: string, payloadB64: string, now = new Date()): Promise<boolean> {
  try {
    const p = parsePayload(payloadB64);
    if (!p || !remainingSeconds(p.salt, now)) return false;
    const expectedChallenge = await sha256Hex(p.salt + p.number);
    if (expectedChallenge !== p.challenge) return false;
    const expectedSig = await hmacHex(hmacKey, p.challenge);
    return expectedSig === p.signature;
  } catch {
    return false;
  }
}

/** Record a verified submission before delivery. Storage must be available. */
export async function consumeAltcha(
  store: Store | undefined,
  payloadB64: string,
  now: () => Date,
): Promise<boolean> {
  try {
    const p = parsePayload(payloadB64);
    if (!store || !p || !remainingSeconds(p.salt, now())) return false;
    const expiresAt = Number(p.salt.split('?expires=')[1]) * 1000;
    const consumed = await store.consume(`altcha:${p.challenge}`, expiresAt);
    return consumed && remainingSeconds(p.salt, now()) > 0;
  } catch {
    return false;
  }
}
